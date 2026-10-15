import test from "node:test";
import assert from "node:assert/strict";
import { resolveAccountBudgetAlert, AccountBudgetAlertResolutionError } from "./live-account-budget-alert.ts";
import { LiveLedgerReadFailed, LiveReadUnavailable } from "./live-read-error.ts";
import { liveEngineOrderPrefix } from "./robot-v1-live-cycle.ts";

type Row = Record<string, unknown>;
type Result = { data?: unknown; error?: unknown; status?: number; thrown?: unknown; apply?: boolean };
const date = "2026-10-15T08:00:00.000Z";
function fixture() {
  const scope = { product_id: "product", tenant_id: "tenant", user_id: "user", operator_id: "operator",
    exchange_account_id: "account", trading_engine_id: "engine-a" };
  const run = { ...scope, id: "run-a", asset: "SOL", symbol: "SOLBRL", engine: {
    exchange_account_id: scope.exchange_account_id, trading_engine_id: scope.trading_engine_id,
    base_asset: "SOL", legacy_compatible: false, executor_shard_id: "executor-02" } };
  const client = `${liveEngineOrderPrefix(run.engine)}8-B-owned`;
  const order = { ...scope, id: "order-a", run_id: run.id, slot_id: "slot-8", operation_sequence: 1,
    client_order_id: client, strategy_decision_id: "decision-a", exchange_order_id: "exchange-a",
    side: "BUY", status: "NEW", executed_quantity: "0", trades_reconciled: true };
  const alert: Row = { ...scope, id: "alert-a", alert_key: `LIVE_RUN:${run.id}:ACCOUNT_ORDER_BUDGET`,
    code: "COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN", first_seen_at: date, last_seen_at: date, resolved_at: null,
    details: { run_id: run.id, side: "BUY", client_order_id: client } };
  const decision: Row = { ...scope, decision_id: order.strategy_decision_id, environment: "REAL", cycle_id: run.id,
    slot_id: order.slot_id, operation_sequence: 1, asset: "SOL", action_type: "ARM_NEXT_BUY", result: "COMPLETED",
    completed_at: date, exchange_ack_at: date, observed_next_state: { exchange_order_id: order.exchange_order_id } };
  const reservation: Row = { operator_id: scope.operator_id, exchange_account_id: scope.exchange_account_id,
    trading_engine_id: scope.trading_engine_id, executor_shard_id: "executor-02", client_order_id: client,
    reserved_at: date, acknowledged_at: date };
  const rows: Record<string, Row[]> = { robot_v1_live_alerts: [alert], robot_v1_strategy_decisions: [decision],
    account_order_budget_reservations: [reservation] };
  const reads: { table: string; filters: Row }[] = [], writes: { table: string; values: Row; filters: Row }[] = [];
  const writeResults: Result[] = [], readResults: Record<string, Result[]> = {};
  let renewals = 0;
  let afterWrite: (() => void) | undefined;
  const field = (row: Row, name: string) => name.includes("->>")
    ? (row[name.split("->>")[0]] as Row)?.[name.split("->>")[1]] : row[name];
  const service = { from(table: string) {
    const filters: Row = {}; let values: Row | null = null;
    const chain = { select: () => chain, limit: () => chain,
      abortSignal: (signal: AbortSignal) => { assert.equal(signal.aborted, false); return chain; },
      eq: (name: string, value: unknown) => { filters[name] = value; return chain; },
      is: (name: string, value: unknown) => { filters[name] = value; return chain; },
      update: (value: Row) => { values = value; return chain; },
      then: (done: (value: unknown) => unknown, rejected?: (error: unknown) => unknown) => {
        const matches = (rows[table] ?? []).filter(row => Object.entries(filters).every(([key, value]) => field(row, key) === value));
        if (values) {
          writes.push({ table, values, filters: { ...filters } });
          const result = writeResults.shift() ?? {};
          if (result.apply ?? (!result.error && !result.thrown)) for (const row of matches) Object.assign(row, values);
          afterWrite?.();
          if (result.thrown) return Promise.reject(result.thrown).then(done, rejected);
          return Promise.resolve({ data: result.data ?? matches.map(row => ({ id: row.id })), error: result.error ?? null,
            status: result.status ?? 200 }).then(done);
        }
        reads.push({ table, filters: { ...filters } });
        const result = readResults[table]?.shift();
        if (result?.thrown) return Promise.reject(result.thrown).then(done, rejected);
        return Promise.resolve(result ? { data: result.data ?? (result.error ? null : matches), error: result.error ?? null,
          status: result.status ?? 200 } : { data: structuredClone(matches), error: null, status: 200 }).then(done);
      } };
    return chain;
  } };
  const resolve = (next = "HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT", options = { renewLease: async () => { renewals++; } }) =>
    resolveAccountBudgetAlert(service as unknown as Parameters<typeof resolveAccountBudgetAlert>[0], run, [order], next, options);
  return { run, order, alert, decision, reservation, rows, reads, writes, writeResults, readResults, resolve,
    renewals: () => renewals, afterWrite: (callback: () => void) => { afterWrite = callback; } };
}

test("absent/already resolved budget target is NOOP even with closed entry gate", async () => {
  const absent = fixture(); absent.rows.robot_v1_live_alerts = [];
  assert.deepEqual(await absent.resolve("KILL_SWITCH"), { status: "ABSENT" });
  assert.equal(absent.reads.length, 1); assert.equal(absent.writes.length, 0);
  const closed = fixture(); closed.alert.resolved_at = date;
  assert.deepEqual(await closed.resolve(), { status: "ABSENT" });
  assert.equal(closed.writes.length, 0);
});

test("entry holds, partial fills, unknown next states never hide a budget warning", async () => {
  for (const next of ["KILL_SWITCH", "EXECUTOR_NOT_ACTIVE", "CAPACITY_HOLD", "QUOTE_BALANCE_HOLD",
    "BNB_FEE_BALANCE_HOLD", "BNB_FEE_BALANCE_READ_HOLD", "BUY_PARTIAL", "ENTRY_FILLED_DURING_REPLACEMENT", "UNKNOWN"]) {
    const f = fixture(); assert.deepEqual(await f.resolve(next), { status: "DEFERRED" });
    assert.equal(f.reads.length, 1); assert.equal(f.writes.length, 0); assert.equal(f.alert.resolved_at, null);
  }
  const partial = fixture(); partial.order.status = "PARTIALLY_FILLED"; partial.order.executed_quantity = "0.1";
  assert.equal((await partial.resolve()).status, "DEFERRED"); assert.equal(partial.writes.length, 0);
});

test("same completed held intent resolves only its exact metadata CAS and never financial records", async () => {
  for (const next of ["INITIAL_SUBMITTED", "NEXT_BUY_ARMED", "HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT",
    "NO_UNCROSSED_ENTRY_CANDIDATE", "VERIFIED_METADATA_RECOVERY"]) {
    const f = fixture();
    f.rows.robot_v1_live_alerts.push({ ...f.alert, id: "other-alert", trading_engine_id: "engine-b" });
    assert.deepEqual(await f.resolve(next), { status: "RESOLVED" });
    assert.equal(f.writes.length, 1); assert.equal(f.renewals(), 1);
    const write = f.writes[0]; assert.equal(write.table, "robot_v1_live_alerts");
    assert.deepEqual(Object.keys(write.values), ["resolved_at"]);
    for (const key of ["product_id", "tenant_id", "user_id", "operator_id", "exchange_account_id", "trading_engine_id"])
      assert.equal(write.filters[key], f.run[key as keyof typeof f.run]);
    for (const key of ["id", "code", "first_seen_at", "last_seen_at", "alert_key"])
      assert.equal(write.filters[key], f.alert[key]);
    assert.equal(write.filters["details->>client_order_id"], f.order.client_order_id);
    assert.equal(write.filters["details->>run_id"], f.run.id); assert.equal(write.filters["details->>side"], "BUY");
    assert.equal(f.rows.robot_v1_live_alerts[1].resolved_at, null);
  }
});

test("valid settled fill/terminal and SELL TP proof use the same completion/ACK contract", async () => {
  for (const status of ["FILLED", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH"]) {
    const f = fixture(); f.order.status = status; f.order.executed_quantity = "0.2";
    assert.equal((await f.resolve()).status, "RESOLVED");
  }
  const sell = fixture(); sell.order.side = "SELL";
  (sell.alert.details as Row).side = "SELL"; sell.decision.action_type = "CREATE_TP";
  assert.equal((await sell.resolve()).status, "RESOLVED");
});

test("missing/current incomplete order, decision or ACK remain visible and unmodified", async () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => { f.order.client_order_id += "-different"; },
    (f: ReturnType<typeof fixture>) => { f.order.status = "PREPARED"; },
    (f: ReturnType<typeof fixture>) => { f.order.status = "FILLED"; f.order.trades_reconciled = false; },
    (f: ReturnType<typeof fixture>) => { f.order.exchange_order_id = ""; },
    (f: ReturnType<typeof fixture>) => { f.order.executed_quantity = "NaN"; },
    (f: ReturnType<typeof fixture>) => { f.decision.result = "DISPATCHED"; },
    (f: ReturnType<typeof fixture>) => { f.decision.completed_at = null; },
    (f: ReturnType<typeof fixture>) => { f.decision.exchange_ack_at = null; },
    (f: ReturnType<typeof fixture>) => { f.decision.observed_next_state = { exchange_order_id: "another" }; },
    (f: ReturnType<typeof fixture>) => { f.reservation.acknowledged_at = null; },
    (f: ReturnType<typeof fixture>) => { f.rows.account_order_budget_reservations = []; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f); assert.equal((await f.resolve()).status, "DEFERRED");
    assert.equal(f.writes.length, 0); assert.equal(f.alert.resolved_at, null);
  }
});

test("missing/foreign run, engine, symbol-side context or cross-shard ACK cannot authorize cleanup", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.order.run_id = "another-run"; },
    (f: ReturnType<typeof fixture>) => { f.order.trading_engine_id = "engine-b"; },
    (f: ReturnType<typeof fixture>) => { f.order.side = "SELL"; },
    (f: ReturnType<typeof fixture>) => { (f.alert.details as Row).run_id = "another-run"; },
    (f: ReturnType<typeof fixture>) => { f.decision.cycle_id = "another-run"; },
    (f: ReturnType<typeof fixture>) => { f.decision.asset = "BTC"; },
    (f: ReturnType<typeof fixture>) => { f.reservation.executor_shard_id = "executor-03"; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(f.resolve(), /COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_PROOF_INVALID/);
    assert.equal(f.writes.length, 0);
  }
});

test("lease renewal is mandatory before each metadata mutation", async () => {
  const f = fixture(); await assert.rejects(f.resolve(undefined, {} as { renewLease: () => Promise<void> }), /LEASE_REQUIRED/);
  assert.equal(f.writes.length, 0);
  const lost = fixture();
  await assert.rejects(lost.resolve(undefined, { renewLease: async () => { throw new Error("LEASE_LOST"); } }), /LEASE_LOST/);
  assert.equal(lost.writes.length, 0);
});

test("lost metadata response applied once is proved by readback without a second CAS", async () => {
  const f = fixture(); f.writeResults.push({ thrown: new TypeError("PRIVATE network loss"), apply: true });
  assert.equal((await f.resolve()).status, "RESOLVED");
  assert.equal(f.writes.length, 1); assert.equal(f.reads.filter(read => read.table === "robot_v1_live_alerts").length, 2);
});

test("NEW with zero fills does not need a fictitious reconciled-trades flag", async () => {
  const f = fixture(); f.order.trades_reconciled = false;
  assert.equal((await f.resolve()).status, "RESOLVED"); assert.equal(f.writes.length, 1);
});

test("PostgREST offset rendering of the same resolved instant proves a lost response", async () => {
  const f = fixture(); f.writeResults.push({ thrown: new DOMException("PRIVATE", "TimeoutError"), apply: true });
  f.afterWrite(() => { f.alert.resolved_at = String(f.alert.resolved_at).replace("Z", "+00:00"); });
  assert.equal((await f.resolve()).status, "RESOLVED"); assert.equal(f.writes.length, 1);
});

test("confirmed transient metadata failure retries only the identical CAS after exact readback", async () => {
  const f = fixture(); f.writeResults.push({ error: { code: "PGRST003", message: "PRIVATE" }, status: 503, apply: false });
  assert.equal((await f.resolve()).status, "RESOLVED"); assert.equal(f.writes.length, 2); assert.equal(f.renewals(), 2);
  assert.deepEqual(f.writes[0], f.writes[1]);
  assert.ok(f.writes.every(write => write.table === "robot_v1_live_alerts"));
});

test("bounded write exhaustion stays explicit and cannot masquerade as a GET outage", async () => {
  const f = fixture(); f.writeResults.push(...Array.from({ length: 2 }, () => ({ error: { code: "08006", message: "PRIVATE" }, status: 504, apply: false })));
  await assert.rejects(f.resolve(), error => {
    assert.ok(error instanceof AccountBudgetAlertResolutionError); assert.ok(!(error instanceof LiveReadUnavailable));
    assert.equal(error.code, "COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_RESOLVE_RETRY");
    assert.equal(error.path, "alert/account_budget/resolve"); assert.equal(error.attempts, 2);
    assert.equal(error.httpStatus, 504); assert.equal(error.providerCode, "08006");
    assert.ok(!JSON.stringify(error).includes("PRIVATE")); return true;
  });
  assert.equal(f.writes.length, 2); assert.equal(f.alert.resolved_at, null);
});

test("permission/schema/unknown write failure is hard, never retried by status or text alone", async () => {
  for (const result of [
    { error: { code: "42501", message: "PRIVATE" }, status: 503 },
    { error: { code: "PGRST204" }, status: 504 }, { error: { code: "UNKNOWN_PRIVATE" }, status: 503 },
    { error: { message: "fetch failed PRIVATE" }, status: 0 }, { thrown: new Error("EXECUTOR_HTTP_503") },
  ]) {
    const f = fixture(); f.writeResults.push(result);
    await assert.rejects(f.resolve(), error => error instanceof AccountBudgetAlertResolutionError
      && error.code === "COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_WRITE_FAILED");
    assert.equal(f.writes.length, 1); assert.equal(f.alert.resolved_at, null);
  }
});

test("GET retries are bounded and typed; missing/malformed/permission data do not become zero or write retry", async () => {
  const transient = fixture(); transient.readResults.robot_v1_live_alerts = [{ error: { code: "PGRST003" }, status: 503 }];
  assert.equal((await transient.resolve()).status, "RESOLVED");
  assert.equal(transient.reads.filter(read => read.table === "robot_v1_live_alerts").length, 2);
  const denied = fixture(); denied.readResults.robot_v1_live_alerts = [{ error: { code: "42501" }, status: 503 }];
  await assert.rejects(denied.resolve(), LiveLedgerReadFailed); assert.equal(denied.reads.length, 1); assert.equal(denied.writes.length, 0);
  const malformed = fixture(); delete malformed.alert.resolved_at;
  await assert.rejects(malformed.resolve(), /PROOF_INVALID/); assert.equal(malformed.writes.length, 0);
});

test("a later hard proof failure takes precedence over a parallel transient GET", async () => {
  const f = fixture();
  f.readResults.robot_v1_strategy_decisions = [{ error: { code: "PGRST003" }, status: 503 }];
  f.readResults.account_order_budget_reservations = [{ error: { code: "42501" }, status: 403 }];
  await assert.rejects(f.resolve(), LiveLedgerReadFailed); assert.equal(f.writes.length, 0);
  assert.equal(f.reads.filter(read => read.table === "robot_v1_strategy_decisions").length, 1);
});

test("changed alert after uncertain response rejects retry and leaves the successor visible", async () => {
  for (const field of ["last_seen_at", "client_order_id"]) {
    const f = fixture(); f.writeResults.push({ error: {}, status: 503, apply: false });
    f.afterWrite(() => { if (field === "last_seen_at") f.alert.last_seen_at = "2026-10-15T08:01:00Z";
      else (f.alert.details as Row).client_order_id = "new-intent"; });
    await assert.rejects(f.resolve(), /COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_CHANGED/);
    assert.equal(f.writes.length, 1); assert.equal(f.alert.resolved_at, null);
  }
});
