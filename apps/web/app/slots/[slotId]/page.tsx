import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import type { CapitalContributionView } from "@/lib/slotgain/capital-contributions";
import { normalizeSlot, type HistoryEvent, type SlotRow } from "@/lib/slotgain/types";
import { SlotDetailClient } from "./slot-detail-client";

export const metadata: Metadata = { title: "Detalhe do slot" };

export default async function SlotDetailPage({ params }: { params: { slotId: string } }) {
  if (!isSupabaseConfigured()) redirect("/login?setup=missing-env");

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [slotResponse, contributionResponse, historyResponse] = await Promise.all([
    supabase
      .from("slots")
      .select("id,strategy_id,status,gains,real_gains,added_gains,operational_gains,redistribution_received_usdt,redistribution_sent_usdt,base_value,realized_profit,growth_contribution,operational_slot_value,position_notional_usdt,position_gain_unit_usdt,accounting_version,gain_rate,preco_entrada,preco_atual,preco_alvo,slot_number,sort_order,notes,updated_at,strategies(id,key,title,display_name,asset,base_value,gain_rate,drop_percent,restart_amount,sort_order)")
      .eq("id", params.slotId)
      .maybeSingle(),
    supabase
      .from("btc_external_contributions")
      .select("asset,slot_id,amount_usdt,accounting_amount_usdt,gain_equivalent,input_mode")
      .eq("slot_id", params.slotId),
    supabase
      .from("history_events")
      .select("id,user_id,action,detail,event_at,created_at,strategy_id,slot_id,strategy_key,slot_number,strategies(asset,key)")
      .eq("slot_id", params.slotId)
      .order("event_at", { ascending: false })
      .limit(8)
  ]);

  if (!slotResponse.data) notFound();
  const history = ((historyResponse.data ?? []) as Array<HistoryEvent & { strategies?: HistoryEvent["strategy"] | HistoryEvent["strategy"][] }>).map((item) => ({
    ...item,
    strategy: Array.isArray(item.strategies) ? item.strategies[0] || null : item.strategies || null
  }));

  return (
    <SlotDetailClient
      slot={normalizeSlot(slotResponse.data as unknown as SlotRow)}
      contributions={(contributionResponse.data ?? []) as CapitalContributionView[]}
      history={history}
      setupError={contributionResponse.error?.message || historyResponse.error?.message || null}
      userLabel={user.email || "Conta CoinOps"}
    />
  );
}
