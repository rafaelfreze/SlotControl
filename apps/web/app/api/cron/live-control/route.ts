import { NextRequest, NextResponse } from "next/server";

import { loadLiveExecutorStatus } from "@/lib/execution/live-executor-health";
import { readLiveExecutorState } from "@/lib/execution/live-executor-transport";
import { prepareLiveCycle } from "@/lib/execution/robot-v1-live-server";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";
export const preferredRegion = "gru1";
export const maxDuration = 60;

const headers = { "cache-control": "no-store" };

/** Operator-only control plane. CRON_SECRET already authorizes the execution
 * cron; this endpoint accepts no amounts, prices, order IDs, or user IDs. */
export async function POST(request: NextRequest) {
  if (!process.env.CRON_SECRET
    || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401, headers });
  if (process.env.VERCEL_ENV !== "production"
    || request.nextUrl.hostname !== "cripto-flax.vercel.app"
    || getSupabaseDataSchema() !== "coinops" || !getCoinOpsServiceTenantId())
    return NextResponse.json({ error: "COINOPS_LIVE_SCOPE_DENIED" }, { status: 503, headers });
  const payload = await request.json().catch(() => null) as { action?: unknown; asset?: unknown } | null;
  if (!payload || Object.keys(payload).length !== 2
    || !["PREPARE", "ACTIVATE"].includes(String(payload.action))
    || !["BTC", "SOL"].includes(String(payload.asset)))
    return NextResponse.json({ error: "COINOPS_LIVE_CONTROL_INVALID" }, { status: 400, headers });
  try {
    const service = createServiceRoleClient();
    const owner = await service.from("robot_v1_live_preparations")
      .select("product_id,tenant_id,user_id,asset,configured_live_capital_brl")
      .eq("tenant_id", getCoinOpsServiceTenantId()).order("asset");
    if (owner.error || owner.data?.length !== 2
      || owner.data[0]?.asset !== "BTC" || owner.data[1]?.asset !== "SOL"
      || owner.data[0].product_id !== owner.data[1].product_id
      || owner.data[0].user_id !== owner.data[1].user_id
      || owner.data.some((row) => row.tenant_id !== getCoinOpsServiceTenantId()))
      throw new Error("COINOPS_LIVE_OWNER_AMBIGUOUS");
    const asset = payload.asset as "BTC" | "SOL";
    const action = payload.action as "PREPARE" | "ACTIVATE";
    const health = await loadLiveExecutorStatus();
    if (health.gate !== (action === "PREPARE" ? "LIVE_EXECUTOR_READY" : "LIVE_EXECUTOR_ACTIVE"))
      throw new Error("COINOPS_LIVE_EXECUTOR_GATE_DENIED");
    if (action === "PREPARE") {
      const cycleId = await prepareLiveCycle(owner.data[0].user_id, asset);
      return NextResponse.json({ status: "PREPARED", asset, cycle_id: cycleId }, { headers });
    }
    if (process.env.COINOPS_LIVE_CRON_ENABLED !== "true")
      throw new Error("COINOPS_LIVE_CRON_GATE_DENIED");
    const runs = await service.from("robot_v1_live_runs").select("id,status,product_id")
      .eq("tenant_id", getCoinOpsServiceTenantId()).eq("user_id", owner.data[0].user_id)
      .eq("asset", asset).in("status", ["PREPARING", "ACTIVE", "PAUSED"]);
    if (runs.error || runs.data?.length !== 1 || runs.data[0].status !== "PREPARING"
      || runs.data[0].product_id !== owner.data[0].product_id)
      throw new Error("COINOPS_LIVE_RUN_GATE_DENIED");
    const state = await readLiveExecutorState(`${asset}BRL`);
    if (Date.now() - Date.parse(state.observed_at) > 30_000
      || state.open_orders.some((order) => order.clientOrderId?.startsWith(`COR1-${asset}-`)))
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
