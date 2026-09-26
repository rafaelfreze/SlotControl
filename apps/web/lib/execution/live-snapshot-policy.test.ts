import assert from "node:assert/strict";
import test from "node:test";

import { canReuseLiveState, mayCancelPartialBuy, needsResidentPreflight } from "./live-snapshot-policy.ts";

const resident = { status: "NEW", side: "BUY" as const,
  submission_guarded_at: "2026-09-26T12:00:00Z", executed_quantity: "0" };

test("only an unguarded PREPARED order requires resident-price preflight before dispatch", () => {
  assert.equal(needsResidentPreflight([resident]), false);
  assert.equal(needsResidentPreflight([{ ...resident, status: "PREPARED" }]), false);
  assert.equal(needsResidentPreflight([{ ...resident, status: "PREPARED",
    submission_guarded_at: null }]), true);
});

test("partial BUY invalidates state after TP protection; unchanged resident does not", () => {
  assert.equal(mayCancelPartialBuy([resident]), false);
  assert.equal(mayCancelPartialBuy([{ ...resident, status: "PARTIALLY_FILLED",
    executed_quantity: "0.001" }]), true);
  assert.equal(mayCancelPartialBuy([{ ...resident, side: "SELL", status: "PARTIALLY_FILLED",
    executed_quantity: "0.001" }]), false);
});

test("snapshot reuse is bounded and never crosses a write or ATH transition", () => {
  assert.equal(canReuseLiveState(10_000, 14_999, false), true);
  assert.equal(canReuseLiveState(10_000, 15_001, false), false);
  assert.equal(canReuseLiveState(10_000, 10_100, true), false);
  assert.equal(canReuseLiveState(10_000, 9_999, false), false);
});
