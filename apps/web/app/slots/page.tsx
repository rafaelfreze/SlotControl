import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { loadOfficialMonitoring } from "@/lib/coinops-monitoring/server";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import type { CapitalContributionView } from "@/lib/slotgain/capital-contributions";
import { normalizeSlot, type SlotRow, type StrategyView } from "@/lib/slotgain/types";
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

  const [strategiesResponse, slotsResponse, contributionsResponse, monitoring] = await Promise.all([
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
    loadOfficialMonitoring()
  ]);

  const setupError = strategiesResponse.error || slotsResponse.error || contributionsResponse.error;

  return (
    <SlotsClient
      userLabel={user.email || "Usuario"}
      strategies={(strategiesResponse.data ?? []) as StrategyView[]}
      slots={((slotsResponse.data ?? []) as unknown as SlotRow[]).map(normalizeSlot)}
      contributions={(contributionsResponse.data ?? []) as CapitalContributionView[]}
      setupError={setupError?.message || null}
      initialNotice={searchParams?.notice || null}
      initialAsset={searchParams?.asset || null}
      initialFlow={searchParams?.flow || null}
      monitoring={monitoring.overview}
    />
  );
}
