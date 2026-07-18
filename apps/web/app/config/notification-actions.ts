"use server";

import { revalidatePath } from "next/cache";

import { processPendingPushNotifications } from "@/lib/push/server";
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from "@/lib/push/types";
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
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase não está configurado.");
  }

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Sessão expirada. Entre novamente para configurar notificações.");
  }

  return { supabase, user };
}

function stringValue(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export async function savePushSubscription(input: SubscriptionInput) {
  const { supabase, user } = await getAuthenticatedClient();
  const endpoint = stringValue(input.endpoint, 2_000);
  const p256dh = stringValue(input.p256dh, 1_000);
  const auth = stringValue(input.auth, 1_000);
  const platform = input.platform === "ios" || input.platform === "android" || input.platform === "desktop" ? input.platform : "unknown";

  if (!endpoint.startsWith("https://") || !p256dh || !auth) {
    throw new Error("A inscrição de notificações retornou dados inválidos.");
  }

  const { error: subscriptionError } = await supabase.from("push_subscriptions").upsert({
    user_id: user.id,
    endpoint,
    p256dh,
    auth,
    user_agent: stringValue(input.userAgent, 1_000) || null,
    device_name: stringValue(input.deviceName, 120) || null,
    platform,
    is_active: true,
    failure_count: 0,
    last_failure_at: null
  }, { onConflict: "endpoint" });

  if (subscriptionError) {
    throw new Error("Não foi possível salvar este celular para notificações.");
  }

  const { error: preferencesError } = await supabase.from("notification_preferences").upsert({
    user_id: user.id,
    global_enabled: true
  }, { onConflict: "user_id", ignoreDuplicates: false });

  if (preferencesError) {
    throw new Error("A inscrição foi salva, mas as preferências não puderam ser ativadas.");
  }

  revalidatePath("/config");
  return { ok: true };
}

export async function removePushSubscription(subscriptionId: string) {
  const { supabase, user } = await getAuthenticatedClient();
  const id = stringValue(subscriptionId, 80);
  if (!id) {
    throw new Error("Dispositivo inválido.");
  }

  const { error } = await supabase.from("push_subscriptions").delete().eq("id", id).eq("user_id", user.id);
  if (error) {
    throw new Error("Não foi possível remover este dispositivo.");
  }

  revalidatePath("/config");
  return { ok: true };
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
  if (error) {
    throw new Error("Não foi possível salvar as preferências de notificações.");
  }

  revalidatePath("/config");
  return { ok: true };
}

export async function sendPushTestNotification() {
  const { user } = await getAuthenticatedClient();
  const serviceSupabase = createServiceRoleClient();
  const eventId = `test:${crypto.randomUUID()}`;
  const { error } = await serviceSupabase.from("notification_outbox").insert({
    event_id: eventId,
    user_id: user.id,
    event_type: "test",
    origin: "test",
    payload: {
      eventId,
      title: "Teste de notificações do Slot Control",
      body: "As notificações deste celular estão configuradas. Toque para abrir o painel.",
      url: "/config"
    }
  });
  if (error) {
    throw new Error("Não foi possível criar a notificação de teste.");
  }

  try {
    const stats = await processPendingPushNotifications(10);
    return { ok: true, stats };
  } catch {
    return { ok: true, queued: true };
  }
}
