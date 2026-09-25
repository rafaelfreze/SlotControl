import { randomUUID } from "node:crypto";

import { signedExecutorHeaders } from "./live-executor-client.ts";
import type { RawLiveSymbol } from "./live-preparation.ts";

export type OperatorExchangeSnapshot = { operator_id: string; exchange_account_id: string;
  environment: string; quote_asset: string; observed_at: string; executor_ip: string;
  whitelist_accepted: boolean; permission: Record<string, boolean | null>;
  balances: Array<{ asset: string; free: number; locked: number }>;
  markets: Array<{ symbol: string; price: number; observed_at: string;
    rules: RawLiveSymbol; open_orders: Array<{ clientOrderId: string; side: string; status: string }> }> };

function config() {
  const ip = process.env.LIVE_EXECUTOR_EGRESS_IP;
  const base = process.env.LIVE_EXECUTOR_BASE_URL;
  const secret = process.env.COINOPS_EXECUTOR_HMAC_SECRET;
  if (!ip || base !== `https://${ip}` || !secret) throw new Error("COINOPS_ENGINE_EXECUTOR_UNAVAILABLE");
  return { base, secret };
}

export async function operatorExecutorAdmin<T>(path: "/v1/admin/snapshot" | "/v1/admin/promote" | "/v1/admin/capital" | "/v1/testnet/transport",
  payload: Record<string, unknown>, prefix: "SNAPSHOT" | "PROMOTE" | "CAPITAL" | "TESTNET"): Promise<T> {
  const { base, secret } = config();
  const requestId = randomUUID(), key = `${prefix}:${requestId}`;
  const body = JSON.stringify({ ...payload, request_id: requestId });
  const response = await fetch(`${base}${path}`, { method: "POST", cache: "no-store",
    headers: signedExecutorHeaders(secret, path, body, key), body,
    signal: AbortSignal.timeout(25_000) });
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(result.error && /^EXECUTOR_[A-Z0-9_]+$/.test(result.error)
    ? result.error : "COINOPS_ENGINE_EXECUTOR_UNAVAILABLE");
  return result;
}

export async function operatorAccountSnapshot(operatorId: string, accountId: string,
  quote: string, symbols: string[], credentialRef = `account_${accountId.replaceAll("-", "")}`,
  environment: "REAL" | "TESTNET" = "REAL"): Promise<OperatorExchangeSnapshot> {
  const result = await operatorExecutorAdmin<OperatorExchangeSnapshot>("/v1/admin/snapshot", {
    operator_id: operatorId, exchange_account_id: accountId,
    credential_ref: credentialRef,
    environment, quote_asset: quote, symbols,
  }, "SNAPSHOT");
  if (result.operator_id !== operatorId || result.exchange_account_id !== accountId
    || result.environment !== environment || result.quote_asset !== quote
    || (environment === "REAL" && (!result.whitelist_accepted || result.permission?.withdrawals !== false))
    || result.permission?.spotTrading !== true
    || !Array.isArray(result.markets) || result.markets.length !== symbols.length
    || symbols.some((symbol) => !result.markets.some((market) => market.symbol === symbol))
    || !Number.isFinite(Date.parse(result.observed_at))
    || Date.now() - Date.parse(result.observed_at) > 30_000)
    throw new Error("COINOPS_ENGINE_SNAPSHOT_INVALID");
  return result;
}
