import { NextRequest, NextResponse } from "next/server";

import { advanceLiveRun, auditLiveRun } from "./robot-v1-live-server";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "../supabase/env";
import { createServiceRoleClient } from "../supabase/service-role";

const headers = { "cache-control": "no-store" };

export async function handleLiveCron(request: NextRequest, mode: "EXECUTION" | "MONITOR") {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401, headers });
  if (process.env.COINOPS_LIVE_CRON_ENABLED !== "true")
    return NextResponse.json({ status: "DISABLED", mode }, { headers });
  if (getSupabaseDataSchema() !== "coinops" || !getCoinOpsServiceTenantId())
    return NextResponse.json({ error: "COINOPS_LIVE_SCHEMA_SCOPE_INVALID" }, { status: 503, headers });
  try {
    const service = createServiceRoleClient();
    const result = await service.from("robot_v1_live_runs").select("id,asset,status")
      .eq("tenant_id", getCoinOpsServiceTenantId()).in("status", ["ACTIVE", "PAUSED"])
      .in("asset", ["BTC", "SOL"]).order("asset");
    if (result.error || !result.data || result.data.length > 2)
      throw new Error("COINOPS_LIVE_RUN_DISCOVERY_FAILED");
    const reports = await Promise.all(result.data.map(async (run) => {
      try {
        return { asset: run.asset, run_id: run.id, ...(mode === "EXECUTION"
          ? await advanceLiveRun(run.id) : await auditLiveRun(run.id)) };
      } catch (error) {
        const code = error instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(error.message)
          ? error.message : "COINOPS_LIVE_CRON_FAILED";
        return { asset: run.asset, run_id: run.id, status: "FAILED", code };
      }
    }));
    const failed = reports.some((item) => item.status === "FAILED" || item.status === "CRITICAL");
    const status = failed ? "PARTIAL_FAILURE" : reports.length ? "COMPLETED" : "NO_ACTIVE_RUNS";
    const summary = { event: "COINOPS_LIVE_CRON", mode, status, reports,
      app_commit_sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null };
    if (failed) console.error(JSON.stringify(summary));
    else console.info(JSON.stringify(summary));
    return NextResponse.json(summary, { status: failed ? 503 : 200, headers });
  } catch (error) {
    const code = error instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_LIVE_CRON_FAILED";
    console.error(JSON.stringify({ event: "COINOPS_LIVE_CRON", mode, status: "FAILED", code }));
    return NextResponse.json({ error: code, mode }, { status: 503, headers });
  }
}
