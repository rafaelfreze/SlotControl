import assert from "node:assert/strict";
import test from "node:test";

import { advanceAthState, buildPostAthQueue, orderedPostAthSlots, reconcileHistoricalAth, type AthState } from "../execution/ath-regime.ts";
import { planAthLadder, type AthLadderSlot } from "../execution/ath-ladder.ts";
import { simulateAth } from "../execution/ath-simulator.ts";
import { monthlyPeriodKey, nextMonthlyResetAt, rankMonthlySlots, MONTHLY_SLOT_TARGET } from "../execution/monthly-slot-policy.ts";
import { planStrategyClosedSlot, planStrategyNextEntry, planStrategyPostAthNextEntry,
  calculateStrategyTakeProfit, type StrategyCandidate, type StrategyContext } from "../execution/strategy-engine.ts";

const instant = "2026-10-01T03:59:59.999Z";
const ctx = (asset: "BTC" | "SOL" = "BTC"): StrategyContext => ({ asset, cycleId: `audit-${asset}`, observedAt: instant });
const candidates = (): StrategyCandidate[] => Array.from({ length: 25 }, (_, i) => ({ id: `physical-${i + 1}`,
  slotNumber: i + 1, operationSequence: 1, buyPrice: 100 - i, balanceUsdc: 10,
  operationalRank: i + 1, monthlyTargetReached: false, state: "PLANNED" }));
const ladder = (): AthLadderSlot[] => candidates().map((slot) => ({ physicalSlotId: slot.id,
  physicalSlotNumber: slot.slotNumber, lifetimeGainCount: 0, monthlyGainCount: 0,
  entryState: "PLANNED", status: "PENDING", buyPrice: slot.buyPrice,
  entryOrigin: "GRID", operationSequence: 1 }));
const parameters = { gainRate: .005, normalSpacing: .01, postAthSpacing: .02 };

test("audit 5: all 25 targets hold the final close and the next local month restores eligibility", () => {
  for (const asset of ["BTC", "SOL"] as const) {
    const target = MONTHLY_SLOT_TARGET[asset];
    const physical = candidates().map((slot) => ({ physicalSlotId: slot.id, physicalSlotNumber: slot.slotNumber,
      lifetimeGainCount: 100 + target, monthlyGainCount: target, balanceUsdc: 11, entryState: "CLOSED" }));
    const before = structuredClone(physical);
    const held = rankMonthlySlots(asset, instant, physical);
    const queue = candidates().map((slot, i) => ({ ...slot, state: "CLOSED" as const,
      monthlyTargetReached: held[i]!.monthlyTargetReached, operationalRank: held[i]!.operationalRank }));
    assert.equal(planStrategyNextEntry(ctx(asset), queue, 101).decision.action_type, "WAIT");
    const closed = planStrategyClosedSlot(ctx(asset), queue, queue[0]!.id);
    assert.equal(closed.mode, "MONTHLY_HOLD");
    assert.ok(closed.decisions.every((decision) => decision.action_type === "WAIT"));
    const after = rankMonthlySlots(asset, "2026-10-01T04:00:00.000Z",
      physical.map((slot) => ({ ...slot, monthlyGainCount: 0 })));
    assert.equal(after.filter((slot) => slot.eligibleForNewEntry).length, 25);
    assert.deepEqual(after.map((slot) => slot.lifetimeGainCount), physical.map((slot) => slot.lifetimeGainCount));
    assert.deepEqual(after.map((slot) => slot.physicalSlotId), physical.map((slot) => slot.physicalSlotId));
    const resumed = queue.map((slot, i) => ({ ...slot, monthlyTargetReached: false,
      operationalRank: after[i]!.operationalRank }));
    assert.equal(planStrategyClosedSlot(ctx(asset), resumed, resumed[0]!.id).mode, "GLOBAL_RESET");
    assert.deepEqual(physical, before);
  }
});

test("audit 5: POST ATH never hides a resident reserve partial or a duplicate resident BUY", () => {
  const rows = candidates().slice(0, 2);
  rows[0] = { ...rows[0]!, postAthGroup: "PRIMARY", buyPrice: 95 };
  rows[1] = { ...rows[1]!, postAthGroup: "RESERVE", buyPrice: 98, state: "PARTIALLY_FILLED" };
  const plan = planStrategyPostAthNextEntry(ctx(), rows, 100);
  assert.equal(plan.decision.reason, "RESIDENT_BUY_PARTIAL_FILL_PROTECTED");
  assert.equal(plan.nextCandidateId, rows[1]!.id);
  rows[0]!.state = "ARMED";
  assert.throws(() => planStrategyPostAthNextEntry(ctx(), rows, 100), /MULTIPLE_ARMED_BUYS/);
});

test("audit 5: missing primary gain evidence cannot block a valid reserve entry", () => {
  const rows = candidates().slice(0, 2);
  rows[0] = { ...rows[0]!, postAthGroup: "PRIMARY", buyPrice: 95, operationalRank: null };
  rows[1] = { ...rows[1]!, postAthGroup: "RESERVE", buyPrice: 90 };
  assert.equal(planStrategyPostAthNextEntry(ctx(), rows, 100).nextCandidateId, rows[1]!.id);
});

test("audit 5: NORMAL ladder uses the same equal-gain physical-number order as monthly ranking", () => {
  const rows = ladder();
  const ranked = rankMonthlySlots("BTC", instant, rows.map((slot) => ({ ...slot, balanceUsdc: 10 })));
  const plan = planAthLadder("BTC", "NORMAL", 100, parameters, .01, rows);
  assert.deepEqual(plan.map((slot) => slot.operationalRank), ranked.map((slot) => slot.operationalRank));
  assert.equal(plan[1]!.nextBuyPrice, 99);
});

test("audit 5: NORMAL ladder fails closed on duplicate physical identity and invalid gain evidence", () => {
  const rows = ladder();
  rows[0]!.entryState = "OPEN"; rows[0]!.status = "TP_ACTIVE";
  rows[1]!.entryState = "OPEN"; rows[1]!.status = "TP_ACTIVE";
  rows[1]!.physicalSlotId = rows[0]!.physicalSlotId;
  assert.throws(() => planAthLadder("BTC", "NORMAL", 100, parameters, .01, rows), /SLOT_EVIDENCE_INVALID/);
  const invalid = ladder(); invalid[0]!.monthlyGainCount = 1;
  assert.throws(() => planAthLadder("BTC", "NORMAL", 100, parameters, .01, invalid), /SLOT_EVIDENCE_INVALID/);
});

test("audit 5: a late pre-floor ATH cannot rewind a newer floor transition", () => {
  const initial: AthState = { regime: "POST_ATH", athPrice: 100, previousAth: 90,
    athObservedAt: "2026-09-01T00:00:00Z", athSource: "BINANCE", floorReference: 80,
    floorSource: "USER", floorDefinedAt: "2026-08-01T00:00:00Z", transitionKey: "initial" };
  const floor = advanceAthState(initial, { price: 80, observedAt: "2026-09-03T00:00:00Z", source: "BINANCE", fresh: true });
  assert.equal(floor.state.regime, "NORMAL");
  const late = advanceAthState(floor.state, { price: 105, observedAt: "2026-09-02T00:00:00Z", source: "BINANCE", fresh: true });
  assert.deepEqual(late, { state: floor.state, events: [] });
});

test("audit 5: local timezone boundaries are exact for leap years and duplicate rollover", () => {
  for (const year of [2024, 2026, 2028]) for (let month = 0; month < 12; month++) {
    const boundary = new Date(Date.UTC(year, month + 1, 1, 4));
    const before = new Date(boundary.getTime() - 1);
    assert.equal(nextMonthlyResetAt(before), boundary.toISOString());
    assert.notEqual(monthlyPeriodKey(before), monthlyPeriodKey(boundary));
    assert.equal(monthlyPeriodKey(boundary), monthlyPeriodKey(new Date(boundary)));
  }
});

test("audit 5: simulator cycle reset cannot reuse an initial decision identity", () => {
  const result = simulateAth({ asset: "BTC", initialPrice: 100, previousAth: 1000, floorReference: null,
    parameters, lifetimeGains: Array(25).fill(0), monthlyGains: Array(25).fill(0), prices: [100, 101, 100, 101] });
  const initial = result.steps.filter((step) => step.event === "INITIAL_MARKET_FILLED");
  assert.ok(initial.length >= 2);
  assert.equal(new Set(initial.map((step) => step.decisionId)).size, initial.length);
  assert.equal(new Set(initial.map((step) => step.operationId)).size, initial.length);
});

test("audit 5: simulator does not start a new cycle after all 25 monthly targets", () => {
  for (const asset of ["BTC", "SOL"] as const) {
    const target = MONTHLY_SLOT_TARGET[asset];
    const monthly = Array(25).fill(target); monthly[0] = target - 1;
    const result = simulateAth({ asset, initialPrice: 100, previousAth: 1000, floorReference: null,
      parameters, lifetimeGains: Array(25).fill(100), monthlyGains: monthly, prices: [100, 101, 102] });
    assert.equal(result.cycleNumber, 1);
    assert.equal(result.steps.filter((step) => step.event === "GLOBAL_RESET").length, 0);
    assert.equal(result.slots.filter((slot) => slot.entryState === "OPEN" || slot.entryState === "ARMED").length, 0);
  }
});

test("audit 5: simulator materializes exchange-tick prices and never fills above a floored BUY", () => {
  const result = simulateAth({ asset: "BTC", initialPrice: 105, previousAth: 100, floorReference: null,
    parameters, lifetimeGains: Array.from({ length: 25 }, (_, i) => i + 1), monthlyGains: Array(25).fill(0),
    prices: [105, 102.9, 100.842] });
  assert.deepEqual(result.steps.filter((step) => ["INITIAL_MARKET_FILLED", "BUY_FILLED"].includes(step.event))
    .map((step) => step.slot), [11, 12]);
  assert.ok(result.steps.some((step) => step.event === "NEXT_BUY_ARMED" && step.slot === 13 && step.targetPrice === 100.84));
});

test("audit 5: late complete ATH history updates the high without rewinding a newer floor", () => {
  const restored: AthState = { regime: "NORMAL", athPrice: 100, previousAth: 90,
    athObservedAt: "2026-09-01T00:00:00Z", athSource: "BINANCE", floorReference: 80,
    floorSource: "USER", floorDefinedAt: "2026-08-01T00:00:00Z", transitionKey: "FLOOR",
    lastTransitionAt: "2026-09-03T00:00:00Z" };
  const historical = { asset: "BTC" as const, symbol: "BTCUSDC" as const, price: 105,
    observedAt: "2026-09-02T23:59:59Z", source: "BINANCE_SPOT_BTCUSDC_CONFIRMED_1D_FULL_HISTORY",
    verifiedAt: "2026-09-03T01:00:00Z", fresh: true, candleCount: 2000 };
  const result = reconcileHistoricalAth(restored, historical);
  assert.equal(result.state.athPrice, 105);
  assert.equal(result.state.regime, "NORMAL");
  assert.equal(result.state.lastTransitionAt, restored.lastTransitionAt);
  assert.equal(result.state.transitionKey, restored.transitionKey);
  assert.deepEqual(result.events, []);
  assert.deepEqual(reconcileHistoricalAth(result.state, historical), { state: result.state, events: [] });
});

test("audit 5: rollover reactivates monthly eligibility while OPEN and reentry prices stay frozen", () => {
  for (const asset of ["BTC", "SOL"] as const) for (const regime of ["NORMAL", "POST_ATH"] as const) {
    const target = MONTHLY_SLOT_TARGET[asset];
    const rows = ladder().map((slot) => ({ ...slot, lifetimeGainCount: 100 + slot.physicalSlotNumber,
      monthlyGainCount: target }));
    rows[0] = { ...rows[0]!, status: "TP_ACTIVE", entryState: "OPEN" };
    rows[1] = { ...rows[1]!, entryOrigin: "REENTRY", operationSequence: 3 };
    const openBefore = structuredClone(rows[0]);
    const before = planAthLadder(asset, regime, 150, parameters, .01, rows);
    const newMonth = rows.map((slot) => ({ ...slot, monthlyGainCount: 0 }));
    const after = planAthLadder(asset, regime, 150, parameters, .01, newMonth);
    assert.equal(before[0]!.nextBuyPrice, openBefore!.buyPrice);
    assert.equal(after[0]!.nextBuyPrice, openBefore!.buyPrice);
    assert.equal(after[1]!.nextBuyPrice, rows[1]!.buyPrice);
    assert.equal(after.filter((slot) => slot.operationalRank !== null).length, 24);
    assert.deepEqual(newMonth.map((slot) => slot.physicalSlotId), rows.map((slot) => slot.physicalSlotId));
    assert.deepEqual(newMonth.map((slot) => slot.lifetimeGainCount), rows.map((slot) => slot.lifetimeGainCount));
    assert.deepEqual(planAthLadder(asset, regime, 150, parameters, .01, newMonth), after);
    assert.deepEqual(rows[0], openBefore);
  }
});

test("audit 5: six supplied environment/asset snapshots use exact custom percentages without shared mutation", () => {
  const profiles = ["SHADOW", "TESTNET", "REAL"].flatMap((environment) => (["BTC", "SOL"] as const).map((asset) => ({
    environment, asset, parameters: environment === "REAL" ? asset === "BTC"
      ? { gainRate: .012, normalSpacing: .01, postAthSpacing: .05 }
      : { gainRate: .055, normalSpacing: .015, postAthSpacing: .08 }
      : { gainRate: .005, normalSpacing: .01, postAthSpacing: .02 } })));
  const frozen = structuredClone(profiles);
  for (const profile of profiles) {
    const initial = ladder();
    const plan = planAthLadder(profile.asset, "NORMAL", 100, profile.parameters, .01, initial);
    assert.equal(plan[1]!.nextBuyPrice, 100 * (1 - profile.parameters.normalSpacing));
    assert.equal(calculateStrategyTakeProfit(100, .01, { gainRate: profile.parameters.gainRate,
      entrySpacing: profile.parameters.normalSpacing }), Number((100 * (1 + profile.parameters.gainRate)).toFixed(2)));
  }
  assert.deepEqual(profiles, frozen);
  profiles[0]!.parameters = { gainRate: .031, normalSpacing: .017, postAthSpacing: .043 };
  assert.deepEqual(profiles.slice(1), frozen.slice(1));
  const modified = planAthLadder("BTC", "NORMAL", 100, profiles[0]!.parameters, .01, ladder());
  assert.equal(modified[1]!.nextBuyPrice, 98.3);
});
