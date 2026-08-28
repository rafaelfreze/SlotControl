import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { loadOfficialMonitoring } from "@/lib/coinops-monitoring/server";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import type { HistoryEvent } from "@/lib/slotgain/types";
import { HistoricoClient } from "./historico-client";

export const metadata: Metadata = { title: "Historico" };

export default async function HistoricoPage() {
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

  const [historyResponse, contributionsResponse, slotsResponse, monitoring] = await Promise.all([
    supabase
      .from("history_events")
      .select("id,user_id,action,detail,event_at,created_at,strategy_id,slot_id,strategy_key,slot_number,strategies(asset,key)")
      .order("event_at", { ascending: false })
      .limit(1000),
    supabase
      .from("btc_external_contributions")
      .select("id,asset,slot_id,amount_usdt,gain_equivalent,reason,created_at")
      .order("created_at", { ascending: false })
      .limit(500),
    supabase.from("slots").select("id,slot_number"),
    loadOfficialMonitoring()
  ]);

  const history = ((historyResponse.data ?? []) as Array<HistoryEvent & { strategies?: HistoryEvent["strategy"] | HistoryEvent["strategy"][] }>).map(
    (item) => ({
      ...item,
      strategy: Array.isArray(item.strategies) ? item.strategies[0] || null : item.strategies || null
    })
  );
  const slotNumberById = new Map((slotsResponse.data ?? []).map((slot) => [slot.id, slot.slot_number]));
  const contributionEvents: HistoryEvent[] = (contributionsResponse.data ?? []).map((contribution) => ({
    id: `aporte-${contribution.id}`,
    action: "Aporte externo",
    detail: JSON.stringify({
      asset: contribution.asset,
      eventType: "aporte_externo",
      origin: "PLANO",
      message: contribution.reason,
      slotValue: Number(contribution.amount_usdt),
      gains: Number(contribution.gain_equivalent)
    }),
    event_at: contribution.created_at,
    created_at: contribution.created_at,
    strategy_id: null,
    slot_id: contribution.slot_id,
    strategy_key: String(contribution.asset || "").toLowerCase(),
    slot_number: slotNumberById.get(contribution.slot_id) ?? null,
    strategy: { asset: contribution.asset, key: String(contribution.asset || "").toLowerCase() }
  }));
  const mergedHistory = [...history, ...contributionEvents].sort((first, second) => new Date(second.event_at).getTime() - new Date(first.event_at).getTime());
  const error = historyResponse.error || contributionsResponse.error || slotsResponse.error;

  return <HistoricoClient userEmail={user.email || "Usuario"} history={mergedHistory} error={error?.message || null} referenceNow={new Date().toISOString()} baselineStartedAt={monitoring.overview.baseline?.started_at || null} monitoring={monitoring.overview} />;
}
