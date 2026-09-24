import { NextRequest, NextResponse } from "next/server";

import { loadLiveEngineExecutorStatus } from "@/lib/execution/live-executor-health";
import { resolveOperatorEngine } from "@/lib/execution/operator-context-server";
import { liveEngineOrderPrefix } from "@/lib/execution/robot-v1-live-cycle";
import type { EngineSelection } from "@/lib/execution/operator-context";
import { readLiveExecutorState } from "@/lib/execution/live-executor-transport";
import { prepareLiveCycle, resumeLiveRun } from "@/lib/execution/robot-v1-live-server";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";
export const preferredRegion = "gru1";
export const maxDuration = 60;

const headers = { "cache-control": "no-store" };

/** Operator-only control plane with a dedicated Production secret. This
 * endpoint accepts no amounts, prices, order IDs, or user IDs. */
export async function POST(request: NextRequest) {
  if (!process.env.COINOPS_LIVE_CONTROL_SECRET
    || process.env.COINOPS_LIVE_CONTROL_SECRET.length < 32
    || request.headers.get("authorization") !== `Bearer ${process.env.COINOPS_LIVE_CONTROL_SECRET}`)
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401, headers });
  if (process.env.VERCEL_ENV !== "production"
    || request.nextUrl.hostname !== "cripto-flax.vercel.app"
    || getSupabaseDataSchema() !== "coinops" || !getCoinOpsServiceTenantId())
    return NextResponse.json({ error: "COINOPS_LIVE_SCOPE_DENIED" }, { status: 503, headers });
  const payload = await request.json().catch(() => null) as { action?: unknown; asset?: unknown;
    exchange_account_id?: string; trading_engine_id?: string } | null;
  if (!payload || Object.keys(payload).some((key) => !["action", "asset", "exchange_account_id", "trading_engine_id"].includes(key))
    || !["PREPARE", "ACTIVATE", "RESUME"].includes(String(payload.action))
    || !["BTC", "SOL"].includes(String(payload.asset)))
    return NextResponse.json({ error: "COINOPS_LIVE_CONTROL_INVALID" }, { status: 400, headers });
  try {
    const service = createServiceRoleClient();
    const owner = await service.from("operators").select("product_id,tenant_id,user_id")
      .eq("tenant_id", getCoinOpsServiceTenantId()).eq("status", "ACTIVE");
    if (owner.error || owner.data?.length !== 1)
      throw new Error("COINOPS_LIVE_OWNER_AMBIGUOUS");
    const asset = payload.asset as "BTC" | "SOL";
    const action = payload.action as "PREPARE" | "ACTIVATE" | "RESUME";
    const selection: EngineSelection = { environment: "REAL", asset,
      exchange_account_id: payload.exchange_account_id, trading_engine_id: payload.trading_engine_id };
    const engine = await resolveOperatorEngine(service, owner.data[0], selection);
    const health = await loadLiveEngineExecutorStatus(engine);
    if (health.gate !== (action === "PREPARE" ? "LIVE_EXECUTOR_READY" : "LIVE_EXECUTOR_ACTIVE"))
      throw new Error("COINOPS_LIVE_EXECUTOR_GATE_DENIED");
    if (action === "PREPARE") {
      const cycleId = await prepareLiveCycle(owner.data[0].user_id, asset, selection);
      return NextResponse.json({ status: "PREPARED", asset, cycle_id: cycleId }, { headers });
    }
    if (process.env.COINOPS_LIVE_CRON_ENABLED !== "true")
      throw new Error("COINOPS_LIVE_CRON_GATE_DENIED");
    const runs = await service.from("robot_v1_live_runs").select("id,status,product_id")
      .eq("tenant_id", getCoinOpsServiceTenantId()).eq("user_id", owner.data[0].user_id)
      .eq("trading_engine_id", engine.trading_engine_id).in("status", ["PREPARING", "ACTIVE", "PAUSED"]);
    const requiredStatus = action === "RESUME" ? "ACTIVE" : "PREPARING";
    if (runs.error || runs.data?.length !== 1 || runs.data[0].status !== requiredStatus
      || runs.data[0].product_id !== owner.data[0].product_id)
      throw new Error("COINOPS_LIVE_RUN_GATE_DENIED");
    if (action === "RESUME") {
      const result = await resumeLiveRun(runs.data[0].id, owner.data[0].user_id, asset);
      return NextResponse.json(result, { headers });
    }
    const state = await readLiveExecutorState(engine);
    if (Date.now() - Date.parse(state.observed_at) > 30_000
      || state.open_orders.some((order) => order.clientOrderId?.startsWith(liveEngineOrderPrefix(engine))))
      throw new Error("COINOPS_LIVE_EXCHANGE_GATE_DENIED");
    const run = await service.rpc("activate_robot_v1_live_cycle", { p_run_id: runs.data[0].id });
    if (run.error || !run.data || run.data.id !== runs.data[0].id || run.data.status !== "ACTIVE")
      throw new Error("COINOPS_LIVE_ACTIVATION_FAILED");
    return NextResponse.json({ status: "ACTIVE", asset, cycle_id: runs.data[0].id }, { headers });
  } catch (error) {
    const code = error instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_LIVE_CONTROL_FAILED";
    return NextResponse.json({ error: code }, { status: 503, headers });
  }
}
