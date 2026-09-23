import assert from "node:assert/strict";
import test from "node:test";
import { adjustmentCommittedNotional, previewManualAdjustment } from "../execution/manual-adjustments.ts";

const buy = { side: "BUY" as const, executed_quantity: "0.4", fee_base: "0", cumulative_quote: "40" };
test("ARMED partial execution has frozen committed capital in manual preview", () => {
  const committed = adjustmentCommittedNotional([buy]);
  const preview = previewManualAdjustment({ environment: "TESTNET", asset: "SOL", physicalSlotNumber: 1,
    balanceUsdc: 100, committedNotionalUsdc: committed, entryState: "ARMED", monthlyGainCount: 0,
    lifetimeGainCount: 0, gainRate: 0.005 }, { kind: "MANUAL_CONTRIBUTION", currency: "USD", amount: 5 });
  assert.equal(committed, 40);
  assert.equal(preview.committedNotionalUsdc, 40);
  assert.equal(preview.balanceAfterUsdc, 105);
  assert.equal(preview.monthlyAfter, 0);
  assert.equal(preview.appliesTo, "NEXT_OPERATION");
});
test("partial SELL keeps original committed evidence; complete SELL and fees close exposure", () => {
  const sell = { side: "SELL" as const, executed_quantity: "0.2", fee_base: "0", cumulative_quote: "20.1" };
  assert.equal(adjustmentCommittedNotional([buy, sell]), 40);
  assert.equal(adjustmentCommittedNotional([buy, { ...sell, executed_quantity: "0.4" }]), null);
  assert.equal(adjustmentCommittedNotional([{ ...buy, fee_base: "0.001" }, { ...sell, executed_quantity: "0.399" }]), null);
  assert.equal(adjustmentCommittedNotional([]), null);
});
test("nonfinite and impossible position evidence fails closed", () => {
  for (const patch of [{ executed_quantity: "NaN" }, { fee_base: "Infinity" }, { cumulative_quote: "-1" },
    { executed_quantity: "-1" }, { fee_base: "1" }, { cumulative_quote: "0" }]) {
    assert.throws(() => adjustmentCommittedNotional([{ ...buy, ...patch }]), /POSITION_UNAVAILABLE/);
  }
});
