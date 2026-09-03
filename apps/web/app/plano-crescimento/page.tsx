import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { loadOfficialMonitoring } from "@/lib/coinops-monitoring/server";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import type { AssetExternalContributionHistory, AssetLadderPlanResponse, AssetPlanActionKeys } from "./btc-ladder-section";
import { GrowthPlanClient, type GrowthContributionHistoryItem, type ProgrammedGrowthPlanResponse } from "./growth-plan-client";

export const metadata: Metadata = { title: "Plano de Crescimento" };

export default async function GrowthPlanPage({ searchParams }: { searchParams?: { notice?: string; tone?: string; asset?: string; view?: string } }) {
  if (!isSupabaseConfigured()) redirect("/login?setup=missing-env");

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [historyResponse, btcLadderResponse, solLadderResponse, contributionAccountingResponse, contributionBatchResponse, manualGainBatchResponse, poolResponse, monitoring] = await Promise.all([
    supabase
      .from("programmed_growth_contributions")
      .select("id,asset,month_number,cumulative_goal,slot_number,gains_before,gains_after,value_before,value_after,contributed_amount,note,created_at")
      .order("created_at", { ascending: false })
      .limit(30),
    supabase.rpc("get_asset_ladder_plan", { p_asset: "BTC" }),
    supabase.rpc("get_asset_ladder_plan", { p_asset: "SOL" }),
    supabase
      .from("btc_external_contributions")
      .select("id,asset,slot_id,slot_number,amount_usdt,accounting_amount_usdt,gain_equivalent,input_mode,operational_before,operational_after,reason,applied_by,created_at,bulk_batch_id,bulk_sequence,bulk_slot_count")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("asset_external_contribution_batches")
      .select("id,asset,amount_per_slot_usdt,applied_slot_count,open_slot_count,total_amount_usdt")
      .eq("status", "COMPLETED")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("asset_manual_operational_gain_batches")
      .select("id,asset,status,below_operational_gains,operational_gains_per_slot,expected_slot_count,open_slot_count,total_amount_usdt,operational_total_before,operational_total_after,items,expires_at,reason,created_at")
      .eq("status", "PREPARED")
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("slot_pool_configuration")
      .select("baseline_id,asset,slot_id,slot_number")
      .eq("pool", "MAIN")
      .eq("enabled", true)
      .eq("funded", true)
      .gte("slot_number", 1)
      .lte("slot_number", 25)
      .order("slot_number", { ascending: true }),
    loadOfficialMonitoring({ includeDetailedPreview: true })
  ]);

  const actionKeys = (): AssetPlanActionKeys => ({
    prepare: randomUUID(),
    confirm: randomUUID(),
    contribution: randomUUID(),
    balanceContribution: randomUUID(),
    prepareManualGains: randomUUID(),
    confirmManualGains: randomUUID()
  });
  const contributionRows = (contributionAccountingResponse.data || []) as AssetExternalContributionHistory[];
  const contributionBatchRows = (contributionBatchResponse.data || []) as Array<{
    id: string;
    asset: "BTC" | "SOL";
    amount_per_slot_usdt: number | string;
    applied_slot_count: number;
    open_slot_count: number;
    total_amount_usdt: number | string;
  }>;
  const batchById = new Map(contributionBatchRows.map((batch) => [batch.id, batch]));
  const manualGainBatchRows = (manualGainBatchResponse.data || []) as Array<{
    id: string;
    asset: "BTC" | "SOL";
    status: string;
    below_operational_gains: number | string;
    operational_gains_per_slot: number | string;
    expected_slot_count: number;
    open_slot_count: number;
    total_amount_usdt: number | string;
    operational_total_before: number | string;
    operational_total_after: number | string;
    items: unknown;
    expires_at: string;
    reason: string;
    created_at: string;
  }>;
  const manualGainBatchByAsset = new Map<"BTC" | "SOL", NonNullable<AssetLadderPlanResponse["manual_gain_batch_preview"]>>();
  manualGainBatchRows.forEach((batch) => {
    if (manualGainBatchByAsset.has(batch.asset)) return;
    manualGainBatchByAsset.set(batch.asset, {
      batch_id: batch.id,
      status: batch.status,
      below_operational_gains: batch.below_operational_gains,
      operational_gains_per_slot: batch.operational_gains_per_slot,
      slot_count: batch.expected_slot_count,
      open_slot_count: batch.open_slot_count,
      total_amount_usdt: batch.total_amount_usdt,
      operational_total_before: batch.operational_total_before,
      operational_total_after: batch.operational_total_after,
      items: Array.isArray(batch.items) ? batch.items : [],
      expires_at: batch.expires_at,
      reason: batch.reason,
      created_at: batch.created_at
    });
  });
  const activeBaselineId = monitoring.overview.baseline?.id;
  const poolRows = (poolResponse.data || []) as Array<{ baseline_id: string; asset: "BTC" | "SOL"; slot_id: string; slot_number: number }>;
  const eligibleSlotIds = (asset: "BTC" | "SOL") => poolRows
    .filter((slot) => slot.baseline_id === activeBaselineId && slot.asset === asset)
    .map((slot) => slot.slot_id);
  const applyContributionAccounting = (response: unknown, fallbackCode: string) => {
    const plan = (response || { ok: false, code: fallbackCode }) as AssetLadderPlanResponse;
    const asset = plan.asset;
    const enrichedContributions = asset
      ? contributionRows.filter((contribution) => contribution.asset === asset).map((contribution) => {
        const batch = contribution.bulk_batch_id ? batchById.get(contribution.bulk_batch_id) : undefined;
        return {
          ...contribution,
          bulk_slot_count: contribution.bulk_slot_count ?? batch?.applied_slot_count ?? null,
          bulk_total_amount_usdt: batch?.total_amount_usdt ?? null,
          bulk_amount_per_slot_usdt: batch?.amount_per_slot_usdt ?? null,
          bulk_open_slot_count: batch?.open_slot_count ?? null
        };
      })
      : [];
    const mergedContributions = new Map<string, AssetExternalContributionHistory>();
    (plan.contributions || []).forEach((contribution) => mergedContributions.set(contribution.id, contribution));
    enrichedContributions.forEach((contribution) => mergedContributions.set(contribution.id, contribution));
    return {
      ...plan,
      contributions: [...mergedContributions.values()].sort((first, second) => new Date(second.created_at).getTime() - new Date(first.created_at).getTime()),
      bulk_eligible_slot_ids: asset ? eligibleSlotIds(asset) : [],
      manual_gain_batch_preview: asset ? manualGainBatchByAsset.get(asset) || null : null
    } satisfies AssetLadderPlanResponse;
  };
  const btcLadder = applyContributionAccounting(btcLadderResponse.data, "BTC_LADDER_LOAD_ERROR");
  const solLadder = applyContributionAccounting(solLadderResponse.data, "SOL_LADDER_LOAD_ERROR");

  return (
    <GrowthPlanClient
      userLabel={user.email || "Usuario"}
      plan={{ ok: btcLadder.ok, started_at: btcLadder.started_at, elapsed_days: btcLadder.elapsed_days, cycle_days: btcLadder.cycle_days } as ProgrammedGrowthPlanResponse}
      btcLadder={btcLadder}
      solLadder={solLadder}
      history={(historyResponse.data || []) as GrowthContributionHistoryItem[]}
      setupError={historyResponse.error?.message || btcLadderResponse.error?.message || solLadderResponse.error?.message || contributionAccountingResponse.error?.message || contributionBatchResponse.error?.message || manualGainBatchResponse.error?.message || poolResponse.error?.message || null}
      initialNotice={searchParams?.notice || null}
      initialNoticeTone={searchParams?.tone === "error" ? "error" : "success"}
      initialAsset={searchParams?.asset === "SOL" ? "SOL" : "BTC"}
      initialView={searchParams?.view === "gains" || searchParams?.view === "balance" ? searchParams.view : "ladder"}
      btcActionKeys={actionKeys()}
      monitoring={monitoring.overview}
      monitoringPreview={monitoring.preview}
      monitoringError={monitoring.error}
      solActionKeys={actionKeys()}
    />
  );
}
