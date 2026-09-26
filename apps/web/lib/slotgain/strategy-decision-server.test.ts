import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type * as DecisionServer from "../execution/strategy-decision-server.ts";
import { assertDomainRegistry, isIdentity, resolveEngineContext, visibleOperatorRegistry,
  type DomainRegistry } from "../execution/operator-context.ts";
import { planStrategyInitialEntry } from "../execution/strategy-engine.ts";

type Row = Record<string, unknown>;
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const owner = { product_id: uuid(1), tenant_id: uuid(2), user_id: uuid(3) };
const scope = { ...owner, operator_id: uuid(4), exchange_account_id: uuid(5), trading_engine_id: uuid(7) };
const scopeB = { ...scope, exchange_account_id: uuid(6), trading_engine_id: uuid(8) };
const shadowScope = { ...scope, trading_engine_id: uuid(9) };

/** Exercise both real server modules and the real pure registry resolver. Only
 * the database is in memory; no server-only import, network or credentials. */
function compile(relative: string, dependencies: Record<string, unknown>) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const exports: Row = {};
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected server dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}
const registryServer = compile("../execution/operator-context-server.ts", {
  "server-only": {}, "./operator-context": { assertDomainRegistry, resolveEngineContext,
    visibleOperatorRegistry },
});
const { persistStrategyDecision, dispatchStrategyDecision, completeStrategyDecision, failStrategyDecision } = compile(
  "../execution/strategy-decision-server.ts", { "./operator-context-server": registryServer, "./operator-context": { isIdentity } },
) as unknown as typeof DecisionServer;

const decision = planStrategyInitialEntry({ asset: "SOL", cycleId: "cycle", observedAt: "2026-09-23T04:23:36.439Z" },
  { id: "slot", slotNumber: 1, operationSequence: 1, buyPrice: 118.97, balanceUsdc: 10, state: "PLANNED" });
function database(legacy = false) {
  const registry: DomainRegistry = {
    operator: { id: scope.operator_id, ...owner, status: "ACTIVE", kill_switch: false },
    accounts: [scope.exchange_account_id, scopeB.exchange_account_id].map((id, index) => ({
      id, operator_id: scope.operator_id, display_name: `Fixture ${index}`, status: "ACTIVE",
      is_legacy_default: legacy && index === 0, kill_switch: false,
    })),
    engines: [scope, scopeB, shadowScope].map((context, index) => ({
      id: context.trading_engine_id, operator_id: context.operator_id, exchange_account_id: context.exchange_account_id,
      environment: index === 2 ? "SHADOW" : "TESTNET", symbol: "SOLUSDT", base_asset: "SOL", quote_asset: "USDT",
      status: "ACTIVE", kill_switch: false, hard_cap_quote: 250, legacy_compatible: legacy && index === 0,
    })),
  };
  const rows: Row[] = [];
  const tables: Record<string, Row[]> = { robot_v1_strategy_decisions: rows,
    operators: [registry.operator], exchange_accounts: registry.accounts, trading_engines: registry.engines };
  let fail = false;
  const service = { from(name: string) {
    assert.ok(name in tables, `Unexpected table: ${name}`);
    const source = tables[name]!;
    let mutation: Row | null = null, single = false;
    const predicates: Array<(row: Row) => boolean> = [];
    const builder = {
      upsert(row: Row, options: { ignoreDuplicates: boolean; onConflict: string }) {
        assert.equal(name, "robot_v1_strategy_decisions");
        assert.equal(options.ignoreDuplicates, true);
        assert.equal(options.onConflict, "trading_engine_id,decision_id");
        if (!fail && !rows.some((item) => ["trading_engine_id", "decision_id"].every((key) => item[key] === row[key])))
          rows.push({ created_at: new Date().toISOString(), result: "PENDING", dispatched_at: null, ...row });
        return builder;
      },
      select() { return builder; },
      update(values: Row) { assert.equal(name, "robot_v1_strategy_decisions"); mutation = values; return builder; },
      eq(key: string, value: unknown) { predicates.push((row) => row[key] === value); return builder; },
      neq(key: string, value: unknown) { predicates.push((row) => row[key] !== value); return builder; },
      is(key: string, value: unknown) { predicates.push((row) => row[key] === value); return builder; },
      in(key: string, values: unknown[]) { predicates.push((row) => values.includes(row[key])); return builder; },
      order() { return builder; },
      single() { single = true; return builder; },
      then(resolve: (value: unknown) => unknown) {
        const selected = source.filter((row) => predicates.every((predicate) => predicate(row)));
        const failed = fail && name === "robot_v1_strategy_decisions";
        if (mutation && !failed) for (const row of selected) Object.assign(row, mutation);
        return Promise.resolve(resolve({ data: single ? selected[0] ?? null : selected,
          error: failed || single && selected.length !== 1 ? { message: "unavailable" } : null }));
      },
    };
    return builder;
  } } as unknown as Parameters<typeof persistStrategyDecision>[0];
  return { service, rows, fail: () => { fail = true; } };
}

test("durable intent precedes dispatch and never backdates historical observations", async () => {
  const db = database();
  const saved = await persistStrategyDecision(db.service, scope, "TESTNET", decision, 1);
  assert.equal(saved.result, "PENDING");
  assert.notEqual(saved.created_at, decision.created_at);
  assert.equal(db.rows[0].dispatched_at, null);
  await dispatchStrategyDecision(db.service, scope, "TESTNET", decision.decision_id);
  assert.equal(db.rows[0].result, "DISPATCHED");
  assert.ok(db.rows[0].dispatched_at);
});

test("recovery deduplicates intent and preserves first dispatch/completion/ack", async () => {
  const db = database();
  const first = await persistStrategyDecision(db.service, scope, "TESTNET", decision, 1);
  await dispatchStrategyDecision(db.service, scope, "TESTNET", decision.decision_id);
  const dispatched = db.rows[0].dispatched_at;
  await completeStrategyDecision(db.service, scope, "TESTNET", decision.decision_id, { state: "OPEN", exchange_order_id: "42" }, true);
  const completed = structuredClone(db.rows[0]);
  await persistStrategyDecision(db.service, scope, "TESTNET", { ...decision, created_at: new Date().toISOString() }, 1);
  await dispatchStrategyDecision(db.service, scope, "TESTNET", decision.decision_id);
  await completeStrategyDecision(db.service, scope, "TESTNET", decision.decision_id, { state: "wrong" }, true);
  await failStrategyDecision(db.service, scope, "TESTNET", decision.decision_id, "COINOPS_TIMEOUT");
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].created_at, first.created_at);
  assert.equal(db.rows[0].dispatched_at, dispatched);
  assert.deepEqual(db.rows[0], completed);
});

test("environment and full scope are applied to every decision mutation", async () => {
  const db = database();
  await persistStrategyDecision(db.service, scope, "TESTNET", decision, 1);
  await assert.rejects(dispatchStrategyDecision(db.service, { ...scope, tenant_id: uuid(99) }, "TESTNET", decision.decision_id), /COINOPS_OPERATOR_SCOPE_UNAVAILABLE/);
  await assert.rejects(dispatchStrategyDecision(db.service, scope, "SHADOW", decision.decision_id), /COINOPS_ENGINE_SCOPE_DENIED/);
  assert.equal(db.rows[0].result, "PENDING");
  await persistStrategyDecision(db.service, shadowScope, "SHADOW", decision, 1);
  assert.equal(db.rows.length, 2);
});

test("intent persistence failure blocks dispatch; error text is sanitized", async () => {
  const db = database();
  db.fail();
  await assert.rejects(persistStrategyDecision(db.service, scope, "TESTNET", decision), /COINOPS_STRATEGY_DECISION_PERSIST_FAILED/);
  assert.equal(db.rows.length, 0);
  const working = database();
  await persistStrategyDecision(working.service, scope, "TESTNET", decision);
  await failStrategyDecision(working.service, scope, "TESTNET", decision.decision_id, "secret-bearing response text");
  assert.equal(working.rows[0].error, "COINOPS_STRATEGY_DISPATCH_FAILED");
});

test("identical decision IDs remain isolated across A/B accounts and engine mutations", async () => {
  const db = database();
  await persistStrategyDecision(db.service, scope, "TESTNET", decision, 1);
  await persistStrategyDecision(db.service, scopeB, "TESTNET", decision, 1);
  assert.equal(db.rows.length, 2);
  const [a, b] = db.rows;
  assert.equal(a.exchange_account_id, scope.exchange_account_id);
  assert.equal(b.exchange_account_id, scopeB.exchange_account_id);
  await dispatchStrategyDecision(db.service, scope, "TESTNET", decision.decision_id);
  assert.equal(a.result, "DISPATCHED"); assert.equal(b.result, "PENDING");
  await completeStrategyDecision(db.service, scope, "TESTNET", decision.decision_id, { account: "A" }, true);
  await failStrategyDecision(db.service, scopeB, "TESTNET", decision.decision_id, "COINOPS_TIMEOUT");
  assert.equal(a.result, "COMPLETED"); assert.deepEqual(a.observed_next_state, { account: "A" });
  assert.equal(b.result, "FAILED"); assert.equal(b.exchange_ack_at, undefined);
  await persistStrategyDecision(db.service, scopeB, "TESTNET", decision, 1);
  assert.equal(db.rows.length, 2);
});

test("non-legacy writes with missing, partial, unknown or cross-account identity fail closed", async () => {
  const db = database();
  await persistStrategyDecision(db.service, scope, "TESTNET", decision);
  const before = structuredClone(db.rows);
  for (const denied of [owner, { ...owner, exchange_account_id: scope.exchange_account_id },
    { ...scope, trading_engine_id: uuid(99) }, { ...scope, exchange_account_id: scopeB.exchange_account_id },
    { ...scope, operator_id: uuid(99) }]) {
    await assert.rejects(persistStrategyDecision(db.service, denied, "TESTNET", decision), /COINOPS_(ENGINE|OPERATOR|STRATEGY_DECISION)_/);
    await assert.rejects(dispatchStrategyDecision(db.service, denied, "TESTNET", decision.decision_id), /COINOPS_(ENGINE|OPERATOR|STRATEGY_DECISION)_/);
    await assert.rejects(completeStrategyDecision(db.service, denied, "TESTNET", decision.decision_id, {}), /COINOPS_(ENGINE|OPERATOR|STRATEGY_DECISION)_/);
    await assert.rejects(failStrategyDecision(db.service, denied, "TESTNET", decision.decision_id, "COINOPS_TIMEOUT"), /COINOPS_(ENGINE|OPERATOR|STRATEGY_DECISION)_/);
  }
  assert.deepEqual(db.rows, before);
});

test("only explicit legacy registry mapping permits ID-less compatibility; supplied IDs never fall back", async () => {
  const db = database(true);
  await persistStrategyDecision(db.service, owner, "TESTNET", decision);
  await dispatchStrategyDecision(db.service, owner, "TESTNET", decision.decision_id);
  assert.equal(db.rows[0].trading_engine_id, scope.trading_engine_id);
  assert.equal(db.rows[0].result, "DISPATCHED");
  await assert.rejects(dispatchStrategyDecision(db.service, { ...owner, trading_engine_id: uuid(99) },
    "TESTNET", decision.decision_id), /COINOPS_ENGINE_SELECTION_INCOMPLETE/);
  const before = structuredClone(db.rows);
  for (const operator_id of [uuid(99), "", "invalid"]) {
    const denied = { ...owner, operator_id };
    await assert.rejects(persistStrategyDecision(db.service, denied, "TESTNET", decision), /COINOPS_(OPERATOR_SCOPE_DENIED|ENGINE_SELECTION_INVALID)/);
    await assert.rejects(dispatchStrategyDecision(db.service, denied, "TESTNET", decision.decision_id), /COINOPS_OPERATOR_SCOPE_DENIED/);
    await assert.rejects(completeStrategyDecision(db.service, denied, "TESTNET", decision.decision_id, {}), /COINOPS_OPERATOR_SCOPE_DENIED/);
    await assert.rejects(failStrategyDecision(db.service, denied, "TESTNET", decision.decision_id, "COINOPS_TIMEOUT"), /COINOPS_OPERATOR_SCOPE_DENIED/);
  }
  assert.deepEqual(db.rows, before);
  assert.equal(db.rows.length, 1);
});
