/** Direct, read-only Binance observation from the fixed-IP executor.
 * Run as root on the executor. Never print environment values or raw balances. */
import { readFile } from "node:fs/promises";
import { loadExecutorRegistry } from "../src/account-registry.mjs";
import { BinanceLiveTransport } from "../src/binance-live.mjs";

const env = Object.fromEntries((await readFile("/etc/coinops/live-executor.env", "utf8"))
  .split(/\r?\n/).filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
  .map((line) => { const position = line.indexOf("="); return [line.slice(0, position), line.slice(position + 1).replace(/^['"]|['"]$/g, "")]; }));
const registry = await loadExecutorRegistry(env.COINOPS_EXECUTOR_REGISTRY_PATH);
const results = [];
for (const engine of registry.engines.filter((row) => row.is_legacy_default && ["BTCBRL", "SOLBRL"].includes(row.symbol))) {
  const reference = registry.credentials[engine.credential_ref];
  const transport = new BinanceLiveTransport({ apiKey: env[reference.api_key_env],
    apiSecret: env[reference.api_secret_env], fetcher: fetch, now: Date.now, engine });
  const snapshot = await transport.safetySnapshot(engine.symbol);
  results.push({ symbol: engine.symbol, account_id: engine.exchange_account_id,
    trading_engine_id: engine.trading_engine_id, observed_at: new Date().toISOString(),
    orders: snapshot.openOrders.map((order) => ({ client_order_id: order.clientOrderId,
      order_id: order.id, side: order.side, status: order.status, quantity: order.executedQuantity,
      price: order.price })) });
}
if (results.length !== 2) throw new Error("COINOPS_RAFAEL_ENGINE_COUNT_INVALID");
process.stdout.write(JSON.stringify({ mode: "BINANCE_GET_ONLY", results }) + "\n");
