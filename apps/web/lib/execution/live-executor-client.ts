import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

import { STRATEGY_VERSION } from "./strategy-engine.ts";
import type { LiveConfig } from "./live-preparation.ts";

export function signedDryRunHeaders(secret: string, body: string, idempotencyKey: string,
  timestamp = Date.now(), nonce = randomBytes(18).toString("base64url")): Headers {
  if (Buffer.byteLength(secret) < 32) throw new Error("EXECUTOR_AUTH_NOT_CONFIGURED");
  const hash = createHash("sha256").update(body).digest("hex");
  const canonical = ["POST", "/v1/dry-run", String(timestamp), nonce, hash].join("\n");
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  return new Headers({ "content-type": "application/json", "x-coinops-timestamp": String(timestamp),
    "x-coinops-nonce": nonce, "x-coinops-body-sha256": hash,
    "x-coinops-signature": signature, "x-coinops-idempotency-key": idempotencyKey });
}

export async function requestExecutorDryRun(config: LiveConfig, portfolioCaps: { BTC: number; SOL: number },
  globalCapBrl: number, fetcher: typeof fetch = fetch) {
  const ip = process.env.LIVE_EXECUTOR_EGRESS_IP;
  const base = process.env.LIVE_EXECUTOR_BASE_URL;
  const secret = process.env.COINOPS_EXECUTOR_HMAC_SECRET;
  if (!ip || base !== `https://${ip}` || !secret) throw new Error("EXECUTOR_NOT_CONFIGURED");
  const requestId = randomUUID();
  const body = JSON.stringify({ action: "DRY_RUN", environment: "REAL", asset: config.asset,
    symbol: config.symbol, decision_id: `COINOPS:REAL:${config.asset}:diagnostic:${requestId}`,
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
    headers: signedDryRunHeaders(secret, body, `COINOPS:REAL:${config.asset}:diagnostic:${requestId}`),
    body, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`EXECUTOR_DRY_RUN_HTTP_${response.status}`);
  const result = await response.json() as { status: string; strategy_version: string;
    symbol: string; valid_slots: number; initial: { action_type: string };
    next_buy: { action_type: string }; planned: unknown[]; trading_enabled: boolean; kill_switch: boolean };
  if (result.status !== "NO_WRITE" || result.strategy_version !== STRATEGY_VERSION
    || result.symbol !== config.symbol || result.valid_slots !== 25
    || result.trading_enabled !== false || result.kill_switch !== true)
    throw new Error("EXECUTOR_DRY_RUN_RESPONSE_UNSAFE");
  return { asset: config.asset, status: result.status, strategy_version: result.strategy_version,
    valid_slots: result.valid_slots, initial: result.initial.action_type,
    next_buy: result.next_buy.action_type, planned: result.planned.length,
    latency_ms: Date.now() - started };
}
