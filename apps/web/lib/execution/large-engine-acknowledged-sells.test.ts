import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

type Row = Record<string, any>;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function fixture(failFirst = false) {
  const calls: string[] = [], completed: string[] = [];
  let active = 0, peak = 0;
  const deps: Row = { "./robot-v1-live-cycle": { LIVE_TERMINAL_ORDER_STATUSES: new Set(["FILLED", "CANCELED"]) } };
  const compiled = ts.transpileModule(readFileSync(new URL("./robot-v1-live-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const runtime: Row = {};
  const observed = async (_db: unknown, _run: unknown, order: Row) => {
    assert.equal(order.side, "SELL"); assert.notEqual(order.exchange_order_id, null); assert.notEqual(order.status, "PREPARED");
    calls.push(order.id); active++; peak = Math.max(peak, active);
    try {
      await delay(order.id === "sell-0" ? 1 : 4);
      if (failFirst && order.id === "sell-0") throw new Error("EXACT_FIRST_FAILURE");
      completed.push(order.id);
    } finally { active--; }
  };
  new Function("require", "exports", "observed", `${compiled}
    reconcileOrder=observed; exports.reconcileAcknowledgedSellOrders=reconcileAcknowledgedSellOrders;`)(
    (name: string) => deps[name] ?? {}, runtime, observed);
  return { calls, completed, active: () => active, peak: () => peak,
    reconcile: (orders: Row[]) => runtime.reconcileAcknowledgedSellOrders({}, {}, orders, {}) };
}
const acknowledged = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `sell-${index}`,
  side: "SELL", exchange_order_id: String(index + 1), status: "NEW", trades_reconciled: false }));

test("100 independent ACKed SELL observations use at most four workers; BUY, PREPARED and settled rows remain serial", async () => {
  const f = fixture(), orders: Row[] = [...acknowledged(100),
    { ...acknowledged(1)[0], id: "buy", side: "BUY" },
    { ...acknowledged(1)[0], id: "prepared", status: "PREPARED" },
    { ...acknowledged(1)[0], id: "unacknowledged", exchange_order_id: null },
    { ...acknowledged(1)[0], id: "settled", status: "FILLED", trades_reconciled: true }];
  const actual = await f.reconcile(orders);
  assert.equal(actual.size, 100); assert.equal(f.calls.length, 100); assert.equal(f.completed.length, 100);
  assert.equal(f.peak(), 4); assert.equal(f.active(), 0);
  assert.ok(f.calls.every(id => id.startsWith("sell-")));
});

test("the first failure stops queueing and every in-flight operation drains before rejection/lease release", async () => {
  const f = fixture(true);
  await assert.rejects(f.reconcile(acknowledged(100)), /EXACT_FIRST_FAILURE/);
  assert.deepEqual(f.calls, ["sell-0", "sell-1", "sell-2", "sell-3"]);
  assert.equal(f.completed.length, 3); assert.equal(f.active(), 0);
  const settled = JSON.stringify([f.calls, f.completed]); await delay(12);
  assert.equal(JSON.stringify([f.calls, f.completed]), settled, "no late SQL work after the caller may release its lease");
});

test("duplicate acknowledged order identities fail before any observation or sync", async () => {
  const f = fixture();
  await assert.rejects(f.reconcile([acknowledged(1)[0], acknowledged(1)[0]]), /DUPLICATE_ORDER_ID/);
  assert.equal(f.calls.length, 0);
});
