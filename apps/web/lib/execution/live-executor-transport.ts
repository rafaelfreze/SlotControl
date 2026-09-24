import { randomUUID } from "node:crypto";

import { signedExecutorHeaders } from "./live-executor-client.ts";

export type LiveOrder = { orderId: string; clientOrderId: string; symbol: "BTCBRL" | "SOLBRL";
  side: "BUY" | "SELL"; status: string; executedQuantity: number;
  cumulativeQuoteQuantity: number; price: number };
export type LiveTrade = { id: string; quantity: number; quoteQuantity: number;
  commission: number; commissionAsset: string; isBuyer: boolean; filledAt: string };
export type LiveExecutorState = { symbol: "BTCBRL" | "SOLBRL";
  balances: Array<{ asset: string; free: number; locked: number; total: number }>;
  filters: { symbol: string; baseAsset: string; quoteAsset: string; minQuantity: number;
    maxQuantity: number; quantityStep: number; minNotional: number; priceTick: number };
  price: { symbol: string; price: number; observedAt: string };
  bnb_brl_price: { symbol: string; price: number; observedAt: string } | null;
  open_orders: Array<{ id: string; symbol: string; side: string; status: string;
    executedQuantity: number; price: number | null; clientOrderId: string | null }>;
  observed_at: string };

function validState(value: LiveExecutorState, symbol: "BTCBRL" | "SOLBRL") {
  return value?.symbol === symbol && Array.isArray(value.balances)
    && value.filters?.symbol === symbol
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
  return payload;
}

const readKey = () => `COINOPS:REAL:READ:${randomUUID()}`;
export async function readLiveExecutorState(symbol: "BTCBRL" | "SOLBRL", fetcher?: typeof fetch) {
  // Retry only an observation. Never retry create/cancel after an uncertain result.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const state = await request<LiveExecutorState>("/v1/state", { symbol }, readKey(), fetcher);
      if (!validState(state, symbol)) throw new Error("EXECUTOR_STATE_INVALID");
      return state;
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const transient = code === "EXECUTOR_STATE_INVALID"
        || code === "EXECUTOR_HTTP_502" || code === "EXECUTOR_HTTP_503"
        || code === "EXECUTOR_HTTP_504" || error instanceof TypeError
        || error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name);
      if (attempt === 0 && transient) continue;
      throw error;
    }
  }
  throw new Error("EXECUTOR_STATE_INVALID");
}
export function readLegacyProductionReconciliation(fetcher?: typeof fetch) {
  return request<{
    capabilities: { readEnabled: boolean; tradingEnabled: boolean;
      withdrawalsEnabled: boolean; ipRestricted: boolean | null };
    account: { balances: Array<{ asset: string; free: number; locked: number; total: number }> };
    filters: Record<"BTCUSDT" | "SOLUSDT", unknown>;
    prices: Record<"BTCUSDT" | "SOLUSDT", unknown>;
    orders: import("./types").ExchangeOrder[];
    trades: import("./types").ExchangeTrade[];
  }>("/v1/reconciliation", { scope: "COINOPS_SHADOW_READ_ONLY" }, readKey(), fetcher);
}
export async function readLiveExecutorOrder(symbol: "BTCBRL" | "SOLBRL", clientOrderId: string,
  orderId?: string | null, fetcher?: typeof fetch) {
  return request<{ order: LiveOrder | null }>("/v1/query-order",
    { symbol, clientOrderId, orderId: orderId ?? null }, readKey(), fetcher);
}
export async function readLiveExecutorTrades(symbol: "BTCBRL" | "SOLBRL", clientOrderId: string,
  orderId: string, fetcher?: typeof fetch) {
  return request<{ order: LiveOrder | null; trades: LiveTrade[] | null }>("/v1/trades",
    { symbol, clientOrderId, orderId }, readKey(), fetcher);
}
export async function createLiveExecutorOrder(input: Record<string, unknown> & { clientOrderId: string },
  fetcher?: typeof fetch) {
  return request<{ order: LiveOrder; replayed: boolean }>("/v1/create-order", input,
    input.clientOrderId, fetcher);
}
export async function cancelLiveExecutorOrder(input: { symbol: "BTCBRL" | "SOLBRL";
  clientOrderId: string; orderId: string }, fetcher?: typeof fetch) {
  return request<{ order: LiveOrder; replayed: boolean }>("/v1/cancel-order", input,
    `CANCEL:${input.clientOrderId}`, fetcher);
}
