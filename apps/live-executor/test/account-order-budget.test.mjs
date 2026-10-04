import assert from "node:assert/strict";
import test from "node:test";
import { BinanceLiveTransport } from "../src/binance-live.mjs";
import { readAccountOrderBudget, createAccountOrderBudgetReader } from "../src/account-order-budget.mjs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createExecutorHandler } from "../src/server.mjs";
import { requestSignature, sha256 } from "../src/security.mjs";
import { registryFixture, credentialEnvironment, OPERATOR, ACCOUNT_A } from "./registry-fixture.mjs";

const NOW = Date.parse("2026-10-04T12:00:01Z");
function fixture({ count = 2, global = false, accountGlobal = false, accountSymbolLimit = 150,
  assetFilter = false, positionFilter = false, supportedStp = true, malformed = false, crossBoundary = false } = {}) {
  const calls = []; let clock = NOW;
  const fetcher = async (url, init = {}) => {
    const parsed = new URL(url); calls.push({ path: parsed.pathname, method: init.method, query: parsed.searchParams });
    if (parsed.pathname === "/api/v3/time") return Response.json({ serverTime: NOW });
    if (parsed.pathname === "/api/v3/rateLimit/order") {
      if (crossBoundary) clock += 10_000;
      return Response.json(malformed ? [] : [{ rateLimitType: "ORDERS", interval: "SECOND", intervalNum: 10, limit: 50, count }]);
    }
    if (parsed.pathname === "/api/v3/exchangeInfo") return Response.json({
      exchangeFilters: global ? [{ filterType: "EXCHANGE_MAX_NUM_ORDERS", maxNumOrders: 1000 }] : [],
      symbols: ["SOLBRL", "BTCBRL"].map((symbol) => ({ symbol, status: "TRADING",
        allowedSelfTradePreventionModes: supportedStp ? ["NONE", "EXPIRE_TAKER"] : ["NONE", "EXPIRE_MAKER"],
        filters: [{ filterType: "MAX_NUM_ORDERS", maxNumOrders: 200 }] })) });
    if (parsed.pathname === "/api/v3/myFilters") return Response.json({
      exchangeFilters: accountGlobal ? [{ filterType: "EXCHANGE_MAX_NUM_ORDERS", maxNumOrders: 500 }] : [],
      symbolFilters: [{ filterType: "MAX_NUM_ORDERS", maxNumOrders: accountSymbolLimit },
        ...(positionFilter ? [{ filterType: "MAX_POSITION", maxPosition: "100" }] : [])],
      assetFilters: assetFilter ? [{ filterType: "MAX_ASSET", asset: "SOL", limit: "100" }] : [] });
    if (parsed.pathname === "/api/v3/openOrders") return Response.json([]);
    throw new Error("unexpected route");
  };
  return { calls, transport: new BinanceLiveTransport({ apiKey: "synthetic", apiSecret: "synthetic", fetcher, now: () => clock }) };
}
test("account-global signed ORDERS counter and real filters are observed without writes/history", async () => {
  const { transport, calls } = fixture();
  const sample = await readAccountOrderBudget(transport, ["SOLBRL", "BTCBRL"]);
  assert.deepEqual(sample.intervals, [{ intervalMs: 10_000, limit: 50, count: 2 }]);
  assert.equal(sample.exchangeOrders, null);
  assert.equal(sample.symbols[0].maxOrders, 150);
  assert.equal(sample.symbols[0].selfTradePrevention, "EXPIRE_TAKER");
  assert.deepEqual(sample.restrictions, []);
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.ok(calls.filter((call) => call.path === "/api/v3/openOrders").every((call) => call.query.has("symbol")));
});

test("signed account filters override less restrictive public limits and cannot be ignored", async () => {
  const { transport, calls } = fixture({ global: true, accountGlobal: true, accountSymbolLimit: 100 });
  const sample = await readAccountOrderBudget(transport, ["SOLBRL"]);
  assert.equal(sample.exchangeOrders.limit, 500);
  assert.equal(sample.symbols[0].maxOrders, 100);
  assert.equal(calls.filter((call) => call.path === "/api/v3/myFilters").length, 1);
});

test("position/value restrictions and unsupported maker-preserving STP remain explicit blocking evidence", async () => {
  const { transport } = fixture({ assetFilter: true, positionFilter: true, supportedStp: false });
  const sample = await readAccountOrderBudget(transport, ["SOLBRL"]);
  assert.deepEqual(sample.restrictions, ["SOL:MAX_ASSET", "SOLBRL:MAX_POSITION"]);
  assert.equal(sample.symbols[0].selfTradePrevention, null);
});
test("global exchange filter demands complete current open orders, never a partial per-symbol count", async () => {
  const { transport, calls } = fixture({ global: true });
  const sample = await readAccountOrderBudget(transport, ["SOLBRL"]);
  assert.equal(sample.exchangeOrders.limit, 1000);
  assert.equal(calls.filter((call) => call.path === "/api/v3/openOrders").length, 1);
  assert.equal(calls.find((call) => call.path === "/api/v3/openOrders").query.has("symbol"), false);
});
test("missing counters, malformed evidence and interval jitter fail closed without a fabricated reset", async () => {
  for (const input of [{ malformed: true }, { crossBoundary: true }, { count: -1 }]) {
    const { transport, calls } = fixture(input);
    await assert.rejects(readAccountOrderBudget(transport, ["SOLBRL"]), /BUDGET_UNKNOWN/);
    assert.ok(calls.every((call) => call.method === "GET"));
  }
});

const scope = { operator_id: "d508bb3e-5a1d-4579-bd7a-de171c118d25",
  exchange_account_id: "95c95966-b92e-4e22-ac03-32a3f1d0bc1b", environment: "REAL" };
test("concurrent same-account probes coalesce and never return secrets or mutable cache objects", async () => {
  const { transport, calls } = fixture();
  const cached = createAccountOrderBudgetReader({ now: () => NOW });
  const results = await Promise.all(Array.from({ length: 30 }, (_, index) => cached(
    { ...scope, trading_engine_id: `not-an-authority-${index}` }, transport,
    index % 2 ? ["BTCBRL", "SOLBRL"] : ["SOLBRL", "BTCBRL"])));
  assert.equal(calls.filter((call) => call.path === "/api/v3/rateLimit/order").length, 1);
  results[0].intervals[0].count = 1000000;
  assert.equal((await cached(scope, transport, ["SOLBRL", "BTCBRL"])).intervals[0].count, 2);
  assert.equal(JSON.stringify(results[1]).includes("synthetic"), false);
  await assert.rejects(cached({ ...scope, environment: "TESTNET" }, transport, ["SOLBRL"]), /BUDGET_UNKNOWN/);
});

test("cache expires at the actual Binance interval, including signed clock offset", async () => {
  let clock = NOW, reads = 0;
  const cached = createAccountOrderBudgetReader({ now: () => clock, read: async () => {
    reads++;
    return { observedAt: clock, serverTime: clock + 1500,
      intervals: [{ intervalMs: 10_000, limit: 50, count: 2 }] };
  } });
  const transport = { apiKey: "synthetic" };
  await cached(scope, transport, ["SOLBRL"]);
  clock += 7499;
  await cached(scope, transport, ["SOLBRL"]);
  assert.equal(reads, 1);
  clock += 1;
  await cached(scope, transport, ["SOLBRL"]);
  assert.equal(reads, 2, "expiry is the server boundary, not local 10s/30s TTL");
});

test("failed probe is never a cached PASS and rapid retries cannot create a weight storm", async () => {
  let reads = 0;
  const cached = createAccountOrderBudgetReader({ now: () => NOW, read: async () => {
    reads++; throw new Error("signed probe failed");
  } });
  const transport = { apiKey: "synthetic" };
  await assert.rejects(cached(scope, transport, ["SOLBRL"]), /signed probe failed/);
  await assert.rejects(cached(scope, transport, ["SOLBRL"]), /BUDGET_UNKNOWN/);
  assert.equal(reads, 1);
});

test("signed budget endpoint binds its installed account/IP, coalesces probes and cannot write an order or vault", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coinops-signed-budget-"));
  const secret = "fictional-budget-authentication-secret-1234567890";
  const { transport, calls } = fixture(), logs = [];
  const server = createServer(createExecutorHandler({ secret, stateDirectory: directory,
    registry: { ...registryFixture(), legacy_account_id: ACCOUNT_A }, credentialEnvironment,
    expectedEgressIp: "203.0.113.10", now: () => NOW, logger: (event) => logs.push(event),
    fetcher: (url, init) => new URL(url).host === "api.ipify.org" ? Promise.resolve(Response.json({ ip: "203.0.113.10" }))
      : transport.fetcher(url, init) }));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  async function send(patch = {}) {
    const request_id = randomUUID(), nonce = randomUUID().replaceAll("-", ""), path = "/v1/admin/order-budget";
    const body = JSON.stringify({ operator_id: OPERATOR, exchange_account_id: ACCOUNT_A,
      environment: "REAL", executor_shard_id: "executor-01", credential_ref: "legacy-binance-production",
      symbols: ["SOLBRL", "BTCBRL"], request_id, ...patch });
    return fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST", body,
      headers: { "content-type": "application/json", "x-coinops-timestamp": String(NOW),
        "x-coinops-nonce": nonce, "x-coinops-body-sha256": sha256(body),
        "x-coinops-signature": requestSignature(secret, "POST", path, NOW, nonce, body),
        "x-coinops-idempotency-key": `ORDER_BUDGET:${request_id}` } });
  }
  try {
    const responses = await Promise.all(Array.from({ length: 8 }, () => send()));
    for (const response of responses) {
      assert.equal(response.status, 200);
      const sample = await response.json();
      assert.equal(sample.exchange_account_id, ACCOUNT_A);
      assert.equal(sample.executor_shard_id, "executor-01");
      assert.equal(sample.executor_ip, "203.0.113.10");
      assert.deepEqual(sample.intervals, [{ intervalMs: 10000, limit: 50, count: 2 }]);
      assert.ok(!JSON.stringify(sample).includes("fictional-key-A"));
      assert.ok(!JSON.stringify(sample).includes("fictional-secret-A"));
    }
    assert.equal(calls.filter((call) => call.path === "/api/v3/rateLimit/order").length, 1);
    for (const patch of [{ exchange_account_id: randomUUID() }, { operator_id: randomUUID() },
      { symbols: ["ETHUSDT"] }, { executor_shard_id: "executor-03" }, { apiKey: "not-accepted" }])
      assert.equal((await send(patch)).status, 403);
    assert.ok(calls.every((call) => call.method === "GET"));
    assert.ok(calls.every((call) => !["/api/v3/order", "/api/v3/myTrades"].includes(call.path)));
    assert.deepEqual((await readdir(directory)).sort(), ["nonces"]);
    assert.ok(!JSON.stringify(logs).includes("fictional-key-A"));
  } finally {
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  }
});
