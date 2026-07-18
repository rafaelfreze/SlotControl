import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { normalizeSlot, type SlotRow, type StrategyView } from "@/lib/slotgain/types";
import type { AssetMarketStrategySettings, BtcMarketState, MarketRegimeSettings } from "@/lib/slotgain/market-regime";
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

  const [strategiesResponse, slotsResponse, settingsResponse, redistributionsResponse, marketStateResponse, regimeSettingsResponse, assetSettingsResponse] = await Promise.all([
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
    supabase
      .from("slot_gain_redistributions")
      .select("id,asset,action_type,target_slot_count,total_gains_before,total_gains_after,total_reinvested_before,total_reinvested_after,base_reinvested,remainder_reinvested_units,algorithm_version,status,snapshot_before,snapshot_after,created_at")
      .order("created_at", { ascending: false })
      .limit(30),
    supabase.from("btc_market_state").select("ath_price,current_price,classification_price,distance_from_ath_percent,calculated_mode,effective_mode,source,price_updated_at,ath_updated_at,classified_at,mode_changed_at").eq("singleton", true).maybeSingle(),
    supabase.from("market_regime_settings").select("top_threshold_percent,deep_threshold_percent,hysteresis_percent,classification_timeframe,mode_source,manual_mode,last_effective_mode,manual_reason").eq("user_id", user.id).maybeSingle(),
    supabase.from("asset_market_strategy_settings").select("asset,buy_drop_top_percent,buy_drop_normal_percent,buy_drop_deep_percent,top_zero_reserve_count,normal_zero_reserve_count,deep_zero_reserve_count,deep_active_slot_limit").eq("user_id", user.id)
  ]);

  const setupError = strategiesResponse.error || slotsResponse.error || settingsResponse.error || redistributionsResponse.error || marketStateResponse.error || regimeSettingsResponse.error || assetSettingsResponse.error;

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
      marketState={marketStateResponse.data as Partial<BtcMarketState> | null}
      regimeSettings={regimeSettingsResponse.data as Partial<MarketRegimeSettings> | null}
      assetSettings={(assetSettingsResponse.data || []) as Partial<AssetMarketStrategySettings>[]}
    />
  );
}
