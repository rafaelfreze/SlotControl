import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { assertPhysicalLedger, boundedLedgerRead, observeLedgerRows } from "./live-ledger-read.ts";
import * as readErrors from "./live-read-error.ts";
import { completeLedgerRead } from "./complete-ledger-read.ts";

const physical = () => Array.from({ length: 25 }, (_, i) => ({ slot_number: i + 1 }));

test("503/connection/timeout reads retry a complete snapshot once; provider evidence is sanitized", async () => {
  for (const error of [{ code: "PGRST003", status: 504 }, { code: "08006", status: 503 },
    { code: "57014", status: 500 }, { code: "", status: 503 }, { code: "", status: 0 }]) {
    let calls = 0;
    const rows = await boundedLedgerRead(async (deadline, attempt) => {
      calls++;
      return observeLedgerRows("orders", Promise.resolve(calls === 1
        ? { data: null, error: { code: error.code, message: "TypeError: fetch failed PRIVATE", details: "PRIVATE" }, status: error.status }
        : { data: [{ id: "own" }], error: null, status: 200 }), deadline, attempt);
    });
    assert.deepEqual(rows, [{ id: "own" }]); assert.equal(calls, 2);
  }
  let calls = 0;
  await assert.rejects(boundedLedgerRead(async (deadline, attempt) => {
    calls++;
    return observeLedgerRows("slots", Promise.resolve({ data: null,
      error: { code: "PGRST003", message: "PRIVATE" }, status: 504 }), deadline, attempt);
  }), error => {
    assert.ok(error instanceof readErrors.LiveReadUnavailable);
    assert.equal(error.attempts, 2); assert.equal(error.path, "ledger/slots");
    const evidence = readErrors.liveFailureEvidence(error, "RECONCILE_ORDERS", "LIVE_CRON");
    assert.equal(evidence.provider_code, "PGRST003");
    assert.equal(evidence.http_status, 504); assert.ok(!JSON.stringify(evidence).includes("PRIVATE"));
    return true;
  });
  assert.equal(calls, 2);
});

test("own expired read deadline retries; permission/schema errors never inherit timeout treatment", async () => {
  const expired = AbortSignal.abort();
  await assert.rejects(observeLedgerRows("slots", Promise.resolve({ data: null,
    error: { code: "", message: "TimeoutError: private" }, status: 0 }), expired, 1), readErrors.LiveReadUnavailable);
  for (const code of ["42501", "PGRST301", "42P01", "PGRST204", "UNKNOWN_PRIVATE"]) {
    let calls = 0;
    await assert.rejects(boundedLedgerRead(async () => {
      calls++;
      return observeLedgerRows("orders", Promise.resolve({ data: null,
        error: { code, message: "PRIVATE" }, status: 503 }), expired, 1);
    }), readErrors.LiveLedgerReadFailed);
    assert.equal(calls, 1);
  }
  await assert.rejects(observeLedgerRows("slots", Promise.resolve({ data: null,
    error: { code: "PGRST003" }, status: 403 }), expired, 1), readErrors.LiveLedgerReadFailed);
});

test("successful missing/null/malformed physical rows remain fail-closed, never an observation retry", async () => {
  for (const rows of [physical().slice(1), [...physical().slice(1), { slot_number: 2 }],
    [...physical().slice(1), { slot_number: 26 }]]) {
    let calls = 0;
    await assert.rejects(boundedLedgerRead(async () => { calls++; assertPhysicalLedger(rows); }), /LEDGER_INCOMPLETE/);
    assert.equal(calls, 1);
  }
  assert.doesNotThrow(() => assertPhysicalLedger(physical()));
  await assert.rejects(observeLedgerRows("orders", Promise.resolve({ data: null, error: null }),
    AbortSignal.timeout(5_000), 1), /LEDGER_INCOMPLETE/);
});

/** Real runRows, stubbed GET builders only. No financial or network boundary is available. */
function fixture(engine: string, failures: Record<string, { code: string; status: number }> = {}, manyOrders = false) {
  const scope = { tenant_id: "tenant", product_id: "product", user_id: "user", operator_id: "operator",
    exchange_account_id: "same-account", trading_engine_id: engine, executor_shard_id: engine === "a" ? "executor-02" : "executor-03" };
  const run = { ...scope, id: `run-${engine}`, engine: scope };
  const reads: string[] = [], attempts: Record<string, number> = {};
  const rows: Record<string, Record<string, unknown>[]> = {
    robot_v1_live_slots: physical().map(row => ({ ...scope, ...row, id: `${engine}:slot:${row.slot_number}` })),
    robot_v1_live_slot_accounts: physical().map(row => ({ ...scope, ...row })),
    robot_v1_live_orders: Array.from({ length: manyOrders ? 1201 : 1 }, (_, i) => ({ ...scope, id: `${engine}:order:${i}` })),
  };
  const service = { from(table: string) {
    const filters: Record<string, unknown> = {}; let range: [number, number] | null = null;
    const chain = { select: () => chain, order: () => chain, abortSignal: () => chain,
      eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
      range: (start: number, end: number) => { range = [start, end]; return chain; },
      then: (resolve: (result: unknown) => unknown) => {
        assert.equal(filters.trading_engine_id, engine); assert.equal(filters.tenant_id, "tenant");
        reads.push(table); const attempt = attempts[table] = (attempts[table] ?? 0) + 1;
        const failure = failures[table];
        const result = failure && attempt === 1 ? { data: null, error: { code: failure.code }, status: failure.status }
          : { data: range ? rows[table].slice(range[0], range[1] + 1) : rows[table], error: null, status: 200 };
        return Promise.resolve(result).then(resolve);
      } };
    return chain;
  } };
  const deps: Record<string, unknown> = { "./live-read-error": readErrors,
    "./live-ledger-read": { boundedLedgerRead, observeLedgerRows, assertPhysicalLedger },
    "./complete-ledger-read": { completeLedgerRead }, "./operator-context": { assertRowEngine: (row: Record<string, unknown>) => {
      assert.equal(row.trading_engine_id, engine); assert.equal(row.exchange_account_id, "same-account");
    } } };
  const compiled = ts.transpileModule(readFileSync(new URL("./robot-v1-live-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled + "\nexports.readLedger = runRows;")((name: string) => deps[name] ?? {}, exports);
  return { reads, rows, read: () => (exports.readLedger as (s: unknown, r: unknown) => Promise<{ orders: { id: string }[] }>)(service, run) };
}

test("real runRows discards partial results, pages all orders and isolates same account cross-shard", async () => {
  for (const engine of ["a", "b"]) {
    const f = fixture(engine, { robot_v1_live_slots: { code: "PGRST003", status: 504 } }, true);
    const ledger = await f.read();
    assert.equal(ledger.orders.length, 1201);
    assert.ok(ledger.orders.every(row => row.id.startsWith(`${engine}:`)));
    assert.equal(f.reads.filter(table => table === "robot_v1_live_slot_accounts").length, 2);
  }
});

test("parallel transient read cannot mask a permission failure; incomplete physical data cannot pass", async () => {
  const f = fixture("a", { robot_v1_live_slots: { code: "PGRST003", status: 504 },
    robot_v1_live_orders: { code: "42501", status: 403 } });
  await assert.rejects(f.read(), readErrors.LiveLedgerReadFailed);
  assert.equal(f.reads.length, 3);
  const missing = fixture("b"); missing.rows.robot_v1_live_slots.pop();
  await assert.rejects(missing.read(), /LEDGER_INCOMPLETE/);
});
