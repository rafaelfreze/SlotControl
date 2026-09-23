import assert from "node:assert/strict";
import test from "node:test";

import { projectTestnetEntryState, recoverTestnetStrategyDecisions, type RecoverableTestnetDecision, type RecoveryTestnetOrder, type RecoveryTestnetSlot } from "../execution/strategy-testnet-recovery.ts";

const slot: RecoveryTestnetSlot = { id: "slot-1", run_id: "run", operation_sequence: 2, entry_state: "PLANNED", target_buy_price: "118.97000000", balance_usdc: "10.09996000" };
const decision = (values: Partial<RecoverableTestnetDecision> = {}): RecoverableTestnetDecision => ({
  decision_id: "decision", cycle_id: "run", slot_id: "slot-1", operation_sequence: 2,
  action_type: "ARM_NEXT_BUY", target_price: 118.97, target_notional: 10.09996, result: "DISPATCHED", ...values,
});
const order = (values: Partial<RecoveryTestnetOrder> = {}): RecoveryTestnetOrder => ({
  run_id: "run", slot_id: "slot-1", operation_sequence: 2, side: "BUY", purpose: "ENTRY", status: "NEW",
  client_order_id: "own-buy", exchange_order_id: "101", price: "118.97000000", executed_quantity: 0,
  cumulative_quote: 0, strategy_decision_id: "decision", ...values,
});
const recover = (decisions: RecoverableTestnetDecision[], orders: RecoveryTestnetOrder[] = [], slots: RecoveryTestnetSlot[] = [slot], successorId?: string) =>
  recoverTestnetStrategyDecisions({ runId: "run", decisions, slots, orders, successorId });

test("crash recovery derives residence from orders, preserving uncovered and partial positions", () => {
  assert.equal(projectTestnetEntryState({ ...slot, entry_state: "ARMED" }, [order({ status: "CANCELED" })]), "PLANNED");
  assert.equal(projectTestnetEntryState(slot, [order()]), "ARMED");
  assert.equal(projectTestnetEntryState(slot, [order({ status: "PARTIALLY_FILLED", executed_quantity: 0.01 })]), "ARMED");
  assert.equal(projectTestnetEntryState(slot, [order({ status: "FILLED", executed_quantity: 0.00001 })]), "OPEN");
  assert.equal(projectTestnetEntryState({ ...slot, entry_state: "ARMED" }, [order({ status: "FILLED", executed_quantity: 0.084 }), order({ side: "SELL", status: "FILLED", executed_quantity: 0.084 })]), "PLANNED");
  assert.equal(projectTestnetEntryState(slot, [order({ run_id: "other" })]), "PLANNED");
  assert.equal(projectTestnetEntryState({ ...slot, entry_state: "CLOSED" }, [order({ status: "FILLED", executed_quantity: 0.00001 })]), "CLOSED");
});

test("recover initial fill persisted before decision completion without inventing fill or acknowledgment time", () => {
  const initial = decision({ action_type: "OPEN_INITIAL_MARKET", operation_sequence: 1, target_notional: 10 });
  const fill = order({ purpose: "INITIAL", status: "FILLED", operation_sequence: 1, price: null, requested_quote: "10", executed_quantity: 0.084, cumulative_quote: 9.99516 });
  const result = recover([initial], [fill]);
  assert.equal(result.length, 1);
  assert.equal(result[0].exchangeAck, true);
  assert.equal(result[0].observed.executed_quantity, 0.084);
  assert.equal(result[0].observed.recovered_from_ledger, true);
  assert.equal(result[0].observed.exchange_ack_at, undefined);
  assert.equal(result[0].observed.filled_at, undefined);
  assert.deepEqual(recover([initial], [{ ...fill, status: "NEW", executed_quantity: 0 }]), []);
  assert.deepEqual(recover([initial], [{ ...fill, status: "PARTIALLY_FILLED" }]), []);
});

test("local-reentry crash after slot mutation recovers exact sequence and retains compounded balance", () => {
  const result = recover([decision({ action_type: "PLAN_LOCAL_REENTRY" })]);
  assert.equal(result.length, 1);
  assert.equal(result[0].exchangeAck, false);
  assert.equal(result[0].observed.balance_usdc, 10.09996);
  assert.equal(result[0].observed.operation_sequence, 2);
  assert.deepEqual(recover([decision({ action_type: "PLAN_LOCAL_REENTRY" })], [], [{ ...slot, operation_sequence: 3 }]), []);
  assert.deepEqual(recover([decision({ action_type: "PLAN_LOCAL_REENTRY" })], [], [{ ...slot, entry_state: "CLOSED" }]), []);
  assert.deepEqual(recover([decision({ action_type: "PLAN_LOCAL_REENTRY" })], [], [{ ...slot, target_buy_price: 117.78 }]), []);
});

test("cancel then crash then arm through another decision recovers original only from actual matching order", () => {
  const original = decision({ action_type: "CANCEL_REPLACE_NEXT_BUY" });
  const actualReplacement = order({ strategy_decision_id: "new-arm-decision" });
  assert.equal(recover([original], [actualReplacement])[0]?.observed.matched_by, "EXACT_SLOT_SEQUENCE_PURPOSE_PRICE");
  assert.deepEqual(recover([original], [{ ...actualReplacement, status: "PREPARED", exchange_order_id: null }]), []);
  assert.deepEqual(recover([original], [actualReplacement, order({ slot_id: "lower-slot", client_order_id: "lower-own-buy", price: 116.6 })]), []);
});

test("TP accepted or already filled is proof but rejected/canceled/prepared is not", () => {
  const tp = decision({ action_type: "CREATE_TP", target_price: 119.59 });
  for (const status of ["NEW", "PARTIALLY_FILLED", "FILLED"]) {
    assert.equal(recover([tp], [order({ purpose: "TP", side: "SELL", status, price: 119.59 })]).length, 1);
  }
  for (const status of ["PREPARED", "REJECTED", "CANCELED", "EXPIRED"]) {
    assert.deepEqual(recover([tp], [order({ purpose: "TP", side: "SELL", status, price: 119.59 })]), []);
  }
});

test("global reset audit recovers only from verified persisted successor relation", () => {
  const decisions = [decision({ action_type: "COMPLETE_CYCLE" }), decision({ decision_id: "reanchor", action_type: "REANCHOR", slot_id: null, operation_sequence: null })];
  assert.deepEqual(recover(decisions), []);
  assert.deepEqual(recover(decisions, [], [], "run"), []);
  const result = recover(decisions, [], [], "successor-run");
  assert.equal(result.length, 2);
  assert.ok(result.every((row) => row.observed.next_cycle_id === "successor-run" && row.exchangeAck === false));
  assert.equal(result[1].observed.state, "READY_FOR_INITIAL_MARKET");
});

test("completed decisions are immutable and run/slot/sequence/side/target boundaries do not leak", () => {
  assert.deepEqual(recover([decision({ result: "COMPLETED" })], [order()]), []);
  assert.deepEqual(recover([decision({ cycle_id: "foreign-run" })], [order()]), []);
  for (const changed of [{ run_id: "foreign-run" }, { slot_id: "slot-2" }, { operation_sequence: 1 }, { side: "SELL" }, { price: 117.78 }, { exchange_order_id: null }]) {
    assert.deepEqual(recover([decision()], [order(changed)]), []);
  }
});

test("queue fill before crash recovery proves actual arm without retroactive execution", () => {
  const actual = order({ status: "FILLED", executed_quantity: 0.084, cumulative_quote: 9.99516 });
  const before = structuredClone(actual);
  const result = recover([decision()], [actual]);
  assert.equal(result[0]?.observed.order_status, "FILLED");
  assert.equal(result[0]?.observed.executed_quantity, 0.084);
  assert.deepEqual(actual, before);
  assert.deepEqual(recover([decision({ action_type: "WAIT" })], [actual]), []);
});
