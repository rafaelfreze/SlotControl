import { createHash, randomUUID } from "node:crypto";
import { ExecutorHttpError, observationFailure, retryableObservation } from "./live-read-error.ts";

import { signedExecutorHeaders } from "./live-executor-client.ts";
import type { EngineContext } from "./operator-context.ts";
import { resolveExecutorForEngine, withExecutorShard, type ExecutorEngineResolver } from "./executor-shards-server.ts";
import { accountBudgetPermitHeaders, type AccountBudgetReservation } from "./account-order-budget-permit.ts";
import { AccountOrderNotSubmitted, signAccountOrderUnsentProof, verifyAccountOrderUnsentProof } from "./account-order-unsent-proof.ts";

export type ExecutorEngineScope = Pick<EngineContext, "operator_id" | "exchange_account_id" | "trading_engine_id" | "symbol" | "quote_asset">;
export type ExecutorContext = ExecutorEngineScope & { environment: "REAL"; decision_id: string; idempotency_key: string };
export function executorContext(engine: ExecutorEngineScope, decisionId: string, key: string): ExecutorContext {
  return { operator_id: engine.operator_id, exchange_account_id: engine.exchange_account_id,
    trading_engine_id: engine.trading_engine_id, environment: "REAL", symbol: engine.symbol,
    quote_asset: engine.quote_asset, decision_id: decisionId, idempotency_key: key };
}

export type LiveOrder = { orderId: string; clientOrderId: string; symbol: string;
  side: "BUY" | "SELL"; status: string; executedQuantity: number;
  cumulativeQuoteQuantity: number; price: number };
export type LiveTrade = { id: string; quantity: number; quoteQuantity: number;
  commission: number; commissionAsset: string; isBuyer: boolean; filledAt: string };
export type LiveExecutorState = ExecutorEngineScope & { symbol: string;
  balances: Array<{ asset: string; free: number; locked: number; total: number }>;
  filters: { symbol: string; baseAsset: string; quoteAsset: string; minQuantity: number;
    maxQuantity: number; quantityStep: number; minNotional: number; priceTick: number };
  price: { symbol: string; price: number; observedAt: string };
  bnb_brl_price: { symbol: string; price: number; observedAt: string } | null;
  bnb_quote_price?: { symbol: string; price: number; observedAt: string } | null;
  supports_unfilled_buy_cancel?: boolean;
  execution_caps?: { engine: number; account: number; max_order: number };
  open_orders: Array<{ id: string; symbol: string; side: string; status: string;
    executedQuantity: number; price: number | null; clientOrderId: string | null }>;
  observed_at: string };

function validState(value: LiveExecutorState, engine: ExecutorEngineScope) {
  const symbol = engine.symbol;
  return value?.symbol === symbol && Array.isArray(value.balances)
    && value.filters?.symbol === symbol
    && value.filters.quoteAsset === engine.quote_asset
    && `${value.filters.baseAsset}${value.filters.quoteAsset}` === symbol
    && Number.isFinite(value.filters.quantityStep) && value.filters.quantityStep > 0
    && Number.isFinite(value.filters.minNotional) && value.filters.minNotional > 0
    && Number.isFinite(value.filters.priceTick) && value.filters.priceTick > 0
    && value.price?.symbol === symbol && Number.isFinite(value.price.price)
    && value.price.price > 0 && Number.isFinite(Date.parse(value.price.observedAt))
    && Array.isArray(value.open_orders)
    && Number.isFinite(Date.parse(value.observed_at));
}

async function request<T>(path: string, input: Record<string, unknown>, key: string,
  fetcher: typeof fetch = fetch, resolver: ExecutorEngineResolver = resolveExecutorForEngine,
  reservation?: AccountBudgetReservation): Promise<T> {
  const target = await resolver(String(input.operator_id ?? ""), String(input.exchange_account_id ?? ""), String(input.trading_engine_id ?? ""));
  const { base, secret } = target;
  const body = JSON.stringify(withExecutorShard(input, target));
  const permitScope = { operator_id: String(input.operator_id), exchange_account_id: String(input.exchange_account_id),
    trading_engine_id: String(input.trading_engine_id), executor_shard_id: target.shardId,
    environment: String(input.environment), symbol: String(input.symbol), side: String(input.side),
    clientOrderId: String(input.clientOrderId) };
  const headers = signedExecutorHeaders(secret, path, body, key);
  const { side: permitSide, ...receiptScope } = permitScope;
  void permitSide;
  const proofScope = { ...receiptScope, decision_id: String(input.decision_id), request_nonce: headers.get("x-coinops-nonce")! };
  let permit: Record<string, string>;
  try { permit = reservation ? accountBudgetPermitHeaders(secret, reservation, permitScope, body) : {}; }
  catch (error) {
    // No fetch has started. This typed, scoped receipt cannot be synthesized
    // from a timeout, remote error string or an absent Binance order.
    if (path !== "/v1/create-order" || !(error instanceof Error)
      || error.message !== "EXECUTOR_ACCOUNT_ORDER_BUDGET_PERMIT_DENIED") throw error;
    const proof = signAccountOrderUnsentProof(secret, proofScope, createHash("sha256").update(body).digest("hex"));
    throw new AccountOrderNotSubmitted(verifyAccountOrderUnsentProof(secret, proof, proofScope, body));
  }
  for (const [name, value] of Object.entries(permit)) headers.set(name, value);
  const response = await fetcher(`${base}${path}`, { method: "POST", cache: "no-store",
    headers, body,
    signal: AbortSignal.timeout(path === "/v1/state" ? 25_000 : 35_000) });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; unsent_proof?: unknown };
  if (!response.ok) {
    if (path === "/v1/create-order" && payload.error === "EXECUTOR_ACCOUNT_ORDER_BUDGET_PERMIT_DENIED"
      && response.status === 403 && payload.unsent_proof) {
      const { side, ...proofScope } = permitScope;
      void side;
      throw new AccountOrderNotSubmitted(verifyAccountOrderUnsentProof(secret, payload.unsent_proof,
        { ...proofScope, decision_id: String(input.decision_id), request_nonce: headers.get("x-coinops-nonce")! }, body));
    }
    const code = payload.error && /^EXECUTOR_[A-Z0-9_]+$/.test(payload.error)
      ? payload.error : `EXECUTOR_HTTP_${response.status}`;
    throw new ExecutorHttpError(code, response.status);
  }
  for (const field of ["operator_id", "exchange_account_id", "trading_engine_id", "environment", "symbol", "quote_asset"])
    if ((payload as Record<string, unknown>)[field] !== input[field]) throw new Error("EXECUTOR_RESPONSE_SCOPE_MISMATCH");
  if (target.shardId !== "executor-01"
    && (payload as Record<string, unknown>).executor_shard_id !== target.shardId)
    throw new Error("EXECUTOR_RESPONSE_SHARD_MISMATCH");
  if (path === "/v1/prove-unsent-order") {
    const value = payload as T & { order?: unknown; unsent_proof?: unknown };
    if (value.order !== null) throw new Error("COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN");
    throw new AccountOrderNotSubmitted(verifyAccountOrderUnsentProof(secret, value.unsent_proof, proofScope, body));
  }
  return payload;
}

/** Attests durable absence with fencing and exact Binance GET. Never POSTs an order. */
export async function proveLiveExecutorUnsentOrder(engine: ExecutorEngineScope, clientOrderId: string,
  decisionId: string, dispatchedAt: string, fetcher?: typeof fetch, resolver?: ExecutorEngineResolver) {
  return request<never>("/v1/prove-unsent-order", { ...executorContext(engine, decisionId, clientOrderId),
    clientOrderId, dispatched_at: dispatchedAt, side: "BUY", purpose: "ENTRY" }, clientOrderId, fetcher, resolver);
}

const readKey = () => `COINOPS:REAL:READ:${randomUUID()}`;
async function readWithRetry<T>(path: "/v1/health" | "/v1/state" | "/v1/query-order" | "/v1/trades",
  input: (key: string) => Record<string, unknown>, fetcher: typeof fetch = fetch,
  resolver: ExecutorEngineResolver = resolveExecutorForEngine): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const key = readKey();
      return await request<T>(path, input(key), key, fetcher, resolver);
    } catch (error) {
      if (!retryableObservation(error)) throw error;
      if (attempt === 3) throw observationFailure(error, path, attempt + 1);
      // Rolling executor restarts may interrupt a GET. Retry observations only;
      // create/cancel requests must still resolve through persisted ownership.
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw new Error("EXECUTOR_READ_UNAVAILABLE");
}
export async function readLiveExecutorHealth(engine: ExecutorEngineScope, fetcher?: typeof fetch,
  resolver?: ExecutorEngineResolver) {
  // A single failed observation (e.g. transient Binance read/egress timeout) must not
  // irreversibly kill-switch an otherwise protected engine. Only GET-equivalent reads retry.
  return readWithRetry<import("./live-executor-health").LiveExecutorHealth>("/v1/health",
    (key) => executorContext(engine, key, key), fetcher, resolver);
}
export async function readLiveExecutorState(engine: ExecutorEngineScope, fetcher?: typeof fetch,
  resolver?: ExecutorEngineResolver) {
  // Retry only an observation. Never retry create/cancel after an uncertain result.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const state = await readWithRetry<LiveExecutorState>("/v1/state",
        (key) => executorContext(engine, key, key), fetcher, resolver);
      if (!validState(state, engine)) throw new Error("EXECUTOR_STATE_INVALID");
      return state;
    } catch (error) {
      if (attempt === 0 && error instanceof Error && error.message === "EXECUTOR_STATE_INVALID") continue;
      throw error;
    }
  }
  throw new Error("EXECUTOR_STATE_INVALID");
}
export function readLegacyProductionReconciliation(engine: ExecutorEngineScope, fetcher?: typeof fetch,
  resolver?: ExecutorEngineResolver) {
  const key = readKey();
  return request<{
    capabilities: { readEnabled: boolean; tradingEnabled: boolean;
      withdrawalsEnabled: boolean; ipRestricted: boolean | null };
    account: { balances: Array<{ asset: string; free: number; locked: number; total: number }> };
    filters: Record<"BTCUSDT" | "SOLUSDT", unknown>;
    prices: Record<"BTCUSDT" | "SOLUSDT", unknown>;
    orders: import("./types").ExchangeOrder[];
    trades: import("./types").ExchangeTrade[];
  }>("/v1/reconciliation", { scope: "COINOPS_SHADOW_READ_ONLY", ...executorContext(engine, key, key) }, key, fetcher, resolver);
}
export async function readLiveExecutorOrder(engine: ExecutorEngineScope, clientOrderId: string,
  orderId?: string | null, fetcher?: typeof fetch, resolver?: ExecutorEngineResolver) {
  for (let confirmation = 0; ; confirmation++) {
    const result = await readWithRetry<{ order: LiveOrder | null }>("/v1/query-order",
      (key) => ({ ...executorContext(engine, key, key), clientOrderId, orderId: orderId ?? null }), fetcher, resolver);
    if (result.order || !orderId || confirmation === 2) return result;
    // Confirm temporary invisibility only for an already acknowledged exact ID.
    // Persistent absence still reaches the existing fail-closed ownership gate.
    await new Promise(resolve => setTimeout(resolve, 250 * (confirmation + 1)));
  }
}
export async function readLiveExecutorTrades(engine: ExecutorEngineScope, clientOrderId: string,
  orderId: string, fetcher?: typeof fetch, resolver?: ExecutorEngineResolver) {
  return readWithRetry<{ order: LiveOrder | null; trades: LiveTrade[] | null }>("/v1/trades",
    (key) => ({ ...executorContext(engine, key, key), clientOrderId, orderId }), fetcher, resolver);
}
export async function createLiveExecutorOrder(input: Record<string, unknown> & { clientOrderId: string }, engine: ExecutorEngineScope,
  decisionId: string,
  fetcher?: typeof fetch, resolver?: ExecutorEngineResolver, reservation?: AccountBudgetReservation) {
  return request<{ order: LiveOrder; replayed: boolean }>("/v1/create-order", { ...input, ...executorContext(engine, decisionId, input.clientOrderId) },
    input.clientOrderId, fetcher, resolver, reservation);
}
export async function cancelLiveExecutorOrder(input: { symbol: string;
  clientOrderId: string; orderId: string; onlyUnfilled?: boolean }, engine: ExecutorEngineScope, fetcher?: typeof fetch,
  resolver?: ExecutorEngineResolver) {
  const key = `${input.onlyUnfilled === true ? "CANCEL_UNFILLED" : "CANCEL"}:${input.clientOrderId}`;
  return request<{ order: LiveOrder; replayed: boolean }>("/v1/cancel-order", { ...input,
    ...executorContext(engine, key, key) }, key, fetcher, resolver);
}
