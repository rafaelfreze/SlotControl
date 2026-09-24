import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

import { STRATEGY_VERSION } from "./strategy-engine.ts";
import type { LiveConfig } from "./live-preparation.ts";
import type { ExecutorEngineScope } from "./live-executor-transport.ts";

export function signedExecutorHeaders(secret: string, path: string, body: string, idempotencyKey: string,
  timestamp = Date.now(), nonce = randomBytes(18).toString("base64url")): Headers {
  if (Buffer.byteLength(secret) < 32) throw new Error("EXECUTOR_AUTH_NOT_CONFIGURED");
  if (!["/v1/health", "/v1/dry-run", "/v1/state", "/v1/query-order", "/v1/trades", "/v1/reconciliation",
    "/v1/create-order", "/v1/cancel-order", "/v1/admin/credentials", "/v1/admin/registry"].includes(path)) throw new Error("EXECUTOR_ROUTE_DENIED");
  const hash = createHash("sha256").update(body).digest("hex");
  const canonical = ["POST", path, String(timestamp), nonce, hash].join("\n");
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  return new Headers({ "content-type": "application/json", "x-coinops-timestamp": String(timestamp),
    "x-coinops-nonce": nonce, "x-coinops-body-sha256": hash,
    "x-coinops-signature": signature, "x-coinops-idempotency-key": idempotencyKey });
}

export function signedDryRunHeaders(secret: string, body: string, idempotencyKey: string,
  timestamp = Date.now(), nonce = randomBytes(18).toString("base64url")): Headers {
  return signedExecutorHeaders(secret, "/v1/dry-run", body, idempotencyKey, timestamp, nonce);
}

export async function requestExecutorDryRun(config: LiveConfig, portfolioCaps: { BTC: number; SOL: number },
  globalCapBrl: number, engine: ExecutorEngineScope, fetcher: typeof fetch = fetch) {
  const ip = process.env.LIVE_EXECUTOR_EGRESS_IP;
  const base = process.env.LIVE_EXECUTOR_BASE_URL;
  const secret = process.env.COINOPS_EXECUTOR_HMAC_SECRET;
  if (!ip || base !== `https://${ip}` || !secret) throw new Error("EXECUTOR_NOT_CONFIGURED");
  const requestId = randomUUID();
  const decisionId = `COINOPS:REAL:${config.asset}:diagnostic:${requestId}`;
  const body = JSON.stringify({ action: "DRY_RUN", environment: "REAL", asset: config.asset,
    operator_id: engine.operator_id, exchange_account_id: engine.exchange_account_id,
    trading_engine_id: engine.trading_engine_id, quote_asset: engine.quote_asset,
    idempotency_key: decisionId, symbol: config.symbol, decision_id: decisionId,
    strategy_version: STRATEGY_VERSION,
    config: { ...config, gain_rate: Number(config.gain_rate),
      normal_spacing_rate: Number(config.normal_spacing_rate),
      post_ath_spacing_rate: Number(config.post_ath_spacing_rate),
      configured_live_capital_brl: Number(config.configured_live_capital_brl),
      max_order_notional_brl: Number(config.max_order_notional_brl),
      max_total_exposure_brl: Number(config.max_total_exposure_brl) },
    portfolio_caps_brl: portfolioCaps, global_cap_brl: globalCapBrl });
  const started = Date.now();
  const response = await fetcher(`${base}/v1/dry-run`, { method: "POST", cache: "no-store",
    headers: signedDryRunHeaders(secret, body, decisionId),
    body, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`EXECUTOR_DRY_RUN_HTTP_${response.status}`);
  const result = await response.json() as { status: string; strategy_version: string;
    operator_id: string; exchange_account_id: string; trading_engine_id: string; quote_asset: string;
    symbol: string; valid_slots: number; initial: { action_type: string };
    next_buy: { action_type: string }; planned: unknown[]; trading_enabled: boolean; kill_switch: boolean };
  if (result.status !== "NO_WRITE" || result.strategy_version !== STRATEGY_VERSION
    || result.operator_id !== engine.operator_id || result.exchange_account_id !== engine.exchange_account_id
    || result.trading_engine_id !== engine.trading_engine_id || result.quote_asset !== engine.quote_asset
    || result.symbol !== config.symbol || result.valid_slots !== 25
    || result.trading_enabled !== false || result.kill_switch !== true)
    throw new Error("EXECUTOR_DRY_RUN_RESPONSE_UNSAFE");
  return { asset: config.asset, status: result.status, strategy_version: result.strategy_version,
    valid_slots: result.valid_slots, initial: result.initial.action_type,
    next_buy: result.next_buy.action_type, planned: result.planned.length,
    latency_ms: Date.now() - started };
}
