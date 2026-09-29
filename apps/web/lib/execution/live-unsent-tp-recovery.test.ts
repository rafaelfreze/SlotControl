import assert from "node:assert/strict";
import test from "node:test";

import { isProvablyUnsentTakeProfit } from "./live-unsent-tp-recovery.ts";

const now = Date.parse("2026-09-29T16:00:00Z");
const order = { status: "PREPARED", side: "SELL", purpose: "TP", run_id: "cycle-a",
  slot_id: "slot-a", operation_sequence: 1, strategy_decision_id: "decision-a",
  submission_guarded_at: "2026-09-29T15:27:03Z" };
const decision = { decision_id: "decision-a", cycle_id: "cycle-a", slot_id: "slot-a",
  operation_sequence: 1, action_type: "CREATE_TP", result: "PENDING",
  dispatched_at: null, exchange_ack_at: null, completed_at: null };

test("only an old, exact TP with a never-dispatched durable decision can recover", () => {
  assert.equal(isProvablyUnsentTakeProfit(order, decision, now), true);
  assert.equal(isProvablyUnsentTakeProfit(order, decision, Date.parse("2026-09-29T15:28:00Z")), false);
  assert.equal(isProvablyUnsentTakeProfit(order, null, now), false);
  for (const changed of [{ side: "BUY" }, { status: "NEW" }, { purpose: "ENTRY" },
    { run_id: "other-cycle" }, { slot_id: "other-slot" }, { strategy_decision_id: "other" },
    { submission_guarded_at: null }])
    assert.equal(isProvablyUnsentTakeProfit({ ...order, ...changed }, decision, now), false);
  for (const changed of [{ result: "DISPATCHED" }, { dispatched_at: "2026-09-29T15:27:04Z" },
    { exchange_ack_at: "2026-09-29T15:27:05Z" }, { completed_at: "2026-09-29T15:27:06Z" },
    { cycle_id: "other-cycle" }, { slot_id: "other-slot" }, { operation_sequence: 2 },
    { action_type: "ARM_NEXT_BUY" }])
    assert.equal(isProvablyUnsentTakeProfit(order, { ...decision, ...changed }, now), false);
});
