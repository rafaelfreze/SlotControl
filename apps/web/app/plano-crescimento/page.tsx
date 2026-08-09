import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import type { BtcLadderPlanResponse } from "./btc-ladder-section";
import { GrowthPlanClient, type GrowthContributionHistoryItem, type ProgrammedGrowthPlanResponse } from "./growth-plan-client";

export const metadata: Metadata = { title: "Plano de Crescimento" };

export default async function GrowthPlanPage({ searchParams }: { searchParams?: { notice?: string; tone?: string } }) {
  if (!isSupabaseConfigured()) redirect("/login?setup=missing-env");

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [planResponse, historyResponse, btcLadderResponse] = await Promise.all([
    supabase.rpc("get_programmed_growth_plan"),
    supabase
      .from("programmed_growth_contributions")
      .select("id,asset,month_number,cumulative_goal,slot_number,gains_before,gains_after,value_before,value_after,contributed_amount,note,created_at")
      .order("created_at", { ascending: false })
      .limit(30),
    supabase.rpc("get_btc_ladder_plan")
  ]);

  return (
    <GrowthPlanClient
      plan={(planResponse.data || { ok: false, code: "LOAD_ERROR" }) as ProgrammedGrowthPlanResponse}
      btcLadder={(btcLadderResponse.data || { ok: false, code: "BTC_LADDER_LOAD_ERROR" }) as BtcLadderPlanResponse}
      history={(historyResponse.data || []) as GrowthContributionHistoryItem[]}
      setupError={planResponse.error?.message || historyResponse.error?.message || btcLadderResponse.error?.message || null}
      initialNotice={searchParams?.notice || null}
      initialNoticeTone={searchParams?.tone === "error" ? "error" : "success"}
      btcActionKeys={{
        prepare: randomUUID(),
        confirm: randomUUID(),
        contribution: randomUUID()
      }}
    />
  );
}
