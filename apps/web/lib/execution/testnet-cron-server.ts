import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { advanceTestnetRun } from "./robot-v1-testnet-server";
import { runTestnetCronBatch, type TestnetCronMode, type TestnetCronRun } from "./testnet-cron";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "../supabase/env";
import { createServiceRoleClient } from "../supabase/service-role";

const columns = "id,asset,product_id,tenant_id,user_id,status,last_reconciled_at,lease_until,last_error,operator_id,exchange_account_id,trading_engine_id,symbol,quote_asset";
const headers = { "cache-control": "no-store" };

/** Authenticated serverless polling; no permanent connection or Production exchange client. */
export async function handleTestnetCron(request: NextRequest, mode: TestnetCronMode) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401, headers });
  if (process.env.COINOPS_TESTNET_ENABLED !== "true") {
    console.warn(JSON.stringify({ event: "COINOPS_TESTNET_CRON", mode, status: "DISABLED" }));
    return NextResponse.json({ status: "DISABLED", mode }, { headers });
  }
  if (getSupabaseDataSchema() !== "coinops") return NextResponse.json({ error: "COINOPS_TESTNET_SCHEMA_SCOPE_INVALID" }, { status: 503, headers });
  try {
    const service = createServiceRoleClient();
    const tenantId = getCoinOpsServiceTenantId();
    const operators = await service.from("operators").select("id").eq("tenant_id", tenantId).eq("status", "ACTIVE");
    if (operators.error) throw new Error("COINOPS_TESTNET_OPERATOR_DISCOVERY_FAILED");
    const engines = await service.from("trading_engines").select("id")
      .in("operator_id", (operators.data || []).map((operator) => operator.id)).eq("environment", "TESTNET").eq("status", "ACTIVE");
    if (engines.error) throw new Error("COINOPS_TESTNET_ENGINE_DISCOVERY_FAILED");
    const { data, error } = await service.from("robot_v1_testnet_runs").select(columns)
      .eq("tenant_id", tenantId).eq("status", "ACTIVE")
      .in("trading_engine_id", (engines.data || []).map((engine) => engine.id)).order("trading_engine_id");
    if (error) throw new Error("COINOPS_TESTNET_RUN_DISCOVERY_FAILED");
    if (new Set((data || []).map((run) => run.trading_engine_id)).size !== (data || []).length)
      throw new Error("COINOPS_TESTNET_DUPLICATE_ENGINE_RUN");
    const invocationId = randomUUID();
    const results = await runTestnetCronBatch((data || []) as TestnetCronRun[], mode, {
      now: Date.now,
      advance: advanceTestnetRun,
      currentRun: async (runId) => {
        const result = await service.from("robot_v1_testnet_runs").select(columns).eq("tenant_id", tenantId).eq("id", runId).maybeSingle();
        if (result.error) throw new Error("COINOPS_TESTNET_RUN_DISCOVERY_FAILED");
        return result.data as TestnetCronRun | null;
      },
      record: async (run, evidence) => {
        const result = await service.from("robot_v1_testnet_events").insert({
          run_id: run.id, product_id: run.product_id, tenant_id: run.tenant_id, user_id: run.user_id,
          operator_id: run.operator_id, exchange_account_id: run.exchange_account_id, trading_engine_id: run.trading_engine_id,
          event_key: `${evidence.type}:${invocationId}:${run.id}`, event_type: evidence.type,
          observed_at: evidence.observedAt, details: { ...evidence.details, app_commit_sha: process.env.VERCEL_GIT_COMMIT_SHA || null },
        });
        if (result.error) throw new Error("COINOPS_TESTNET_RECONCILIATION_EVIDENCE_FAILED");
      },
    });
    const failed = results.some((result) => result.status === "FAILED");
    const status = failed ? "PARTIAL_FAILURE" : results.length ? "COMPLETED" : "NO_ACTIVE_RUNS";
    const summary = { event: "COINOPS_TESTNET_CRON", mode, status, discovered: data?.length || 0, results };
    if (failed || !results.length) console.warn(JSON.stringify(summary));
    else console.info(JSON.stringify(summary));
    return NextResponse.json(summary, { status: failed ? 503 : 200, headers });
  } catch (error) {
    const code = error instanceof Error && /^COINOPS_TESTNET_[A-Z_]+$/.test(error.message) ? error.message : "COINOPS_TESTNET_CRON_FAILED";
    console.error(JSON.stringify({ event: "COINOPS_TESTNET_CRON", mode, status: "FAILED", error: code }));
    return NextResponse.json({ error: code, mode }, { status: 503, headers });
  }
}
