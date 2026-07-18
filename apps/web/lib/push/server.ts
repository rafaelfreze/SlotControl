import { createHash } from "node:crypto";
import webpush from "web-push";

import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { buildPushNotification, classifyPushError, isNotificationEnabled } from "./payload";
import { emptyPushTestResult, isValidPushSubscriptionData, normalizeUrlSafeBase64, type PushTestDeliveryResult, type PushTestResult } from "./test-result";
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences, type PushOutboxRecord, type PushSubscriptionRecord } from "./types";

const RETRY_DELAYS_MINUTES = [1, 5, 30];
const MAX_ATTEMPTS = 4;

type DeliveryRow = { subscription_id: string; status: string };
type StoredSubscription = PushSubscriptionRecord & { p256dh: string; auth: string; failure_count: number };
type PushProcessingResult = PushTestResult & { retry: boolean; skipped: number };

function cleanVapidEnvironmentValue(value: string | undefined) {
  return value?.replace(/^[\s\u200B-\u200D\uFEFF]+|[\s\u200B-\u200D\uFEFF]+$/g, "") || "";
}

function getWebPush() {
  const publicKey = normalizeUrlSafeBase64(cleanVapidEnvironmentValue(process.env.VAPID_PUBLIC_KEY || process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY));
  const privateKey = normalizeUrlSafeBase64(cleanVapidEnvironmentValue(process.env.VAPID_PRIVATE_KEY));
  const subject = cleanVapidEnvironmentValue(process.env.VAPID_SUBJECT);

  if (!publicKey) throw new Error("VAPID_PUBLIC_KEY não configurada.");
  if (!privateKey) throw new Error("VAPID_PRIVATE_KEY não configurada.");
  if (!subject) throw new Error("VAPID_SUBJECT não configurada.");

  if (!/^[A-Za-z0-9_-]+$/.test(publicKey)) throw new Error("VAPID public key inválida.");
  if (!/^[A-Za-z0-9_-]+$/.test(privateKey)) throw new Error("VAPID private key inválida.");

  try {
    const parsed = new URL(subject);
    if (!["mailto:", "https:", "http:"].includes(parsed.protocol)) {
      throw new Error("invalid protocol");
    }
  } catch {
    throw new Error("VAPID_SUBJECT inválida.");
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  return {
    sender: webpush,
    publicKeyFingerprint: createHash("sha256").update(publicKey).digest("hex").slice(0, 12)
  };
}

function asPreferences(value: unknown): NotificationPreferences {
  return value && typeof value === "object"
    ? { ...DEFAULT_NOTIFICATION_PREFERENCES, ...(value as Partial<NotificationPreferences>) }
    : DEFAULT_NOTIFICATION_PREFERENCES;
}

function nextRetry(attemptCount: number) {
  const minutes = RETRY_DELAYS_MINUTES[attemptCount - 1];
  return minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
}

function endpointHost(endpoint: string) {
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

function validSubscription(subscription: StoredSubscription) {
  return isValidPushSubscriptionData(subscription) && subscription.is_active && !subscription.revoked_at;
}

function createProcessResult(overrides: Partial<PushProcessingResult> = {}): PushProcessingResult {
  return { ...emptyPushTestResult(), retry: false, skipped: 0, ...overrides };
}

async function setOutboxResult(outbox: PushOutboxRecord, status: PushOutboxRecord["status"], lastError: string | null, nextAttemptAt: string | null = null) {
  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("notification_outbox").update({
    status,
    last_error: lastError,
    next_attempt_at: nextAttemptAt || new Date().toISOString(),
    processing_started_at: null,
    processed_at: ["sent", "failed", "cancelled"].includes(status) ? new Date().toISOString() : null
  }).eq("id", outbox.id);
  if (error) throw error;
}

async function upsertDelivery(input: Record<string, unknown>) {
  const { error } = await createServiceRoleClient().from("notification_deliveries").upsert(input, { onConflict: "outbox_id,subscription_id" });
  if (error) throw error;
}

async function updateSubscription(subscriptionId: string, values: Record<string, unknown>) {
  const { error } = await createServiceRoleClient().from("push_subscriptions").update(values).eq("id", subscriptionId);
  if (error) throw error;
}

async function markProviderConfigurationFailure(outbox: PushOutboxRecord, recipients: StoredSubscription[], error: unknown): Promise<PushProcessingResult> {
  const classified = classifyPushError(error);
  const results: PushTestDeliveryResult[] = recipients.map((subscription) => ({
    endpointHost: endpointHost(subscription.endpoint),
    success: false,
    statusCode: classified.statusCode,
    errorCode: "vapid_configuration",
    message: "A configuração VAPID do servidor precisa ser corrigida."
  }));
  const now = new Date().toISOString();
  await Promise.all(recipients.map((subscription, index) => upsertDelivery({
    outbox_id: outbox.id,
    subscription_id: subscription.id,
    status: "failed",
    attempted_at: now,
    completed_at: now,
    http_status: classified.statusCode,
    error_code: "vapid_configuration",
    error_message: results[index].message
  })));
  await setOutboxResult(outbox, "failed", "Configuração VAPID inválida no servidor.");
  console.error("[push-worker] vapid_configuration_failed", {
    event: "push_send",
    outboxId: outbox.id,
    eventId: outbox.event_id,
    subscriptionsFound: recipients.length,
    message: classified.message
  });
  return createProcessResult({ subscriptionsFound: recipients.length, attempted: recipients.length, failed: recipients.length, results });
}

async function processOutboxItem(outbox: PushOutboxRecord): Promise<PushProcessingResult> {
  const supabase = createServiceRoleClient();
  const [{ data: preferencesRow }, { data: subscriptions }, { data: priorDeliveries }] = await Promise.all([
    supabase.from("notification_preferences").select("*").eq("user_id", outbox.user_id).maybeSingle(),
    supabase.from("push_subscriptions").select("id,endpoint,p256dh,auth,user_agent,device_name,platform,is_active,created_at,last_success_at,last_seen_at,revoked_at,failure_count").eq("user_id", outbox.user_id).eq("is_active", true).is("revoked_at", null),
    supabase.from("notification_deliveries").select("subscription_id,status").eq("outbox_id", outbox.id)
  ]);
  const preferences = asPreferences(preferencesRow);
  const activeSubscriptions = ((subscriptions || []) as StoredSubscription[]).filter(validSubscription);
  const sentIds = new Set(((priorDeliveries || []) as DeliveryRow[]).filter((delivery) => delivery.status === "sent").map((delivery) => delivery.subscription_id));

  if (!isNotificationEnabled(preferences, outbox)) {
    await setOutboxResult(outbox, "cancelled", "Preferência do usuário bloqueou o envio.");
    return createProcessResult({ subscriptionsFound: activeSubscriptions.length, skipped: activeSubscriptions.length });
  }

  const recipients = activeSubscriptions.filter((subscription) => !sentIds.has(subscription.id));
  if (!recipients.length) {
    await setOutboxResult(outbox, "sent", null);
    return createProcessResult({ subscriptionsFound: activeSubscriptions.length, skipped: activeSubscriptions.length });
  }

  let sender: ReturnType<typeof getWebPush>["sender"];
  let publicKeyFingerprint: string;
  try {
    ({ sender, publicKeyFingerprint } = getWebPush());
  } catch (error) {
    return markProviderConfigurationFailure(outbox, recipients, error);
  }

  const content = buildPushNotification(outbox, preferences);
  const results: PushTestDeliveryResult[] = [];
  let deliveredToProvider = 0;
  let removedExpired = 0;
  let transientFailures = 0;
  let permanentFailures = 0;

  for (const subscription of recipients) {
    const attemptedAt = new Date().toISOString();
    await upsertDelivery({ outbox_id: outbox.id, subscription_id: subscription.id, status: "processing", attempted_at: attemptedAt, completed_at: null, error_code: null, error_message: null, http_status: null });
    try {
      const response = await sender.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: normalizeUrlSafeBase64(subscription.p256dh), auth: normalizeUrlSafeBase64(subscription.auth) } },
        JSON.stringify(content),
        { TTL: 60 * 60, urgency: "high", topic: content.tag.slice(0, 32) }
      );
      deliveredToProvider += 1;
      results.push({ endpointHost: endpointHost(subscription.endpoint), success: true, statusCode: response.statusCode, errorCode: null, message: null });
      await Promise.all([
        upsertDelivery({ outbox_id: outbox.id, subscription_id: subscription.id, status: "sent", attempted_at: attemptedAt, completed_at: new Date().toISOString(), http_status: response.statusCode, error_code: null, error_message: null }),
        updateSubscription(subscription.id, { last_success_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), failure_count: 0, is_active: true, revoked_at: null })
      ]);
    } catch (error) {
      const classified = classifyPushError(error);
      results.push({ endpointHost: endpointHost(subscription.endpoint), success: false, statusCode: classified.statusCode, errorCode: classified.code, message: classified.message });
      if (classified.expired) {
        removedExpired += 1;
        await Promise.all([
          upsertDelivery({ outbox_id: outbox.id, subscription_id: subscription.id, status: "expired", attempted_at: attemptedAt, completed_at: new Date().toISOString(), http_status: classified.statusCode, error_code: classified.code, error_message: classified.message }),
          updateSubscription(subscription.id, { is_active: false, revoked_at: new Date().toISOString(), last_failure_at: new Date().toISOString(), failure_count: subscription.failure_count + 1 })
        ]);
      } else {
        transientFailures += Number(classified.transient);
        permanentFailures += Number(!classified.transient);
        await Promise.all([
          upsertDelivery({ outbox_id: outbox.id, subscription_id: subscription.id, status: "failed", attempted_at: attemptedAt, completed_at: new Date().toISOString(), http_status: classified.statusCode, error_code: classified.code, error_message: classified.message }),
          updateSubscription(subscription.id, { last_failure_at: new Date().toISOString(), failure_count: subscription.failure_count + 1 })
        ]);
      }
    }
  }

  const result = createProcessResult({
    ok: deliveredToProvider > 0,
    subscriptionsFound: activeSubscriptions.length,
    attempted: recipients.length,
    deliveredToProvider,
    failed: recipients.length - deliveredToProvider,
    removedExpired,
    results
  });
  if (transientFailures && outbox.attempt_count < MAX_ATTEMPTS) {
    result.retry = true;
    await setOutboxResult(outbox, deliveredToProvider ? "partial" : "pending", "Falha temporária no provedor push.", nextRetry(outbox.attempt_count));
  } else if (transientFailures || permanentFailures) {
    await setOutboxResult(outbox, deliveredToProvider ? "partial" : "failed", "Não foi possível entregar a todos os dispositivos.");
  } else {
    await setOutboxResult(outbox, "sent", null);
  }
  console.info("[push-worker] delivery_summary", {
    event: outbox.event_type === "test" ? "push_test" : "push_delivery",
    outboxId: outbox.id,
    subscriptionsFound: result.subscriptionsFound,
    attempted: result.attempted,
    accepted: result.deliveredToProvider,
    failed: result.failed,
    expired: result.removedExpired,
    statusCodes: results.map((item) => item.statusCode).filter((value): value is number => value !== null),
    vapidPublicKeyFingerprint: publicKeyFingerprint
  });
  return result;
}

async function claimOutboxById(outboxId: string) {
  const supabase = createServiceRoleClient();
  const { data: pending, error: pendingError } = await supabase.from("notification_outbox").select("*").eq("id", outboxId).in("status", ["pending", "partial"]).maybeSingle();
  if (pendingError) throw pendingError;
  if (!pending) return null;
  const { data, error } = await supabase.from("notification_outbox").update({
    status: "processing",
    attempt_count: pending.attempt_count + 1,
    processing_started_at: new Date().toISOString(),
    last_error: null
  }).eq("id", outboxId).in("status", ["pending", "partial"]).select("*").maybeSingle();
  if (error) throw error;
  return (data || null) as PushOutboxRecord | null;
}

export async function processPushOutboxById(outboxId: string): Promise<PushProcessingResult> {
  const claimed = await claimOutboxById(outboxId);
  if (!claimed) return createProcessResult({ failed: 1, results: [{ endpointHost: null, success: false, statusCode: null, errorCode: "outbox_unavailable", message: "O teste já está sendo processado. Atualize o diagnóstico em alguns segundos." }] });
  return processOutboxItem(claimed);
}

export async function getPushSubscriptionDiagnostics(userId: string, currentEndpoint?: string | null) {
  const { data, error } = await createServiceRoleClient().from("push_subscriptions").select("id,endpoint,p256dh,auth,is_active,revoked_at").eq("user_id", userId);
  if (error) throw error;
  const valid = ((data || []) as StoredSubscription[]).filter(validSubscription);
  const endpoint = currentEndpoint || "";
  return {
    activeCount: valid.length,
    invalidCount: (data || []).filter((item) => item.is_active && !item.revoked_at).length - valid.length,
    currentDeviceMatched: Boolean(endpoint && valid.some((item) => item.endpoint === endpoint)),
    currentSubscriptionId: endpoint ? valid.find((item) => item.endpoint === endpoint)?.id || null : null
  };
}

export async function processPendingPushNotifications(limit = 25) {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc("claim_notification_outbox", { p_limit: limit });
  if (error) throw error;
  const outbox = (data || []) as PushOutboxRecord[];
  const stats = { claimed: outbox.length, sent: 0, expired: 0, retries: 0, failed: 0 };
  for (const item of outbox) {
    try {
      const result = await processOutboxItem(item);
      stats.sent += result.deliveredToProvider;
      stats.expired += result.removedExpired;
      stats.retries += Number(result.retry);
      stats.failed += Number(!result.ok && result.failed > 0);
    } catch (error) {
      stats.failed += 1;
      const message = error instanceof Error ? error.message.slice(0, 400) : "Falha desconhecida no worker push.";
      await setOutboxResult(item, item.attempt_count < MAX_ATTEMPTS ? "pending" : "failed", message, item.attempt_count < MAX_ATTEMPTS ? nextRetry(item.attempt_count) : null);
      console.error("[push-worker] outbox_failed", { event: "push_delivery", outboxId: item.id, eventId: item.event_id, message });
    }
  }
  console.log("[push-worker] completed", stats);
  return stats;
}
