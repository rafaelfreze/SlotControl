import { NextRequest, NextResponse } from "next/server";

import { advanceTestnetRun } from "@/lib/execution/robot-v1-testnet-server";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "gru1";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  if (process.env.COINOPS_TESTNET_ENABLED !== "true") return NextResponse.json({ status: "DISABLED" });
  if (getSupabaseDataSchema() !== "coinops") return NextResponse.json({ error: "COINOPS_TESTNET_SCHEMA_SCOPE_INVALID" }, { status: 503 });
  try {
    const { data, error } = await createServiceRoleClient().from("robot_v1_testnet_runs").select("id,asset")
      .eq("tenant_id", getCoinOpsServiceTenantId()).eq("status", "ACTIVE").in("asset", ["BTC", "SOL"]).order("asset").limit(2);
    if (error) throw error;
    const results = [];
    for (const run of data || []) {
      try { results.push({ asset: run.asset, ...await advanceTestnetRun(run.id, "CRON_RECONCILIATION") }); }
      catch (runError) {
        results.push({ asset: run.asset, status: "FAILED", error: runError instanceof Error && /^COINOPS_TESTNET_[A-Z_]+$/.test(runError.message) ? runError.message : "COINOPS_TESTNET_RECONCILIATION_FAILED" });
      }
    }
    const failed = results.some((result) => result.status === "FAILED");
    return NextResponse.json({ status: failed ? "PARTIAL_FAILURE" : "OK", runs: results.length, results }, { status: failed ? 503 : 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && /^COINOPS_TESTNET_[A-Z_]+$/.test(error.message) ? error.message : "COINOPS_TESTNET_CRON_FAILED";
    return NextResponse.json({ error: code }, { status: 503 });
  }
}
