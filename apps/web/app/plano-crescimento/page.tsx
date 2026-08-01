import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { GrowthPlanClient, type GrowthContributionHistoryItem, type ProgrammedGrowthPlanResponse } from "./growth-plan-client";

export const metadata: Metadata = { title: "Plano de Crescimento" };

export default async function GrowthPlanPage() {
  if (!isSupabaseConfigured()) redirect("/login?setup=missing-env");

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [planResponse, historyResponse] = await Promise.all([
    supabase.rpc("get_programmed_growth_plan"),
    supabase
      .from("programmed_growth_contributions")
      .select("id,asset,month_number,cumulative_goal,slot_number,gains_before,gains_after,value_before,value_after,contributed_amount,note,created_at")
      .order("created_at", { ascending: false })
      .limit(30)
  ]);

  return (
    <GrowthPlanClient
      plan={(planResponse.data || { ok: false, code: "LOAD_ERROR" }) as ProgrammedGrowthPlanResponse}
      history={(historyResponse.data || []) as GrowthContributionHistoryItem[]}
      setupError={planResponse.error?.message || historyResponse.error?.message || null}
    />
  );
}
