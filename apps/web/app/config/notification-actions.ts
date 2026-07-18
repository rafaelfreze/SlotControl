"use server";

import { revalidatePath } from "next/cache";

import { getPushSubscriptionDiagnostics, processPushOutboxById } from "@/lib/push/server";
import { emptyPushTestResult, normalizeUrlSafeBase64 } from "@/lib/push/test-result";
import { type NotificationPreferences } from "@/lib/push/types";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

type SubscriptionInput = {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
  deviceName?: string;
  platform?: "ios" | "android" | "desktop" | "unknown";
};

async function getAuthenticatedClient() {
  if (!isSupabaseConfigured()) throw new Error("Supabase não está configurado.");
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Sessão expirada. Entre novamente para configurar notificações.");
  return { supabase, user };
}

function stringValue(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

async function getActiveSubscriptionCount(userId: string) {
  return (await getPushSubscriptionDiagnostics(userId)).activeCount;
}

export async function savePushSubscription(input: SubscriptionInput) {
  const { supabase, user } = await getAuthenticatedClient();
  const endpoint = stringValue(input.endpoint, 2_000);
  const p256dh = normalizeUrlSafeBase64(stringValue(input.p256dh, 1_000));
  const auth = normalizeUrlSafeBase64(stringValue(input.auth, 1_000));
  const platform = input.platform === "ios" || input.platform === "android" || input.platform === "desktop" ? input.platform : "unknown";
  if (!endpoint.startsWith("https://") || !p256dh || !auth) throw new Error("A inscrição de notificações retornou dados inválidos.");

  const now = new Date().toISOString();
  const { data: subscription, error: subscriptionError } = await supabase.from("push_subscriptions").upsert({
    user_id: user.id,
    endpoint,
    p256dh,
    auth,
    user_agent: stringValue(input.userAgent, 1_000) || null,
    device_name: stringValue(input.deviceName, 120) || null,
    platform,
    is_active: true,
    failure_count: 0,
    last_failure_at: null,
    last_seen_at: now,
    revoked_at: null
  }, { onConflict: "endpoint" }).select("id,is_active").single();

  if (subscriptionError) {
    console.warn("[push-subscription] save_failed", { code: subscriptionError.code || "unknown", platform });
    if (subscriptionError.code === "42501") throw new Error("Sua sessão não tem permissão para salvar este dispositivo. Entre novamente e tente de novo.");
    if (subscriptionError.code === "23505") throw new Error("Este dispositivo já está vinculado a outra conta. Desative-o na outra conta antes de continuar.");
    throw new Error("Não foi possível salvar este celular para notificações.");
  }

  const { error: preferencesError } = await supabase.from("notification_preferences").upsert({ user_id: user.id, global_enabled: true }, { onConflict: "user_id", ignoreDuplicates: false });
  if (preferencesError) throw new Error("A inscrição foi salva, mas as preferências não puderam ser ativadas.");

  const activeCount = await getActiveSubscriptionCount(user.id);
  console.info("[push-subscription] saved", { platform, activeCount, wasActive: subscription.is_active });
  revalidatePath("/config");
  return { ok: true, subscriptionId: subscription.id, activeCount };
}

export async function deactivatePushSubscription(subscriptionId: string) {
  const { supabase, user } = await getAuthenticatedClient();
  const id = stringValue(subscriptionId, 80);
  if (!id) throw new Error("Dispositivo inválido.");
  const now = new Date().toISOString();
  const { error } = await supabase.from("push_subscriptions").update({ is_active: false, revoked_at: now, last_seen_at: now }).eq("id", id).eq("user_id", user.id);
  if (error) throw new Error("Não foi possível desativar este dispositivo.");
  const activeCount = await getActiveSubscriptionCount(user.id);
  console.info("[push-subscription] deactivated", { activeCount });
  revalidatePath("/config");
  return { ok: true, activeCount };
}

export async function deactivateCurrentPushSubscription(endpointInput: string) {
  const { supabase, user } = await getAuthenticatedClient();
  const endpoint = stringValue(endpointInput, 2_000);
  if (!endpoint.startsWith("https://")) throw new Error("A inscrição local deste dispositivo é inválida.");
  const now = new Date().toISOString();
  const { error } = await supabase.from("push_subscriptions").update({ is_active: false, revoked_at: now, last_seen_at: now }).eq("user_id", user.id).eq("endpoint", endpoint);
  if (error) throw new Error("Não foi possível confirmar a desativação deste celular no servidor.");
  const activeCount = await getActiveSubscriptionCount(user.id);
  console.info("[push-subscription] current_device_deactivated", { activeCount });
  revalidatePath("/config");
  return { ok: true, activeCount };
}

export async function saveNotificationPreferences(input: NotificationPreferences) {
  const { supabase, user } = await getAuthenticatedClient();
  const values: NotificationPreferences = {
    global_enabled: Boolean(input.global_enabled),
    btc_entry_enabled: Boolean(input.btc_entry_enabled),
    btc_exit_enabled: Boolean(input.btc_exit_enabled),
    sol_entry_enabled: Boolean(input.sol_entry_enabled),
    sol_exit_enabled: Boolean(input.sol_exit_enabled),
    manual_events_enabled: Boolean(input.manual_events_enabled),
    automatic_events_enabled: Boolean(input.automatic_events_enabled),
    privacy_mode: Boolean(input.privacy_mode),
    quiet_hours_enabled: false,
    quiet_hours_start: null,
    quiet_hours_end: null
  };
  const { error } = await supabase.from("notification_preferences").upsert({ user_id: user.id, ...values }, { onConflict: "user_id" });
  if (error) throw new Error("Não foi possível salvar as preferências de notificações.");
  revalidatePath("/config");
  return { ok: true };
}

export async function getPushNotificationDiagnostics(currentEndpointInput?: string | null) {
  const { user } = await getAuthenticatedClient();
  const currentEndpoint = stringValue(currentEndpointInput, 2_000);
  return getPushSubscriptionDiagnostics(user.id, currentEndpoint || null);
}

export async function sendPushTestNotification(currentEndpointInput?: string | null) {
  const { user } = await getAuthenticatedClient();
  const serviceSupabase = createServiceRoleClient();
  const currentEndpoint = stringValue(currentEndpointInput, 2_000);
  const [subscriptionDiagnostics, recentTestResponse] = await Promise.all([
    getPushSubscriptionDiagnostics(user.id, currentEndpoint || null),
    serviceSupabase.from("notification_outbox").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("origin", "test").gte("created_at", new Date(Date.now() - 30_000).toISOString())
  ]);
  if (!subscriptionDiagnostics.activeCount) return emptyPushTestResult({ currentDeviceMatched: subscriptionDiagnostics.currentDeviceMatched });
  if (recentTestResponse.error) throw new Error("Não foi possível validar o limite do teste de notificações.");
  if (recentTestResponse.count) {
    return emptyPushTestResult({
      rateLimited: true,
      subscriptionsFound: subscriptionDiagnostics.activeCount,
      currentDeviceMatched: subscriptionDiagnostics.currentDeviceMatched
    });
  }

  const eventId = `test:${crypto.randomUUID()}`;
  const { data: outbox, error } = await serviceSupabase.from("notification_outbox").insert({
    event_id: eventId,
    user_id: user.id,
    event_type: "test",
    origin: "test",
    payload: {
      eventId,
      title: "CoinOps",
      body: "Notificação de teste enviada com sucesso.",
      url: "/config"
    }
  }).select("id").single();
  if (error) throw new Error("Não foi possível criar a notificação de teste.");

  const result = await processPushOutboxById(outbox.id);
  const after = await getPushSubscriptionDiagnostics(user.id, currentEndpoint || null);
  const response = { ...result, currentDeviceMatched: after.currentDeviceMatched };
  console.info("[push-test] completed", {
    event: "push_test",
    userId: user.id,
    subscriptionsFound: response.subscriptionsFound,
    attempted: response.attempted,
    accepted: response.deliveredToProvider,
    failed: response.failed,
    expired: response.removedExpired,
    statusCodes: response.results.map((item) => item.statusCode).filter((value): value is number => value !== null)
  });
  revalidatePath("/config");
  return response;
}
