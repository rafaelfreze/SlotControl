import assert from "node:assert/strict";
import test from "node:test";
import { readLiveExposure, type ExposureScope } from "./live-exposure-read.ts";
import { LiveLedgerReadFailed, LiveReadUnavailable } from "./live-read-error.ts";

type Row = Record<string, unknown>;
type Failure = { error: { code: string; message: string }; status: number } | { thrown: Error };
const scope: ExposureScope = { id: "run-a", asset: "SOL", symbol: "SOLBRL", product_id: "product", tenant_id: "tenant",
  user_id: "user", operator_id: "operator", exchange_account_id: "account", trading_engine_id: "engine-a", quote_asset: "BRL" };

function fixture(options: { failures?: Record<string, Failure[]>; partial?: string; partialStart?: number;
  missingCount?: string; countDrift?: string } = {}) {
  const owned = { product_id: scope.product_id, tenant_id: scope.tenant_id, user_id: scope.user_id,
    operator_id: scope.operator_id, exchange_account_id: scope.exchange_account_id, quote_asset: scope.quote_asset };
  const runs = [
    { ...owned, id: "run-a", trading_engine_id: "engine-a", asset: "SOL", symbol: "SOLBRL", status: "ACTIVE" },
    { ...owned, id: "run-b", trading_engine_id: "engine-b", asset: "SOL", symbol: "SOLBRL", status: "PAUSED" },
    { ...owned, id: "run-c", trading_engine_id: "engine-c", asset: "BTC", symbol: "BTCBRL", status: "ACTIVE" },
  ];
  const engines = runs.map((run, index) => ({ id: run.trading_engine_id, operator_id: scope.operator_id,
    exchange_account_id: scope.exchange_account_id, quote_asset: scope.quote_asset, environment: "REAL",
    symbol: run.symbol, base_asset: run.asset, hard_cap_quote: 200, executor_shard_id: `executor-0${index + 1}` }));
  const slots = runs.flatMap((run, index) => Array.from({ length: 25 }, (_, number) => ({ ...owned,
    id: `${run.id}-slot-${number + 1}`, run_id: run.id, trading_engine_id: run.trading_engine_id,
    slot_number: number + 1, operational_rank: 25 - number,
    position_committed_brl: number === 0 ? [30, 40, 50][index] : 0 })));
  const orders = [
    { ...owned, id: "buy-a", run_id: "run-a", trading_engine_id: "engine-a", slot_id: "run-a-slot-2",
      side: "BUY", status: "NEW", reserved_notional_brl: 10, cumulative_quote: 0 },
    { ...owned, id: "buy-b", run_id: "run-b", trading_engine_id: "engine-b", slot_id: "run-b-slot-2",
      side: "BUY", status: "PARTIALLY_FILLED", reserved_notional_brl: 25, cumulative_quote: 5 },
    { ...owned, id: "tp-c", run_id: "run-c", trading_engine_id: "engine-c", slot_id: "run-c-slot-1",
      side: "SELL", status: "NEW", reserved_notional_brl: 0, cumulative_quote: 0 },
  ];
  const tables: Record<string, Row[]> = { robot_v1_live_runs: runs, trading_engines: engines,
    robot_v1_live_slots: slots, robot_v1_live_orders: orders,
    account_quote_caps: [{ operator_id: scope.operator_id, exchange_account_id: scope.exchange_account_id,
      quote_asset: scope.quote_asset, hard_cap_quote: 500 }] };
  const calls: Array<{ table: string; filters: Record<string, unknown>; signal: AbortSignal; columns: string }> = [];
  const client = { from(table: string) {
    const filters: Record<string, unknown> = {};
    let start = 0, end = 499, singleton = false, signal: AbortSignal, columns = "";
    const chain = {
      select(value: string, settings?: { count: string }) {
        columns = value;
        if (table !== "account_quote_caps") assert.equal(settings?.count, "exact");
        return chain;
      },
      eq(key: string, value: unknown) { filters[key] = value; return chain; },
      in(key: string, value: unknown[]) { filters[key] = value; return chain; },
      order(key: string) { assert.equal(key, "id"); return chain; },
      range(from: number, to: number) { start = from; end = to; return chain; },
      abortSignal(value: AbortSignal) { signal = value; return chain; },
      single() { singleton = true; return chain; },
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        calls.push({ table, filters: { ...filters }, signal, columns });
        assert.ok(signal instanceof AbortSignal);
        const failure = options.failures?.[table]?.shift();
        if (failure && "thrown" in failure) return Promise.reject(failure.thrown).then(resolve, reject);
        if (failure) return Promise.resolve({ data: null, count: null, ...failure }).then(resolve, reject);
        const rows = tables[table].filter(row => Object.entries(filters).every(([key, value]) =>
          Array.isArray(value) ? value.includes(row[key]) : row[key] === value)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
        let data: Row[] | Row | null = singleton ? rows[0] ?? null : rows.slice(start, end + 1);
        if (table === options.partial && start >= (options.partialStart ?? 0) && Array.isArray(data))
          data = data.slice(0, Math.max(0, data.length - 1));
        return Promise.resolve({ data, error: null, status: 200,
          count: table === options.missingCount ? null : rows.length - (table === options.countDrift && start >= 500 ? 1 : 0) }).then(resolve, reject);
      },
    };
    return chain;
  } } as unknown as Parameters<typeof readLiveExposure>[0];
  return { client, tables, calls, owned };
}

test("complete exposure uses native account total across same-symbol engines/shards without rank dependence", async () => {
  const f = fixture();
  assert.deepEqual(await readLiveExposure(f.client, scope), { BTC: 0, SOL: 40, global: 150 });
  assert.deepEqual(await readLiveExposure(f.client, { ...scope, id: "run-b", trading_engine_id: "engine-b" }),
    { BTC: 0, SOL: 60, global: 150 });
  assert.deepEqual(await readLiveExposure(f.client, { ...scope, id: "run-c", asset: "BTC", symbol: "BTCBRL", trading_engine_id: "engine-c" }),
    { BTC: 50, SOL: 0, global: 150 });
  assert.ok(f.calls.every(call => call.filters.executor_shard_id === undefined && !call.columns.includes("operational_rank")));
  assert.ok(f.calls.every(call => call.filters.operator_id === scope.operator_id && call.filters.exchange_account_id === scope.exchange_account_id));
  assert.ok(f.calls.filter(call => ["robot_v1_live_runs", "trading_engines", "account_quote_caps"].includes(call.table))
    .every(call => call.filters.quote_asset === scope.quote_asset));
  // Child rows are read through the native-quote selected run IDs, not by
  // trusting their own quote field to filter corrupted reserves out of view.
  assert.ok(f.calls.filter(call => ["robot_v1_live_slots", "robot_v1_live_orders"].includes(call.table))
    .every(call => call.filters.quote_asset === undefined));
  assert.equal(new Set(f.calls.slice(0, 5).map(call => call.signal)).size, 1);
});

test("same account same symbol 25 and100 slots across shards use their own complete canonical counts", async () => {
  const f = fixture();
  f.tables.robot_v1_live_runs[1].slot_count = 100;
  f.tables.trading_engines[1].slot_count = 100;
  f.tables.trading_engines[1].config = { slot_count: 100 };
  const existing = f.tables.robot_v1_live_slots.find(row => row.run_id === "run-b")!;
  for (let number = 26; number <= 100; number++) f.tables.robot_v1_live_slots.push({ ...existing,
    id: `run-b-slot-${number}`, slot_number: number, position_committed_brl: 0 });
  assert.deepEqual(await readLiveExposure(f.client, scope), { BTC: 0, SOL: 40, global: 150 });
  f.tables.robot_v1_live_slots.pop();
  await assert.rejects(readLiveExposure(f.client, scope), /LEDGER_INCOMPLETE/);
  f.tables.robot_v1_live_runs[1].slot_count = 25;
  await assert.rejects(readLiveExposure(f.client, scope), /EXPOSURE_INCOMPLETE/);
});

test("the first activated run with 25 seeded zero-position slots legitimately has zero exposure before dispatch", async () => {
  const f = fixture();
  f.tables.robot_v1_live_runs = f.tables.robot_v1_live_runs.filter(row => row.id === scope.id);
  f.tables.trading_engines = f.tables.trading_engines.filter(row => row.id === scope.trading_engine_id);
  f.tables.robot_v1_live_slots = f.tables.robot_v1_live_slots.filter(row => row.run_id === scope.id)
    .map(row => ({ ...row, position_committed_brl: 0 }));
  f.tables.robot_v1_live_orders = [];
  assert.deepEqual(await readLiveExposure(f.client, scope), { BTC: 0, SOL: 0, global: 0 });
  // Preparation never calls exposure; activation commits ACTIVE and all 25
  // physical slots before the worker may prepare the first exchange order.
  f.tables.robot_v1_live_runs[0].status = "PREPARING";
  await assert.rejects(readLiveExposure(f.client, scope), /INCOMPLETE/);
});

test("USDT projection stays native and a genuine own/global cap breach is never observation retry", async () => {
  const f = fixture();
  for (const rows of Object.values(f.tables)) for (const row of rows) {
    row.quote_asset = "USDT";
    if (typeof row.symbol === "string") row.symbol = row.symbol.replace("BRL", "USDT");
  }
  const usdt = { ...scope, quote_asset: "USDT", symbol: "SOLUSDT" };
  assert.deepEqual(await readLiveExposure(f.client, usdt), { BTC: 0, SOL: 40, global: 150 });
  f.tables.account_quote_caps[0].hard_cap_quote = 149;
  const before = f.calls.length;
  await assert.rejects(readLiveExposure(f.client, usdt), /HARD_CAP_BREACHED/);
  assert.equal(f.calls.slice(before).filter(call => call.table === "robot_v1_live_runs").length, 1);
  f.tables.account_quote_caps[0].hard_cap_quote = 500;
  f.tables.trading_engines[0].hard_cap_quote = 39;
  await assert.rejects(readLiveExposure(f.client, usdt), /HARD_CAP_BREACHED/);
});

test("nonoperational historical runs do not enter the total; a PAUSED same-symbol sibling still does", async () => {
  const f = fixture();
  const archived = { ...f.tables.robot_v1_live_runs[0], id: "run-archived", trading_engine_id: "engine-archived", status: "COMPLETED" };
  f.tables.robot_v1_live_runs.push(archived);
  f.tables.trading_engines.push({ ...f.tables.trading_engines[0], id: "engine-archived", status: "INACTIVE", executor_shard_id: "executor-03" });
  f.tables.robot_v1_live_slots.push({ ...f.tables.robot_v1_live_slots[0], id: "archived-slot", run_id: "run-archived",
    trading_engine_id: "engine-archived", position_committed_brl: 999 });
  assert.deepEqual(await readLiveExposure(f.client, scope), { BTC: 0, SOL: 40, global: 150 });
  assert.ok(f.calls.filter(call => call.table === "robot_v1_live_runs")
    .every(call => JSON.stringify(call.filters.status) === JSON.stringify(["ACTIVE", "PAUSED"])));
});

test("one 503 discards the partial set and re-reads all facts with a fresh shared deadline", async () => {
  const f = fixture({ failures: { robot_v1_live_orders: [{ status: 503, error: { code: "PGRST003", message: "private-provider-detail" } }] } });
  assert.deepEqual(await readLiveExposure(f.client, scope), { BTC: 0, SOL: 40, global: 150 });
  assert.equal(f.calls.filter(call => call.table === "robot_v1_live_runs").length, 2);
  assert.equal(new Set(f.calls.map(call => call.signal)).size, 2);
});

test("persistent 503/timeout is typed, bounded and retains the exact observation path", async () => {
  for (const failure of [{ status: 503, error: { code: "PGRST003", message: "private-provider-detail" } },
    { thrown: new DOMException("private timeout", "TimeoutError") }]) {
    const f = fixture({ failures: { robot_v1_live_orders: [failure, failure] } });
    await assert.rejects(readLiveExposure(f.client, scope), (error: unknown) => error instanceof LiveReadUnavailable
      && error.code === "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE" && error.path === "ledger/exposure_orders" && error.attempts === 2
      && !error.message.includes("private"));
    assert.equal(f.calls.filter(call => call.table === "robot_v1_live_runs").length, 2);
  }
});

test("permission/schema/unknown failures never retry or get relabeled as missing/zero exposure", async () => {
  for (const [status, code] of [[403, "42501"], [400, "42703"], [500, ""]] as const) {
    const f = fixture({ failures: { robot_v1_live_orders: [{ status, error: { code, message: "private-provider-detail" } }] } });
    await assert.rejects(readLiveExposure(f.client, scope), (error: unknown) => error instanceof LiveLedgerReadFailed
      && error.path === "ledger/exposure_orders" && error.httpStatus === status && error.attempts === 1
      && !error.message.includes("private"));
    assert.equal(f.calls.filter(call => call.table === "robot_v1_live_runs").length, 1);
  }
});

test("simultaneous transient and permission errors prefer fail-closed permission rather than retry", async () => {
  const f = fixture({ failures: {
    trading_engines: [{ status: 503, error: { code: "PGRST003", message: "private" } }],
    account_quote_caps: [{ status: 403, error: { code: "42501", message: "private" } }],
  } });
  await assert.rejects(readLiveExposure(f.client, scope), (error: unknown) => error instanceof LiveLedgerReadFailed
    && error.path === "ledger/quote_cap" && error.providerCode === "42501");
  assert.equal(f.calls.filter(call => call.table === "robot_v1_live_runs").length, 1);
});

test("empty/partial roster or physical slots are incomplete, never valid zero", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.tables.robot_v1_live_runs = []; },
    (f: ReturnType<typeof fixture>) => { f.tables.robot_v1_live_runs.shift(); },
    (f: ReturnType<typeof fixture>) => { f.tables.trading_engines.shift(); },
    (f: ReturnType<typeof fixture>) => { f.tables.robot_v1_live_slots.pop(); },
    (f: ReturnType<typeof fixture>) => { f.tables.robot_v1_live_slots[24].slot_number = 1; },
    (f: ReturnType<typeof fixture>) => { f.tables.robot_v1_live_runs[1].trading_engine_id = "engine-a"; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(readLiveExposure(f.client, scope), /INCOMPLETE/);
    assert.equal(f.calls.filter(call => call.table === "robot_v1_live_runs").length, 1);
  }
  for (const table of ["robot_v1_live_runs", "trading_engines", "robot_v1_live_slots", "robot_v1_live_orders"]) {
    await assert.rejects(readLiveExposure(fixture({ partial: table }).client, scope), /INCOMPLETE/);
    await assert.rejects(readLiveExposure(fixture({ missingCount: table }).client, scope), /INCOMPLETE/);
  }
});

test("foreign identity, quote, engine/run mapping, order slot and missing money all fail closed", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.tables.robot_v1_live_slots[0].trading_engine_id = "engine-b"; },
    (f: ReturnType<typeof fixture>) => { f.tables.robot_v1_live_slots[0].user_id = "another-user"; },
    (f: ReturnType<typeof fixture>) => { f.tables.robot_v1_live_orders[0].trading_engine_id = "engine-b"; },
    (f: ReturnType<typeof fixture>) => { f.tables.robot_v1_live_orders[0].slot_id = "run-b-slot-2"; },
    (f: ReturnType<typeof fixture>) => { f.tables.trading_engines[1].base_asset = "BTC"; },
    (f: ReturnType<typeof fixture>) => { f.tables.robot_v1_live_slots[0].quote_asset = "USDT"; },
    (f: ReturnType<typeof fixture>) => { f.tables.robot_v1_live_slots[0].position_committed_brl = null; },
    (f: ReturnType<typeof fixture>) => { f.tables.robot_v1_live_slots[0].position_committed_brl = ""; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(readLiveExposure(f.client, scope), /INCOMPLETE/);
  }
});

test("duplicate IDs never get counted twice or certified as complete exposure", async () => {
  for (const table of ["robot_v1_live_runs", "trading_engines", "robot_v1_live_slots", "robot_v1_live_orders"]) {
    const f = fixture(); f.tables[table].push({ ...f.tables[table][0] });
    await assert.rejects(readLiveExposure(f.client, scope), /INCOMPLETE/);
  }
});

test("a resident order's wrong/null quote cannot disappear through filtering and understate account reserves", async () => {
  for (const quote of ["USDT", null]) {
    const f = fixture();
    f.tables.robot_v1_live_orders[0].quote_asset = quote;
    await assert.rejects(readLiveExposure(f.client, scope), /INCOMPLETE/);
    assert.equal(f.calls.filter(call => call.table === "robot_v1_live_runs").length, 1);
    assert.ok(f.calls.filter(call => call.table === "robot_v1_live_orders")
      .every(call => call.filters.quote_asset === undefined));
  }
});

test("large complete pages include every position/resident order and reject a truncated final page", async () => {
  const options: { partial?: string; partialStart?: number; countDrift?: string } = {};
  const f = fixture(options);
  const runs = Array.from({ length: 25 }, (_, n) => ({ ...f.tables.robot_v1_live_runs[0], id: `run-${n}`,
    trading_engine_id: `engine-${n}` }));
  f.tables.robot_v1_live_runs = runs;
  f.tables.trading_engines = runs.map((run, n) => ({ ...f.tables.trading_engines[0], id: run.trading_engine_id,
    executor_shard_id: `executor-0${n % 3 + 1}` }));
  f.tables.robot_v1_live_slots = runs.flatMap(run => Array.from({ length: 25 }, (_, slot) => ({ ...f.owned,
    id: `${run.id}-slot-${slot}`, run_id: run.id, trading_engine_id: run.trading_engine_id,
    slot_number: slot + 1, position_committed_brl: slot < 20 ? 1 : 0 })));
  f.tables.robot_v1_live_orders = runs.flatMap(run => Array.from({ length: 21 }, (_, slot) => ({ ...f.owned,
    id: `${run.id}-order-${slot}`, run_id: run.id, trading_engine_id: run.trading_engine_id,
    slot_id: `${run.id}-slot-${slot}`, side: slot < 20 ? "SELL" : "BUY", status: "NEW",
    reserved_notional_brl: slot < 20 ? 0 : 1, cumulative_quote: 0 })));
  f.tables.account_quote_caps[0].hard_cap_quote = 1000;
  const selected = { ...scope, id: runs[0].id, trading_engine_id: runs[0].trading_engine_id };
  assert.deepEqual(await readLiveExposure(f.client, selected), { BTC: 0, SOL: 21, global: 525 });
  assert.equal(f.calls.filter(call => call.table === "robot_v1_live_slots").length, 2);
  assert.equal(f.calls.filter(call => call.table === "robot_v1_live_orders").length, 2);
  options.partial = "robot_v1_live_orders";
  options.partialStart = 500;
  await assert.rejects(readLiveExposure(f.client, selected), /INCOMPLETE/);
  options.partial = undefined;
  options.countDrift = "robot_v1_live_orders";
  const before = f.calls.length;
  await assert.rejects(readLiveExposure(f.client, selected), /INCOMPLETE/);
  // The changing GET set was not an atomic snapshot and cannot be certified.
  // It is not mislabeled as a provider timeout or a financial success.
  assert.equal(f.calls.slice(before).filter(call => call.table === "robot_v1_live_runs").length, 1);
});
