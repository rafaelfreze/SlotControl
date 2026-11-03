import test from "node:test";
import assert from "node:assert/strict";
import { cumulativeSlotGoal, CUMULATIVE_SLOT_GOAL_POLICY, type SlotGoalPolicy } from "./cumulative-slot-goal.ts";
import { rankMonthlySlots, type MonthlySlotInput } from "./monthly-slot-policy.ts";
import { buildPostAthQueue } from "./ath-regime.ts";
import { allocateMonthlyEntryLevels } from "./strategy-engine.ts";
const policy = (rate = 2, anchor = "2026-09-20T04:00:00Z"): SlotGoalPolicy => ({
  policy: CUMULATIVE_SLOT_GOAL_POLICY, anchor_at: anchor,
  schedule: [{ effective_period: anchor.slice(0, 7), monthly_target: rate, source: "FIRST_BUY" }] });
const inputs = (n = 25): MonthlySlotInput[] => Array.from({ length: n }, (_, i) => ({
  physicalSlotNumber: i + 1, physicalSlotId: `engine:${i + 1}`, monthlyGainCount: 0,
  lifetimeGainCount: i === 0 ? 2 : i === 1 ? 1 : 0, balanceUsdc: 22, entryState: "PLANNED" }));
const rank = (rows: MonthlySlotInput[], p = policy(), at = "2026-10-02T12:00:00Z") => {
  const goal = cumulativeSlotGoal(p, at);
  return rankMonthlySlots("SOL", at, rows, goal.target, rows.length, undefined, goal);
};
test("SOL2 and BTC7 accrue calendar months from actual start, including annual rollover and large cumulative values", () => {
  for (const rate of [2, 3, 7, 1000]) {
    assert.equal(cumulativeSlotGoal(policy(rate), "2026-09-21T00:00:00Z").target, rate);
    assert.equal(cumulativeSlotGoal(policy(rate), "2026-10-01T04:00:00Z").target, rate * 2);
    assert.equal(cumulativeSlotGoal(policy(rate), "2026-11-01T04:00:00Z").target, rate * 3);
    assert.equal(cumulativeSlotGoal(policy(rate, "2026-12-31T20:00:00Z"), "2027-01-01T04:00:00Z").target, rate * 2);
  }
});
test("Campo Grande boundary is local, not UTC midnight or elapsed30days; original cycle anchor survives software/reset date", () => {
  assert.equal(cumulativeSlotGoal(policy(), "2026-10-01T03:59:59.999Z").cycleMonth, 1);
  const goal = cumulativeSlotGoal(policy(), "2026-10-01T04:00:00Z");
  assert.equal(goal.cycleMonth, 2); assert.equal(goal.nextPeriodAt, "2026-11-01T04:00:00.000Z");
  assert.equal(goal.nextTarget, 6);
  assert.equal(cumulativeSlotGoal(policy(2, "2026-10-31T16:00:00Z"), "2026-11-01T04:00:00Z").target, 4);
});
test("prospective edits sum past competences, never multiply historical months by latest rate", () => {
  const p = policy(); p.schedule.push({ effective_period: "2026-11", monthly_target: 3, source: "CONFIG2" });
  assert.equal(cumulativeSlotGoal(p, "2026-10-30T12:00:00Z").target, 4);
  assert.equal(cumulativeSlotGoal(p, "2026-10-30T12:00:00Z").nextTarget, 7);
  assert.equal(cumulativeSlotGoal(p, "2026-12-30T12:00:00Z").target, 10);
  assert.throws(() => cumulativeSlotGoal({ ...p, schedule: [...p.schedule].reverse() }, "2026-12-30"));
  assert.throws(() => cumulativeSlotGoal(p, "2026-08-30"));
});

test("historical DST uses IANA local calendar, never a fixed UTC4 offset",()=>{
  const p=policy(2,"2018-10-15T12:00:00Z");
  assert.equal(cumulativeSlotGoal(p,"2018-12-01T02:59:59Z").target,4);
  assert.equal(cumulativeSlotGoal(p,"2018-12-01T03:00:00Z").target,6);
});
for (const n of [25, 50, 100]) test(`${n}slots:2/2 becomes2/4,1/2 becomes1/4; lifetime2 precedes1 despite current-month0`, () => {
  const rows = inputs(n), before = JSON.stringify(rows);
  const september = rank(rows, policy(), "2026-09-21T12:00:00Z");
  assert.equal(september[0].eligibleForNewEntry, false);
  const october = rank(rows);
  assert.equal(october[0].monthlyGainTarget, 4); assert.equal(october[0].operationalRank, 1);
  assert.equal(october[1].operationalRank, 2); assert.equal(october[0].monthlyGainCount, 0);
  assert.equal(JSON.stringify(rows), before);
  const queue = buildPostAthQueue("SOL", october.map(s => ({ ...s,
    goalEntryEligible: s.eligibleForNewEntry, goalTargetReached: s.monthlyTargetReached })), 4, n);
  assert.equal(queue.filter(s => s.postAthGroup === "PRIMARY").length, 15);
  assert.equal(queue.filter(s => s.postAthGroup === "RESERVE").length, n - 15);
});
test("OPEN/partial/blocked cannot compete or prevent all-available release; below-goal available slot holds reached slots", () => {
  const rows = inputs(); rows.forEach(s => { s.entryState = "OPEN"; s.lifetimeGainCount = 0; });
  rows[0] = { ...rows[0], entryState: "CLOSED", lifetimeGainCount: 4 };
  assert.equal(rank(rows)[0].eligibleForNewEntry, true);
  assert.equal(rank(rows).filter(s => s.eligibleForNewEntry).length, 1);
  rows[1].entryState = "PLANNED";
  assert.equal(rank(rows)[0].eligibleForNewEntry, false);
  rows[1].entryBlocked = true;
  assert.equal(rank(rows)[0].eligibleForNewEntry, true);
  rows[2].entryState = "PARTIALLY_FILLED";
  assert.equal(rank(rows)[2].eligibleForNewEntry, false);
  rows[3].monthlyGainCount = null;
  assert.equal(rank(rows)[0].eligibleForNewEntry, false);
});
test("real prospective pool permutation preserves money/history and pins partial resident; retry deterministic", () => {
  const statuses = rank(inputs());
  const candidates = statuses.map(s => ({ id: s.physicalSlotId, slotNumber: s.physicalSlotNumber,
    operationSequence: 1, buyPrice: 100 - s.physicalSlotNumber, balanceQuote: 22,
    state: "PLANNED" as const, monthlyGainCount: s.monthlyGainCount!, lifetimeGainCount: s.lifetimeGainCount,
    priorityGainCount: s.priorityGainCount, operationalRank: s.operationalRank,
    monthlyTargetReached: s.monthlyTargetReached, monthlyEntryEligible: s.eligibleForNewEntry }));
  const context = { asset: "SOL" as const, cycleId: "engineA", observedAt: "2026-10-02T12:00:00Z", entryPriorityPolicy: "MONTHLY_GAINS_V1" as const };
  const before = JSON.stringify(candidates), result = allocateMonthlyEntryLevels(context, candidates, 105, "NORMAL");
  assert.equal(result.nextCandidateId, "engine:1");
  assert.deepEqual(allocateMonthlyEntryLevels(context, candidates, 105, "NORMAL"), result);
  assert.equal(JSON.stringify(candidates), before);
  const armed = candidates.map(s => s.slotNumber === 2 ? { ...s, state: "PARTIALLY_FILLED" as const } : s);
  assert.equal(allocateMonthlyEntryLevels(context, armed, 105, "NORMAL", { candidateId: "engine:2", executedQuantity: .001 }).held, true);
});
