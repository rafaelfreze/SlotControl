import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { normalizeSlot, type SlotRow, type StrategyView } from "@/lib/slotgain/types";
import { ConfigClient } from "./config-client";

export const metadata: Metadata = { title: "Configuracoes" };

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
    supabase.from("btc_market_state").select("*").eq("singleton", true).maybeSingle(),
    supabase.from("market_regime_settings").select("*").eq("user_id", user.id).maybeSingle(),
    supabase.from("asset_market_strategy_settings").select("*").eq("user_id", user.id)
  ]);

  const setupError = strategiesResponse.error || slotsResponse.error || marketStateResponse.error || regimeSettingsResponse.error || assetSettingsResponse.error;

  return (
    <ConfigClient
      userEmail={user.email || "Usuario"}
      strategies={(strategiesResponse.data ?? []) as StrategyView[]}
      slots={((slotsResponse.data ?? []) as unknown as SlotRow[]).map(normalizeSlot)}
      setupError={setupError?.message || null}
      initialNotice={searchParams?.notice || null}
      marketState={marketStateResponse.data}
      regimeSettings={regimeSettingsResponse.data}
      assetSettings={assetSettingsResponse.data || []}
    />
  );
}
