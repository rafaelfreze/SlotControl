import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import type { CapitalContributionView } from "@/lib/slotgain/capital-contributions";
import { normalizeSlot, type SlotRow, type StrategyView } from "@/lib/slotgain/types";
import { DashboardClient } from "./dashboard-client";

type DashboardAssetLadderPlan = {
  monthly_goal?: number;
  started_at?: string;
  elapsed_days?: number;
  month_reference?: string;
  real_gains_month?: number | string;
  real_gains_month_source?: string;
};

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage({ searchParams }: { searchParams?: { notice?: string } }) {
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

  const [strategiesResponse, slotsResponse, contributionsResponse, marketStateResponse, regimeSettingsResponse, btcLadderResponse, solLadderResponse] = await Promise.all([
    supabase
      .from("strategies")
      .select(
        "id,key,title,display_name,asset,base_value,gain_rate,drop_percent,restart_amount,sort_order"
      )
      .order("sort_order", { ascending: true }),
    supabase
      .from("slots")
      .select(
        "id,strategy_id,status,gains,real_gains,added_gains,operational_gains,redistribution_received_usdt,redistribution_sent_usdt,base_value,realized_profit,growth_contribution,operational_slot_value,position_notional_usdt,position_gain_unit_usdt,accounting_version,gain_rate,preco_entrada,preco_atual,preco_alvo,slot_number,sort_order,notes,updated_at,strategies(id,key,title,display_name,asset,base_value,gain_rate,drop_percent,restart_amount,sort_order)"
      )
      .order("sort_order", { ascending: true }),
    supabase
      .from("btc_external_contributions")
      .select("asset,slot_id,amount_usdt,accounting_amount_usdt,gain_equivalent,input_mode"),
    supabase.from("btc_market_state").select("*").eq("singleton", true).maybeSingle(),
    supabase.from("market_regime_settings").select("*").eq("user_id", user.id).maybeSingle(),
    supabase.rpc("get_asset_ladder_plan", { p_asset: "BTC" }),
    supabase.rpc("get_asset_ladder_plan", { p_asset: "SOL" })
  ]);

  const setupError = strategiesResponse.error || slotsResponse.error || contributionsResponse.error || marketStateResponse.error || regimeSettingsResponse.error || btcLadderResponse.error || solLadderResponse.error;
  const btcPlan = (btcLadderResponse.data || null) as DashboardAssetLadderPlan | null;

  return (
    <DashboardClient
      userEmail={user.email || "Usuario"}
      operationStartedAt={btcPlan?.started_at || user.created_at || null}
      operationElapsedDays={btcPlan?.elapsed_days ?? null}
      strategies={(strategiesResponse.data ?? []) as StrategyView[]}
      slots={((slotsResponse.data ?? []) as unknown as SlotRow[]).map(normalizeSlot)}
      contributions={(contributionsResponse.data ?? []) as CapitalContributionView[]}
      setupError={setupError?.message || null}
      initialNotice={searchParams?.notice || null}
      marketState={marketStateResponse.data}
      regimeSettings={regimeSettingsResponse.data}
      btcLadderPlan={btcPlan}
      solLadderPlan={(solLadderResponse.data || null) as DashboardAssetLadderPlan | null}
    />
  );
}
