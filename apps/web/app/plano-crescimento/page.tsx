import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import type { AssetLadderPlanResponse, AssetPlanActionKeys } from "./btc-ladder-section";
import { GrowthPlanClient, type GrowthContributionHistoryItem, type ProgrammedGrowthPlanResponse } from "./growth-plan-client";

export const metadata: Metadata = { title: "Plano de Crescimento" };

export default async function GrowthPlanPage({ searchParams }: { searchParams?: { notice?: string; tone?: string } }) {
  if (!isSupabaseConfigured()) redirect("/login?setup=missing-env");

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [historyResponse, btcLadderResponse, solLadderResponse] = await Promise.all([
    supabase
      .from("programmed_growth_contributions")
      .select("id,asset,month_number,cumulative_goal,slot_number,gains_before,gains_after,value_before,value_after,contributed_amount,note,created_at")
      .order("created_at", { ascending: false })
      .limit(30),
    supabase.rpc("get_asset_ladder_plan", { p_asset: "BTC" }),
    supabase.rpc("get_asset_ladder_plan", { p_asset: "SOL" })
  ]);

  const actionKeys = (): AssetPlanActionKeys => ({
    prepare: randomUUID(),
    confirm: randomUUID(),
    contribution: randomUUID()
  });
  const btcLadder = (btcLadderResponse.data || { ok: false, code: "BTC_LADDER_LOAD_ERROR" }) as AssetLadderPlanResponse;

  return (
    <GrowthPlanClient
      plan={{ ok: btcLadder.ok, started_at: btcLadder.started_at, elapsed_days: btcLadder.elapsed_days, cycle_days: btcLadder.cycle_days } as ProgrammedGrowthPlanResponse}
      btcLadder={btcLadder}
      solLadder={(solLadderResponse.data || { ok: false, code: "SOL_LADDER_LOAD_ERROR" }) as AssetLadderPlanResponse}
      history={(historyResponse.data || []) as GrowthContributionHistoryItem[]}
      setupError={historyResponse.error?.message || btcLadderResponse.error?.message || solLadderResponse.error?.message || null}
      initialNotice={searchParams?.notice || null}
      initialNoticeTone={searchParams?.tone === "error" ? "error" : "success"}
      btcActionKeys={actionKeys()}
      solActionKeys={actionKeys()}
    />
  );
}
