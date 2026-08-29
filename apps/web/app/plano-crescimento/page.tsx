import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { loadOfficialMonitoring } from "@/lib/coinops-monitoring/server";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import type { AssetLadderPlanResponse, AssetPlanActionKeys } from "./btc-ladder-section";
import { GrowthPlanClient, type GrowthContributionHistoryItem, type ProgrammedGrowthPlanResponse } from "./growth-plan-client";

export const metadata: Metadata = { title: "Plano de Crescimento" };

export default async function GrowthPlanPage({ searchParams }: { searchParams?: { notice?: string; tone?: string } }) {
  if (!isSupabaseConfigured()) redirect("/login?setup=missing-env");

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [historyResponse, btcLadderResponse, solLadderResponse, contributionAccountingResponse, monitoring] = await Promise.all([
    supabase
      .from("programmed_growth_contributions")
      .select("id,asset,month_number,cumulative_goal,slot_number,gains_before,gains_after,value_before,value_after,contributed_amount,note,created_at")
      .order("created_at", { ascending: false })
      .limit(30),
    supabase.rpc("get_asset_ladder_plan", { p_asset: "BTC" }),
    supabase.rpc("get_asset_ladder_plan", { p_asset: "SOL" }),
    supabase
      .from("btc_external_contributions")
      .select("id,accounting_amount_usdt,input_mode"),
    loadOfficialMonitoring({ includeDetailedPreview: true })
  ]);

  const actionKeys = (): AssetPlanActionKeys => ({
    prepare: randomUUID(),
    confirm: randomUUID(),
    contribution: randomUUID(),
    balanceContribution: randomUUID()
  });
  const accountingById = new Map(
    (contributionAccountingResponse.data || []).map((item) => [item.id, item])
  );
  const applyContributionAccounting = (response: unknown, fallbackCode: string) => {
    const plan = (response || { ok: false, code: fallbackCode }) as AssetLadderPlanResponse;
    return {
      ...plan,
      contributions: (plan.contributions || []).map((contribution) => {
        const accounting = accountingById.get(contribution.id);
        return {
          ...contribution,
          accounting_amount_usdt: accounting?.accounting_amount_usdt ?? contribution.amount_usdt,
          input_mode: (accounting?.input_mode as "MANUAL_GAINS" | "USDT" | null | undefined) ?? contribution.input_mode
        };
      })
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
      setupError={historyResponse.error?.message || btcLadderResponse.error?.message || solLadderResponse.error?.message || contributionAccountingResponse.error?.message || null}
      initialNotice={searchParams?.notice || null}
      initialNoticeTone={searchParams?.tone === "error" ? "error" : "success"}
      btcActionKeys={actionKeys()}
      monitoring={monitoring.overview}
      monitoringPreview={monitoring.preview}
      monitoringError={monitoring.error}
      solActionKeys={actionKeys()}
    />
  );
}
