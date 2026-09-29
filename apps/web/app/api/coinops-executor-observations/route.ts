import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCoinOpsServiceTenantId } from "@/lib/supabase/env";
import { loadOperatorRegistry } from "@/lib/execution/operator-context-server";
import { resolveEngineContext } from "@/lib/execution/operator-context";
import { loadLiveExecutorStatus } from "@/lib/execution/live-executor-health";
import { resolveExecutorForAccount } from "@/lib/execution/executor-shards-server";
import { readPublicSymbolRule } from "@/lib/coinops-monitoring/public-symbol-rules";

export const dynamic = "force-dynamic";
export const preferredRegion = "gru1";
export const maxDuration = 30;
const headers = { "Cache-Control": "private, no-store" };

/** UI observations only: signed health, never advance/reconcile/submit. */
export async function GET() {
  const started = performance.now();
  try {
    const db = createClient();
    const user = (await db.auth.getUser()).data.user;
    if (!user) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401, headers });
    const owner = await db.from("operators").select("product_id,tenant_id,user_id")
      .eq("tenant_id", getCoinOpsServiceTenantId()).eq("user_id", user.id).eq("status", "ACTIVE").single();
    if (owner.error || !owner.data) return NextResponse.json({ error: "SCOPE_DENIED" }, { status: 403, headers });
    const registry = await loadOperatorRegistry(db, owner.data);
    const contexts = registry.engines.filter((engine) => engine.environment === "REAL").map((engine) =>
      resolveEngineContext(registry, { environment: "REAL", exchange_account_id: engine.exchange_account_id, trading_engine_id: engine.id }));
    const rules = Promise.all([...new Set(contexts.map((context) => context.symbol))].map(readPublicSymbolRule));
    // Request-local memoization only; never share authorization/config across users.
    const targets = new Map<string, ReturnType<typeof resolveExecutorForAccount>>();
    const resolve: typeof resolveExecutorForAccount = (operatorId, accountId) => {
      const key = `${operatorId}:${accountId}`;
      if (!targets.has(key)) targets.set(key, resolveExecutorForAccount(operatorId, accountId));
      return targets.get(key)!;
    };
    const fetchHealth: typeof fetch = (url, init) => fetch(url, { ...init,
      signal: AbortSignal.any([AbortSignal.timeout(5_000), ...(init?.signal ? [init.signal] : [])]) });
    const observations: Array<{ engineId: string; status: Awaited<ReturnType<typeof loadLiveExecutorStatus>> }> = [];
    for (let offset = 0; offset < contexts.length; offset += 8) {
      observations.push(...await Promise.all(contexts.slice(offset, offset + 8).map(async (context) => ({
        engineId: context.trading_engine_id,
        status: await loadLiveExecutorStatus(undefined, undefined, fetchHealth, undefined, context, resolve),
      }))));
    }
    return NextResponse.json({ observations, symbolRules: (await rules).filter(Boolean), observedAt: new Date().toISOString() }, {
      headers: { ...headers, "Server-Timing": `executor_observations;dur=${(performance.now() - started).toFixed(1)}` },
    });
  } catch {
    return NextResponse.json({ error: "COINOPS_EXECUTOR_OBSERVATIONS_UNAVAILABLE" }, { status: 503, headers });
  }
}
