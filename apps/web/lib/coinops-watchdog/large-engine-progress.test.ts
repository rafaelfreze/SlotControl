import assert from "node:assert/strict";
import test from "node:test";
import { evaluateFastRun, type FastRun, type FastOrder, type FastSlot } from "./watchdog-policy.ts";
import { liveClientOrderId } from "../execution/robot-v1-live-cycle.ts";

const now = Date.parse("2026-10-16T18:00:00Z");
function fixture() {
  const engine = { id: "engine-a", operator_id: "operator-a", exchange_account_id: "account-a", symbol: "SOLBRL",
    status: "ACTIVE", kill_switch: false, executor_shard_id: "executor-03", slot_count: 100,
    base_asset: "SOL", legacy_compatible: false, environment: "REAL" };
  const run: FastRun = { id: "00000000-0000-4000-8000-000000000001", operator_id: engine.operator_id, trading_engine_id: engine.id,
    exchange_account_id: engine.exchange_account_id, symbol: engine.symbol, quote_asset: "BRL", slot_count: 100,
    status: "ACTIVE", last_error: null, lease_until: null, last_reconciled_at: new Date(now - 6 * 60_000).toISOString() };
  const checkpoint = { contract: "LARGE_ENGINE_PROGRESS_V1", run_id: run.id, operator_id: run.operator_id,
    exchange_account_id: run.exchange_account_id, trading_engine_id: run.trading_engine_id,
    executor_shard_id: "executor-03", symbol: "SOLBRL", quote_asset: "BRL", slot_count: 100,
    phase: "CREDIT_SLOTS", quantity_step: .001, started_at: new Date(now - 5 * 60_000).toISOString(),
    observed_at: new Date(now - 30_000).toISOString(), settled_orders: 100, credited_gains: 70, operation_total: 100 };
  run.reconciliation_checkpoint = checkpoint;
  const account = { id: run.exchange_account_id, operator_id: run.operator_id, executor_shard_id: "executor-01",
    status: "ACTIVE", kill_switch: false };
  const slots: FastSlot[] = Array.from({ length: 100 }, (_, i) => ({ id: `slot-${i + 1}`, run_id: run.id,
    operator_id: run.operator_id, exchange_account_id: run.exchange_account_id, trading_engine_id: engine.id,
    slot_number: i + 1, operation_sequence: 1, entry_state: "CLOSED", position_quantity: 0, updated_at: checkpoint.observed_at }));
  const orders: FastOrder[] = [];
  return { run, engine, account, slots, orders, now, shardId: "executor-03", checkpoint };
}

test("100-slot durable progress is RECONCILING, never HEALTHY or fabricated last reconciliation", () => {
  const f = fixture(), last = f.run.last_reconciled_at;
  assert.deepEqual(evaluateFastRun(f), { state: "RECONCILING", code: null, recoverable: false });
  assert.equal(f.run.last_reconciled_at, last);
});

test("old, foreign, malformed or incomplete progress fails closed", () => {
  for (const patch of [{ executor_shard_id: "executor-02" }, { trading_engine_id: "sibling" },
    { settled_orders: -1 }, { observed_at: "unknown" }, { slot_count: 25 }]) {
    const f = fixture(); Object.assign(f.checkpoint, patch);
    assert.equal(evaluateFastRun(f).state, "BLOCKED");
  }
  const f = fixture(); f.slots.pop(); assert.equal(evaluateFastRun(f).state, "BLOCKED");
  const stale = fixture(); stale.checkpoint.observed_at = new Date(now - 151_000).toISOString();
  assert.equal(evaluateFastRun(stale).code, "WATCHDOG_RECONCILIATION_PROGRESS_STALE");
  const prolonged = fixture(); prolonged.checkpoint.started_at = new Date(now - 901_000).toISOString();
  assert.equal(evaluateFastRun(prolonged).state, "STALE");
});

test("a checkpoint cannot hide critical financial alerts, a missing TP or an uncredited fill", () => {
  const f = fixture();
  assert.equal(evaluateFastRun({ ...f, alerts: [{ trading_engine_id: f.engine.id,
    exchange_account_id: f.account.id, alert_key: `LIVE_RUN:${f.run.id}:CRITICAL`, severity: "CRITICAL",
    code: "COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN" }] }).state, "BLOCKED");
  f.slots[0].position_quantity = .02;
  assert.equal(evaluateFastRun(f).code, "WATCHDOG_TP_MISSING");
  f.orders.push({ id: "order-1", run_id: f.run.id, slot_id: f.slots[0].id, side: "SELL", status: "PARTIALLY_FILLED",
    exchange_order_id: "123", operator_id: f.run.operator_id, exchange_account_id: f.account.id,
    trading_engine_id: f.engine.id, client_order_id: liveClientOrderId(f.run.id, "SOL", 1, 1, "SELL", 1,
      { ...f.engine, trading_engine_id: f.engine.id }), requested_quantity: .03, price: 515, purpose: "TP", operation_sequence: 1, revision: 1,
    executed_quantity: .01, trades_reconciled: false });
  assert.equal(evaluateFastRun(f).code, "WATCHDOG_FILL_UNRECONCILED");
  f.orders[0].trades_reconciled = true;
  assert.equal(evaluateFastRun(f).state, "RECONCILING");
  f.slots[0].position_quantity = .03;
  assert.equal(evaluateFastRun(f).code, "WATCHDOG_TP_QUANTITY_MISMATCH");
  f.slots[0].position_quantity = .02;
  f.slots[0].operation_sequence = 2;
  assert.equal(evaluateFastRun(f).state, "BLOCKED");
});

test("progress cannot suppress blocked configuration, while proven sub-step dust is not a sellable uncovered position", () => {
  const f = fixture();
  assert.equal(evaluateFastRun({ ...f, engine: { ...f.engine, strategy_config_pending: true } }).state, "BLOCKED");
  f.slots[0].position_quantity = .0001;
  assert.equal(evaluateFastRun(f).state, "RECONCILING");
  f.checkpoint.quantity_step = 0;
  assert.equal(evaluateFastRun(f).state, "BLOCKED");
});

test("a later full reconciliation supersedes its checkpoint, while 25-slot engines remain unchanged", () => {
  const f = fixture(); f.run.last_reconciled_at = new Date(now).toISOString();
  assert.equal(evaluateFastRun(f).state, "HEALTHY");
  const g = fixture(); g.run.slot_count = 25; g.engine.slot_count = 25; g.slots = g.slots.slice(0, 25);
  g.run.reconciliation_checkpoint = null; g.run.last_reconciled_at = new Date(now - 30_000).toISOString();
  assert.equal(evaluateFastRun(g).state, "HEALTHY");
});
