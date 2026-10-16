import assert from "node:assert/strict";
import test from "node:test";
import { reserveLiveObservationRetry, withLiveObservationRetryBudget } from "./live-observation-retry-budget.ts";
import { readLiveExecutorOrder, readLiveExecutorState, createLiveExecutorOrder } from "./live-executor-transport.ts";
import { LiveReadUnavailable } from "./live-read-error.ts";

const run = { id: "run-a", operator_id: "00000000-0000-4000-8000-000000000001",
  exchange_account_id: "00000000-0000-4000-8000-000000000002",
  trading_engine_id: "00000000-0000-4000-8000-000000000003", symbol: "SOLBRL", quote_asset: "BRL",
  slot_count: 100, engine: { executor_shard_id: "executor-03", slot_count: 100 } };
const target = { shardId: "executor-03", ip: "203.0.113.3", base: "https://203.0.113.3", secret: "x".repeat(32) };
const scope = { operator_id: run.operator_id, exchange_account_id: run.exchange_account_id,
  trading_engine_id: run.trading_engine_id, symbol: run.symbol, quote_asset: run.quote_asset,
  environment: "REAL", executor_shard_id: target.shardId };

test("100-slot reconciliation shares three extra GET attempts, not three per order", async () => {
  let calls = 0;
  const attempts = new Map<string, number>();
  const fetcher = (async (_url: unknown, options?: RequestInit) => {
    calls++;
    const body = JSON.parse(String(options?.body));
    const count = (attempts.get(body.clientOrderId) ?? 0) + 1;
    attempts.set(body.clientOrderId, count);
    return count === 1 ? Response.json({ error: "EXECUTOR_ORDER_QUERY_FAILED" }, { status: 503 })
      : Response.json({ ...scope, order: { orderId: body.orderId, clientOrderId: body.clientOrderId } });
  }) as typeof fetch;
  const completed: number[] = [];
  await assert.rejects(withLiveObservationRetryBudget(run, async () => {
    for (let index = 1; index <= 100; index++) {
      await readLiveExecutorOrder(run, `owned-${index}`, String(index), fetcher, async () => target);
      completed.push(index);
    }
  }), (error: unknown) => {
    assert.ok(error instanceof LiveReadUnavailable);
    assert.equal(error.path, "/v1/query-order"); assert.equal(error.attempts, 1);
    return true;
  });
  assert.deepEqual(completed, [1, 2, 3]);
  assert.equal(calls, 7);
});

test("the first GET remains available after retries are exhausted; no extra null confirmations", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return Response.json({ ...scope, order: null }); }) as typeof fetch;
  await withLiveObservationRetryBudget(run, async () => {
    assert.equal(reserveLiveObservationRetry(run), true);
    assert.equal(reserveLiveObservationRetry(run), true);
    assert.equal(reserveLiveObservationRetry(run), true);
    assert.equal(reserveLiveObservationRetry(run), false);
    assert.deepEqual(await readLiveExecutorOrder(run, "owned", "1", fetcher, async () => target), { ...scope, order: null });
  });
  assert.equal(calls, 1);
});

test("invalid state cannot launch an unbudgeted second complete GET", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return Response.json(scope); }) as typeof fetch;
  await assert.rejects(withLiveObservationRetryBudget(run, async () => {
    for (let index = 0; index < 3; index++) reserveLiveObservationRetry(run);
    await readLiveExecutorState(run, fetcher, async () => target);
  }), /EXECUTOR_STATE_INVALID/);
  assert.equal(calls, 1);
});

test("25-slot engines keep existing retry policy and concurrent invocations own separate pools", async () => {
  const legacy = { ...run, slot_count: 25, engine: { ...run.engine, slot_count: 25 } };
  await withLiveObservationRetryBudget(legacy, async () => {
    for (let index = 0; index < 10; index++) assert.equal(reserveLiveObservationRetry(legacy), true);
  });
  await Promise.all([run, { ...run, id: "run-b", trading_engine_id: "engine-b" }].map(selected =>
    withLiveObservationRetryBudget(selected, async () => {
      for (let index = 0; index < 3; index++) {
        await Promise.resolve(); assert.equal(reserveLiveObservationRetry(selected), true);
      }
      assert.equal(reserveLiveObservationRetry(selected), false);
    })));
  assert.equal(reserveLiveObservationRetry(run), true, "completed invocation cannot retain its pool");
});

test("a sibling run, account, engine, market or shard cannot borrow another invocation's retry budget", async () => {
  await withLiveObservationRetryBudget(run, async () => {
    for (const field of ["id", "operator_id", "exchange_account_id", "trading_engine_id", "symbol", "quote_asset", "shard"]) {
      const foreign = structuredClone(run);
      if (field === "shard") foreign.engine.executor_shard_id = "executor-02";
      else (foreign as Record<string, unknown>)[field] = "foreign";
      assert.throws(() => reserveLiveObservationRetry(foreign), /OBSERVATION_RETRY_SCOPE_MISMATCH/);
    }
    assert.equal(reserveLiveObservationRetry(run), true);
  });
});

test("the same resolved EngineContext need not carry private run metadata to share its invocation budget", async () => {
  await withLiveObservationRetryBudget(run, async () => {
    const resolvedContext = { operator_id: run.operator_id, exchange_account_id: run.exchange_account_id,
      trading_engine_id: run.trading_engine_id, symbol: run.symbol, quote_asset: run.quote_asset,
      executor_shard_id: run.engine.executor_shard_id };
    assert.equal(reserveLiveObservationRetry(resolvedContext), true);
    assert.equal(reserveLiveObservationRetry({ ...resolvedContext, executor_shard_id: undefined }), true);
    assert.throws(() => reserveLiveObservationRetry({ ...resolvedContext, executor_shard_id: "executor-02" }), /SCOPE_MISMATCH/);
    assert.equal(reserveLiveObservationRetry(run), true);
    assert.equal(reserveLiveObservationRetry(run), false);
  });
});

test("a dispatched order request is never retried, including inside an exhausted observation pool", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return Response.json({ error: "EXECUTOR_HTTP_503" }, { status: 503 }); }) as typeof fetch;
  await assert.rejects(withLiveObservationRetryBudget(run, async () => {
    for (let index = 0; index < 3; index++) reserveLiveObservationRetry(run);
    await createLiveExecutorOrder({ clientOrderId: "owned-order", side: "BUY" }, run,
      "decision", fetcher, async () => target);
  }), /EXECUTOR_HTTP_503/);
  assert.equal(calls, 1);
});
