import { NextResponse } from "next/server";

import { loadOperatorRegistry } from "@/lib/execution/operator-context-server";
import { resolveEngineContext } from "@/lib/execution/operator-context";
import { resolveExecutorForAccount } from "@/lib/execution/executor-shards-server";
import { readLiveExecutorState } from "@/lib/execution/live-executor-transport";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "gru1";
export const maxDuration = 30;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status,
  headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

/** Read-only, lazy observation. Requested account is checked against the owned registry. */
export async function GET(request: Request) {
  try {
    if (getSupabaseDataSchema() !== "coinops") return json({ error: "COINOPS_BALANCE_SCHEMA_DENIED" }, 503);
    const tenantId = getCoinOpsServiceTenantId();
    const db = createClient();
    const user = (await db.auth.getUser()).data.user;
    if (!user || !tenantId) return json({ error: "COINOPS_BALANCE_AUTH_REQUIRED" }, 401);
    // Use the same authenticated scope discovery as /automacao. A secondary
    // balance read must not drift into a stricter ownership branch than Home.
    const scope = await db.from("strategies").select("product_id")
      .eq("tenant_id", tenantId).eq("user_id", user.id).limit(1).maybeSingle();
    if (scope.error || !scope.data) return json({ error: "COINOPS_BALANCE_SCOPE_DENIED" }, 403);
    const registry = await loadOperatorRegistry(db, {
      product_id: scope.data.product_id, tenant_id: tenantId, user_id: user.id,
    });
    const accountId = new URL(request.url).searchParams.get("account");
    if (!accountId || accountId !== "ALL" && !registry.accounts.some((account) => account.id === accountId))
      return json({ error: "COINOPS_BALANCE_ACCOUNT_SCOPE_DENIED" }, 403);
    const groups = new Map<string, { accountId: string; currency: string; engineId: string }>();
    for (const engine of registry.engines.filter((item) => item.environment === "REAL" && item.status === "ACTIVE" && (accountId === "ALL" || item.exchange_account_id === accountId))) {
      const key = `${engine.exchange_account_id}:${engine.quote_asset}`;
      if (!groups.has(key)) groups.set(key, { accountId: engine.exchange_account_id,
        currency: engine.quote_asset, engineId: engine.id });
    }
    // Resolve each account/shard once and bound this optional UI read. A slow
    // balance collection never blocks Home and never triggers a trading action.
    const targets = new Map<string, ReturnType<typeof resolveExecutorForAccount>>();
    const resolve: typeof resolveExecutorForAccount = (operatorId, exchangeAccountId) => {
      const key = `${operatorId}:${exchangeAccountId}`;
      if (!targets.has(key)) targets.set(key, resolveExecutorForAccount(operatorId, exchangeAccountId));
      return targets.get(key)!;
    };
    const fetchState: typeof fetch = (url, init) => fetch(url, { ...init,
      signal: AbortSignal.any([AbortSignal.timeout(5_000), ...(init?.signal ? [init.signal] : [])]) });
    const observed = await Promise.allSettled([...groups.values()].map(async (group) => {
      const context = resolveEngineContext(registry, { environment: "REAL",
        exchange_account_id: group.accountId, trading_engine_id: group.engineId });
      const state = await readLiveExecutorState(context, fetchState, resolve);
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
