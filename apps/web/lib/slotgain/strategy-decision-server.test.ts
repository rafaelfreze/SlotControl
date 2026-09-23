import assert from "node:assert/strict";
import test from "node:test";
import { persistStrategyDecision, dispatchStrategyDecision, completeStrategyDecision, failStrategyDecision } from "../execution/strategy-decision-server.ts";
import { planStrategyInitialEntry } from "../execution/strategy-engine.ts";

const scope = { product_id: "product", tenant_id: "tenant", user_id: "user" };
const decision = planStrategyInitialEntry({ asset: "SOL", cycleId: "cycle", observedAt: "2026-09-23T04:23:36.439Z" },
  { id: "slot", slotNumber: 1, operationSequence: 1, buyPrice: 118.97, balanceUsdc: 10, state: "PLANNED" });
function database() {
  const rows: Record<string, unknown>[] = [];
  let fail = false;
  const service = { from(name: string) {
    assert.equal(name, "robot_v1_strategy_decisions");
    let mutation: Record<string, unknown> | null = null;
    const predicates: Array<(row: Record<string, unknown>) => boolean> = [];
    const builder = {
      upsert(row: Record<string, unknown>, options: { ignoreDuplicates: boolean }) {
        assert.equal(options.ignoreDuplicates, true);
        if (!fail && !rows.some((item) => ["product_id", "tenant_id", "user_id", "environment", "decision_id"].every((key) => item[key] === row[key])))
          rows.push({ created_at: new Date().toISOString(), result: "PENDING", dispatched_at: null, ...row });
        return builder;
      },
      select() { return builder; },
      update(values: Record<string, unknown>) { mutation = values; return builder; },
      eq(key: string, value: unknown) { predicates.push((row) => row[key] === value); return builder; },
      neq(key: string, value: unknown) { predicates.push((row) => row[key] !== value); return builder; },
      is(key: string, value: unknown) { predicates.push((row) => row[key] === value); return builder; },
      single() { return builder; },
      then(resolve: (value: unknown) => unknown) {
        const selected = rows.filter((row) => predicates.every((predicate) => predicate(row)));
        if (mutation && !fail) for (const row of selected) Object.assign(row, mutation);
        return Promise.resolve(resolve({ data: selected[0] ?? null, error: fail ? { message: "unavailable" } : null }));
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
  await dispatchStrategyDecision(db.service, { ...scope, tenant_id: "other" }, "TESTNET", decision.decision_id);
  await dispatchStrategyDecision(db.service, scope, "SHADOW", decision.decision_id);
  assert.equal(db.rows[0].result, "PENDING");
  await persistStrategyDecision(db.service, scope, "SHADOW", decision, 1);
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
