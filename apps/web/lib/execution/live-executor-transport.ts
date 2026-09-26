import { randomUUID } from "node:crypto";

import { signedExecutorHeaders } from "./live-executor-client.ts";
import type { EngineContext } from "./operator-context.ts";

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
  fetcher: typeof fetch = fetch): Promise<T> {
  const ip = process.env.LIVE_EXECUTOR_EGRESS_IP;
  const base = process.env.LIVE_EXECUTOR_BASE_URL;
  const secret = process.env.COINOPS_EXECUTOR_HMAC_SECRET;
  if (!ip || base !== `https://${ip}` || !secret) throw new Error("EXECUTOR_NOT_CONFIGURED");
  const body = JSON.stringify(input);
  const response = await fetcher(`${base}${path}`, { method: "POST", cache: "no-store",
    headers: signedExecutorHeaders(secret, path, body, key), body,
    signal: AbortSignal.timeout(path === "/v1/state" ? 25_000 : 35_000) });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    const code = payload.error && /^EXECUTOR_[A-Z0-9_]+$/.test(payload.error)
      ? payload.error : `EXECUTOR_HTTP_${response.status}`;
    throw new Error(code);
  }
  for (const field of ["operator_id", "exchange_account_id", "trading_engine_id", "environment", "symbol", "quote_asset"])
    if ((payload as Record<string, unknown>)[field] !== input[field]) throw new Error("EXECUTOR_RESPONSE_SCOPE_MISMATCH");
  return payload;
}

const readKey = () => `COINOPS:REAL:READ:${randomUUID()}`;
function transientReadError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  return ["EXECUTOR_HTTP_502", "EXECUTOR_HTTP_503", "EXECUTOR_HTTP_504", "EXECUTOR_UNAVAILABLE"].includes(code)
    || error instanceof TypeError
    || error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name);
}
async function readWithRetry<T>(path: "/v1/state" | "/v1/query-order" | "/v1/trades",
  input: (key: string) => Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const key = readKey();
      return await request<T>(path, input(key), key, fetcher);
    } catch (error) {
      if (attempt === 3 || !transientReadError(error)) throw error;
      // Rolling executor restarts may interrupt a GET. Retry observations only;
      // create/cancel requests must still resolve through persisted ownership.
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw new Error("EXECUTOR_READ_UNAVAILABLE");
}
export async function readLiveExecutorHealth(engine: ExecutorEngineScope, fetcher?: typeof fetch) {
  const key = readKey();
  return request<import("./live-executor-health").LiveExecutorHealth>("/v1/health", executorContext(engine, key, key), key, fetcher);
}
export async function readLiveExecutorState(engine: ExecutorEngineScope, fetcher?: typeof fetch) {
  // Retry only an observation. Never retry create/cancel after an uncertain result.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const state = await readWithRetry<LiveExecutorState>("/v1/state",
        (key) => executorContext(engine, key, key), fetcher);
      if (!validState(state, engine)) throw new Error("EXECUTOR_STATE_INVALID");
      return state;
    } catch (error) {
      if (attempt === 0 && error instanceof Error && error.message === "EXECUTOR_STATE_INVALID") continue;
      throw error;
    }
  }
  throw new Error("EXECUTOR_STATE_INVALID");
}
export function readLegacyProductionReconciliation(engine: ExecutorEngineScope, fetcher?: typeof fetch) {
  const key = readKey();
  return request<{
    capabilities: { readEnabled: boolean; tradingEnabled: boolean;
      withdrawalsEnabled: boolean; ipRestricted: boolean | null };
    account: { balances: Array<{ asset: string; free: number; locked: number; total: number }> };
    filters: Record<"BTCUSDT" | "SOLUSDT", unknown>;
    prices: Record<"BTCUSDT" | "SOLUSDT", unknown>;
    orders: import("./types").ExchangeOrder[];
    trades: import("./types").ExchangeTrade[];
  }>("/v1/reconciliation", { scope: "COINOPS_SHADOW_READ_ONLY", ...executorContext(engine, key, key) }, key, fetcher);
}
export async function readLiveExecutorOrder(engine: ExecutorEngineScope, clientOrderId: string,
  orderId?: string | null, fetcher?: typeof fetch) {
  return readWithRetry<{ order: LiveOrder | null }>("/v1/query-order",
    (key) => ({ ...executorContext(engine, key, key), clientOrderId, orderId: orderId ?? null }), fetcher);
}
export async function readLiveExecutorTrades(engine: ExecutorEngineScope, clientOrderId: string,
  orderId: string, fetcher?: typeof fetch) {
  return readWithRetry<{ order: LiveOrder | null; trades: LiveTrade[] | null }>("/v1/trades",
    (key) => ({ ...executorContext(engine, key, key), clientOrderId, orderId }), fetcher);
}
export async function createLiveExecutorOrder(input: Record<string, unknown> & { clientOrderId: string }, engine: ExecutorEngineScope,
  decisionId: string,
  fetcher?: typeof fetch) {
  return request<{ order: LiveOrder; replayed: boolean }>("/v1/create-order", { ...input, ...executorContext(engine, decisionId, input.clientOrderId) },
    input.clientOrderId, fetcher);
}
export async function cancelLiveExecutorOrder(input: { symbol: string;
  clientOrderId: string; orderId: string }, engine: ExecutorEngineScope, fetcher?: typeof fetch) {
  return request<{ order: LiveOrder; replayed: boolean }>("/v1/cancel-order", { ...input,
    ...executorContext(engine, `CANCEL:${input.clientOrderId}`, `CANCEL:${input.clientOrderId}`) },
    `CANCEL:${input.clientOrderId}`, fetcher);
}
