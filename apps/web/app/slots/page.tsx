import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { normalizeSlot, type SlotRow, type StrategyView } from "@/lib/slotgain/types";
import type { AssetMarketStrategySettings, BtcMarketState, MarketRegimeSettings } from "@/lib/slotgain/market-regime";
import { SlotsClient } from "./slots-client";

export const metadata: Metadata = { title: "Slots" };

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

  const [strategiesResponse, slotsResponse, marketStateResponse, regimeSettingsResponse, assetSettingsResponse] = await Promise.all([
    supabase
      .from("strategies")
      .select(
        "id,key,title,display_name,asset,base_value,gain_rate,drop_percent,restart_amount,sort_order"
      )
      .order("sort_order", { ascending: true }),
    supabase
      .from("slots")
      .select(
        "id,strategy_id,status,gains,real_gains,added_gains,base_value,realized_profit,growth_contribution,operational_slot_value,gain_rate,preco_entrada,preco_atual,preco_alvo,slot_number,sort_order,notes,updated_at,strategies(id,key,title,display_name,asset,base_value,gain_rate,drop_percent,restart_amount,sort_order)"
      )
      .order("sort_order", { ascending: true }),
    supabase.from("btc_market_state").select("ath_price,current_price,classification_price,distance_from_ath_percent,calculated_mode,effective_mode,source,price_updated_at,ath_updated_at,classified_at,mode_changed_at").eq("singleton", true).maybeSingle(),
    supabase.from("market_regime_settings").select("top_threshold_percent,deep_threshold_percent,hysteresis_percent,classification_timeframe,mode_source,manual_mode,last_effective_mode,manual_reason").eq("user_id", user.id).maybeSingle(),
    supabase.from("asset_market_strategy_settings").select("asset,buy_drop_top_percent,buy_drop_normal_percent,buy_drop_deep_percent,top_zero_reserve_count,normal_zero_reserve_count,deep_zero_reserve_count,deep_active_slot_limit").eq("user_id", user.id)
  ]);

  const setupError = strategiesResponse.error || slotsResponse.error || marketStateResponse.error || regimeSettingsResponse.error || assetSettingsResponse.error;

  return (
    <SlotsClient
      userEmail={user.email || "Usuario"}
      strategies={(strategiesResponse.data ?? []) as StrategyView[]}
      slots={((slotsResponse.data ?? []) as unknown as SlotRow[]).map(normalizeSlot)}
      setupError={setupError?.message || null}
      initialNotice={searchParams?.notice || null}
      initialAsset={searchParams?.asset || null}
      initialFlow={searchParams?.flow || null}
      marketState={marketStateResponse.data as Partial<BtcMarketState> | null}
      regimeSettings={regimeSettingsResponse.data as Partial<MarketRegimeSettings> | null}
      assetSettings={(assetSettingsResponse.data || []) as Partial<AssetMarketStrategySettings>[]}
    />
  );
}
