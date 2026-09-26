import { NextRequest, NextResponse } from "next/server";

import { advanceLiveRun, auditLiveRun } from "./robot-v1-live-server";
import { runFairPool } from "./live-cron-scheduler";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "../supabase/env";
import { createServiceRoleClient } from "../supabase/service-role";

const headers = { "cache-control": "no-store" };

function latencyPercentile(values: number[], percent: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * percent / 100) - 1] ?? 0;
}

export async function handleLiveCron(request: NextRequest, mode: "EXECUTION" | "MONITOR") {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401, headers });
  if (process.env.COINOPS_LIVE_CRON_ENABLED !== "true")
    return NextResponse.json({ status: "DISABLED", mode }, { headers });
  if (getSupabaseDataSchema() !== "coinops" || !getCoinOpsServiceTenantId())
    return NextResponse.json({ error: "COINOPS_LIVE_SCHEMA_SCOPE_INVALID" }, { status: 503, headers });
  const startedAt = performance.now();
  try {
    const service = createServiceRoleClient();
    const operators = await service.from("operators").select("id")
      .eq("tenant_id", getCoinOpsServiceTenantId()).eq("status", "ACTIVE");
    if (operators.error || !operators.data) throw new Error("COINOPS_LIVE_OPERATOR_DISCOVERY_FAILED");
    if (!operators.data.length) return NextResponse.json({ status: "NO_ACTIVE_OPERATORS", mode }, { headers });
    const engines = await service.from("trading_engines").select("id")
      .in("operator_id", operators.data.map((operator) => operator.id))
      .eq("environment", "REAL").eq("status", "ACTIVE");
    if (engines.error || !engines.data) throw new Error("COINOPS_LIVE_ENGINE_DISCOVERY_FAILED");
    if (!engines.data.length) return NextResponse.json({ status: "NO_ACTIVE_ENGINES", mode }, { headers });
    const result = await service.from("robot_v1_live_runs")
      .select("id,asset,status,operator_id,exchange_account_id,trading_engine_id,symbol,quote_asset")
      .eq("tenant_id", getCoinOpsServiceTenantId()).in("status", ["ACTIVE", "PAUSED"])
      .in("trading_engine_id", engines.data.map((engine) => engine.id))
      .order("trading_engine_id");
    if (result.error || !result.data)
      throw new Error("COINOPS_LIVE_RUN_DISCOVERY_FAILED");
    // Run leases and all decisions remain engine-scoped. A broken account is
    // returned as one failure, never promoted to another account's credential.
    if (new Set(result.data.map((run) => run.trading_engine_id)).size !== result.data.length)
      throw new Error("COINOPS_LIVE_DUPLICATE_ENGINE_RUN");
    const reports = await runFairPool(result.data, 12, Math.floor(Date.now() / 60_000), async (run) => {
      const runStartedAt = performance.now();
      try {
        const outcome = mode === "EXECUTION" ? await advanceLiveRun(run.id) : await auditLiveRun(run.id);
        return { ...run, run_id: run.id, ...outcome,
          duration_ms: Math.round(performance.now() - runStartedAt) };
      } catch (error) {
        const code = error instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(error.message)
          ? error.message : "COINOPS_LIVE_CRON_FAILED";
        return { ...run, run_id: run.id, status: "FAILED", code,
          duration_ms: Math.round(performance.now() - runStartedAt) };
      }
    });
    const failed = reports.some((item) => item.status === "FAILED" || item.status === "CRITICAL");
    const status = failed ? "PARTIAL_FAILURE" : reports.length ? "COMPLETED" : "NO_ACTIVE_RUNS";
    const durations = reports.map((item) => item.duration_ms);
    const summary = { event: "COINOPS_LIVE_CRON", mode, status, reports,
      duration_ms: Math.round(performance.now() - startedAt),
      engine_duration_ms: { p50: latencyPercentile(durations, 50),
        p95: latencyPercentile(durations, 95), p99: latencyPercentile(durations, 99) },
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
