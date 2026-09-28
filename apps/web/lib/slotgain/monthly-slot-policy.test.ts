import assert from "node:assert/strict";
import test from "node:test";

import { monthlyPeriodKey, nextMonthlyResetAt, rankMonthlySlots, physicalSlotIdentity } from "../execution/monthly-slot-policy.ts";

const slots = (counts: Array<[number, number, number | null]>) => counts.map(([physicalSlotNumber, lifetimeGainCount, monthlyGainCount]) => ({
  physicalSlotNumber, physicalSlotId: `TESTNET:scope:SOL:${physicalSlotNumber}`, lifetimeGainCount, monthlyGainCount,
  balanceUsdc: 10 + lifetimeGainCount * 0.05, entryState: "PLANNED",
}));

test("BTC 6 to 7 and SOL 1 to 2 block new entry while preserving OPEN and lifetime", () => {
  const btc = rankMonthlySlots("BTC", "2026-09-23T16:00:00Z", slots([[2, 6, 6], [5, 7, 7]]));
  const sol = rankMonthlySlots("SOL", "2026-09-23T16:00:00Z", slots([[2, 1, 1], [5, 2, 2]]));
  assert.deepEqual([btc[0]?.monthlyGainTarget, sol[0]?.monthlyGainTarget], [7, 2]);
  assert.equal(btc[1]?.blockedReason, "MONTHLY_TARGET_REACHED");
  assert.equal(sol[1]?.blockedReason, "MONTHLY_TARGET_REACHED");
  assert.equal(rankMonthlySlots("SOL", "2026-09-23T16:00:00Z", [{ ...slots([[5, 2, 2]])[0]!, entryState: "OPEN" }])[0]?.entryState, "OPEN");
});

test("eligible queue ranks lifetime gains descending, ties by immutable physical number", () => {
  const result = rankMonthlySlots("BTC", "2026-09-23T16:00:00Z", slots([[2, 3, 1], [4, 6, 1], [5, 10, 2], [7, 6, 0]]));
  assert.deepEqual(result.filter((slot) => slot.eligibleForNewEntry).sort((a, b) => a.operationalRank! - b.operationalRank!).map((slot) => slot.physicalSlotNumber), [5, 4, 7, 2]);
  const reached = rankMonthlySlots("SOL", "2026-09-23T16:00:00Z", slots([[2, 3, 1], [4, 6, 1], [5, 10, 2]]));
  assert.deepEqual(reached.filter((slot) => slot.eligibleForNewEntry).sort((a, b) => a.operationalRank! - b.operationalRank!).map((slot) => slot.physicalSlotNumber), [4, 2]);
  assert.equal(reached[2]?.operationalRank, null);
});

test("Campo Grande month rolls at the local boundary without resetting lifetime or physical identity", () => {
  assert.equal(monthlyPeriodKey("2026-10-01T03:59:59.999Z"), "2026-09");
  assert.equal(monthlyPeriodKey("2026-10-01T04:00:00.000Z"), "2026-10");
  assert.equal(nextMonthlyResetAt("2026-09-23T16:00:00Z"), "2026-10-01T04:00:00.000Z");
  const id = physicalSlotIdentity("TESTNET", { productId: "p", tenantId: "t", userId: "u", asset: "SOL" }, 5);
  const reached = rankMonthlySlots("SOL", "2026-09-30T23:00:00-04:00", [{ ...slots([[5, 10, 2]])[0]!, physicalSlotId: id }]);
  const next = rankMonthlySlots("SOL", "2026-10-01T00:00:00-04:00", [{ ...slots([[5, 10, 0]])[0]!, physicalSlotId: id }]);
  assert.equal(reached[0]?.eligibleForNewEntry, false);
  assert.equal(next[0]?.eligibleForNewEntry, true);
  assert.equal(next[0]?.lifetimeGainCount, 10);
  assert.equal(next[0]?.physicalSlotId, reached[0]?.physicalSlotId);
});

test("missing credit evidence blocks new entry and duplicate physical IDs fail closed", () => {
  assert.equal(rankMonthlySlots("SOL", "2026-09-23T16:00:00Z", slots([[5, 10, null]]))[0]?.blockedReason, "GAIN_EVIDENCE_INCOMPLETE");
  assert.throws(() => rankMonthlySlots("SOL", "2026-09-23T16:00:00Z", [slots([[5, 0, 0]])[0]!, slots([[5, 0, 0]])[0]!]), /COINOPS_MONTHLY_SLOT_EVIDENCE_INVALID/);
});

test("SOL 0/2, 1/2, 2/2, 3/2 and BTC 0/7, 6/7, 7/7, 8/7 keep the goal as a floor", () => {
  for (const [asset, target, counts] of [["SOL", 2, [0, 1, 2, 3]], ["BTC", 7, [0, 6, 7, 8]]] as const) {
    for (const count of counts) {
      const inputs = slots(Array.from({ length: 25 }, (_, index) => [index + 1, count + 8, index === 0 ? count : 0]));
      const status = rankMonthlySlots(asset, "2026-09-28T16:00:00Z", inputs);
      assert.equal(status[0]?.monthlyGainCount, count);
      assert.equal(status[0]?.monthlyGainTarget, target);
      assert.equal(status[0]?.monthlyTargetReached, count >= target);
      assert.equal(status[0]?.eligibleForNewEntry, count < target);
      assert.equal(status[1]?.eligibleForNewEntry, true);
    }
    const almost = rankMonthlySlots(asset, "2026-09-28T16:00:00Z",
      slots(Array.from({ length: 25 }, (_, index) => [index + 1, target + 8, index === 24 ? target - 1 : target])));
    assert.equal(almost.filter((status) => status.eligibleForNewEntry).length, 1);
    assert.equal(almost[24]?.operationalRank, 1);
    const complete = rankMonthlySlots(asset, "2026-09-28T16:00:00Z",
      slots(Array.from({ length: 25 }, (_, index) => [index + 1, target + 8, index === 0 ? target + 1 : target])));
    assert.equal(complete.filter((status) => status.monthlyTargetReached).length, 25);
    assert.equal(complete.filter((status) => status.eligibleForNewEntry).length, 25);
    assert.equal(new Set(complete.map((status) => status.operationalRank)).size, 25);
    assert.equal(complete[0]?.monthlyGainCount, target + 1);
  }
});

test("local September/October and December/January rollover keeps OPEN and lifetime facts", () => {
  for (const [before, after, previous, current] of [
    ["2026-10-01T03:59:59.999Z", "2026-10-01T04:00:00.000Z", "2026-09", "2026-10"],
    ["2027-01-01T03:59:59.999Z", "2027-01-01T04:00:00.000Z", "2026-12", "2027-01"],
  ]) {
    assert.equal(monthlyPeriodKey(before), previous);
    assert.equal(monthlyPeriodKey(after), current);
    assert.equal(nextMonthlyResetAt(before), after);
    const physical = slots(Array.from({ length: 25 }, (_, index) => [index + 1, 12, index === 0 ? 2 : 0]));
    physical[0]!.entryState = "OPEN";
    const old = rankMonthlySlots("SOL", before, physical);
    const next = rankMonthlySlots("SOL", after, physical.map((slot) => ({ ...slot, monthlyGainCount: 0 })));
    assert.equal(old[0]?.entryState, "OPEN");
    assert.equal(next[0]?.entryState, "OPEN");
    assert.equal(next[0]?.monthlyGainCount, 0);
    assert.equal(next[0]?.lifetimeGainCount, 12);
    assert.equal(next[0]?.physicalSlotId, old[0]?.physicalSlotId);
  }
});
