import { randomUUID } from "node:crypto";

import { signedExecutorHeaders } from "./live-executor-client.ts";
import type { RawLiveSymbol } from "./live-preparation.ts";
import { resolveExecutorForAccount, resolveExecutorForEngine, resolveExecutorForConnection, withExecutorShard,
  type ExecutorShardConfig } from "./executor-shards-server.ts";

export type OperatorExchangeSnapshot = { operator_id: string; exchange_account_id: string;
  environment: string; quote_asset: string; observed_at: string; executor_ip: string;
  whitelist_accepted: boolean; permission: Record<string, boolean | null>;
  balances: Array<{ asset: string; free: number; locked: number }>;
  markets: Array<{ symbol: string; price: number; observed_at: string;
    rules: RawLiveSymbol; open_orders: Array<{ clientOrderId: string; side: string; status: string;
      orderId?: string | number; origQty?: string | number; executedQty?: string | number; price?: string | number }> }> };

type AdminPath = "/v1/admin/snapshot" | "/v1/admin/promote" | "/v1/admin/capital" | "/v1/admin/account-cap" | "/v1/admin/registry-append" | "/v1/testnet/transport" | "/v1/admin/account-policy" | "/v1/admin/credentials";
type AdminPrefix = "SNAPSHOT" | "PROMOTE" | "CAPITAL" | "SHARED_CAP" | "REGISTRY" | "TESTNET" | "ACCOUNT_POLICY" | "CREDENTIAL";
async function sendAdmin<T>(target: ExecutorShardConfig, path: AdminPath, payload: Record<string, unknown>, prefix: AdminPrefix): Promise<T> {
  const { base, secret } = target;
  const requestId = randomUUID(), key = `${prefix}:${requestId}`;
  const body = JSON.stringify(withExecutorShard({ ...payload, request_id: requestId }, target));
  const response = await fetch(`${base}${path}`, { method: "POST", cache: "no-store",
    headers: signedExecutorHeaders(secret, path, body, key), body,
    signal: AbortSignal.timeout(25_000) });
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(result.error && /^EXECUTOR_[A-Z0-9_]+$/.test(result.error)
    ? result.error : "COINOPS_ENGINE_EXECUTOR_UNAVAILABLE");
  if (target.shardId !== "executor-01"
    && (result as Record<string, unknown>).executor_shard_id !== target.shardId)
    throw new Error("EXECUTOR_RESPONSE_SHARD_MISMATCH");
  return result;
}
export async function operatorExecutorAdmin<T>(path: AdminPath,
  payload: Record<string, unknown>, prefix: "SNAPSHOT" | "PROMOTE" | "CAPITAL" | "SHARED_CAP" | "REGISTRY" | "TESTNET"): Promise<T> {
  const target = payload.trading_engine_id
    ? await resolveExecutorForEngine(String(payload.operator_id ?? ""), String(payload.exchange_account_id ?? ""), String(payload.trading_engine_id))
    : await resolveExecutorForAccount(String(payload.operator_id ?? ""), String(payload.exchange_account_id ?? ""));
  return sendAdmin<T>(target, path, payload, prefix);
}

/** Explicit destination for a new engine: resolver validates tenant, account,
 * registry/IP and its independent credential connection; no bootstrap fallback. */
export async function operatorConnectionAdmin<T>(operatorId: string, accountId: string, shardId: string,
  path: AdminPath, payload: Record<string, unknown>, prefix: AdminPrefix): Promise<T> {
  const target = await resolveExecutorForConnection(operatorId, accountId, shardId);
  if (payload.operator_id !== undefined && payload.operator_id !== operatorId
    || payload.exchange_account_id !== undefined && payload.exchange_account_id !== accountId
    || payload.credential_ref !== undefined && payload.credential_ref !== target.credentialRef
    || payload.apiKey !== undefined || payload.apiSecret !== undefined)
    throw new Error("EXECUTOR_CONNECTION_SHARD_DENIED");
  return sendAdmin<T>(target, path, { ...payload, operator_id: operatorId,
    exchange_account_id: accountId, credential_ref: target.credentialRef, environment: "REAL" }, prefix);
}

export async function operatorAccountSnapshot(operatorId: string, accountId: string,
  quote: string, symbols: string[], credentialRef = `account_${accountId.replaceAll("-", "")}`,
  environment: "REAL" | "TESTNET" = "REAL", engineId?: string): Promise<OperatorExchangeSnapshot> {
  const result = await operatorExecutorAdmin<OperatorExchangeSnapshot>("/v1/admin/snapshot", {
    operator_id: operatorId, exchange_account_id: accountId,
    credential_ref: credentialRef,
    environment, quote_asset: quote, symbols,
    ...(engineId ? { trading_engine_id: engineId } : {}),
  }, "SNAPSHOT");
  return validateSnapshot(result, operatorId, accountId, quote, symbols, environment);
}
export async function operatorConnectionSnapshot(operatorId: string, accountId: string, shardId: string,
  quote: string, symbols: string[]) {
  const result = await operatorConnectionAdmin<OperatorExchangeSnapshot>(operatorId, accountId, shardId,
    "/v1/admin/snapshot", { quote_asset: quote, symbols: [...new Set(symbols)] }, "SNAPSHOT");
  return validateSnapshot(result, operatorId, accountId, quote, [...new Set(symbols)], "REAL");
}
function validateSnapshot(result: OperatorExchangeSnapshot, operatorId: string, accountId: string,
  quote: string, symbols: string[], environment: "REAL" | "TESTNET") {
  if (result.operator_id !== operatorId || result.exchange_account_id !== accountId
    || result.environment !== environment || result.quote_asset !== quote
    || (environment === "REAL" && (!result.whitelist_accepted || result.permission?.withdrawals !== false))
    || result.permission?.spotTrading !== true
    || !Array.isArray(result.markets) || result.markets.length !== symbols.length
    || symbols.some((symbol) => !result.markets.some((market) => market.symbol === symbol))
    || !Number.isFinite(Date.parse(result.observed_at))
    || Date.now() - Date.parse(result.observed_at) > 30_000 || Date.parse(result.observed_at) > Date.now() + 2000)
    throw new Error("COINOPS_ENGINE_SNAPSHOT_INVALID");
  return result;
}
