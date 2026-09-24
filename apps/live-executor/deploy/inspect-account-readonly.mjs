/** GET-only account preflight on the fixed-IP executor. Prints no credentials. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadCredential } from "../src/credential-vault.mjs";
import { BinanceSpotAdapter } from "../../web/lib/execution/binance-spot-adapter.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const [operatorId, accountId] = process.argv.slice(2);
if (!UUID.test(operatorId ?? "") || !UUID.test(accountId ?? ""))
  throw new Error("COINOPS_READONLY_SCOPE_INVALID");
const env = Object.fromEntries((await readFile("/etc/coinops/live-executor.env", "utf8"))
  .split(/\r?\n/).filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
  .map((line) => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, "")]; }));
const scope = { operator_id: operatorId, exchange_account_id: accountId,
  credential_ref: `account_${accountId.replaceAll("-", "")}`, environment: "REAL" };
const credential = await loadCredential(join(env.COINOPS_EXECUTOR_STATE_DIR, "credentials"),
  env.COINOPS_EXECUTOR_HMAC_SECRET, scope);
const adapter = new BinanceSpotAdapter(credential, { maxReadRetries: 0 });
const symbols = ["BTCUSDT", "SOLUSDT"];
const [account, filters, prices, orders] = await Promise.all([
  adapter.getAccount(),
  Promise.all(symbols.map((symbol) => adapter.getSymbolInfo(symbol))),
  Promise.all(symbols.map((symbol) => adapter.getMarketPrice(symbol))),
  Promise.all(symbols.map((symbol) => adapter.getOpenOrders(symbol))),
]);
const response = await fetch(`https://api.binance.com/api/v3/exchangeInfo?symbols=${encodeURIComponent(JSON.stringify(symbols))}`,
  { method: "GET", cache: "no-store", signal: AbortSignal.timeout(8_000) });
if (!response.ok) throw new Error("COINOPS_READONLY_FILTERS_UNAVAILABLE");
const raw = await response.json();
const capabilities = (raw.symbols ?? []).map((row) => ({ symbol: row.symbol, status: row.status,
  orderTypes: row.orderTypes, quoteOrderQtyMarketAllowed: row.quoteOrderQtyMarketAllowed,
  marketLot: row.filters?.find((item) => item.filterType === "MARKET_LOT_SIZE") ?? null }));
if (!account.canTrade || filters.length !== 2 || prices.length !== 2 || orders.length !== 2
  || capabilities.length !== 2 || capabilities.some((row) => row.status !== "TRADING"))
  throw new Error("COINOPS_READONLY_PREFLIGHT_INCOMPLETE");
process.stdout.write(JSON.stringify({ mode: "BINANCE_GET_ONLY", accountId, observedAt: new Date().toISOString(),
  balances: account.balances.filter((row) => ["USDT", "BTC", "SOL", "BNB"].includes(row.asset)),
  filters, capabilities, prices, openOrders: orders.flat().map((row) => ({ symbol: row.symbol,
    side: row.side, status: row.status, quantity: row.executedQuantity,
    price: row.price, clientOrderId: row.clientOrderId })) }) + "\n");
