import assert from "node:assert/strict";
import test from "node:test";
import { allocateBulkSlots, projectSlotAdjustment, splitBulkEngines } from "../execution/live-adjustment-plans.ts";

const btc = "11111111-1111-4111-8111-111111111111";
const sol = "22222222-2222-4222-8222-222222222222";

test("bulk 50/50 and 25 slots preserve every cent and engine boundary", () => {
  const shares = splitBulkEngines(200, [btc, sol]);
  assert.deepEqual(shares.map((row) => row.amount), [100, 100]);
  const slots = allocateBulkSlots(200, shares);
  assert.equal(slots.length, 50);
  assert.deepEqual(slots.filter((row) => row.engineId === btc).map((row) => row.amount), Array(25).fill(4));
  assert.deepEqual(slots.filter((row) => row.engineId === sol).map((row) => row.amount), Array(25).fill(4));
});

test("single engine, custom 60/40 and odd cents do not create capital", () => {
  const single = splitBulkEngines(200, [btc]);
  assert.equal(allocateBulkSlots(200, single).reduce((sum, row) => sum + Math.round(row.amount * 100), 0), 20_000);
  const shares = splitBulkEngines(100.01, [btc, sol], 60);
  assert.deepEqual(shares.map((row) => row.amount), [60.01, 40]);
  const slots = allocateBulkSlots(100.01, shares);
  assert.equal(slots.reduce((sum, row) => sum + Math.round(row.amount * 100), 0), 10_001);
});

test("cross-engine duplication, cent errors and amount below 25-slot minimum fail", () => {
  assert.throws(() => splitBulkEngines(10, [btc, btc]), /SELECTION/);
  assert.throws(() => allocateBulkSlots(10, [{ engineId: btc, amount: 9 }]), /DISTRIBUTION/);
  assert.throws(() => splitBulkEngines(0.1, [btc, sol]), /SLOT_MINIMUM/);
  assert.throws(() => splitBulkEngines(100.001, [btc]), /PRECISION/);
});

test("OPEN capital stays outside the existing position and becomes future balance", () => {
  const next = projectSlotAdjustment({ balanceBefore: 100, committed: 100, amount: 5,
    gainUnits: 0, monthlyBefore: 1, lifetimeBefore: 3, open: true });
  assert.equal(next.balanceAfter, 105);
  assert.equal(next.committedAfter, 100);
  assert.equal(next.pendingForNextOperation, 5);
  assert.equal(next.monthlyAfter, 1);
  assert.equal(next.lifetimeAfter, 3);
  // An eventual net TP profit X=1.2 belongs to the next operation, once.
  assert.equal(Number((next.balanceAfter + 1.2).toFixed(2)), 106.2);
});

test("closed capital and manual gain stay different accounting dimensions", () => {
  const capital = projectSlotAdjustment({ balanceBefore: 16.76, committed: 0, amount: 4,
    gainUnits: 0, monthlyBefore: 1, lifetimeBefore: 8, open: false });
  const gain = projectSlotAdjustment({ ...capital, balanceBefore: capital.balanceAfter,
    committed: 0, amount: 0, gainUnits: 1, open: false });
  assert.equal(capital.balanceAfter, 20.76);
  assert.equal(capital.monthlyAfter, 1);
  assert.equal(gain.balanceAfter, 20.76);
  assert.equal(gain.monthlyAfter, 2);
  assert.equal(gain.lifetimeAfter, 9);
});
