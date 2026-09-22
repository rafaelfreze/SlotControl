import assert from "node:assert/strict";
import test from "node:test";

import { BINANCE_SPOT_TESTNET_BASE_URL, BinanceSpotTestnetAdapter } from "../execution/binance-spot-testnet-adapter.ts";

const id = "COV1-BTC-2-BUY-0123456789abcdef01";
const sellId = "COV1-BTC-2-SELL-0123456789abcdef01";
const payload = (clientOrderId: string, status = "NEW") => ({ orderId: 42, clientOrderId, symbol: "BTCUSDC", side: clientOrderId.includes("-BUY-") ? "BUY" : "SELL", status, executedQty: "0", cummulativeQuoteQty: "0", price: "60000" });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("testnet order is capped, owned, and sent only to the fictitious-money host", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const adapter = new BinanceSpotTestnetAdapter({ apiKey: "test-key", apiSecret: "test-secret" }, { now: () => 1000, fetcher: async (url, init) => {
    calls.push({ url, method: init?.method || "GET" });
    if (url.endsWith("/api/v3/time")) return json({ serverTime: 1000 });
    if (init?.method === "GET") return json({ code: -2013 }, 400);
    return json(payload(id));
  } });
  await assert.rejects(adapter.ensureOwnedOrder({ type: "LIMIT", symbol: "BTCUSDT" as never, side: "BUY", quantity: "0.001", price: "60000", clientOrderId: id, maxNotional: 100 }), /NOT_OWNED/);
  await assert.rejects(adapter.ensureOwnedOrder({ type: "LIMIT", symbol: "BTCUSDC", side: "BUY", quantity: "0.001", price: "60000", clientOrderId: id, maxNotional: 10 }), /NOTIONAL_CAP/);
  assert.equal(calls.length, 0);
  const result = await adapter.ensureOwnedOrder({ type: "LIMIT", symbol: "BTCUSDC", side: "BUY", quantity: "0.001", price: "60000", clientOrderId: id, maxNotional: 100 });
  assert.equal(result.orderId, "42");
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET", "POST"]);
  assert.ok(calls.every((call) => call.url.startsWith(BINANCE_SPOT_TESTNET_BASE_URL)));
});

test("lost response recovers the same client order without a second POST", async () => {
  let reads = 0, writes = 0;
  const adapter = new BinanceSpotTestnetAdapter({ apiKey: "test-key", apiSecret: "test-secret" }, { now: () => 1000, fetcher: async (url, init) => {
    if (url.endsWith("/api/v3/time")) return json({ serverTime: 1000 });
    if (init?.method === "GET") return ++reads === 1 ? json({ code: -2013 }, 400) : json(payload(id, "FILLED"));
    writes += 1;
    throw new Error("network timeout");
  } });
  const result = await adapter.ensureOwnedOrder({ type: "LIMIT", symbol: "BTCUSDC", side: "BUY", quantity: "0.001", price: "60000", clientOrderId: id, maxNotional: 100 });
  assert.equal(result.status, "FILLED");
  assert.equal(writes, 1);
});

test("cancel requires the exact owned order ID and leaves other orders untouched", async () => {
  let deletes = 0;
  const adapter = new BinanceSpotTestnetAdapter({ apiKey: "test-key", apiSecret: "test-secret" }, { now: () => 1000, fetcher: async (url, init) => {
    if (url.endsWith("/api/v3/time")) return json({ serverTime: 1000 });
    if (init?.method === "DELETE") { deletes += 1; const cancelId = new URLSearchParams(String(init.body)).get("newClientOrderId"); return json({ ...payload(id, "CANCELED"), origClientOrderId: id, clientOrderId: cancelId }); }
    return json(payload(id));
  } });
  await assert.rejects(adapter.cancelOwnedOrder("BTCUSDC", "43", id), /OWNED_ORDER_NOT_FOUND/);
  await assert.rejects(adapter.cancelOwnedOrder("BTCUSDC", "42", sellId), /ORDER_RESPONSE_INVALID/);
  assert.equal(deletes, 0);
  const result = await adapter.cancelOwnedOrder("BTCUSDC", "42", id);
  assert.equal(result?.status, "CANCELED");
  assert.equal(result?.clientOrderId, id);
  assert.equal(deletes, 1);
});

test("cancel lost response recovers the same owned order after Binance replaces its client ID", async () => {
  let canceled = false, cancelId = "", deletes = 0;
  const adapter = new BinanceSpotTestnetAdapter({ apiKey: "test-key", apiSecret: "test-secret" }, { now: () => 1000, fetcher: async (url, init) => {
    if (url.endsWith("/api/v3/time")) return json({ serverTime: 1000 });
    if (init?.method === "DELETE") { canceled = true; deletes += 1; cancelId = new URLSearchParams(String(init.body)).get("newClientOrderId") || ""; throw new Error("lost cancel response"); }
    if (new URL(url).searchParams.has("orderId")) return json({ ...payload(id, "CANCELED"), clientOrderId: cancelId });
    return canceled ? json({ code: -2013 }, 400) : json(payload(id));
  } });
  const result = await adapter.cancelOwnedOrder("BTCUSDC", "42", id);
  assert.equal(result?.status, "CANCELED");
  assert.equal(result?.clientOrderId, id);
  assert.equal(deletes, 1);
});

test("environment gate prevents use without dedicated Testnet configuration", () => {
  const previous = process.env.COINOPS_TESTNET_ENABLED;
  try { delete process.env.COINOPS_TESTNET_ENABLED; assert.throws(() => BinanceSpotTestnetAdapter.fromEnvironment(), /DISABLED/); }
  finally { if (previous === undefined) delete process.env.COINOPS_TESTNET_ENABLED; else process.env.COINOPS_TESTNET_ENABLED = previous; }
});

test("TRADE probe validates without placing an exchange order", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const adapter = new BinanceSpotTestnetAdapter({ apiKey: "test-key", apiSecret: "test-secret" }, { now: () => 1000, fetcher: async (url, init) => {
    calls.push({ url, method: init?.method || "GET" });
    return url.endsWith("/api/v3/time") ? json({ serverTime: 1000 }) : json({});
  } });
  assert.deepEqual(await adapter.checkTradePermission(), { ok: true, error: null });
  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), ["GET /api/v3/time", "POST /api/v3/order/test"]);
  assert.ok(calls.every((call) => call.url.startsWith(BINANCE_SPOT_TESTNET_BASE_URL)));
});

test("owned trades preserve base and quote commissions for partial-fill accounting", async () => {
  const adapter = new BinanceSpotTestnetAdapter({ apiKey: "test-key", apiSecret: "test-secret" }, { now: () => 1000, fetcher: async (url) => {
    if (url.endsWith("/api/v3/time")) return json({ serverTime: 1000 });
    if (new URL(url).pathname === "/api/v3/order") return json(payload(id, "PARTIALLY_FILLED"));
    return json([{ id: 9, orderId: 42, qty: "0.08", quoteQty: "9.6", commission: "0.00008", commissionAsset: "BTC", isBuyer: true }]);
  } });
  const trades = await adapter.getOwnedTrades("BTCUSDC", id, "42");
  assert.deepEqual(trades, [{ id: "9", quantity: 0.08, quoteQuantity: 9.6, commission: 0.00008, commissionAsset: "BTC", isBuyer: true }]);
  await assert.rejects(adapter.getOwnedTrades("BTCUSDC", id, "43"), /OWNED_ORDER_NOT_FOUND/);
});
