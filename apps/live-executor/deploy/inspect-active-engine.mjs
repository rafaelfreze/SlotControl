/** Root-only, GET-equivalent health/state read for an ACTIVE registry engine. */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { signedExecutorHeaders } from "../../web/lib/execution/live-executor-client.ts";
import { loadExecutorRegistry, loadCombinedRegistry } from "../src/account-registry.mjs";

const env = Object.fromEntries((await readFile("/etc/coinops/live-executor.env", "utf8"))
  .split(/\r?\n/).filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
  .map((line) => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, "")]; }));
if (!env.COINOPS_EXECUTOR_HMAC_SECRET || env.LIVE_EXECUTOR_EGRESS_IP !== "46.101.104.48")
  throw new Error("COINOPS_ACTIVE_INSPECTION_SCOPE_DENIED");
const staticRegistry = await loadExecutorRegistry(env.COINOPS_EXECUTOR_REGISTRY_PATH);
const registry = await loadCombinedRegistry(staticRegistry, env.COINOPS_EXECUTOR_STATE_DIR, (code) => {
  throw new Error(code);
});
const rows = registry.engines.filter((row) => row.exchange_account_id === process.argv[2]);
if (rows.length !== 2 || rows.some((row) => row.status !== "ACTIVE" || !row.execution_allowed
  || row.kill_switch || row.account_kill_switch || row.global_kill_switch))
  throw new Error("COINOPS_ACTIVE_INSPECTION_ENGINE_DENIED");
const output = [];
for (const engine of rows) {
  const readings = {};
  for (const path of ["/v1/health", "/v1/state"]) {
    const key = `COINOPS:REAL:READ:${randomUUID()}`;
    const body = JSON.stringify({ operator_id: engine.operator_id,
      exchange_account_id: engine.exchange_account_id, trading_engine_id: engine.trading_engine_id,
      environment: engine.environment, symbol: engine.symbol, quote_asset: engine.quote_asset,
      decision_id: key, idempotency_key: key });
    const response = await fetch(`https://${env.LIVE_EXECUTOR_EGRESS_IP}${path}`,
      { method: "POST", headers: signedExecutorHeaders(env.COINOPS_EXECUTOR_HMAC_SECRET, path, body, key),
        body, signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    if (!response.ok) throw new Error(`COINOPS_ACTIVE_INSPECTION_HTTP_${response.status}:${result.error ?? "UNKNOWN"}`);
    if (path === "/v1/health") readings.health = { healthy: result.healthy, version: result.version,
      egress_ipv4_verified: result.egress_ipv4_verified, account_permission: result.account_permission,
      trading_enabled: result.trading_enabled, kill_switch: result.kill_switch };
    else readings.state = { balances: result.balances?.filter((item) => ["USDT", "BTC", "SOL", "BNB"].includes(item.asset)),
      filters: result.filters, price: result.price, open_orders: result.open_orders?.length,
      observed_at: result.observed_at };
  }
  output.push({ symbol: engine.symbol, ...readings });
}
console.log(JSON.stringify({ account_id: process.argv[2], mode: "READ_ONLY", engines: output }));
