import assert from "node:assert/strict";
import test from "node:test";

import { BinanceLiveTransport } from "../src/binance-live.mjs";

const NOW = Date.parse("2026-09-24T03:00:00.000Z");
const BTC_ID = "COR1-BTC-1-1-BUY-0123456789abcd";

function fixture({ openOrders = [], existingOrder = null, trades = [], failFirstOpenOrders = false,
  restrictionsStatus = 200 } = {}) {
  const calls = [];
  let order = existingOrder;
  let openOrderFailures = 0;
  const filters = { symbol: "BTCBRL", status: "TRADING", baseAsset: "BTC", quoteAsset: "BRL",
    filters: [
      { filterType: "LOT_SIZE", minQty: "0.00001", maxQty: "100", stepSize: "0.00001" },
      { filterType: "PRICE_FILTER", minPrice: "1", maxPrice: "10000000", tickSize: "1" },
      { filterType: "NOTIONAL", minNotional: "10" },
    ] };
  const restrictions = { ipRestrict: true, enableReading: true, enableSpotAndMarginTrading: true,
    enableWithdrawals: false, enableInternalTransfer: false, permitsUniversalTransfer: false,
    enableMargin: false, enableFutures: false, enableVanillaOptions: false,
    enablePortfolioMarginTrading: false, enableFixApiTrade: false };
  const fetcher = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, method: init.method ?? "GET",
      params: init.body ? new URLSearchParams(init.body) : parsed.searchParams });
    if (parsed.pathname === "/api/v3/time") return Response.json({ serverTime: NOW });
    if (parsed.pathname === "/api/v3/account") return Response.json({ canTrade: true, balances: [
      { asset: "BRL", free: "730", locked: "0" }, { asset: "BTC", free: "0", locked: "0" },
      { asset: "BNB", free: "0.005", locked: "0" }] });
    if (parsed.pathname === "/sapi/v1/account/apiRestrictions")
      return Response.json(restrictionsStatus === 200 ? restrictions : { code: -1003 },
        { status: restrictionsStatus });
    if (parsed.pathname === "/api/v3/exchangeInfo") {
      const symbol = parsed.searchParams.get("symbol") ?? "BTCBRL";
      return Response.json({ symbols: [{ ...filters, symbol,
        baseAsset: symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol.slice(0, -3),
        quoteAsset: symbol.endsWith("USDT") ? "USDT" : "BRL" }] });
    }
    if (parsed.pathname === "/api/v3/ticker/price") {
      const symbol = parsed.searchParams.get("symbol") ?? "BTCBRL";
      return Response.json({ symbol, price: symbol === "BNBBRL" ? "5000" : "437724" });
    }
    if (parsed.pathname === "/api/v3/openOrders") {
      if (failFirstOpenOrders && openOrderFailures++ === 0) throw new Error("transient read timeout");
      return Response.json(openOrders);
    }
    if (parsed.pathname === "/api/v3/myTrades") return Response.json(trades);
    if (parsed.pathname === "/api/v3/order" && init.method === "GET")
      return order ? Response.json(order) : Response.json({ code: -2013 }, { status: 400 });
    if (parsed.pathname === "/api/v3/order" && init.method === "POST") {
      order = { symbol: "BTCBRL", clientOrderId: BTC_ID, orderId: 123, side: "BUY", status: "FILLED",
        executedQty: "0.00004", cummulativeQuoteQty: "17.50", price: "0" };
      return Response.json(order);
    }
    if (parsed.pathname === "/api/v3/order" && init.method === "DELETE") {
      order = { ...order, status: "CANCELED" };
      return Response.json({ ...order, origClientOrderId: BTC_ID });
    }
    throw new Error(`Unexpected ${parsed.pathname}`);
  };
  return { transport: new BinanceLiveTransport({ apiKey: "test-key", apiSecret: "test-secret",
    fetcher, now: () => NOW }), calls };
}

function marketIntent(overrides = {}) {
  return { symbol: "BTCBRL", clientOrderId: BTC_ID, side: "BUY", purpose: "INITIAL",
    type: "MARKET", quoteOrderQty: "17.50", expectedOwnedOpenIds: [],
    assetCapBrl: 450, globalCapBrl: 725, assetExposureBeforeBrl: 0,
    globalExposureBeforeBrl: 0, ...overrides };
}

test("Production transport rejects unsupported pairs and kill switch before Binance POST", async () => {
  const { transport, calls } = fixture();
  await assert.rejects(transport.createOwnedOrder(marketIntent({ symbol: "BTCUSDT" }),
    { allowCreate: true, tradingEnabled: true, killSwitch: false }), /ORDER_NOT_OWNED/);
  await assert.rejects(transport.createOwnedOrder(marketIntent(),
    { allowCreate: true, tradingEnabled: false, killSwitch: true }), /TRADING_DISABLED/);
  await assert.rejects(transport.createOwnedOrder(marketIntent(),
    { allowCreate: false, tradingEnabled: true, killSwitch: false }), /SUBMISSION_OUTCOME_UNKNOWN/);
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
});

test("complete safety snapshot retries one transient GET failure without any write", async () => {
  const { transport, calls } = fixture({ failFirstOpenOrders: true });
  const snapshot = await transport.safetySnapshot("BTCBRL");
  assert.deepEqual(snapshot.openOrders, []);
  assert.equal(calls.filter((call) => call.path === "/api/v3/openOrders").length, 2);
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.equal(calls.filter((call) => call.path === "/api/v3/account").length, 2,
    "one account read per snapshot attempt");
});

test("Binance rate limit fails closed without retry storm or order write", async () => {
  const { transport, calls } = fixture({ restrictionsStatus: 429 });
  await assert.rejects(transport.safetySnapshot("BTCBRL"), /EXECUTOR_BINANCE_RATE_LIMITED/);
  assert.equal(calls.filter((call) => call.path === "/sapi/v1/account/apiRestrictions").length, 1);
  assert.equal(calls.filter((call) => call.path === "/api/v3/account").length, 1);
  assert.ok(calls.every((call) => call.method === "GET"));
});

test("Production transport enforces per-order, asset and global exposure before create", async () => {
  const { transport, calls } = fixture();
  for (const invalid of [
    { quoteOrderQty: "18.01" }, { assetExposureBeforeBrl: 440 },
    { globalExposureBeforeBrl: 710 }, { assetCapBrl: 451 },
  ]) {
    await assert.rejects(transport.createOwnedOrder(marketIntent(invalid),
      { allowCreate: true, tradingEnabled: true, killSwitch: false }), /HARD_CAP_DENIED/);
  }
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
});

test("Production transport creates one exact owned order and query-before-write recovers repeat", async () => {
  const { transport, calls } = fixture();
  const first = await transport.createOwnedOrder(marketIntent(),
    { allowCreate: true, tradingEnabled: true, killSwitch: false });
  const second = await transport.createOwnedOrder(marketIntent(),
    { allowCreate: true, tradingEnabled: true, killSwitch: false });
  assert.equal(first.clientOrderId, BTC_ID);
  assert.equal(second.orderId, first.orderId);
  assert.equal(calls.filter((call) => call.path === "/api/v3/order" && call.method === "POST").length, 1);
  assert.ok(calls.every((call) => !call.path.includes("testnet")));
});

test("Production transport refuses stale own-open-order snapshot before POST", async () => {
  const { transport, calls } = fixture({ openOrders: [{ clientOrderId: BTC_ID,
    orderId: 123, symbol: "BTCBRL", side: "BUY", status: "NEW",
    executedQty: "0", price: "437000" }] });
  await assert.rejects(transport.createOwnedOrder(marketIntent(),
    { allowCreate: true, tradingEnabled: true, killSwitch: false }),
  /UNRECONCILED_OWNED_ORDER/);
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
});

test("Trade history uses the Binance-supported orderId combination only", async () => {
  const { transport, calls } = fixture({ existingOrder: {
    symbol: "BTCBRL", clientOrderId: BTC_ID, orderId: 123, side: "BUY", status: "FILLED",
    executedQty: "0.00004", cummulativeQuoteQty: "17.50", price: "0" },
    trades: [{ symbol: "BTCBRL", id: 456, orderId: 123, qty: "0.00004",
      quoteQty: "17.50", commission: "0.0001", commissionAsset: "BNB",
      isBuyer: true, time: NOW }] });
  const result = await transport.ownedTrades("BTCBRL", BTC_ID, "123");
  assert.equal(result.length, 1);
  const request = calls.find((call) => call.path === "/api/v3/myTrades");
  assert.equal(request.params.get("orderId"), "123");
  assert.equal(request.params.has("fromId"), false);
});

test("Protective cancellation of partially filled own BUY works with kill switch ON", async () => {
  const { transport, calls } = fixture({ existingOrder: {
    symbol: "BTCBRL", clientOrderId: BTC_ID, orderId: 123, side: "BUY", status: "PARTIALLY_FILLED",
    executedQty: "0.00001", cummulativeQuoteQty: "4.37", price: "0" } });
  const result = await transport.cancelOwnedBuy({ symbol: "BTCBRL", clientOrderId: BTC_ID, orderId: "123" },
    { tradingEnabled: true, killSwitch: true });
  assert.equal(result.status, "CANCELED");
  assert.equal(calls.find((call) => call.method === "DELETE")?.params.has("cancelRestrictions"), false);
});

test("legacy Production reconciliation reads manual USDT pairs only from fixed-IP GET transport", async () => {
  const { transport, calls } = fixture();
  const snapshot = await transport.legacyReconciliationSnapshot();
  assert.equal(snapshot.capabilities.ipRestricted, true);
  assert.equal(snapshot.capabilities.withdrawalsEnabled, false);
  assert.deepEqual(Object.keys(snapshot.filters).sort(), ["BTCUSDT", "SOLUSDT"]);
  assert.deepEqual(snapshot.orders, []);
  assert.deepEqual(snapshot.trades, []);
  assert.equal(calls.filter((call) => call.path === "/api/v3/myTrades").length, 2);
  assert.ok(calls.every((call) => call.method === "GET"));
});
