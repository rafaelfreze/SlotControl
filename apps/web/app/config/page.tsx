import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { PushNotificationsSettings } from "@/components/app/push-notifications-settings";
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences, type PushSubscriptionRecord } from "@/lib/push/types";
import { normalizeSlot, type SlotRow, type StrategyView } from "@/lib/slotgain/types";
import { ConfigClient } from "./config-client";

export const metadata: Metadata = { title: "Configuracoes" };

type AutomationMode = "off" | "exit_only" | "entry_exit";

function getAutomationMode(settings: Record<string, unknown> | null | undefined): AutomationMode {
  const mode = settings?.automationMode;
  if (mode === "exit_only" || mode === "entry_exit") {
    return mode;
  }

  return settings?.autoGainEnabled === true ? "exit_only" : "off";
}

export default async function ConfigPage({ searchParams }: { searchParams?: { notice?: string } }) {
  if (!isSupabaseConfigured()) {
    redirect("/login?setup=missing-env");
  }

  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [strategiesResponse, slotsResponse, settingsResponse, preferencesResponse, subscriptionsResponse] = await Promise.all([
    supabase
      .from("strategies")
      .select(
        "id,key,title,display_name,asset,base_value,gain_rate,drop_percent,restart_amount,sort_order"
      )
      .order("sort_order", { ascending: true }),
    supabase
      .from("slots")
      .select(
        "id,strategy_id,status,gains,gains_distribuidos,base_value,reinvested_profit,operational_slot_value,gain_rate,preco_entrada,preco_atual,preco_alvo,slot_number,sort_order,notes,updated_at,strategies(id,key,title,display_name,asset,base_value,gain_rate,drop_percent,restart_amount,sort_order)"
      )
      .order("sort_order", { ascending: true }),
    supabase.from("user_settings").select("settings").eq("user_id", user.id).maybeSingle<{ settings: Record<string, unknown> | null }>(),
    supabase.from("notification_preferences").select("global_enabled,btc_entry_enabled,btc_exit_enabled,sol_entry_enabled,sol_exit_enabled,manual_events_enabled,automatic_events_enabled,privacy_mode,quiet_hours_enabled,quiet_hours_start,quiet_hours_end").eq("user_id", user.id).maybeSingle(),
    supabase.from("push_subscriptions").select("id,endpoint,user_agent,device_name,platform,is_active,created_at,last_success_at,last_seen_at,revoked_at").eq("user_id", user.id).order("created_at", { ascending: false })
  ]);

  const setupError = strategiesResponse.error || slotsResponse.error || settingsResponse.error || preferencesResponse.error || subscriptionsResponse.error;

  return (
    <ConfigClient
      userEmail={user.email || "Usuario"}
      strategies={(strategiesResponse.data ?? []) as StrategyView[]}
      slots={((slotsResponse.data ?? []) as unknown as SlotRow[]).map(normalizeSlot)}
      setupError={setupError?.message || null}
      initialNotice={searchParams?.notice || null}
      initialAutomationMode={getAutomationMode(settingsResponse.data?.settings)}
      notifications={<PushNotificationsSettings initialPreferences={{ ...DEFAULT_NOTIFICATION_PREFERENCES, ...(preferencesResponse.data as Partial<NotificationPreferences> | null) }} subscriptions={(subscriptionsResponse.data || []) as PushSubscriptionRecord[]} vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || null} />}
    />
  );
}
