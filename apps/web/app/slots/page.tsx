import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { normalizeSlot, type SlotRow, type StrategyView } from "@/lib/slotgain/types";
import { type GainRedistributionHistoryItem } from "@/components/slotgain/gain-redistribution-panel";
import { SlotsClient } from "./slots-client";

export const metadata: Metadata = { title: "Slots" };

type AutomationMode = "off" | "exit_only" | "entry_exit";

function getAutomationMode(settings: Record<string, unknown> | null | undefined): AutomationMode {
  const mode = settings?.automationMode;
  if (mode === "exit_only" || mode === "entry_exit") {
    return mode;
  }

  return settings?.autoGainEnabled === true ? "exit_only" : "off";
}

export default async function SlotsPage({
  searchParams
}: {
  searchParams?: { notice?: string; asset?: string; flow?: string };
}) {
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

  const [strategiesResponse, slotsResponse, settingsResponse, redistributionsResponse] = await Promise.all([
    supabase
      .from("strategies")
      .select(
        "id,key,title,display_name,asset,base_value,gain_rate,drop_percent,restart_amount,sort_order"
      )
      .order("sort_order", { ascending: true }),
    supabase
      .from("slots")
      .select(
        "id,strategy_id,status,gains,gains_distribuidos,base_value,gain_rate,preco_entrada,preco_atual,preco_alvo,slot_number,sort_order,notes,updated_at,strategies(id,key,title,display_name,asset,base_value,gain_rate,drop_percent,restart_amount,sort_order)"
      )
      .order("sort_order", { ascending: true }),
    supabase.from("user_settings").select("settings").eq("user_id", user.id).maybeSingle<{ settings: Record<string, unknown> | null }>(),
    supabase
      .from("slot_gain_redistributions")
      .select("id,asset,action_type,target_slot_count,total_gains_before,total_gains_after,status,snapshot_before,snapshot_after,created_at")
      .order("created_at", { ascending: false })
      .limit(30)
  ]);

  const setupError = strategiesResponse.error || slotsResponse.error || settingsResponse.error || redistributionsResponse.error;

  return (
    <SlotsClient
      userEmail={user.email || "Usuario"}
      strategies={(strategiesResponse.data ?? []) as StrategyView[]}
      slots={((slotsResponse.data ?? []) as unknown as SlotRow[]).map(normalizeSlot)}
      redistributionHistory={(redistributionsResponse.data ?? []) as GainRedistributionHistoryItem[]}
      setupError={setupError?.message || null}
      initialNotice={searchParams?.notice || null}
      initialAsset={searchParams?.asset || null}
      initialFlow={searchParams?.flow || null}
      initialAutomationMode={getAutomationMode(settingsResponse.data?.settings)}
    />
  );
}
