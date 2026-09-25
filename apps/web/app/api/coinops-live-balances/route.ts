import { NextResponse } from "next/server";

import { loadOperatorRegistry } from "@/lib/execution/operator-context-server";
import { resolveEngineContext } from "@/lib/execution/operator-context";
import { readLiveExecutorState } from "@/lib/execution/live-executor-transport";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "gru1";
export const maxDuration = 30;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status,
  headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

/** Read-only, lazy dashboard observation. No browser-supplied account/engine ID is accepted. */
export async function GET() {
  try {
    if (getSupabaseDataSchema() !== "coinops") return json({ error: "COINOPS_BALANCE_SCHEMA_DENIED" }, 503);
    const tenantId = getCoinOpsServiceTenantId();
    const db = createClient();
    const user = (await db.auth.getUser()).data.user;
    if (!user || !tenantId) return json({ error: "COINOPS_BALANCE_AUTH_REQUIRED" }, 401);
    const owned = await db.from("operators").select("id,product_id,tenant_id,user_id")
      .eq("tenant_id", tenantId).eq("user_id", user.id).eq("status", "ACTIVE").single();
    if (owned.error || !owned.data) return json({ error: "COINOPS_BALANCE_SCOPE_DENIED" }, 403);
    const registry = await loadOperatorRegistry(createServiceRoleClient(), owned.data);
    const groups = new Map<string, { accountId: string; currency: string; engineId: string }>();
    for (const engine of registry.engines.filter((item) => item.environment === "REAL" && item.status === "ACTIVE")) {
      const key = `${engine.exchange_account_id}:${engine.quote_asset}`;
      if (!groups.has(key)) groups.set(key, { accountId: engine.exchange_account_id,
        currency: engine.quote_asset, engineId: engine.id });
    }
    const observed = await Promise.allSettled([...groups.values()].map(async (group) => {
      const context = resolveEngineContext(registry, { environment: "REAL",
        exchange_account_id: group.accountId, trading_engine_id: group.engineId });
      const state = await readLiveExecutorState(context);
      const quote = state.balances.find((item) => item.asset === group.currency);
      if (!quote || !Number.isFinite(quote.free) || quote.free < 0) throw new Error("COINOPS_BALANCE_UNAVAILABLE");
      return { accountId: group.accountId, currency: group.currency,
        free: quote.free, locked: quote.locked, observedAt: state.observed_at };
    }));
    return json({ balances: observed.flatMap((item) => item.status === "fulfilled" ? [item.value] : []),
      unavailable: observed.filter((item) => item.status === "rejected").length });
  } catch {
    return json({ error: "COINOPS_BALANCE_UNAVAILABLE" }, 503);
  }
}
