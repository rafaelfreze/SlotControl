import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { boundedLedgerRead, observeLedgerRows } from "./live-ledger-read.ts";
import { completeLedgerRead } from "./complete-ledger-read.ts";
import * as readErrors from "./live-read-error.ts";
import { assertRowEngine } from "./operator-context.ts";
import * as liveAudit from "./live-audit-event.ts";

type Row = Record<string, unknown> & { id: string; details: Record<string, unknown> };
const eventTypes = ["NEXT_BUY_CAPITAL_REFRESH_PLANNED", "NEXT_BUY_CAPITAL_REFRESH_CONFIRMED"];

/** Run the real audit functions against GET/upsert fixtures. No exchange,
 * dispatch, slot, gain, capital or order mutation dependency exists here. */
function fixture(options: { count?: number; engine?: string; failRead?: number; status?: number;
  providerCode?: string; writeFailure?: boolean; planned?: boolean } = {}) {
  const scope = { product_id: "product", tenant_id: "tenant", user_id: "user", operator_id: "operator",
    exchange_account_id: "shared-account", trading_engine_id: options.engine ?? "engine-a", quote_asset: "BRL" };
  const run = { ...scope, id: `run-${scope.trading_engine_id}`, engine: { ...scope,
    executor_shard_id: scope.trading_engine_id === "engine-a" ? "executor-02" : "executor-03" } };
  const rows: Row[] = Array.from({ length: options.count ?? 1 }, (_, i) => ({ ...scope,
    id: `event-${i}`, run_id: run.id, observed_at: "2026-10-15T14:22:00Z", slot_number: 8,
    event_type: eventTypes[1], details: { refresh_key: `refresh-${i}`, snapshot: 1 } }));
  if (options.planned) rows[0] = { ...rows[0], event_type: eventTypes[0], details: {
    refresh_key: "old:new:2", old_client_order_id: "old", new_client_order_id: "new", new_quantity: 2, price: 500 } };
  const reads: Array<{ range: number[]; signal: AbortSignal; filters: Record<string, unknown>; order: string[] }> = [];
  const writes: Record<string, unknown>[] = [];
  const orders = [
    { client_order_id: "old", side: "BUY", purpose: "ENTRY", slot_id: "slot-8", operation_sequence: 1,
      status: "CANCELED", executed_quantity: 0, trades_reconciled: true },
    { client_order_id: "new", side: "BUY", purpose: "ENTRY", slot_id: "slot-8", operation_sequence: 1,
      status: "NEW", exchange_order_id: "binance-new", requested_quantity: 2, price: 500 },
  ];
  const service = { from(table: string) {
    assert.equal(table, "robot_v1_live_events");
    const filters: Record<string, unknown> = {}, order: string[] = [];
    let range: number[] = [], signal: AbortSignal;
    let mutation: Record<string, unknown> | null = null;
    const result = () => {
      if (mutation) {
        writes.push(mutation);
        return { data: null, error: options.writeFailure ? { code: "PGRST003" } : null, status: options.writeFailure ? 503 : 200 };
      }
      for (const key of ["product_id", "tenant_id", "user_id", "operator_id", "exchange_account_id", "trading_engine_id", "quote_asset"])
        assert.equal(filters[key], scope[key as keyof typeof scope]);
      assert.equal(filters.run_id, run.id);
      if (filters.event_key) return { data: [], error: null, status: 200 };
      assert.deepEqual(filters.event_type, eventTypes);
      assert.deepEqual(order, ["observed_at", "id"]);
      assert.ok(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      reads.push({ range, signal, filters, order });
      if (reads.length === options.failRead) {
        rows[0].details.snapshot = 2;
        return { data: null, error: { code: options.providerCode ?? "PGRST003", message: "PRIVATE_PROVIDER_BODY" }, status: options.status ?? 504 };
      }
      return { data: structuredClone(rows.slice(range[0], range[1] + 1)), error: null, status: 200 };
    };
    const chain = {
      select: () => chain, eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
      in: (key: string, value: unknown) => { filters[key] = value; return chain; },
      order: (key: string) => { order.push(key); return chain; },
      range: (start: number, end: number) => { range = [start, end]; return chain; },
      abortSignal: (value: AbortSignal) => { signal = value; return chain; },
      limit: () => chain,
      upsert: (data: Record<string, unknown>, config: Record<string, unknown>) => {
        assert.deepEqual(config, { onConflict: "run_id,event_key", ignoreDuplicates: true });
        mutation = data; return chain;
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return chain;
  } };
  const dependencies: Record<string, unknown> = {
    "./live-audit-event": liveAudit,
    "./live-ledger-read": { boundedLedgerRead, observeLedgerRows },
    "./complete-ledger-read": { completeLedgerRead }, "./operator-context": { assertRowEngine },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./robot-v1-live-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled + "\nexports.auditRead=readCapitalRefreshEvents; exports.confirm=confirmCapitalRefreshes;")(
    (name: string) => dependencies[name] ?? {}, exports);
  return { rows, reads, writes, run, orders,
    read: () => (exports.auditRead as (service: unknown, run: unknown) => Promise<Row[]>)(service, run),
    confirm: () => (exports.confirm as (...args: unknown[]) => Promise<void>)(service, run, { orders }) };
}

test("capital audit reads all 1201 events with indexed exact scope and isolates same account across shards", async () => {
  for (const engine of ["engine-a", "engine-b"]) {
    const scenario = fixture({ count: 1201, engine });
    const rows = await scenario.read();
    assert.equal(rows.length, 1201);
    assert.ok(rows.every(row => row.trading_engine_id === engine && row.run_id === scenario.run.id));
    assert.deepEqual(scenario.reads.map(read => read.range), [[0, 499], [500, 999], [1000, 1499]]);
    assert.equal(new Set(scenario.reads.map(read => read.signal)).size, 1);
    assert.deepEqual(scenario.writes, []);
  }
});

test("capital audit retries only a complete GET snapshot after a transient second page", async () => {
  const scenario = fixture({ count: 1201, failRead: 2 });
  const rows = await scenario.read();
  assert.equal(rows[0].details.snapshot, 2, "the first partial snapshot was discarded");
  assert.deepEqual(scenario.reads.map(read => read.range), [[0, 499], [500, 999], [0, 499], [500, 999], [1000, 1499]]);
  assert.notEqual(scenario.reads[0].signal, scenario.reads[2].signal);
  assert.deepEqual(scenario.writes, []);
});

test("capital audit HTTP 400, permission, schema and unknown responses never become observation retries", async () => {
  for (const [status, providerCode] of [[400, ""], [403, "42501"], [400, "42P01"], [503, "UNKNOWN"]] as const) {
    const scenario = fixture({ failRead: 1, status, providerCode });
    await assert.rejects(scenario.read(), error => {
      assert.ok(error instanceof readErrors.LiveLedgerReadFailed);
      assert.equal(error.path, "ledger/capital_refresh_events");
      assert.equal(error.httpStatus, status); assert.equal(error.attempts, 1);
      assert.ok(!JSON.stringify(readErrors.liveFailureEvidence(error, "CONFIRM_CAPITAL_REFRESH", "LIVE_CRON")).includes("PRIVATE"));
      return true;
    });
    assert.equal(scenario.reads.length, 1); assert.deepEqual(scenario.writes, []);
  }
});

test("capital audit rejects incomplete pages, foreign ownership and malformed observation instead of reporting an empty audit", async () => {
  for (const field of ["id", "operator_id", "exchange_account_id", "trading_engine_id", "run_id", "tenant_id", "observed_at"] as const) {
    const scenario = fixture({ count: 501 });
    scenario.rows[500][field] = field === "observed_at" ? "invalid" : "foreign";
    if (field === "id") scenario.rows[500].id = scenario.rows[0].id;
    await assert.rejects(scenario.read(), /CAPITAL_AUDIT_INCOMPLETE|ENGINE_ROW_MISMATCH/);
    assert.equal(scenario.reads.length, 2); assert.deepEqual(scenario.writes, []);
  }
});

test("capital audit confirmation writes once only after every GET page converged and leaves original orders unchanged", async () => {
  const scenario = fixture({ count: 1201, planned: true, failRead: 2 });
  const ordersBefore = structuredClone(scenario.orders);
  await scenario.confirm();
  assert.equal(scenario.reads.length, 5); assert.equal(scenario.writes.length, 1);
  assert.equal(scenario.writes[0].event_type, eventTypes[1]);
  assert.equal(scenario.writes[0].event_key, "CAPITAL_REFRESH:old:new:2:CONFIRMED");
  assert.equal(scenario.writes[0].run_id, scenario.run.id);
  assert.deepEqual(scenario.orders, ordersBefore);
});

test("capital audit metadata alone retries the captured immutable row, never the financial step or paged audit", async () => {
  const scenario = fixture({ planned: true, writeFailure: true });
  const ordersBefore = structuredClone(scenario.orders);
  await assert.rejects(scenario.confirm(), /COINOPS_LIVE_EVENT_PERSIST_FAILED/);
  assert.equal(scenario.reads.length, 1); assert.equal(scenario.writes.length, 2);
  assert.deepEqual(scenario.writes[1], scenario.writes[0]);
  assert.deepEqual(scenario.orders, ordersBefore);
});

test("normal flow marks the capital GET stage separately from entry/metadata order work", () => {
  const source = readFileSync(new URL("./robot-v1-live-server.ts", import.meta.url), "utf8");
  assert.match(source, /stage = "CONFIRM_CAPITAL_REFRESH";\s+await confirmCapitalRefreshes\(service, run, finalLedger\);\s+stage = "RESOLVE_ACCOUNT_BUDGET_ALERT"/);
});
