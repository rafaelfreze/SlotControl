import { NextResponse } from "next/server";

import { loadOperatorRegistry } from "@/lib/execution/operator-context-server";
import { resolveEngineContext } from "@/lib/execution/operator-context";
import { resolveExecutorForEngine } from "@/lib/execution/executor-shards-server";
import { readLiveExecutorState } from "@/lib/execution/live-executor-transport";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { loadAccountFunding } from "@/lib/execution/account-funding-server";

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
    const params = new URL(request.url).searchParams;
    const accountId = params.get("account");
    const fundingRequested = params.get("funding") === "1";
    if (!accountId || accountId !== "ALL" && !registry.accounts.some((account) => account.id === accountId))
      return json({ error: "COINOPS_BALANCE_ACCOUNT_SCOPE_DENIED" }, 403);
    // A funding diagnostic is always one explicitly owned account, never an
    // unbounded all-account exchange audit triggered by Home rendering.
    if (fundingRequested && accountId === "ALL")
      return json({ error: "COINOPS_ACCOUNT_FUNDING_SINGLE_ACCOUNT_REQUIRED" }, 400);
    const groups = new Map<string, { accountId: string; currency: string; engineId: string }>();
    for (const engine of registry.engines.filter((item) => item.environment === "REAL"
      && (fundingRequested ? ["ACTIVE", "PAUSED"].includes(item.status) : item.status === "ACTIVE")
      && (accountId === "ALL" || item.exchange_account_id === accountId))) {
      const key = `${engine.exchange_account_id}:${fundingRequested ? engine.symbol : engine.quote_asset}`;
      if (!groups.has(key)) groups.set(key, { accountId: engine.exchange_account_id,
        currency: engine.quote_asset, engineId: engine.id });
    }
    // Resolve each account/shard once and bound this optional UI read. A slow
    // balance collection never blocks Home and never triggers a trading action.
    const targets = new Map<string, ReturnType<typeof resolveExecutorForEngine>>();
    const resolve: typeof resolveExecutorForEngine = (operatorId, exchangeAccountId, engineId) => {
      const key = `${operatorId}:${exchangeAccountId}:${engineId}`;
      if (!targets.has(key)) targets.set(key, resolveExecutorForEngine(operatorId, exchangeAccountId, engineId));
      return targets.get(key)!;
    };
    const fundingDeadline = fundingRequested ? AbortSignal.timeout(5_000) : null;
    const observed = await Promise.allSettled([...groups.values()].map(async (group) => {
      const context = resolveEngineContext(registry, { environment: "REAL",
        exchange_account_id: group.accountId, trading_engine_id: group.engineId });
      let requests = 0;
      const fetchState: typeof fetch = (url, init) => {
        // The diagnostic observes each distinct market once. Transport retry
        // must not multiply Binance reads; absence stays explicitly partial.
        if (fundingRequested && requests++ > 0)
          throw new Error("COINOPS_ACCOUNT_FUNDING_OBSERVATION_UNAVAILABLE");
        return fetch(url, { ...init, signal: AbortSignal.any([
          fundingDeadline ?? AbortSignal.timeout(5_000), ...(init?.signal ? [init.signal] : []),
        ]) });
      };
      const state = await readLiveExecutorState(context, fetchState, resolve);
      const quote = state.balances.find((item) => item.asset === group.currency);
      if (!quote || !Number.isFinite(quote.free) || quote.free < 0) throw new Error("COINOPS_BALANCE_UNAVAILABLE");
      return { accountId: group.accountId, currency: group.currency,
        free: quote.free, locked: quote.locked, observedAt: state.observed_at, state };
    }));
    const successful = observed.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
    const balances = new Map<string, Omit<typeof successful[number], "state">>();
    for (const { state: _state, ...balance } of successful) {
      void _state;
      const key = `${balance.accountId}:${balance.currency}`;
      const previous = balances.get(key);
      if (!previous || balance.observedAt > previous.observedAt) balances.set(key, balance);
    }
    let funding: Awaited<ReturnType<typeof loadAccountFunding>> | undefined;
    let fundingUnavailable = false;
    if (fundingRequested) {
      try {
        funding = await loadAccountFunding(db, { scope: { product_id: scope.data.product_id,
          tenant_id: tenantId, user_id: user.id }, registry, accountId,
        states: successful.map((item) => item.state) });
      } catch { funding = []; fundingUnavailable = true; }
    }
    return json({ balances: [...balances.values()],
      unavailable: observed.filter((item) => item.status === "rejected").length,
      ...(fundingRequested ? { funding, fundingUnavailable } : {}) });
  } catch {
    return json({ error: "COINOPS_BALANCE_UNAVAILABLE" }, 503);
  }
}
