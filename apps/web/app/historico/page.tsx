import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { loadOfficialMonitoring } from "@/lib/coinops-monitoring/server";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import type { HistoryEvent } from "@/lib/slotgain/types";
import { loadCapitalReportingEntries, type CapitalReportingEntry } from "@/lib/slotgain/capital-reporting-server";
import { HistoricoClient } from "./historico-client";

export const metadata: Metadata = { title: "Historico" };

type ExternalContributionBatchRow = {
  id: string;
  asset: string;
  amount_per_slot_usdt: number | string;
  applied_slot_count: number;
  open_slot_count: number;
  total_amount_usdt: number | string;
  reason: string;
  created_at: string;
};

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

  const [historyResponse, contributionsResponse, contributionBatchesResponse, slotsResponse, monitoring] = await Promise.all([
    supabase
      .from("history_events")
      .select("id,user_id,action,detail,event_at,created_at,strategy_id,slot_id,strategy_key,slot_number,strategies(asset,key)")
      .order("event_at", { ascending: false })
      .limit(1000),
    loadCapitalReportingEntries(supabase, { includeIncorporated: true }),
    supabase
      .from("asset_external_contribution_batches")
      .select("id,asset,amount_per_slot_usdt,applied_slot_count,open_slot_count,total_amount_usdt,reason,created_at")
      .eq("status", "COMPLETED")
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
  const individualContributions = contributionsResponse.data.filter(
    (contribution) => contribution.bulk_batch_id === null
  );
  const contributionEvents: HistoryEvent[] = individualContributions.map((contribution) => ({
    id: `aporte-${contribution.id}`,
    action: contribution.source === "SLOT_INITIAL_CAPITAL" ? "Aporte inicial do slot" : "Aporte externo",
    detail: JSON.stringify({
      asset: contribution.asset,
      eventType: "aporte_externo",
      origin: "PLANO",
      message: `${contribution.reason}${contribution.incorporated_in_opening ? " · Incorporado ao marco inicial operacional; fora dos novos contadores." : ""}`,
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
  const contributionsByBatch = new Map<string, CapitalReportingEntry[]>();
  contributionsResponse.data.forEach((contribution) => {
    if (!contribution.bulk_batch_id) return;
    const group = contributionsByBatch.get(contribution.bulk_batch_id) || [];
    group.push(contribution);
    contributionsByBatch.set(contribution.bulk_batch_id, group);
  });
  const contributionBatchEvents: HistoryEvent[] = ((contributionBatchesResponse.data ?? []) as ExternalContributionBatchRow[]).map((batch) => {
    const slotCount = Number(batch.applied_slot_count);
    const openSlotCount = Number(batch.open_slot_count);
    const amountPerSlot = Number(batch.amount_per_slot_usdt);
    const totalAmount = Number(batch.total_amount_usdt);
    const nonOpenSlotCount = Math.max(slotCount - openSlotCount, 0);
    const batchItems = contributionsByBatch.get(batch.id) || [];
    const incorporated = batchItems.length === slotCount && batchItems.every((item) => item.incorporated_in_opening);

    return {
      id: `aporte-lote-${batch.id}`,
      action: "Aporte em lote",
      detail: JSON.stringify({
        asset: batch.asset,
        eventType: "aporte_externo_lote",
        origin: "PLANO",
        message: `${slotCount} slots receberam ${amountPerSlot} USDT cada; ${openSlotCount} abertos e ${nonOpenSlotCount} demais slots foram incluídos.${incorporated ? " Incorporado ao marco inicial operacional; fora dos novos contadores." : ""}`,
        note: batch.reason,
        slotValue: totalAmount,
        batchId: batch.id,
        amountPerSlot,
        slotCount,
        openSlotCount,
        totalAmount
      }),
      event_at: batch.created_at,
      created_at: batch.created_at,
      strategy_id: null,
      slot_id: null,
      strategy_key: String(batch.asset || "").toLowerCase(),
      slot_number: null,
      strategy: { asset: batch.asset, key: String(batch.asset || "").toLowerCase() }
    };
  });
  const mergedHistory = [...history, ...contributionEvents, ...contributionBatchEvents].sort(
    (first, second) => new Date(second.event_at).getTime() - new Date(first.event_at).getTime()
  );
  const error = historyResponse.error || contributionsResponse.error || contributionBatchesResponse.error || slotsResponse.error;

  return <HistoricoClient userEmail={user.email || "Usuario"} history={mergedHistory} error={error?.message || null} referenceNow={new Date().toISOString()} baselineStartedAt={monitoring.overview.baseline?.started_at || null} monitoring={monitoring.overview} />;
}
