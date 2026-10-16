import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BinanceLiveTransport } from "../src/binance-live.mjs";
import { createExecutorHandler } from "../src/server.mjs";
import { durableOrderOwnership } from "../src/order-identity.mjs";
import { requestSignature, sha256 } from "../src/security.mjs";
import { liveClientOrderId } from "../../web/lib/execution/robot-v1-live-cycle.ts";
import { ACCOUNT_B, credentialEnvironment, engineFixture, intentContext, registryFixture } from "./registry-fixture.mjs";

const NOW = Date.parse("2026-10-16T20:00:00Z");
const SECRET = "fictional-test-observation-secret-never-production";
const engine = (slots = 50, index = 50) => ({ ...engineFixture("SOLBRL", ACCOUNT_B, index, false),
  slot_count: slots, executor_shard_id: "executor-03", hard_cap_quote: slots * 22,
  account_cap_quote: 3000, max_order_quote: 22 });
const clientId = (scope, slot = 1, side = "SELL") => liveClientOrderId("20000000-0000-4000-8000-000000000001",
  "SOL", slot, 1, side, 1, { ...scope, legacy_compatible: false });

function fixture({ slots = 50, status = "FILLED", executed = ".044", quote = "22.66", orders = null,
  trades = null, missing = false } = {}) {
  const scope = engine(slots), id = clientId(scope);
  const base = { symbol: "SOLBRL", clientOrderId: id, orderId: 123, side: "SELL", status,
    executedQty: executed, cummulativeQuoteQty: quote, price: "515" };
  const fills = [{ id: 456, orderId: 123, qty: ".044", quoteQty: "22.66", commission: ".00001",
    commissionAsset: "BNB", isBuyer: false, time: NOW }];
  const calls = [];
  let queries = 0;
  const fetcher = async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? "GET";
    assert.equal(method, "GET", "order observation cannot write to Binance");
    const weights = { "/api/v3/time": 1, "/api/v3/order": 4, "/api/v3/myTrades": 5 };
    calls.push({ host: url.hostname, path: url.pathname, method, params: url.searchParams,
      weight: weights[url.pathname] ?? 0, at: NOW });
    if (url.hostname.includes("ipify")) return Response.json({ ip: "203.0.113.3" });
    if (url.pathname === "/api/v3/time") return Response.json({ serverTime: NOW });
    if (url.pathname === "/api/v3/account") return Response.json({ canTrade: true, balances: [] });
    if (url.pathname === "/sapi/v1/account/apiRestrictions") return Response.json({ ipRestrict: true,
      enableReading: true, enableSpotAndMarginTrading: true, enableWithdrawals: false,
      enableInternalTransfer: false, permitsUniversalTransfer: false, enableMargin: false, enableFutures: false,
      enableVanillaOptions: false, enablePortfolioMarginTrading: false, enableFixApiTrade: false });
    if (url.pathname === "/api/v3/exchangeInfo") return Response.json({ symbols: ["BTCBRL", "SOLBRL"].map(symbol =>
      ({ symbol, status: "TRADING", baseAsset: symbol.slice(0, 3), quoteAsset: "BRL", filters: [] })) });
    if (url.pathname === "/api/v3/ticker/price") return Response.json(["BTCBRL", "SOLBRL"].map(symbol => ({ symbol, price: "500" })));
    if (url.pathname === "/api/v3/order") {
      queries++;
      return missing ? Response.json({ code: -2013 }, { status: 400 })
        : Response.json(orders ? { ...base, ...orders[Math.min(queries - 1, orders.length - 1)] } : base);
    }
    if (url.pathname === "/api/v3/myTrades") {
      assert.equal(url.searchParams.get("symbol"), "SOLBRL");
      assert.equal(url.searchParams.get("orderId"), "123");
      assert.equal(url.searchParams.get("limit"), "1000");
      assert.equal(url.searchParams.has("fromId"), false);
      return Response.json(trades ?? fills);
    }
    throw new Error(`Unexpected read ${url.pathname}`);
  };
  const transport = () => new BinanceLiveTransport({ engine: scope, apiKey: "fixture", apiSecret: "fixture",
    fetcher, now: () => NOW });
  return { engine: scope, id, calls, transport, fetcher, weight: () => calls.reduce((sum, row) => sum + row.weight, 0) };
}

test("single-context filled observation is fresh and costs 10; legacy path still costs 19", async () => {
  const f = fixture(), result = await f.transport().observeOwnedOrder("SOLBRL", f.id, "123");
  assert.equal(result.order.status, "FILLED"); assert.equal(result.trades.length, 1);
  assert.equal(f.weight(), 10); assert.equal(f.calls.length, 3);
  const legacy = fixture({ slots: 25 });
  await legacy.transport().queryOrder("SOLBRL", legacy.id, "123");
  const separate = legacy.transport(), observed = await separate.queryOrder("SOLBRL", legacy.id, "123");
  await separate.ownedTrades("SOLBRL", legacy.id, observed.orderId);
  assert.equal(legacy.weight(), 19, "25-slot endpoint semantics and cost are preserved");
});

for (const slots of [25, 50, 100]) test(`${slots} exact scoped observations use no financial cache`, async () => {
  const f = fixture({ slots });
  for (let index = 0; index < slots; index++) await f.transport().observeOwnedOrder("SOLBRL", f.id, "123");
  assert.equal(f.weight(), slots * 10);
  assert.equal(f.calls.filter(row => row.path === "/api/v3/myTrades").length, slots);
});

for (const status of ["NEW", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"])
  test(`${status} exact zero-fill observation does not manufacture a fill`, async () => {
    const f = fixture({ status, executed: "0", quote: "0" });
    const observed = await f.transport().observeOwnedOrder("SOLBRL", f.id, "123");
    assert.equal(observed.order.status, status); assert.deepEqual(observed.trades, []);
    assert.equal(f.weight(), 5);
  });

test("a fill racing query/trades gets one exact confirmation and coherent totals", async () => {
  const f = fixture({ orders: [{ status: "PARTIALLY_FILLED", executedQty: ".022", cummulativeQuoteQty: "11.33" },
    { status: "FILLED", executedQty: ".044", cummulativeQuoteQty: "22.66" }] });
  const result = await f.transport().observeOwnedOrder("SOLBRL", f.id, "123");
  assert.equal(result.order.status, "FILLED"); assert.equal(result.trades[0].quantity, .044);
  assert.equal(f.weight(), 14);
});

test("delayed fills fail as typed observation, never a false terminal proof", async () => {
  const f = fixture({ trades: [] });
  await assert.rejects(f.transport().observeOwnedOrder("SOLBRL", f.id, "123"), /EXECUTOR_ORDER_OBSERVATION_INCOMPLETE/);
  assert.equal(f.weight(), 14); assert.equal(f.calls.filter(row => row.path === "/api/v3/order").length, 2);
});

test("cancel/fill race returns the exact confirmed partial fills, never a zero-fill cancellation", async () => {
  const f = fixture({ orders: [{ status: "CANCELED", executedQty: ".022", cummulativeQuoteQty: "11.33" },
    { status: "CANCELED", executedQty: ".044", cummulativeQuoteQty: "22.66" }] });
  const result = await f.transport().observeOwnedOrder("SOLBRL", f.id, "123");
  assert.equal(result.order.status, "CANCELED"); assert.equal(result.order.executedQuantity, .044);
  assert.equal(result.trades[0].quantity, .044); assert.equal(f.weight(), 14);
});

test("missing remains null, and foreign engine/account namespace is denied before I/O", async () => {
  const f = fixture({ missing: true });
  assert.deepEqual(await f.transport().observeOwnedOrder("SOLBRL", f.id, "123"), { order: null, trades: null });
  assert.equal(f.weight(), 5);
  const own = fixture();
  for (const foreign of [{ ...own.engine, trading_engine_id: engine(50, 51).trading_engine_id },
    { ...own.engine, exchange_account_id: "00000000-0000-4000-8000-000000000099" }]) {
    await assert.rejects(own.transport().observeOwnedOrder("SOLBRL", clientId(foreign), "123"), /ORDER_NOT_OWNED/);
  }
  assert.equal(own.calls.length, 0);
});

test("terminal/quantity regression, malformed status and inconsistent zero totals are hard failures", async () => {
  for (const options of [
    { status: "SURPRISE" }, { status: "FILLED", executed: "0", quote: "0" },
    { status: "NEW" }, { executed: "0", quote: "1" },
    { orders: [{ status: "FILLED" }, { status: "PARTIALLY_FILLED", executedQty: ".022", cummulativeQuoteQty: "11.33" }], trades: [] },
    { orders: [{ status: "PARTIALLY_FILLED" }, { status: "PARTIALLY_FILLED", executedQty: ".022", cummulativeQuoteQty: "11.33" }], trades: [] },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.transport().observeOwnedOrder("SOLBRL", f.id, "123"), /EXECUTOR_ORDER_RESPONSE_INVALID/);
  }
});

test("trade ownership, ID collision and incomplete page never become a coherent observation", async () => {
  const good = { id: 456, orderId: 123, qty: ".044", quoteQty: "22.66", commission: "0", commissionAsset: "BNB", isBuyer: false, time: NOW };
  for (const [trades, code] of [
    [[{ ...good, orderId: 999 }], "EXECUTOR_TRADE_INVALID"],
    [[{ ...good, isBuyer: true }], "EXECUTOR_TRADE_INVALID"],
    [[good, { ...good, qty: ".043" }], "EXECUTOR_TRADE_ID_COLLISION"],
    [Array.from({ length: 1000 }, (_, id) => ({ ...good, id })), "EXECUTOR_TRADES_PAGE_LIMIT"],
  ]) {
    const f = fixture({ trades });
    await assert.rejects(f.transport().observeOwnedOrder("SOLBRL", f.id, "123"), new RegExp(code));
  }
});

async function serverFixture(slots) {
  const f = fixture({ slots });
  const directory = await mkdtemp(join(tmpdir(), "coinops-order-observation-"));
  // Preflight the exact durable ownership store used by the HTTP handler.
  await durableOrderOwnership(directory, f.engine).record({ orderId: "123", clientOrderId: f.id,
    symbol: "SOLBRL", side: "SELL" });
  const registry = { ...registryFixture([f.engine]), executor_shard_id: "executor-03" };
  const handler = createExecutorHandler({ secret: SECRET, registry, credentialEnvironment,
    stateDirectory: directory, shardId: "executor-03", expectedEgressIp: "203.0.113.3", now: () => NOW,
    tradingEnabled: false, killSwitch: true, fetcher: f.fetcher, logger: () => {} });
  const send = async (path, patch = {}) => {
    const method = path === "/health" ? "GET" : "POST";
    const key = `READ:${randomUUID()}`, nonce = randomUUID().replaceAll("-", "");
    const body = JSON.stringify({ ...intentContext(f.engine, key), executor_shard_id: "executor-03",
      clientOrderId: f.id, orderId: "123", ...patch });
    const request = Object.assign(Readable.from([Buffer.from(body)]), { method, url: path,
      headers: { "content-type": "application/json", "x-coinops-timestamp": String(NOW), "x-coinops-nonce": nonce,
        "x-coinops-body-sha256": sha256(body), "x-coinops-idempotency-key": key,
        "x-coinops-signature": requestSignature(SECRET, method, path, NOW, nonce, body) } });
    const result = {};
    await handler(request, { writeHead: (status) => { result.status = status; },
      end: (value) => { result.body = JSON.parse(value); } });
    return result;
  };
  return { ...f, send, close: async () => { await rm(directory, { recursive: true, force: true }); } };
}

test("signed endpoint is large-engine only; exact scope and shard reject before Binance", async () => {
  for (const slots of [25, 50, 100]) {
    const f = await serverFixture(slots);
    try {
      const result = await f.send("/v1/observe-order");
      assert.equal(result.status, slots === 25 ? 403 : 200, JSON.stringify(result.body));
      assert.equal(f.weight(), slots === 25 ? 0 : 10);
      const previous = f.calls.length;
      for (const patch of [{ executor_shard_id: "executor-02" },
        { exchange_account_id: "00000000-0000-4000-8000-000000000099" },
        { trading_engine_id: engine(slots, 99).trading_engine_id }]) {
        assert.equal((await f.send("/v1/observe-order", patch)).status, 403);
      }
      assert.equal(f.calls.length, previous);
      if (slots === 25) {
        const query = await f.send("/v1/query-order"), trades = await f.send("/v1/trades");
        assert.equal(query.status, 200, JSON.stringify(query.body));
        assert.equal(trades.status, 200, JSON.stringify(trades.body));
        assert.equal(f.weight(), 19);
      }
    } finally { await f.close(); }
  }
});

test("public and signed engine health advertise the same versioned observer protocol", async () => {
  const f = await serverFixture(50);
  try {
    for (const path of ["/health", "/v1/health"]) {
      const result = await f.send(path);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.order_observation_protocol, 1);
      assert.equal(result.body.executor_shard_id, "executor-03");
    }
    assert.equal(f.calls.some(row => row.method !== "GET"), false);
    assert.equal(f.calls.some(row => row.path === "/api/v3/order" || row.path === "/api/v3/myTrades"), false);
  } finally { await f.close(); }
});
