import { NextRequest, NextResponse } from "next/server";

import { loadLiveExecutorStatus } from "@/lib/execution/live-executor-health";
import { prepareLiveCycle } from "@/lib/execution/robot-v1-live-server";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const responseHeaders = { "cache-control": "no-store" };

/** One-time owner-scoped staging/activation. No arbitrary order parameters are
 * accepted from the browser; Binance writes remain in the cron + ledger path. */
export async function POST(request: NextRequest) {
  if (process.env.VERCEL_ENV !== "production"
    || request.nextUrl.hostname !== "cripto-flax.vercel.app"
    || request.headers.get("origin") !== request.nextUrl.origin
    || request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return NextResponse.json({ error: "LIVE_ACTIVATION_ORIGIN_DENIED" },
      { status: 403, headers: responseHeaders });
  if (getSupabaseDataSchema() !== "coinops" || !getCoinOpsServiceTenantId())
    return NextResponse.json({ error: "LIVE_ACTIVATION_SCOPE_DENIED" },
      { status: 503, headers: responseHeaders });
  const payload = await request.json().catch(() => null) as { asset?: unknown; action?: unknown } | null;
  if (!payload || !["BTC", "SOL"].includes(String(payload.asset))
    || !["PREPARE", "ACTIVATE"].includes(String(payload.action)))
    return NextResponse.json({ error: "LIVE_ACTIVATION_REQUEST_INVALID" },
      { status: 400, headers: responseHeaders });
  const db = createClient();
  const user = (await db.auth.getUser()).data.user;
  if (!user) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401, headers: responseHeaders });
  const tenantId = getCoinOpsServiceTenantId()!;
  const scope = await db.from("strategies").select("product_id")
    .eq("tenant_id", tenantId).eq("user_id", user.id).limit(1).maybeSingle();
  if (scope.error || !scope.data)
    return NextResponse.json({ error: "PRODUCT_SCOPE_REQUIRED" }, { status: 403, headers: responseHeaders });
  const health = await loadLiveExecutorStatus();
  if (payload.action === "PREPARE" && health.gate !== "LIVE_EXECUTOR_READY"
    || payload.action === "ACTIVATE" && health.gate !== "LIVE_EXECUTOR_ACTIVE")
    return NextResponse.json({ error: "LIVE_EXECUTOR_GATE_NOT_READY", gate: health.gate },
      { status: 503, headers: responseHeaders });
  if (payload.action === "ACTIVATE" && process.env.COINOPS_LIVE_CRON_ENABLED !== "true")
    return NextResponse.json({ error: "LIVE_CRON_GATE_NOT_READY" },
      { status: 503, headers: responseHeaders });
  try {
    const asset = payload.asset as "BTC" | "SOL";
    if (payload.action === "PREPARE") {
      const cycleId = await prepareLiveCycle(user.id, asset);
      return NextResponse.json({ status: "PREPARED", asset, cycle_id: cycleId },
        { headers: responseHeaders });
    }
    const service = createServiceRoleClient();
    const run = await service.from("robot_v1_live_runs").select("id,status,product_id")
      .eq("tenant_id", tenantId).eq("user_id", user.id).eq("asset", asset)
      .in("status", ["PREPARING", "ACTIVE"]).maybeSingle();
    if (run.error || !run.data || run.data.product_id !== scope.data.product_id)
      throw new Error("COINOPS_LIVE_ACTIVATION_RUN_UNAVAILABLE");
    const activated = await service.rpc("activate_robot_v1_live_cycle", { p_run_id: run.data.id });
    if (activated.error || !activated.data || activated.data.id !== run.data.id
      || activated.data.status !== "ACTIVE")
      throw new Error("COINOPS_LIVE_ACTIVATION_FAILED");
    return NextResponse.json({ status: "ACTIVE", asset, cycle_id: run.data.id },
      { headers: responseHeaders });
  } catch (error) {
    const code = error instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_LIVE_ACTIVATION_FAILED";
    return NextResponse.json({ error: code }, { status: 503, headers: responseHeaders });
  }
}
