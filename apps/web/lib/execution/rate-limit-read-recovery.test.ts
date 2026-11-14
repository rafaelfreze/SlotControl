import assert from "node:assert/strict";
import test from "node:test";
import { proveUndispatchedRateLimitEntry } from "./rate-limit-read-recovery.ts";

function fixture() {
  const now = Date.parse("2026-11-14T10:00:00Z");
  const scope = { product_id: "p", tenant_id: "t", user_id: "u", operator_id: "o",
    exchange_account_id: "a", trading_engine_id: "e", quote_asset: "BRL" };
  const run = { ...scope, id: "run", symbol: "SOLBRL", created_at: "2026-10-01T10:00:00Z",
    last_reconciled_at: "2026-11-14T09:59:59Z" };
  const orders: Record<string, unknown>[] = [{ ...scope, id: "buy", run_id: run.id, slot_id: "slot", slot_number: 16,
    operation_sequence: 1, side: "BUY", purpose: "ENTRY", status: "PREPARED", client_order_id: "owned:buy",
    exchange_order_id: null, submission_guarded_at: null, account_order_unsent_receipt: null,
    price: 415.5, requested_quantity: .026, requested_quote: null, reserved_notional_brl: 10.803,
    executed_quantity: 0, cumulative_quote: 0, fee_base: 0, fee_quote: 0, fee_other: [],
    trades_reconciled: false, strategy_decision_id: "decision", created_at: "2026-11-14T03:33:56Z" }];
  const slots: Record<string, unknown>[] = [{ ...scope, id: "slot", run_id: run.id, slot_number: 16,
    operation_sequence: 1, entry_state: "ARMED", position_quantity: 0, target_buy_price: 415.5 }];
  const decisions: Record<string, unknown>[] = [{ ...scope, decision_id: "decision", environment: "REAL", cycle_id: run.id,
    slot_id: "slot", operation_sequence: 1, action_type: "ARM_NEXT_BUY", expected_next_state: "ARMED", result: "PENDING",
    dispatched_at: null, exchange_ack_at: null, completed_at: null, target_price: 415.5, target_notional: 11,
    created_at: "2026-11-14T03:33:55Z" }];
  const incident = { first_seen_at: "2026-11-14T03:33:59Z", last_seen_at: "2026-11-14T03:33:59Z" };
  return { run, orders, slots, decisions, incident, now,
    prove: (reservations: Record<string, unknown>[] = [], observed: unknown = null) =>
      proveUndispatchedRateLimitEntry(run, orders, slots, decisions, reservations, observed, "owned:", incident, now) };
}

test("rate-limited pre-dispatch LIMIT retains its identity and rounded reservation, with stable evidence", () => {
  const f = fixture(), before = structuredClone([f.orders, f.slots, f.decisions]);
  assert.equal(f.prove(), f.prove());
  assert.deepEqual([f.orders, f.slots, f.decisions], before);
  const first = f.prove(); f.decisions[0].target_notional = 12;
  assert.notEqual(f.prove(), first, "a different authorization cannot reuse the first proof");
});

test("every dispatch, fill, identity or incomplete proof stays closed", () => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
    ...[{ submission_guarded_at: "2026-11-14T03:33:58Z" }, { exchange_order_id: "123" },
      { executed_quantity: .001 }, { cumulative_quote: .4 }, { fee_base: .001 }, { fee_quote: .01 },
      { fee_other: [{ asset: "BNB", amount: .01 }] }, { account_order_unsent_receipt: {} },
      { status: "UNKNOWN" }, { purpose: "INITIAL" }, { side: "SELL" }, { requested_quote: 11 },
      { trading_engine_id: "sibling" }, { exchange_account_id: "sibling" }, { run_id: "other" },
      { client_order_id: "other:buy" }, { operation_sequence: 2 }, { slot_number: 17 },
      { reserved_notional_brl: 11 }, { created_at: "2026-11-14T04:00:00Z" }]
      .map(change => (f: ReturnType<typeof fixture>) => Object.assign(f.orders[0], change)),
    ...[{ dispatched_at: "2026-11-14T03:33:57Z" }, { exchange_ack_at: "now" }, { completed_at: "now" },
      { result: "FAILED" }, { decision_id: "other" }, { cycle_id: "other" }, { target_notional: 10 },
      { target_price: 416 }, { action_type: "CREATE_TP" }, { expected_next_state: "OPEN" },
      { created_at: "invalid" }, { environment: "TESTNET" }, { trading_engine_id: "other" }]
      .map(change => (f: ReturnType<typeof fixture>) => Object.assign(f.decisions[0], change)),
    f => { f.slots[0].entry_state = "OPEN"; }, f => { f.slots[0].position_quantity = .001; },
    f => { f.slots[0].target_buy_price = 400; }, f => { f.slots[0].run_id = "other"; },
    f => { f.decisions.push({ ...f.decisions[0] }); }, f => { f.decisions.pop(); },
    f => { f.slots.push({ ...f.slots[0] }); }, f => { f.orders.push({ ...f.orders[0] }); },
    f => { f.orders.push({ ...f.orders[0], id: "b", client_order_id: "owned:b", status: "NEW" }); },
    f => { f.run.last_reconciled_at = "2026-11-14T09:57:00Z"; },
    f => { f.run.last_reconciled_at = "2026-11-14T10:01:00Z"; },
    f => { f.run.last_reconciled_at = f.incident.last_seen_at; },
  ];
  for (const change of changes) { const f = fixture(); change(f); assert.throws(() => f.prove(), /UNPROVEN/); }
  for (const observed of [undefined, {}, { status: "NEW" }, { status: "FILLED" }]) {
    const f = fixture();
    assert.throws(() => proveUndispatchedRateLimitEntry(f.run, f.orders, f.slots, f.decisions, [], observed,
      "owned:", f.incident, f.now), /UNPROVEN/);
  }
  assert.throws(() => fixture().prove([{ client_order_id: "owned:buy" }]), /UNPROVEN/);
});
