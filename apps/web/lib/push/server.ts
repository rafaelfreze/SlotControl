import webpush from "web-push";

import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { buildPushNotification, classifyPushError, isNotificationEnabled } from "./payload";
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences, type PushOutboxRecord, type PushSubscriptionRecord } from "./types";

const RETRY_DELAYS_MINUTES = [1, 5, 30];
const MAX_ATTEMPTS = 4;

type DeliveryRow = { subscription_id: string; status: string };

function getWebPush() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;

  if (!publicKey || !privateKey || !subject) {
    throw new Error("Configuração VAPID ausente.");
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  return webpush;
}

function asPreferences(value: unknown): NotificationPreferences {
  if (!value || typeof value !== "object") {
    return DEFAULT_NOTIFICATION_PREFERENCES;
  }

  return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...(value as Partial<NotificationPreferences>) };
}

function nextRetry(attemptCount: number) {
  const minutes = RETRY_DELAYS_MINUTES[attemptCount - 1];
  return minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
}

async function setOutboxResult(outbox: PushOutboxRecord, status: PushOutboxRecord["status"], lastError: string | null, nextAttemptAt: string | null = null) {
  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("notification_outbox")
    .update({
      status,
      last_error: lastError,
      next_attempt_at: nextAttemptAt || new Date().toISOString(),
      processing_started_at: null,
      processed_at: ["sent", "failed", "cancelled"].includes(status) ? new Date().toISOString() : null
    })
    .eq("id", outbox.id);

  if (error) {
    throw error;
  }
}

async function upsertDelivery(input: Record<string, unknown>) {
  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("notification_deliveries").upsert(input, { onConflict: "outbox_id,subscription_id" });
  if (error) {
    throw error;
  }
}

async function updateSubscription(subscriptionId: string, values: Record<string, unknown>) {
  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("push_subscriptions").update(values).eq("id", subscriptionId);
  if (error) {
    throw error;
  }
}

async function processOutboxItem(outbox: PushOutboxRecord) {
  const supabase = createServiceRoleClient();
  const [{ data: preferencesRow }, { data: subscriptions }, { data: priorDeliveries }] = await Promise.all([
    supabase.from("notification_preferences").select("*").eq("user_id", outbox.user_id).maybeSingle(),
    supabase.from("push_subscriptions").select("id,endpoint,p256dh,auth,user_agent,device_name,platform,is_active,created_at,last_success_at,failure_count").eq("user_id", outbox.user_id).eq("is_active", true),
    supabase.from("notification_deliveries").select("subscription_id,status").eq("outbox_id", outbox.id)
  ]);
  const preferences = asPreferences(preferencesRow);
  const activeSubscriptions = (subscriptions || []) as Array<PushSubscriptionRecord & { p256dh: string; auth: string; failure_count: number }>;
  const sentIds = new Set(((priorDeliveries || []) as DeliveryRow[]).filter((delivery) => delivery.status === "sent").map((delivery) => delivery.subscription_id));

  if (!isNotificationEnabled(preferences, outbox)) {
    await setOutboxResult(outbox, "cancelled", "Preferência do usuário bloqueou o envio.");
    return { sent: 0, expired: 0, retry: false, skipped: activeSubscriptions.length };
  }

  const recipients = activeSubscriptions.filter((subscription) => !sentIds.has(subscription.id));
  if (!recipients.length) {
    await setOutboxResult(outbox, "sent", null);
    return { sent: 0, expired: 0, retry: false, skipped: activeSubscriptions.length };
  }

  const content = buildPushNotification(outbox, preferences);
  const sender = getWebPush();
  let sent = 0;
  let expired = 0;
  let transientFailures = 0;
  let permanentFailures = 0;

  for (const subscription of recipients) {
    await upsertDelivery({
      outbox_id: outbox.id,
      subscription_id: subscription.id,
      status: "processing",
      attempted_at: new Date().toISOString(),
      completed_at: null,
      error_code: null,
      error_message: null,
      http_status: null
    });

    try {
      const result = await sender.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify(content),
        { TTL: 60 * 60, urgency: "high", topic: content.tag.slice(0, 32) }
      );
      sent += 1;
      await Promise.all([
        upsertDelivery({ outbox_id: outbox.id, subscription_id: subscription.id, status: "sent", attempted_at: new Date().toISOString(), completed_at: new Date().toISOString(), http_status: result.statusCode, error_code: null, error_message: null }),
        updateSubscription(subscription.id, { last_success_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), failure_count: 0, is_active: true, revoked_at: null })
      ]);
    } catch (error) {
      const classified = classifyPushError(error);
      if (classified.expired) {
        expired += 1;
        await Promise.all([
          upsertDelivery({ outbox_id: outbox.id, subscription_id: subscription.id, status: "expired", attempted_at: new Date().toISOString(), completed_at: new Date().toISOString(), http_status: classified.statusCode, error_code: classified.code, error_message: classified.message }),
          updateSubscription(subscription.id, { is_active: false, revoked_at: new Date().toISOString(), last_failure_at: new Date().toISOString(), failure_count: subscription.failure_count + 1 })
        ]);
      } else {
        transientFailures += Number(classified.transient);
        permanentFailures += Number(!classified.transient);
        await Promise.all([
          upsertDelivery({ outbox_id: outbox.id, subscription_id: subscription.id, status: "failed", attempted_at: new Date().toISOString(), completed_at: new Date().toISOString(), http_status: classified.statusCode, error_code: classified.code, error_message: classified.message }),
          updateSubscription(subscription.id, { last_failure_at: new Date().toISOString(), failure_count: subscription.failure_count + 1 })
        ]);
      }
    }
  }

  if (transientFailures && outbox.attempt_count < MAX_ATTEMPTS) {
    await setOutboxResult(outbox, sent ? "partial" : "pending", "Falha temporária no provedor push.", nextRetry(outbox.attempt_count));
    return { sent, expired, retry: true, skipped: 0 };
  }

  if (transientFailures || permanentFailures) {
    await setOutboxResult(outbox, sent ? "partial" : "failed", "Não foi possível entregar a todos os dispositivos.");
    return { sent, expired, retry: false, skipped: 0 };
  }

  await setOutboxResult(outbox, sent ? "sent" : "cancelled", null);
  return { sent, expired, retry: false, skipped: 0 };
}

export async function processPendingPushNotifications(limit = 25) {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc("claim_notification_outbox", { p_limit: limit });
  if (error) {
    throw error;
  }

  const outbox = (data || []) as PushOutboxRecord[];
  const stats = { claimed: outbox.length, sent: 0, expired: 0, retries: 0, failed: 0 };

  for (const item of outbox) {
    try {
      const result = await processOutboxItem(item);
      stats.sent += result.sent;
      stats.expired += result.expired;
      stats.retries += Number(result.retry);
    } catch (error) {
      stats.failed += 1;
      const message = error instanceof Error ? error.message.slice(0, 400) : "Falha desconhecida no worker push.";
      await setOutboxResult(item, item.attempt_count < MAX_ATTEMPTS ? "pending" : "failed", message, item.attempt_count < MAX_ATTEMPTS ? nextRetry(item.attempt_count) : null);
      console.error("[push-worker] outbox_failed", { outboxId: item.id, eventId: item.event_id, message });
    }
  }

  console.log("[push-worker] completed", stats);
  return stats;
}
