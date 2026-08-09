import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { normalizeSlot, type SlotRow, type StrategyView } from "@/lib/slotgain/types";
import { DashboardClient } from "./dashboard-client";

type DashboardGrowthPlan = {
  plans?: {
    BTC?: { monthly_goal?: number; cumulative_goal?: number; missing_gains?: number | null; leader_slot_id?: string | null; leader_slot_number?: number | null };
    SOL?: { monthly_goal?: number; cumulative_goal?: number; missing_gains?: number | null; leader_slot_id?: string | null; leader_slot_number?: number | null };
  };
};

type DashboardBtcLadderPlan = {
  monthly_goal?: number;
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

  const [strategiesResponse, slotsResponse, marketStateResponse, regimeSettingsResponse, growthPlanResponse, btcLadderResponse] = await Promise.all([
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
    supabase.from("btc_market_state").select("*").eq("singleton", true).maybeSingle(),
    supabase.from("market_regime_settings").select("*").eq("user_id", user.id).maybeSingle(),
    supabase.rpc("get_programmed_growth_plan"),
    supabase.rpc("get_btc_ladder_plan")
  ]);

  const setupError = strategiesResponse.error || slotsResponse.error || marketStateResponse.error || regimeSettingsResponse.error || btcLadderResponse.error;

  return (
    <DashboardClient
      userEmail={user.email || "Usuario"}
      accountCreatedAt={user.created_at || null}
      strategies={(strategiesResponse.data ?? []) as StrategyView[]}
      slots={((slotsResponse.data ?? []) as unknown as SlotRow[]).map(normalizeSlot)}
      setupError={setupError?.message || null}
      initialNotice={searchParams?.notice || null}
      marketState={marketStateResponse.data}
      regimeSettings={regimeSettingsResponse.data}
      growthPlan={(growthPlanResponse.data || null) as DashboardGrowthPlan | null}
      btcLadderPlan={(btcLadderResponse.data || null) as DashboardBtcLadderPlan | null}
    />
  );
}
