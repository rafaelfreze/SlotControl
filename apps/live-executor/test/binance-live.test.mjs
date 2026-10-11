import assert from "node:assert/strict";
import test from "node:test";

import { BinanceLiveTransport } from "../src/binance-live.mjs";
import { ExecutorPreDispatchRejection } from "../src/security.mjs";

const NOW = Date.parse("2026-09-24T03:00:00.000Z");
const BTC_ID = "COR1-BTC-1-1-BUY-0123456789abcd";

function fixture({ openOrders = [], existingOrder = null, trades = [], failFirstOpenOrders = false,
  restrictionsStatus = 200, deleteOutcome = null, loseDeleteAck = false,
  stpModes, requireSelfTradePrevention = false, restrictionResponses,
  freeBnb = "0.005", bnbPriceAvailable = true } = {}) {
  const calls = [];
  let order = existingOrder;
  let openOrderFailures = 0;
  let restrictionReads = 0;
  const filters = { symbol: "BTCBRL", status: "TRADING", baseAsset: "BTC", quoteAsset: "BRL",
    ...(stpModes === undefined ? {} : { allowedSelfTradePreventionModes: stpModes }),
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
      { asset: "BNB", free: freeBnb, locked: "0" }] });
    if (parsed.pathname === "/sapi/v1/account/apiRestrictions" && restrictionResponses) {
      const observed = restrictionResponses[Math.min(restrictionReads++, restrictionResponses.length - 1)];
      if (observed instanceof Error) throw observed;
      return Response.json(observed.body === undefined ? restrictions : observed.body,
        { status: observed.status ?? 200 });
    }
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
      if (symbol === "BNBBRL" && !bnbPriceAvailable) return Response.json({ code: -1000 }, { status: 503 });
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
      order = deleteOutcome ? { ...order, ...deleteOutcome } : { ...order, status: "CANCELED" };
      if (loseDeleteAck) throw new Error("LOST_DELETE_ACK");
      if (order.status !== "CANCELED") return Response.json({ code: -2011 }, { status: 400 });
      return Response.json({ ...order, origClientOrderId: BTC_ID });
    }
    throw new Error(`Unexpected ${parsed.pathname}`);
  };
  return { transport: new BinanceLiveTransport({ apiKey: "test-key", apiSecret: "test-secret",
    fetcher, now: () => NOW, requireSelfTradePrevention }), calls };
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

test("BNB reserve guard preserves the strict threshold and requires a price; denial is typed before any POST", async () => {
  for (const config of [{ freeBnb: "0" }, { freeBnb: "0.00001" }, { bnbPriceAvailable: false }]) {
    const { transport, calls } = fixture(config);
    await assert.rejects(transport.createOwnedOrder(marketIntent(),
      { allowCreate: true, tradingEnabled: true, killSwitch: false }), error => {
      assert.ok(error instanceof ExecutorPreDispatchRejection);
      assert.equal(error.code, "EXECUTOR_BNB_FEE_RESERVE_MISSING");
      assert.equal(error.status, 503);
      return true;
    });
    assert.equal(transport.orderPostAttempted, false);
    assert.ok(calls.every(call => call.method === "GET"));
  }
  const enough = fixture({ freeBnb: "0.00001001" });
  await enough.transport.createOwnedOrder(marketIntent(),
    { allowCreate: true, tradingEnabled: true, killSwitch: false });
  assert.equal(enough.calls.filter(call => call.method === "POST").length, 1);
});

test("permission gateway outage retries a complete snapshot and converges without any POST", async () => {
  for (const first of [{ status: 503, body: { code: -1000 } }, new TypeError("private network detail"),
    new DOMException("private timeout detail", "TimeoutError")]) {
    const { transport, calls } = fixture({ restrictionResponses: [first, { status: 200 }] });
    assert.equal((await transport.safetySnapshot("BTCBRL")).account.canTrade, true);
    assert.equal(calls.filter(c => c.path === "/sapi/v1/account/apiRestrictions").length, 2);
    assert.equal(calls.filter(c => c.path === "/api/v3/account").length, 2);
    assert.ok(calls.every(c => c.method === "GET"));
  }
});

test("persistent permission observation is typed and sanitized, never genuine permission denial", async () => {
  for (const status of [502, 503, 504]) {
    const { transport, calls } = fixture({ restrictionResponses: [{ status, body: { code: -1000,
      msg: "private exchange detail" } }] });
    await assert.rejects(transport.safetySnapshot("BTCBRL"), error => {
      assert.equal(error.code, "EXECUTOR_PRODUCTION_PERMISSION_READ_UNAVAILABLE");
      assert.deepEqual(error.readEvidence, { path: "/sapi/v1/account/apiRestrictions",
        http_status: status, provider_code: -1000 });
      assert.ok(!JSON.stringify(error).includes("private"));
      return true;
    });
    assert.equal(calls.filter(c => c.path === "/sapi/v1/account/apiRestrictions").length, 2);
    assert.ok(calls.every(c => c.method === "GET"));
  }
});

test("auth denial, malformed flags and unsafe grants never inherit observation retry", async () => {
  for (const response of [{ status: 401, body: { code: -2015 } }, { status: 403, body: { code: -2015 } },
    { status: 503, body: { code: -2015 } }, { status: 200, body: null },
    { status: 503, body: { code: -1100 } }, { status: 503, body: { code: -9876 } },
    { status: 200, body: [] }, { status: 200, body: { enableWithdrawals: true } }]) {
    const { transport, calls } = fixture({ restrictionResponses: [response] });
    await assert.rejects(transport.createOwnedOrder(marketIntent(),
      { allowCreate: true, tradingEnabled: true, killSwitch: false }), /EXECUTOR_PRODUCTION_PERMISSION_DENIED/);
    assert.equal(calls.filter(c => c.path === "/sapi/v1/account/apiRestrictions").length, 1);
    assert.ok(calls.every(c => c.method === "GET"));
  }
});

test("permission observation outage before create does not submit or claim a successful order", async () => {
  const { transport, calls } = fixture({ restrictionResponses: [{ status: 504, body: { code: -1000 } }] });
  await assert.rejects(transport.createOwnedOrder(marketIntent(),
    { allowCreate: true, tradingEnabled: true, killSwitch: false }), /EXECUTOR_PRODUCTION_PERMISSION_READ_UNAVAILABLE/);
  assert.equal(transport.orderPostAttempted, false);
  assert.ok(calls.every(c => c.method === "GET"));
});

test("supported STP always preserves resident makers and cannot be overridden by caller", async () => {
  const { transport, calls } = fixture({ stpModes: ["NONE", "EXPIRE_TAKER", "EXPIRE_BOTH"] });
  await transport.createOwnedOrder(marketIntent({ selfTradePreventionMode: "EXPIRE_BOTH" }),
    { allowCreate: true, tradingEnabled: true, killSwitch: false });
  const post = calls.find((call) => call.path === "/api/v3/order" && call.method === "POST");
  assert.equal(post.params.get("selfTradePreventionMode"), "EXPIRE_TAKER");
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
});

for (const stpModes of [undefined, ["NONE"], ["EXPIRE_MAKER", "EXPIRE_BOTH"]]) {
  test(`shared pair cannot submit without maker-preserving STP: ${JSON.stringify(stpModes)}`, async () => {
    const { transport, calls } = fixture({ stpModes, requireSelfTradePrevention: true });
    await assert.rejects(transport.createOwnedOrder(marketIntent(),
      { allowCreate: true, tradingEnabled: true, killSwitch: false }), /SELF_TRADE_PREVENTION_UNPROVEN/);
    assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  });
}

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

const unfilledIntent = { symbol: "BTCBRL", clientOrderId: BTC_ID, orderId: "123", onlyUnfilled: true };
const newBuy = { symbol: "BTCBRL", clientOrderId: BTC_ID, orderId: 123, side: "BUY", status: "NEW",
  executedQty: "0", cummulativeQuoteQty: "0", price: "437000" };
const enabled = { tradingEnabled: true, killSwitch: false };

test("capital resize cancellation accepts only NEW and returns proven zero-fill cancel", async () => {
  const { transport, calls } = fixture({ existingOrder: newBuy });
  const result = await transport.cancelOwnedBuy(unfilledIntent, enabled);
  assert.equal(result.status, "CANCELED");
  assert.equal(result.executedQuantity, 0);
  assert.equal(result.cumulativeQuoteQuantity, 0);
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
  assert.equal(calls.find((call) => call.method === "DELETE").params.get("cancelRestrictions"), "ONLY_NEW");
});

for (const status of ["PARTIALLY_FILLED", "FILLED"]) {
  test(`capital resize preserves ${status} observed before cancellation`, async () => {
    const { transport, calls } = fixture({ existingOrder: { ...newBuy, status,
      executedQty: "0.00001", cummulativeQuoteQty: "4.37" } });
    const result = await transport.cancelOwnedBuy(unfilledIntent, enabled);
    assert.equal(result.status, status);
    assert.equal(result.executedQuantity, 0.00001);
    assert.ok(calls.every((call) => call.method === "GET"));
  });
  test(`capital resize reconciles ${status} racing ONLY_NEW rejection without another DELETE`, async () => {
    const { transport, calls } = fixture({ existingOrder: newBuy,
      deleteOutcome: { status, executedQty: "0.00001", cummulativeQuoteQty: "4.37" } });
    const result = await transport.cancelOwnedBuy(unfilledIntent, enabled);
    assert.equal(result.status, status);
    assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
    assert.equal(calls.find((call) => call.method === "DELETE").params.get("cancelRestrictions"), "ONLY_NEW");
  });
}

test("capital resize queries exact order after lost cancellation acknowledgement", async () => {
  const { transport, calls } = fixture({ existingOrder: newBuy, loseDeleteAck: true });
  const result = await transport.cancelOwnedBuy(unfilledIntent, enabled);
  assert.equal(result.status, "CANCELED");
  assert.equal(result.executedQuantity, 0);
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
});

test("capital resize stays uncertain if the exact order remains NEW after lost acknowledgement", async () => {
  const { transport, calls } = fixture({ existingOrder: newBuy, loseDeleteAck: true,
    deleteOutcome: { status: "NEW" } });
  await assert.rejects(transport.cancelOwnedBuy(unfilledIntent, enabled), /EXECUTOR_CANCEL_OUTCOME_UNKNOWN/);
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
});

test("a cancellation observation with fills never erases executed quantities", async () => {
  const { transport, calls } = fixture({ existingOrder: newBuy,
    deleteOutcome: { status: "CANCELED", executedQty: "0.00001", cummulativeQuoteQty: "4.37" } });
  const result = await transport.cancelOwnedBuy(unfilledIntent, enabled);
  assert.equal(result.status, "CANCELED");
  assert.equal(result.executedQuantity, 0.00001);
  assert.equal(result.cumulativeQuoteQuantity, 4.37);
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
});

test("capital resize rejects unproven NEW-with-fill data and invalid cancellation mode", async () => {
  const { transport, calls } = fixture({ existingOrder: { ...newBuy, executedQty: "0.00001" } });
  await assert.rejects(transport.cancelOwnedBuy(unfilledIntent, enabled), /EXECUTOR_CANCEL_UNFILLED_UNPROVEN/);
  await assert.rejects(transport.cancelOwnedBuy({ ...unfilledIntent, onlyUnfilled: "true" }, enabled), /EXECUTOR_CANCEL_MODE_INVALID/);
  assert.ok(calls.every((call) => call.method === "GET"));
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
