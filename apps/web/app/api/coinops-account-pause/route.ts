import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { loadOperatorRegistry } from "@/lib/execution/operator-context-server";
import { isIdentity, resolveEngineContext } from "@/lib/execution/operator-context";
import { loadAccountPauseHome } from "@/lib/execution/account-pause-home-server";
import { pauseLiveRun } from "@/lib/execution/robot-v1-live-server";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "gru1";
export const maxDuration = 60;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status,
  headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
async function adminScope() {
  if (getSupabaseDataSchema() !== "coinops") throw new Error("COINOPS_ACCOUNT_PAUSE_SCHEMA_DENIED");
  const tenantId = getCoinOpsServiceTenantId(), db = createClient();
  const user = (await db.auth.getUser()).data.user;
  if (!user || !tenantId) throw new Error("COINOPS_ACCOUNT_PAUSE_AUTH_REQUIRED");
  const operator = await db.from("operators").select("id,product_id,tenant_id,user_id,status,kill_switch")
    .eq("tenant_id", tenantId).eq("user_id", user.id).eq("status", "ACTIVE").single();
  if (operator.error || !operator.data || operator.data.kill_switch) throw new Error("COINOPS_ACCOUNT_PAUSE_ADMIN_DENIED");
  const service = createServiceRoleClient();
  return { service, registry: await loadOperatorRegistry(service, operator.data) };
}
function failure(error: unknown) {
  const code = error instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(error.message) ? error.message : "COINOPS_ACCOUNT_PAUSE_FAILED";
  return json({ error: code }, code.includes("AUTH") ? 401 : code.includes("UNAVAILABLE") ? 503 : code.includes("BUSY") ? 409 : 403);
}
export async function GET(request: NextRequest) {
  try { const { service, registry } = await adminScope();
    return json(await loadAccountPauseHome(service, registry, request.nextUrl.searchParams.get("account") ?? ""));
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  try {
    if (process.env.VERCEL_ENV !== "production" || request.nextUrl.hostname !== "cripto-flax.vercel.app"
      || request.headers.get("origin") !== request.nextUrl.origin || request.headers.get("sec-fetch-site") === "cross-site"
      || request.headers.get("content-type")?.split(";")[0] !== "application/json"
      || request.headers.get("x-coinops-admin-intent") !== "account-pause") throw new Error("COINOPS_ACCOUNT_PAUSE_ORIGIN_DENIED");
    const raw = await request.text();
    if (raw.length > 65_536) throw new Error("COINOPS_ACCOUNT_PAUSE_INPUT_INVALID");
    const input = JSON.parse(raw) as { action?: string; accountId?: string; engineId?: string; runId?: string;
      expectedEngineIds?: string[]; requestId?: string };
    if (!input || !isIdentity(input.accountId) || !["PAUSE_ENGINE", "HIDE_PAUSED", "SHOW"].includes(input.action ?? ""))
      throw new Error("COINOPS_ACCOUNT_PAUSE_INPUT_INVALID");
    const { service, registry } = await adminScope();
    const account = registry.accounts.find((row) => row.id === input.accountId);
    if (!account || account.status !== "ACTIVE" || account.kill_switch) throw new Error("COINOPS_ACCOUNT_PAUSE_SCOPE_DENIED");
    if (input.action === "PAUSE_ENGINE") {
      if (!isIdentity(input.engineId) || !isIdentity(input.runId)) throw new Error("COINOPS_ACCOUNT_PAUSE_INPUT_INVALID");
      const context = resolveEngineContext(registry, { environment: "REAL", exchange_account_id: account.id,
        trading_engine_id: input.engineId });
      const run = await service.from("robot_v1_live_runs").select("id,status")
        .eq("operator_id", context.operator_id).eq("exchange_account_id", account.id).eq("trading_engine_id", context.trading_engine_id)
        .eq("tenant_id", registry.operator.tenant_id).eq("user_id", registry.operator.user_id)
        .in("status", ["ACTIVE", "PAUSED", "PREPARING"]).maybeSingle();
      if (run.error || !run.data || run.data.id !== input.runId || !["ACTIVE", "PAUSED"].includes(run.data.status)
        || context.status !== "ACTIVE") throw new Error("COINOPS_ACCOUNT_PAUSE_SNAPSHOT_CHANGED");
      // One engine per request: N engines are processed sequentially by the UI,
      // with the same canonical lease/ownership/fill/cancel protocol as PAUSE.
      return json(await pauseLiveRun(run.data.id, registry.operator.user_id, context.base_asset as "BTC" | "SOL"));
    }
    // Reexhibiting changes no trading state and must not depend on a financial
    // snapshot being available. Hide, conversely, always requires the full proof.
    const snapshot = input.action === "HIDE_PAUSED" ? await loadAccountPauseHome(service, registry, account.id) : null;
    if (input.action === "HIDE_PAUSED") {
      const expected = input.expectedEngineIds;
      if (!snapshot || !Array.isArray(expected) || expected.some((id) => !isIdentity(id)) || new Set(expected).size !== expected.length
        || expected.length !== snapshot.engines.length || snapshot.engines.some((engine) => !expected.includes(engine.engineId)))
        throw new Error("COINOPS_ACCOUNT_PAUSE_INVENTORY_CHANGED");
      if (!snapshot.canHide) throw new Error("COINOPS_ACCOUNT_PAUSE_PROTECTION_UNPROVEN");
    }
    const requestId = input.requestId ?? randomUUID();
    if (!isIdentity(requestId)) throw new Error("COINOPS_ACCOUNT_PAUSE_INPUT_INVALID");
    const saved = await service.rpc("set_account_home_preference", { p_operator_id: registry.operator.id,
      p_account_id: account.id, p_user_id: registry.operator.user_id, p_hidden: input.action === "HIDE_PAUSED", p_request_id: requestId,
      p_expected_engine_ids: snapshot ? snapshot.engines.map((engine) => engine.engineId) : null });
    if (saved.error || !saved.data) throw new Error("COINOPS_ACCOUNT_PAUSE_PREFERENCE_UNAVAILABLE");
    return json({ accountId: account.id, hidden: saved.data.hidden === true, status: input.action === "HIDE_PAUSED" ? "PAUSED_HIDDEN" : "VISIBLE" });
  } catch (error) { return failure(error); }
}
