import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

type Row = Record<string, any>;
const scope = { product_id: "product-a", tenant_id: "tenant-a", user_id: "user-a",
  operator_id: "operator-a", exchange_account_id: "account-a", trading_engine_id: "engine-a" };
const initial = () => ({ ...scope, decision_id: "decision-a", environment: "REAL", result: "DISPATCHED",
  created_at: "2026-10-16T18:00:00.000Z", completed_at: null, exchange_ack_at: null,
  observed_next_state: null, latency_ms: null });

function fixture() {
  const rows: Row[] = [initial()], queries: Row[] = [];
  let resolutions = 0, registryReads = 0, rejectScope = false;
  let beforeMutation: (() => void) | undefined;
  class Query {
    conditions: Array<(row: Row) => boolean> = [];
    fields: Array<[string, string, unknown]> = [];
    values: Row | null = null;
    constructor() { queries.push(this); }
    select() { return this; }
    update(values: Row) { this.values = values; return this; }
    eq(key: string, value: unknown) { this.conditions.push(row => row[key] === value); this.fields.push(["eq", key, value]); return this; }
    neq(key: string, value: unknown) { this.conditions.push(row => row[key] !== value); this.fields.push(["neq", key, value]); return this; }
    in(key: string, values: unknown[]) { this.conditions.push(row => values.includes(row[key])); this.fields.push(["in", key, values]); return this; }
    async single() {
      const selected = rows.filter(row => this.conditions.every(check => check(row)));
      return selected.length === 1 ? { data: { ...selected[0] }, error: null } : { data: null, error: { code: "PGRST116" } };
    }
    then(accept: (value: Row) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve().then(() => {
        beforeMutation?.(); beforeMutation = undefined;
        const selected = rows.filter(row => this.conditions.every(check => check(row)));
        if (this.values) for (const row of selected) Object.assign(row, this.values);
        return { data: null, error: null };
      }).then(accept, reject);
    }
  }
  const service = { from: (table: string) => {
    assert.equal(table, "robot_v1_strategy_decisions"); return new Query();
  } };
  const deps: Row = {
    "./operator-context-server": { resolveOperatorEngine: async (_service: unknown, requested: Row, selection: Row) => {
      resolutions++; registryReads += 3;
      assert.equal(selection.environment, "REAL");
      if (rejectScope) throw new Error("COINOPS_OPERATOR_SCOPE_DENIED");
      assert.deepEqual(requested, scope);
      return { trading_engine_id: "engine-a" };
    }, loadOperatorRegistry: async () => assert.fail("explicit engine cannot use legacy fallback") },
    "./operator-context": { isIdentity: () => true },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./strategy-decision-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded: Row = {};
  class Clock extends Date {
    constructor(value?: string | number | Date) {
      super(value === undefined ? "2026-10-16T18:00:05.000Z" : value instanceof Date ? value.getTime() : value);
    }
  }
  new Function("require", "exports", "Date", compiled)((name: string) => deps[name] ?? {}, loaded, Clock);
  return { rows, queries, complete: (observed: Row = { state: "FILLED" }, ack = false) =>
    loaded.completeStrategyDecision(service, scope, "REAL", "decision-a", observed, ack),
    counts: () => ({ resolutions, registryReads }), deny: () => { rejectScope = true; },
    beforeMutation: (hook: () => void) => { beforeMutation = hook; } };
}

test("completion resolves fresh engine scope once and uses one read plus scoped CAS, preserving timestamp and latency", async () => {
  const f = fixture();
  await f.complete({ state: "FILLED" }, true);
  assert.deepEqual(f.counts(), { resolutions: 1, registryReads: 3 });
  assert.equal(f.queries.length, 2);
  for (const query of f.queries) for (const key of ["product_id", "tenant_id", "user_id", "operator_id", "exchange_account_id", "decision_id", "environment"])
    assert(query.fields.some(([kind, field]: string[]) => kind === "eq" && field === key), key);
  assert.deepEqual(f.rows[0], { ...initial(), result: "COMPLETED", completed_at: "2026-10-16T18:00:05.000Z",
    exchange_ack_at: "2026-10-16T18:00:05.000Z", observed_next_state: { state: "FILLED" }, latency_ms: 5000, error: null });
});

test("100 TP completions perform 100 fresh resolutions, not 300; no authorization is retained across operations", async () => {
  const f = fixture();
  for (let index = 0; index < 100; index++) { f.rows[0].result = "DISPATCHED"; await f.complete(); }
  assert.deepEqual(f.counts(), { resolutions: 100, registryReads: 300 });
  assert.equal(f.queries.filter(query => query.values).length, 100);
  assert.equal(f.queries.filter(query => !query.values).length, 100);
  f.deny();
  await assert.rejects(f.complete(), /COINOPS_OPERATOR_SCOPE_DENIED/);
  assert.equal(f.queries.length, 200, "revoked scope cannot reuse previous authorization");
});

test("foreign engine, owner, account, product, tenant, user and environment cannot read or complete a decision", async () => {
  for (const field of ["trading_engine_id", "operator_id", "exchange_account_id", "product_id", "tenant_id", "user_id", "environment"]) {
    const f = fixture(); f.rows[0][field] = "foreign";
    await assert.rejects(f.complete(), /COINOPS_STRATEGY_DECISION_READ_FAILED/);
    assert.equal(f.queries.length, 1, field);
    assert.equal(f.rows[0].result, "DISPATCHED", field);
  }
});

test("concurrent completion and replay cannot rewrite COMPLETED result, original ack, timestamps or latency", async () => {
  const f = fixture(), settled = { ...initial(), result: "COMPLETED", completed_at: "settled-time",
    exchange_ack_at: "original-ack", latency_ms: 1234, observed_next_state: { state: "SETTLED" } };
  f.beforeMutation(() => Object.assign(f.rows[0], settled));
  await f.complete({ state: "late-result" }, true);
  assert.deepEqual(f.rows[0], settled);
  await f.complete({ state: "another-late-result" }, true);
  assert.deepEqual(f.rows[0], settled);
});

test("ownership changed after selected read cannot be mutated through a stale scope", async () => {
  for (const field of ["trading_engine_id", "operator_id", "exchange_account_id"]) {
    const f = fixture(); f.beforeMutation(() => { f.rows[0][field] = "foreign"; });
    await f.complete();
    assert.equal(f.rows[0].result, "DISPATCHED");
    assert.equal(f.rows[0].completed_at, null);
  }
});

test("without exchange acknowledgement no ack timestamp is invented and negative latency clamps to zero", async () => {
  const f = fixture(); f.rows[0].created_at = "2026-10-16T18:01:00.000Z";
  await f.complete();
  assert.equal(f.rows[0].exchange_ack_at, null);
  assert.equal(f.rows[0].latency_ms, 0);
});
