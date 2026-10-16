import assert from "node:assert/strict";
import test from "node:test";
import { readLiveExecutorOrderObservation, createLiveExecutorOrder, cancelLiveExecutorOrder } from "./live-executor-transport.ts";
import { ExecutorHttpError, LiveReadUnavailable } from "./live-read-error.ts";
import { AccountOrderNotSubmitted } from "./account-order-unsent-proof.ts";
import { withLiveObservationRetryBudget } from "./live-observation-retry-budget.ts";

const engine = { operator_id: "00000000-0000-4000-8000-000000000001",
  exchange_account_id: "00000000-0000-4000-8000-000000000002",
  trading_engine_id: "00000000-0000-4000-8000-000000000003", symbol: "SOLBRL", quote_asset: "BRL" };
const target = { shardId: "executor-03", ip: "203.0.113.3", base: "https://203.0.113.3", secret: "x".repeat(32) };
const order = { clientOrderId: "owned-1", orderId: "123", symbol: "SOLBRL", side: "SELL" as const,
  status: "FILLED", executedQuantity: .044, cumulativeQuoteQuantity: 22.66, price: 515 };
const trade = { id: "456", quantity: .044, quoteQuantity: 22.66, commission: .00001,
  commissionAsset: "BNB", isBuyer: false, filledAt: "2026-10-16T20:00:00Z" };
const response = (patch = {}) => ({ ...engine, environment: "REAL", executor_shard_id: target.shardId,
  order, trades: [trade], ...patch });
const scoped = { ...engine, id: "run-50", slot_count: 50,
  engine: { slot_count: 50, executor_shard_id: "executor-03" } };

test("observation uses fresh scoped signed envelopes and returns coherent exact order/fills", async () => {
  const requests: Array<Record<string, unknown>> = [], nonces: string[] = [];
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    assert.equal(new URL(String(input)).pathname, "/v1/observe-order");
    assert.equal(init?.method, "POST", "HTTP envelope is read-only Binance GET, not financial dispatch");
    assert.equal(init?.cache, "no-store");
    const headers = new Headers(init?.headers), body = JSON.parse(String(init?.body));
    nonces.push(headers.get("x-coinops-nonce")!); requests.push(body);
    assert.equal(body.operator_id, engine.operator_id); assert.equal(body.exchange_account_id, engine.exchange_account_id);
    assert.equal(body.trading_engine_id, engine.trading_engine_id); assert.equal(body.executor_shard_id, target.shardId);
    assert.equal(body.clientOrderId, "owned-1"); assert.equal(body.orderId, "123");
    assert.equal(headers.get("x-coinops-idempotency-key"), body.idempotency_key);
    assert.match(headers.get("x-coinops-signature")!, /^[a-f0-9]{64}$/);
    return requests.length === 1 ? Response.json({ error: "EXECUTOR_ORDER_OBSERVATION_INCOMPLETE" }, { status: 503 })
      : Response.json(response());
  }) as typeof fetch;
  assert.deepEqual(await readLiveExecutorOrderObservation(engine, "owned-1", "123", fetcher, async () => target), response());
  assert.equal(requests.length, 2); assert.notEqual(requests[0].idempotency_key, requests[1].idempotency_key);
  assert.notEqual(nonces[0], nonces[1]);
});

test("bounded incomplete observation exhausts as typed GET checkpoint", async () => {
  let attempts = 0;
  const fetcher = (async () => { attempts++;
    return Response.json({ error: "EXECUTOR_ORDER_OBSERVATION_INCOMPLETE" }, { status: 503 }); }) as typeof fetch;
  await assert.rejects(withLiveObservationRetryBudget(scoped, () =>
    readLiveExecutorOrderObservation(engine, "owned-1", "123", fetcher, async () => target)), (error: unknown) => {
    assert.ok(error instanceof LiveReadUnavailable);
    assert.equal(error.code, "EXECUTOR_ORDER_OBSERVATION_INCOMPLETE");
    assert.equal(error.path, "/v1/observe-order"); assert.equal(error.attempts, 4); return true;
  });
  assert.equal(attempts, 4);
});

test("large-engine observation retries share three extras across different orders", async () => {
  let attempts = 0;
  const fetcher = (async () => { attempts++;
    return attempts % 2 === 1 ? Response.json({ error: "EXECUTOR_ORDER_OBSERVATION_INCOMPLETE" }, { status: 503 })
      : Response.json(response()); }) as typeof fetch;
  await withLiveObservationRetryBudget(scoped, async () => {
    for (let index = 0; index < 3; index++)
      await readLiveExecutorOrderObservation(engine, "owned-1", "123", fetcher, async () => target);
    await assert.rejects(readLiveExecutorOrderObservation(engine, "owned-1", "123", fetcher, async () => target), LiveReadUnavailable);
  });
  assert.equal(attempts, 7);
});

test("ACK absence is confirmed twice; unacknowledged absence stays null without invented trades", async () => {
  let attempts = 0;
  const absent = (async () => { attempts++; return Response.json(response({ order: null, trades: null })); }) as typeof fetch;
  assert.equal((await readLiveExecutorOrderObservation(engine, "owned-1", "123", absent, async () => target)).order, null);
  assert.equal(attempts, 3);
  attempts = 0;
  assert.equal((await readLiveExecutorOrderObservation(engine, "owned-1", null, absent, async () => target)).trades, null);
  assert.equal(attempts, 1);
});

test("scope and shard mismatch reject once with no fallback", async () => {
  for (const patch of [{ exchange_account_id: "foreign" }, { trading_engine_id: "foreign" },
    { executor_shard_id: "executor-02" }, { environment: "TESTNET" }]) {
    let attempts = 0;
    await assert.rejects(readLiveExecutorOrderObservation(engine, "owned-1", "123", (async () => {
      attempts++; return Response.json(response(patch)); }) as typeof fetch, async () => target), /RESPONSE_(?:SCOPE|SHARD)_MISMATCH/);
    assert.equal(attempts, 1);
  }
});

test("ownership/auth/page-limit/hard schema errors are never retried", async () => {
  for (const code of ["EXECUTOR_ORDER_NOT_OWNED", "EXECUTOR_ORDER_OBSERVATION_SCOPE_DENIED",
    "EXECUTOR_SIGNATURE_INVALID", "EXECUTOR_TRADES_PAGE_LIMIT", "EXECUTOR_TRADE_ID_COLLISION",
    "EXECUTOR_TRADE_INVALID", "EXECUTOR_ORDER_RESPONSE_INVALID"]) {
    let attempts = 0;
    await assert.rejects(readLiveExecutorOrderObservation(engine, "owned-1", "123", (async () => {
      attempts++; return Response.json({ error: code }, { status: 503 }); }) as typeof fetch, async () => target), new RegExp(code));
    assert.equal(attempts, 1);
  }
});

test("malformed or contradictory observation cannot escape as financial facts", async () => {
  for (const patch of [
    { order: null, trades: [] }, { order }, { trades: null },
    { order: { ...order, orderId: "999" } }, { order: { ...order, clientOrderId: "foreign" } },
    { order: { ...order, status: "UNKNOWN" } }, { order: { ...order, symbol: "BTCBRL" } },
    { order: { ...order, executedQuantity: .043 } }, { trades: [{ ...trade, isBuyer: true }] },
    { trades: [{ ...trade, id: 456 }] }, { trades: [{ ...trade, filledAt: 2026 }] },
    { trades: [{ ...trade, quoteQuantity: 22 }] }, { trades: [trade, trade] },
  ]) {
    let attempts = 0;
    const payload = response(patch);
    if (Object.keys(patch).length === 1 && Object.hasOwn(patch, "order") && patch.order === order) delete (payload as Partial<typeof payload>).trades;
    await assert.rejects(readLiveExecutorOrderObservation(engine, "owned-1", "123", (async () => {
      attempts++; return Response.json(payload); }) as typeof fetch, async () => target), /OBSERVATION_RESPONSE_INVALID/);
    assert.equal(attempts, 1);
  }
});

test("new read-only code on create/cancel never retries nor claims a provably-unsent write", async () => {
  const paths: string[] = [];
  const fetcher = (async (input: unknown) => { paths.push(new URL(String(input)).pathname);
    return Response.json({ error: "EXECUTOR_ORDER_OBSERVATION_INCOMPLETE" }, { status: 503 }); }) as typeof fetch;
  const rejected = (error: unknown) => error instanceof ExecutorHttpError
    && !(error instanceof LiveReadUnavailable) && !(error instanceof AccountOrderNotSubmitted);
  await assert.rejects(createLiveExecutorOrder({ clientOrderId: "owned-1", side: "BUY" }, engine, "decision-fixture",
    fetcher, async () => target), rejected);
  await assert.rejects(cancelLiveExecutorOrder({ symbol: "SOLBRL", clientOrderId: "owned-1", orderId: "123" }, engine,
    fetcher, async () => target), rejected);
  assert.deepEqual(paths, ["/v1/create-order", "/v1/cancel-order"]);
});
