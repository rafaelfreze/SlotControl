import { join, resolve } from "node:path";

import { BinanceSpotAdapter } from "../../web/lib/execution/binance-spot-adapter.ts";
import { loadExecutorRegistry, loadCombinedRegistry, promotePreparedRegistryAccount } from "../src/account-registry.mjs";
import { inspectBinanceCredential, loadCredential } from "../src/credential-vault.mjs";

const accountId = process.argv[2];
const directory = resolve(process.env.COINOPS_EXECUTOR_STATE_DIR ?? "");
const secret = process.env.COINOPS_EXECUTOR_HMAC_SECRET;
const expectedIp = process.env.LIVE_EXECUTOR_EGRESS_IP;
if (accountId !== "5580c011-6ff1-44bd-b568-85932b424ceb" || !secret
  || !process.env.COINOPS_EXECUTOR_STATE_DIR || expectedIp !== "46.101.104.48")
  throw new Error("THYELY_ACTIVATION_SCOPE_DENIED");

const staticRegistry = await loadExecutorRegistry(process.env.COINOPS_EXECUTOR_REGISTRY_PATH);
const registry = await loadCombinedRegistry(staticRegistry, directory, (code) => {
  throw new Error(`THYELY_REGISTRY_UNAVAILABLE:${code}`);
});
const rows = registry.engines.filter((row) => row.exchange_account_id === accountId);
if (rows.length !== 2 || new Set(rows.map((row) => row.symbol)).size !== 2
  || !rows.some((row) => row.symbol === "BTCUSDT") || !rows.some((row) => row.symbol === "SOLUSDT")
  || rows.some((row) => row.operator_id !== "d508bb3e-5a1d-4579-bd7a-de171c118d25"
    || row.account_cap_quote !== 838 || row.hard_cap_quote !== 419 || row.max_order_quote !== 419))
  throw new Error("THYELY_REGISTRY_SCOPE_DENIED");
const scope = { operator_id: rows[0].operator_id, exchange_account_id: accountId,
  credential_ref: rows[0].credential_ref, environment: "REAL" };
const credential = await loadCredential(join(directory, "credentials"), secret, scope);
const inspection = await inspectBinanceCredential({ apiKey: credential.apiKey,
  apiSecret: credential.apiSecret, environment: "REAL", expectedEgressIp: expectedIp });
const quote = inspection.balances.find((row) => row.asset === "USDT");
const feeReserve = inspection.balances.find((row) => row.asset === "BNB");
if (inspection.status !== "PASS" || inspection.executorIp !== expectedIp
  || !quote || quote.free < 838 || quote.locked !== 0
  || !feeReserve || feeReserve.free <= 0.00001
  || ["BTC", "SOL"].some((asset) => {
    const balance = inspection.balances.find((row) => row.asset === asset);
    return balance && (balance.free !== 0 || balance.locked !== 0);
  })) throw new Error("THYELY_EXCHANGE_BALANCE_OR_PERMISSION_DENIED");
const adapter = new BinanceSpotAdapter(credential, { maxReadRetries: 0 });
const bnbPrice = await adapter.getMarketPrice("BNBUSDT");
if (bnbPrice.price <= 0) throw new Error("THYELY_FEE_RESERVE_PRICE_DENIED");
for (const symbol of ["BTCUSDT", "SOLUSDT"]) {
  const [orders, filters, price, rawResponse] = await Promise.all([
    adapter.getOpenOrders(symbol), adapter.getSymbolInfo(symbol), adapter.getMarketPrice(symbol),
    fetch(`https://api.binance.com/api/v3/exchangeInfo?symbol=${symbol}`,
      { cache: "no-store", signal: AbortSignal.timeout(8000) }),
  ]);
  const raw = rawResponse.ok ? (await rawResponse.json()).symbols?.[0] : null;
  if (orders.length !== 0 || filters.symbol !== symbol || raw?.symbol !== symbol
    || raw.status !== "TRADING" || !raw.orderTypes?.includes("MARKET")
    || !raw.orderTypes?.includes("LIMIT") || raw.quoteOrderQtyMarketAllowed !== true
    || filters.quoteAsset !== "USDT" || filters.minNotional > 16.76
    || filters.quantityStep <= 0 || price.price <= 0)
    throw new Error(`THYELY_MARKET_GATE_DENIED:${symbol}`);
}
const result = await promotePreparedRegistryAccount(staticRegistry, directory, scope,
  rows.map((row) => ({ trading_engine_id: row.trading_engine_id, symbol: row.symbol,
    hard_cap_quote: row.hard_cap_quote, max_order_quote: row.max_order_quote })));
console.log(JSON.stringify({ account_id: accountId, status: result.status,
  promoted_engines: result.promoted_engines, replayed: result.replayed,
  executor_ip: inspection.executorIp, usdt_free: quote.free, unallocated_usdt: quote.free - 838,
  observed_at: inspection.validatedAt, exchange_orders_open: 0 }));
