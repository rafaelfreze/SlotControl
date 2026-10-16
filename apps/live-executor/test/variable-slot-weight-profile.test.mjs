import assert from "node:assert/strict";
import test from "node:test";
import { BinanceLiveTransport } from "../src/binance-live.mjs";

const NOW = Date.parse("2026-10-16T16:00:00Z");
const ID = "COR1-SOL-1-1-SELL-0123456789abcd";

// Official REST weights verified on 2026-10-16. In particular, myTrades with
// orderId is 5, not the historical 20 for a symbol-wide trade-history read.
// https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/account
// https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/general
// https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market
// https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/account
function weight(url) {
  const path = url.pathname;
  if (path === "/api/v3/time") return 1;
  if (path === "/api/v3/account" || path === "/api/v3/exchangeInfo") return 20;
  if (path === "/api/v3/ticker/price") return url.searchParams.has("symbol") ? 2 : 4;
  if (path === "/api/v3/openOrders") return url.searchParams.has("symbol") ? 6 : 80;
  if (path === "/sapi/v1/account/apiRestrictions") return 1;
  if (path === "/api/v3/order") return 4;
  if (path === "/api/v3/myTrades") return url.searchParams.has("orderId") ? 5 : 20;
  assert.fail(`Unreviewed request ${path}`);
}

function fixture() {
  const calls = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    assert.equal(init.method ?? "GET", "GET", "this inventory cannot send exchange writes");
    calls.push({ host: url.hostname, path: url.pathname, weight: weight(url) });
    if (url.pathname === "/api/v3/time") return Response.json({ serverTime: NOW });
    if (url.pathname === "/api/v3/account") return Response.json({ canTrade: true, balances: [
      { asset: "BRL", free: "1100", locked: "0" }, { asset: "SOL", free: "0", locked: "0" },
      { asset: "BNB", free: ".005", locked: "0" }] });
    if (url.pathname === "/sapi/v1/account/apiRestrictions") return Response.json({ ipRestrict: true,
      enableReading: true, enableSpotAndMarginTrading: true, enableWithdrawals: false,
      enableInternalTransfer: false, permitsUniversalTransfer: false, enableMargin: false,
      enableFutures: false, enableVanillaOptions: false, enablePortfolioMarginTrading: false, enableFixApiTrade: false });
    if (url.pathname === "/api/v3/exchangeInfo") return Response.json({ symbols: [{ symbol: "SOLBRL",
      baseAsset: "SOL", quoteAsset: "BRL", filters: [
        { filterType: "LOT_SIZE", minQty: ".001", maxQty: "100000", stepSize: ".001" },
        { filterType: "PRICE_FILTER", minPrice: ".1", maxPrice: "10000000", tickSize: ".1" },
        { filterType: "NOTIONAL", minNotional: "10" }] }] });
    if (url.pathname === "/api/v3/ticker/price") return Response.json({ symbol: url.searchParams.get("symbol"), price: "500" });
    if (url.pathname === "/api/v3/openOrders") return Response.json([]);
    if (url.pathname === "/api/v3/order") return Response.json({ symbol: "SOLBRL", clientOrderId: ID,
      orderId: 123, side: "SELL", status: "FILLED", executedQty: ".02", cummulativeQuoteQty: "10.3", price: "515" });
    if (url.pathname === "/api/v3/myTrades") return Response.json([]);
    assert.fail(`Unexpected request ${url.pathname}`);
  };
  const transport = () => new BinanceLiveTransport({ apiKey: "fixture-key", apiSecret: "fixture-secret", fetcher, now: () => NOW });
  const totals = () => ({ all: calls.reduce((sum, call) => sum + call.weight, 0),
    api: calls.filter(call => call.host === "api.binance.com").reduce((sum, call) => sum + call.weight, 0),
    public: calls.filter(call => call.host === "data-api.binance.vision").reduce((sum, call) => sum + call.weight, 0) });
  return { calls, transport, totals };
}

test("fresh safetySnapshot inventories all GETs including concurrent independent clocks", async () => {
  const f = fixture();
  await f.transport().safetySnapshot("SOLBRL");
  assert.equal(f.calls.filter(call => call.path === "/api/v3/time").length, 3);
  assert.deepEqual(f.totals(), { all: 54, api: 30, public: 24 });
});

test("query endpoint and trades endpoint use fresh clocks and orderId-scoped trades", async () => {
  const query = fixture();
  await query.transport().queryOrder("SOLBRL", ID, "123");
  assert.deepEqual(query.totals(), { all: 5, api: 5, public: 0 });
  const trades = fixture(), transport = trades.transport();
  // Mirrors server.mjs /v1/trades: queryOrder, then ownedTrades (which
  // independently reconfirms ownership), not an unscoped history query.
  const observed = await transport.queryOrder("SOLBRL", ID, "123");
  await transport.ownedTrades("SOLBRL", ID, observed.orderId);
  assert.deepEqual(trades.totals(), { all: 14, api: 14, public: 0 });
});

for (const count of [25, 100]) test(`${count} resident orders: steady and simultaneous-fill component costs`, async () => {
  const steady = fixture();
  // Five fixed snapshots in the ACTIVE unchanged-order path. Terminal orders
  // already reconciled are skipped. No new-order or health costs are included.
  for (let index = 0; index < 5; index++) await steady.transport().safetySnapshot("SOLBRL");
  for (let index = 0; index < count; index++) await steady.transport().queryOrder("SOLBRL", ID, "123");
  assert.deepEqual(steady.totals(), { all: 270 + count * 5, api: 150 + count * 5, public: 120 });
  const burst = fixture();
  for (let index = 0; index < 5; index++) await burst.transport().safetySnapshot("SOLBRL");
  for (let index = 0; index < count; index++) {
    await burst.transport().queryOrder("SOLBRL", ID, "123");
    const transport = burst.transport();
    const order = await transport.queryOrder("SOLBRL", ID, "123");
    await transport.ownedTrades("SOLBRL", ID, order.orderId);
    await burst.transport().safetySnapshot("SOLBRL");
  }
  assert.deepEqual(burst.totals(), { all: 270 + count * 73, api: 150 + count * 49, public: 120 + count * 24 });
});
