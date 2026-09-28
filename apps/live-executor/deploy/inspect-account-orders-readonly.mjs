/** Read-only exact-account evidence. Never submits, cancels or tests an order. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [source, ...accountIds] = process.argv.slice(2);
if (!source?.startsWith("/opt/coinops/") || !accountIds.length
  || accountIds.some((id) => !/^[0-9a-f-]{36}$/.test(id))) throw new Error("READ_SCOPE_INVALID");
const env = Object.fromEntries((await readFile("/etc/coinops/live-executor.env", "utf8"))
  .split(/\r?\n/).filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line)).map((line) => {
    const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1).replace(/^['"]|['"]$/g, "")];
  }));
const module = (name) => import(pathToFileURL(join(source, "apps/live-executor/src", name)));
const { loadExecutorRegistry, loadCombinedRegistry } = await module("account-registry.mjs");
const { loadCredential } = await module("credential-vault.mjs");
const { BinanceLiveTransport } = await module("binance-live.mjs");
const registry = await loadCombinedRegistry(await loadExecutorRegistry(env.COINOPS_EXECUTOR_REGISTRY_PATH),
  env.COINOPS_EXECUTOR_STATE_DIR, (code) => { throw new Error(code); });
const output = [];
for (const accountId of accountIds) {
  const engines = registry.engines.filter((e) => e.exchange_account_id === accountId && e.environment === "REAL");
  if (!engines.length) throw new Error("READ_ACCOUNT_NOT_IN_REGISTRY");
  for (const engine of engines) {
    const ref = registry.credentials[engine.credential_ref];
    const credential = ref.vault ? await loadCredential(join(env.COINOPS_EXECUTOR_STATE_DIR, "credentials"),
      env.COINOPS_EXECUTOR_HMAC_SECRET, engine)
      : { apiKey: env[ref.api_key_env], apiSecret: env[ref.api_secret_env] };
    const transport = new BinanceLiveTransport({ ...credential, engine });
    const response = await transport.signed("GET", "/api/v3/openOrders", { symbol: engine.symbol });
    if (!response.ok || !Array.isArray(response.body)) throw new Error("READ_OPEN_ORDERS_FAILED");
    const filters = await transport.reads.getSymbolInfo(engine.symbol);
    output.push({ account_id: accountId, engine_id: engine.trading_engine_id, symbol: engine.symbol,
      caps: { engine: engine.hard_cap_quote, account: engine.account_cap_quote, max_order: engine.max_order_quote },
      filters, orders: response.body.map((o) => ({ client_order_id: o.clientOrderId,
        order_id: String(o.orderId), side: o.side, status: o.status, price: Number(o.price),
        quantity: Number(o.origQty), executed_quantity: Number(o.executedQty), updated_at: o.updateTime })) });
  }
}
console.log(JSON.stringify({ observed_at: new Date().toISOString(), mode: "BINANCE_GET_ONLY", output }));
