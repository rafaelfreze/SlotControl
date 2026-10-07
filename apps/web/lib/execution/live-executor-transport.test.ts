import assert from "node:assert/strict";
import test from "node:test";

import * as transport from "./live-executor-transport.ts";
import { resolveExecutorShard } from "./executor-shards-server.ts";
import { accountBudgetPermitHeaders } from "./account-order-budget-permit.ts";
import { signAccountOrderUnsentProof, AccountOrderNotSubmitted } from "./account-order-unsent-proof.ts";
import { createHash } from "node:crypto";

const resolver = async () => resolveExecutorShard("executor-01");
const readLiveExecutorHealth = (engine: transport.ExecutorEngineScope, fetcher: typeof fetch) =>
  transport.readLiveExecutorHealth(engine, fetcher, resolver);
const readLiveExecutorState = (engine: transport.ExecutorEngineScope, fetcher: typeof fetch) =>
  transport.readLiveExecutorState(engine, fetcher, resolver);
const readLiveExecutorOrder = (engine: transport.ExecutorEngineScope, clientId: string, orderId: string | null, fetcher: typeof fetch) =>
  transport.readLiveExecutorOrder(engine, clientId, orderId, fetcher, resolver);
const readLiveExecutorTrades = (engine: transport.ExecutorEngineScope, clientId: string, orderId: string, fetcher: typeof fetch) =>
  transport.readLiveExecutorTrades(engine, clientId, orderId, fetcher, resolver);

const engine = { operator_id: "00000000-0000-4000-8000-000000000001",
  exchange_account_id: "00000000-0000-4000-8000-000000000002",
  trading_engine_id: "00000000-0000-4000-8000-000000000003", symbol: "BTCBRL", quote_asset: "BRL" };
const state = { ...engine, environment: "REAL",
  symbol: "BTCBRL", balances: [],
  filters: { symbol: "BTCBRL", baseAsset: "BTC", quoteAsset: "BRL",
    minQuantity: 0.00001, maxQuantity: 9000, quantityStep: 0.00001,
    minNotional: 10, priceTick: 1 },
  price: { symbol: "BTCBRL", price: 430000, observedAt: "2026-09-24T10:00:00Z" },
  bnb_brl_price: null, open_orders: [], observed_at: "2026-09-24T10:00:00Z",
};

test("named query 503 reproduces Production: retry exact engine/order, preserve cross-shard isolation", async () => {
  for (const shardId of ["executor-02", "executor-03"]) {
    const scoped = { ...engine, trading_engine_id: shardId === "executor-02" ? engine.trading_engine_id : "00000000-0000-4000-8000-000000000004" };
    const target = { shardId, ip: "203.0.113.2", base: "https://203.0.113.2", secret: "x".repeat(32) };
    const calls: Record<string, unknown>[] = [];
    const order = { clientOrderId: "owned-1", orderId: "100", symbol: scoped.symbol, side: "SELL", status: "FILLED", executedQuantity: 1, cumulativeQuoteQuantity: 10, price: 10 };
    const fetcher = (async (url: unknown, init?: RequestInit) => {
      assert.equal(new URL(String(url)).pathname, "/v1/query-order");
      const body = JSON.parse(String(init?.body)); calls.push(body);
      assert.equal(body.trading_engine_id, scoped.trading_engine_id); assert.equal(body.executor_shard_id, shardId);
      assert.equal(body.clientOrderId, "owned-1"); assert.equal(body.orderId,"100");
      return calls.length === 1 ? Response.json({error:"EXECUTOR_ORDER_QUERY_FAILED"},{status:503})
        : Response.json({...scoped,environment:"REAL",executor_shard_id:shardId,order});
    }) as typeof fetch;
    assert.equal((await transport.readLiveExecutorOrder(scoped,"owned-1","100",fetcher,async()=>target)).order?.status,"FILLED");
    assert.equal(calls.length,2);
  }
});

test("acknowledged order delayed visibility confirms exact ID; permanent absence cannot authorize a write", async () => {
  const target={shardId:"executor-02",ip:"203.0.113.2",base:"https://203.0.113.2",secret:"x".repeat(32)};
  let calls=0;
  const fetcher=(async(url:unknown)=>{
    assert.equal(new URL(String(url)).pathname,"/v1/query-order");calls++;
    return Response.json({...engine,environment:"REAL",executor_shard_id:target.shardId,order:null});
  }) as typeof fetch;
  assert.equal((await transport.readLiveExecutorOrder(engine,"owned","100",fetcher,async()=>target)).order,null);
  assert.equal(calls,3);
  calls=0;
  await transport.readLiveExecutorOrder(engine,"owned",null,fetcher,async()=>target);
  assert.equal(calls,1,"an unacknowledged new intent has no invented Binance ID");
});

test("permit expiry before fetch has scoped proof and zero network attempts; timeout stays uncertain", async () => {
  const target = { shardId: "executor-02", ip: "203.0.113.2", base: "https://203.0.113.2", secret: "fixture-secret-not-real-123456789123456789" };
  const input = { clientOrderId: "C2-fixture-2-B-0123456789abcd", symbol: engine.symbol, side: "BUY", purpose: "ENTRY" };
  const reservation = { code: "PASS", operatorId: engine.operator_id, accountId: engine.exchange_account_id,
    engineId: engine.trading_engine_id, shardId: target.shardId, clientOrderId: input.clientOrderId, expiresAt: Date.now() - 1 };
  let attempts = 0;
  const fetcher = (async () => { attempts++; throw new Error("FETCH_TIMEOUT"); }) as typeof fetch;
  await assert.rejects(transport.createLiveExecutorOrder(input, engine, "a".repeat(64), fetcher, async () => target, reservation),
    (error: any) => error instanceof AccountOrderNotSubmitted && error.receipt.trading_engine_id === engine.trading_engine_id);
  assert.equal(attempts, 0);
  await assert.rejects(transport.createLiveExecutorOrder(input, engine, "a".repeat(64), fetcher, async () => target,
    { ...reservation, expiresAt: Date.now() + 20000 }), /FETCH_TIMEOUT/);
  assert.equal(attempts, 1);
});

test("historical proof endpoint verifies body/shard/engine and never sends create-order", async () => {
  const target = { shardId: "executor-03", ip: "203.0.113.3", base: "https://203.0.113.3", secret: "fixture-secret-not-real-123456789123456789" };
  let calls = 0;
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    calls++; assert.equal(new URL(String(url)).pathname, "/v1/prove-unsent-order");
    const raw = String(init!.body), input = JSON.parse(raw), headers = new Headers(init!.headers);
    const proofScope = { ...engine, environment: "REAL", executor_shard_id: target.shardId,
      clientOrderId: input.clientOrderId, decision_id: input.decision_id, request_nonce: headers.get("x-coinops-nonce")! };
    return Response.json({ ...engine, environment: "REAL", executor_shard_id: target.shardId, order: null,
      unsent_proof: signAccountOrderUnsentProof(target.secret, proofScope, createHash("sha256").update(raw).digest("hex")) });
  }) as typeof fetch;
  await assert.rejects(transport.proveLiveExecutorUnsentOrder(engine, "C2-fixture-2-B-0123456789abcd", "a".repeat(64), new Date(Date.now() - 90000).toISOString(), fetcher, async () => target), AccountOrderNotSubmitted);
  assert.equal(calls, 1);
});

test("create dispatch carries a separate permit on01/03; byte identity, no write retry, and exact signed unsent response", async () => {
  const secret = "fictional-transport-budget-secret-123456789", now = Date.now();
  for (const shardId of ["executor-01", "executor-03"]) {
    const target = { shardId, ip: "203.0.113.33", base: "https://203.0.113.33", secret };
    const input = { clientOrderId: "C2-fixture-1-B-0123456789abcd", symbol: "BTCBRL", side: "BUY", type: "MARKET", quoteOrderQty: "18" };
    const decision = "a".repeat(64);
    const raw = JSON.stringify({ ...input, ...transport.executorContext(engine, decision, input.clientOrderId),
      ...(shardId === "executor-01" ? {} : { executor_shard_id: shardId }) });
    const reservation = { code: "PASS", operatorId: engine.operator_id, accountId: engine.exchange_account_id,
      engineId: engine.trading_engine_id, shardId, clientOrderId: input.clientOrderId, expiresAt: now + 25_000 };
    let attempts = 0;
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      attempts++;
      assert.equal(String(init?.body), raw);
      const headers = new Headers(init?.headers);
      assert.ok(headers.get("x-coinops-signature"));
      assert.ok(headers.get("x-coinops-account-order-budget"));
      assert.ok(accountBudgetPermitHeaders(secret, reservation, { ...JSON.parse(raw), executor_shard_id: shardId }, raw));
      const proof = signAccountOrderUnsentProof(secret, { ...engine, environment: "REAL", executor_shard_id: shardId,
        clientOrderId: input.clientOrderId, decision_id: decision, request_nonce: headers.get("x-coinops-nonce")! },
      createHash("sha256").update(raw).digest("hex"));
      return Response.json({ error: attempts === 1 ? "EXECUTOR_ACCOUNT_ORDER_BUDGET_PERMIT_DENIED"
        : "EXECUTOR_QUOTE_BALANCE_INSUFFICIENT", unsent_proof: proof }, { status: 403 });
    }) as typeof fetch;
    await assert.rejects(transport.createLiveExecutorOrder(input, engine, decision, fetcher, async () => target, reservation), AccountOrderNotSubmitted);
    assert.equal(attempts, 1);
    await assert.rejects(transport.createLiveExecutorOrder(input, engine, decision, fetcher, async () => target, reservation), AccountOrderNotSubmitted);
    assert.equal(attempts, 2);
    await assert.rejects(transport.createLiveExecutorOrder(input, engine, decision,
      (async () => { attempts++; return Response.json({ error: "EXECUTOR_UNAVAILABLE" }, { status: 503 }); }) as typeof fetch,
      async () => target, reservation), /EXECUTOR_UNAVAILABLE/);
    assert.equal(attempts, 3, "uncertain POST outcome is never automatically retried or called unsent");
    await assert.rejects(transport.createLiveExecutorOrder(input, engine, decision,
      (async () => Response.json({ error: "EXECUTOR_QUOTE_BALANCE_INSUFFICIENT", unsent_proof: { signature: "fake" } }, { status: 403 })) as typeof fetch,
      async () => target, reservation), error => !(error instanceof AccountOrderNotSubmitted));
  }
});

test("LIVE monitor health retries transient scoped 503 without retrying writes or crossing engines", async () => {
  const previous = { ip: process.env.LIVE_EXECUTOR_EGRESS_IP,
    base: process.env.LIVE_EXECUTOR_BASE_URL, secret: process.env.COINOPS_EXECUTOR_HMAC_SECRET };
  process.env.LIVE_EXECUTOR_EGRESS_IP = "46.101.104.48";
  process.env.LIVE_EXECUTOR_BASE_URL = "https://46.101.104.48";
  process.env.COINOPS_EXECUTOR_HMAC_SECRET = "x".repeat(32);
  try {
    const requests: Array<{ path: string; method: string | undefined; body: Record<string, string> }> = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ path: new URL(String(url)).pathname, method: init?.method,
        body: JSON.parse(String(init?.body)) });
      return requests.length === 1
        ? Response.json({ error: "EXECUTOR_UNAVAILABLE" }, { status: 503 })
        : Response.json({ ...engine, environment: "REAL", healthy: true });
    }) as typeof fetch;
    assert.equal((await readLiveExecutorHealth(engine, fetcher)).healthy, true);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.path === "/v1/health"
      && request.method === "POST" && request.body.trading_engine_id === engine.trading_engine_id));
    assert.notEqual(requests[0].body.idempotency_key, requests[1].body.idempotency_key);
  } finally {
    if (previous.ip === undefined) delete process.env.LIVE_EXECUTOR_EGRESS_IP;
    else process.env.LIVE_EXECUTOR_EGRESS_IP = previous.ip;
    if (previous.base === undefined) delete process.env.LIVE_EXECUTOR_BASE_URL;
    else process.env.LIVE_EXECUTOR_BASE_URL = previous.base;
    if (previous.secret === undefined) delete process.env.COINOPS_EXECUTOR_HMAC_SECRET;
    else process.env.COINOPS_EXECUTOR_HMAC_SECRET = previous.secret;
  }
});

test("LIVE monitor health fails closed after persistent 503 and never retries authorization errors", async () => {
  const previous = { ip: process.env.LIVE_EXECUTOR_EGRESS_IP,
    base: process.env.LIVE_EXECUTOR_BASE_URL, secret: process.env.COINOPS_EXECUTOR_HMAC_SECRET };
  process.env.LIVE_EXECUTOR_EGRESS_IP = "46.101.104.48";
  process.env.LIVE_EXECUTOR_BASE_URL = "https://46.101.104.48";
  process.env.COINOPS_EXECUTOR_HMAC_SECRET = "x".repeat(32);
  try {
    let attempts = 0;
    await assert.rejects(readLiveExecutorHealth(engine, (async () => {
      attempts++;
      return Response.json({ error: "EXECUTOR_UNAVAILABLE" }, { status: 503 });
    }) as typeof fetch), /EXECUTOR_UNAVAILABLE/);
    assert.equal(attempts, 4);
    attempts = 0;
    await assert.rejects(readLiveExecutorHealth(engine, (async () => {
      attempts++;
      return Response.json({ error: "EXECUTOR_SCOPE_DENIED" }, { status: 403 });
    }) as typeof fetch), /EXECUTOR_SCOPE_DENIED/);
    assert.equal(attempts, 1);
  } finally {
    if (previous.ip === undefined) delete process.env.LIVE_EXECUTOR_EGRESS_IP;
    else process.env.LIVE_EXECUTOR_EGRESS_IP = previous.ip;
    if (previous.base === undefined) delete process.env.LIVE_EXECUTOR_BASE_URL;
    else process.env.LIVE_EXECUTOR_BASE_URL = previous.base;
    if (previous.secret === undefined) delete process.env.COINOPS_EXECUTOR_HMAC_SECRET;
    else process.env.COINOPS_EXECUTOR_HMAC_SECRET = previous.secret;
  }
});

test("LIVE state retries an invalid successful GET once, without any exchange write", async () => {
  const previous = { ip: process.env.LIVE_EXECUTOR_EGRESS_IP,
    base: process.env.LIVE_EXECUTOR_BASE_URL, secret: process.env.COINOPS_EXECUTOR_HMAC_SECRET };
  process.env.LIVE_EXECUTOR_EGRESS_IP = "46.101.104.48";
  process.env.LIVE_EXECUTOR_BASE_URL = "https://46.101.104.48";
  process.env.COINOPS_EXECUTOR_HMAC_SECRET = "x".repeat(32);
  try {
    const requests: Array<{ url: string; method: string | undefined }> = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method });
      return Response.json(requests.length === 1 ? { ...engine, environment: "REAL" } : state);
    }) as typeof fetch;
    assert.deepEqual(await readLiveExecutorState(engine, fetcher), state);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.method === "POST"
      && request.url.endsWith("/v1/state")));

    let rejected = 0;
    const denied = (async () => { rejected++; return Response.json({ error: "EXECUTOR_SYMBOL_DENIED" },
      { status: 403 }); }) as typeof fetch;
    await assert.rejects(readLiveExecutorState(engine, denied), /EXECUTOR_SYMBOL_DENIED/);
    assert.equal(rejected, 1);
    let crossAccount = 0;
    await assert.rejects(readLiveExecutorState(engine, (async () => { crossAccount++;
      return Response.json({ ...state, exchange_account_id: "00000000-0000-4000-8000-000000000004" });
    }) as typeof fetch), /EXECUTOR_RESPONSE_SCOPE_MISMATCH/);
    assert.equal(crossAccount, 1);
  } finally {
    if (previous.ip === undefined) delete process.env.LIVE_EXECUTOR_EGRESS_IP;
    else process.env.LIVE_EXECUTOR_EGRESS_IP = previous.ip;
    if (previous.base === undefined) delete process.env.LIVE_EXECUTOR_BASE_URL;
    else process.env.LIVE_EXECUTOR_BASE_URL = previous.base;
    if (previous.secret === undefined) delete process.env.COINOPS_EXECUTOR_HMAC_SECRET;
    else process.env.COINOPS_EXECUTOR_HMAC_SECRET = previous.secret;
  }
});

test("LIVE read-only transport survives a brief executor restart without retrying writes", async () => {
  const previous = { ip: process.env.LIVE_EXECUTOR_EGRESS_IP,
    base: process.env.LIVE_EXECUTOR_BASE_URL, secret: process.env.COINOPS_EXECUTOR_HMAC_SECRET };
  process.env.LIVE_EXECUTOR_EGRESS_IP = "46.101.104.48";
  process.env.LIVE_EXECUTOR_BASE_URL = "https://46.101.104.48";
  process.env.COINOPS_EXECUTOR_HMAC_SECRET = "x".repeat(32);
  try {
    const paths: string[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (paths.length < 3) return Response.json({}, { status: 503 });
      return Response.json(path === "/v1/state" ? state : { ...engine,
        environment: "REAL", order: null, trades: [] });
    }) as typeof fetch;
    assert.deepEqual(await readLiveExecutorState(engine, fetcher), state);
    assert.deepEqual(paths, ["/v1/state", "/v1/state", "/v1/state"]);
    assert.deepEqual(await readLiveExecutorOrder(engine, "COR1-BTC-1-1-SELL-0000000000000000", null, fetcher), { ...engine,
      environment: "REAL", order: null, trades: [] });
    assert.deepEqual(await readLiveExecutorTrades(engine, "COR1-BTC-1-1-SELL-0000000000000000", "1", fetcher), { ...engine,
      environment: "REAL", order: null, trades: [] });
    assert.ok(paths.every((path) => ["/v1/state", "/v1/query-order", "/v1/trades"].includes(path)));
  } finally {
    if (previous.ip === undefined) delete process.env.LIVE_EXECUTOR_EGRESS_IP;
    else process.env.LIVE_EXECUTOR_EGRESS_IP = previous.ip;
    if (previous.base === undefined) delete process.env.LIVE_EXECUTOR_BASE_URL;
    else process.env.LIVE_EXECUTOR_BASE_URL = previous.base;
    if (previous.secret === undefined) delete process.env.COINOPS_EXECUTOR_HMAC_SECRET;
    else process.env.COINOPS_EXECUTOR_HMAC_SECRET = previous.secret;
  }
});

test("LIVE state retries a transient sanitized executor error after TP creation", async () => {
  const previous = { ip: process.env.LIVE_EXECUTOR_EGRESS_IP,
    base: process.env.LIVE_EXECUTOR_BASE_URL, secret: process.env.COINOPS_EXECUTOR_HMAC_SECRET };
  process.env.LIVE_EXECUTOR_EGRESS_IP = "46.101.104.48";
  process.env.LIVE_EXECUTOR_BASE_URL = "https://46.101.104.48";
  process.env.COINOPS_EXECUTOR_HMAC_SECRET = "x".repeat(32);
  try {
    const paths: string[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      paths.push(new URL(String(url)).pathname);
      return paths.length === 1
        ? Response.json({ error: "EXECUTOR_UNAVAILABLE" }, { status: 503 })
        : Response.json(state);
    }) as typeof fetch;
    assert.deepEqual(await readLiveExecutorState(engine, fetcher), state);
    assert.deepEqual(paths, ["/v1/state", "/v1/state"]);
  } finally {
    if (previous.ip === undefined) delete process.env.LIVE_EXECUTOR_EGRESS_IP;
    else process.env.LIVE_EXECUTOR_EGRESS_IP = previous.ip;
    if (previous.base === undefined) delete process.env.LIVE_EXECUTOR_BASE_URL;
    else process.env.LIVE_EXECUTOR_BASE_URL = previous.base;
    if (previous.secret === undefined) delete process.env.COINOPS_EXECUTOR_HMAC_SECRET;
    else process.env.COINOPS_EXECUTOR_HMAC_SECRET = previous.secret;
  }
});
