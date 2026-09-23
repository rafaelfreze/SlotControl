import assert from "node:assert/strict";
import test from "node:test";

import { advanceAthState, buildPostAthQueue, OFFICIAL_ATH_DEFAULTS, orderedPostAthSlots, reconcileHistoricalAth,
  parseAthPercent, type AthState } from "../execution/ath-regime.ts";
import { simulateAth } from "../execution/ath-simulator.ts";
import { planAthLadder } from "../execution/ath-ladder.ts";
import { planStrategyPostAthNextEntry } from "../execution/strategy-engine.ts";

const slots = (monthly: (number | null)[] = Array(25).fill(0)) => Array.from({ length: 25 }, (_, index) => ({
  physicalSlotId: `slot-${index + 1}`, physicalSlotNumber: index + 1, lifetimeGainCount: index + 1,
  monthlyGainCount: monthly[index] as number | null, entryState: "PLANNED",
}));
const state: AthState = { regime: "NORMAL", athPrice: 100, previousAth: null, athObservedAt: "2026-01-01T00:00:00Z",
  athSource: "BINANCE_ALL_TIME", floorReference: null, floorSource: null, floorDefinedAt: null, transitionKey: null };

test("official defaults are data, while comma/dot custom values are accepted and bounded", () => {
  assert.deepEqual(OFFICIAL_ATH_DEFAULTS.BTC, { gainRate: .012, normalSpacing: .02, postAthSpacing: .05 });
  assert.deepEqual(OFFICIAL_ATH_DEFAULTS.SOL, { gainRate: .055, normalSpacing: .03, postAthSpacing: .08 });
  assert.equal(parseAthPercent("0,5"), .005);
  assert.equal(parseAthPercent("5.5"), .055);
  assert.throws(() => parseAthPercent("0"));
  assert.throws(() => parseAthPercent("21"));
});

test("25 gains 1..25 select 11..25, execute 11..25, then reserve 10..1", () => {
  const queue = buildPostAthQueue("BTC", slots());
  assert.deepEqual(orderedPostAthSlots(queue).map((slot) => slot.physicalSlotNumber), [
    11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
    10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
  ]);
  assert.equal(queue[10]?.postAthGroup, "PRIMARY");
  assert.equal(queue[9]?.postAthGroupRank, 1);
  assert.equal(queue[0]?.physicalSlotId, "slot-1");
});

test("monthly target, missing evidence and OPEN positions are excluded before top 15", () => {
  const input = slots(); input[24]!.monthlyGainCount = 2; input[23]!.entryState = "OPEN";
  input[22]!.monthlyGainCount = null;
  const queue = buildPostAthQueue("SOL", input);
  assert.equal(queue[24]?.postAthGroup, null);
  assert.equal(queue[23]?.postAthGroup, null);
  assert.equal(queue[22]?.postAthGroup, null);
  assert.equal(queue[21]?.postAthGroup, "PRIMARY");
  assert.equal(queue.filter((slot) => slot.postAthGroup === "PRIMARY").length, 15);
  assert.equal(queue.filter((slot) => slot.postAthGroup === "RESERVE").length, 7);
  assert.equal(queue.filter((slot) => slot.eligible).length, 22);
});

test("fewer than 15 eligible never backfill a reached target", () => {
  const input = slots(Array.from({ length: 25 }, (_, index) => index < 12 ? 0 : 2));
  const queue = buildPostAthQueue("SOL", input);
  assert.equal(queue.filter((slot) => slot.postAthGroup === "PRIMARY").length, 12);
  assert.equal(queue.filter((slot) => slot.postAthGroup === "RESERVE").length, 0);
});

test("state machine requires fresh new high and an explicitly sourced floor", () => {
  assert.deepEqual(advanceAthState(state, { price: 105, observedAt: "2026-01-02T00:00:00Z", source: "BINANCE", fresh: false }), { state, events: [] });
  const entered = advanceAthState(state, { price: 105, observedAt: "2026-01-02T00:00:00Z", source: "BINANCE", fresh: true });
  assert.deepEqual(entered.events, ["NEW_ATH_CONFIRMED", "POST_ATH_REGIME_ENTERED"]);
  assert.equal(entered.state.athPrice, 105);
  assert.deepEqual(advanceAthState(entered.state, { price: 80, observedAt: "2026-01-03T00:00:00Z", source: "BINANCE", fresh: true }).events, []);
  const withFloor = { ...entered.state, floorReference: 80, floorSource: "USER", floorDefinedAt: "2026-01-02T00:00:00Z" };
  assert.deepEqual(advanceAthState(withFloor, { price: 80, observedAt: "2026-01-03T00:00:00Z", source: "BINANCE", fresh: true }).events,
    ["ATH_FLOOR_REACHED", "NORMAL_REGIME_RESTORED"]);
  const again = advanceAthState(entered.state, { price: 106, observedAt: "2026-01-03T00:00:00Z", source: "BINANCE", fresh: true });
  assert.deepEqual(again.events, ["NEW_ATH_CONFIRMED"]);
  assert.equal(again.state.regime, "POST_ATH");
});

test("confirmed complete history bootstraps silently and later high enters POST once", () => {
  const empty: AthState = { ...state, athPrice: null, athObservedAt: null, athSource: null };
  const evidence = { asset: "BTC" as const, symbol: "BTCUSDC" as const, price: 100,
    observedAt: "2026-01-01T23:59:59Z", source: "BINANCE_SPOT_BTCUSDC_CONFIRMED_1D_FULL_HISTORY",
    verifiedAt: "2026-01-02T00:00:00Z", fresh: true, candleCount: 2000 };
  const baseline = reconcileHistoricalAth(empty, evidence);
  assert.deepEqual(baseline.events, []);
  assert.equal(baseline.state.athPrice, 100);
  const next = reconcileHistoricalAth(baseline.state, { ...evidence, price: 105, observedAt: "2026-01-02T23:59:59Z" });
  assert.deepEqual(next.events, ["NEW_ATH_CONFIRMED", "POST_ATH_REGIME_ENTERED"]);
  assert.deepEqual(reconcileHistoricalAth(next.state, { ...evidence, price: 105, observedAt: "2026-01-02T23:59:59Z" }).events, []);
  assert.deepEqual(reconcileHistoricalAth(empty, { ...evidence, fresh: false }).events, []);
});

test("deterministic isolated replay uses config and never alters input", () => {
  const input = { asset: "BTC" as const, initialPrice: 105, previousAth: 100, floorReference: null,
    parameters: { gainRate: .005, normalSpacing: .01, postAthSpacing: .02 },
    lifetimeGains: Array.from({ length: 25 }, (_, index) => index + 1), monthlyGains: Array(25).fill(0),
    prices: [105, 102.9, 100.84] };
  const before = structuredClone(input);
  const first = simulateAth(input);
  assert.deepEqual(first, simulateAth(input));
  assert.deepEqual(input, before);
  assert.match(first.simulationId, /^SIM-/);
  assert.deepEqual(first.primary, Array.from({ length: 15 }, (_, index) => index + 11));
  assert.deepEqual(first.reserve, Array.from({ length: 10 }, (_, index) => 10 - index));
  assert.deepEqual(first.steps.filter((step) => step.event === "INITIAL_MARKET_FILLED" || step.event === "BUY_FILLED").map((step) => step.slot), [11, 12, 13]);
  assert.equal(first.steps.filter((step) => step.event === "NEXT_BUY_ARMED").length, 3);
  assert.equal(first.missedLevels, 0);
});

test("scenario A/D consumes 15 primary before 10 reserve with one armed BUY", () => {
  const result = simulateAth({ asset: "BTC", initialPrice: 105, previousAth: 100, floorReference: null,
    parameters: OFFICIAL_ATH_DEFAULTS.BTC, lifetimeGains: Array.from({ length: 25 }, (_, index) => index + 1),
    monthlyGains: Array(25).fill(0), prices: [105, ...Array.from({ length: 24 }, (_, index) =>
      Math.floor(105 * .95 ** (index + 1) * 100 + 1e-8) / 100)] });
  const buys = result.steps.filter((step) => ["INITIAL_MARKET_FILLED", "BUY_FILLED"].includes(step.event));
  assert.deepEqual(buys.map((step) => step.slot), [...Array.from({ length: 15 }, (_, index) => index + 11),
    ...Array.from({ length: 10 }, (_, index) => 10 - index)]);
  assert.equal(result.slots.filter((slot) => slot.entryState === "OPEN").length, 25);
  assert.equal(result.missedLevels, 0);
  assert.equal(result.steps.filter((step) => step.event === "POST_ATH_PRIMARY_EXHAUSTED").length, 1);
  assert.equal(result.steps.filter((step) => step.event === "POST_ATH_RESERVE_ACTIVATED").length, 1);
  assert.ok(result.steps.every((step) => step.nextBuy === null || Number.isInteger(step.nextBuy)));
});

test("scenario B excludes monthly-met slots before selecting the 15 highest eligible", () => {
  const monthly = Array(25).fill(0); monthly[24] = 2; monthly[23] = 2;
  const result = simulateAth({ asset: "SOL", initialPrice: 105, previousAth: 100, floorReference: null,
    parameters: OFFICIAL_ATH_DEFAULTS.SOL, lifetimeGains: Array.from({ length: 25 }, (_, index) => index + 1),
    monthlyGains: monthly, prices: [105] });
  assert.deepEqual(result.primary, Array.from({ length: 15 }, (_, index) => index + 9));
  assert.deepEqual(result.reserve, Array.from({ length: 8 }, (_, index) => 8 - index));
  assert.equal(result.slots[24]?.postAthGroup, null);
  assert.equal(result.slots[23]?.postAthGroup, null);
});

test("scenario G honors the custom .5/1/2 profile without an official-default override", () => {
  const result = simulateAth({ asset: "BTC", initialPrice: 105, previousAth: 100, floorReference: null,
    parameters: { gainRate: .005, normalSpacing: .01, postAthSpacing: .02 },
    lifetimeGains: Array.from({ length: 25 }, (_, index) => index + 1),
    monthlyGains: Array(25).fill(0), prices: [105, 102.899999] });
  assert.deepEqual(result.configSnapshot, { gainRate: .005, normalSpacing: .01, postAthSpacing: .02 });
  assert.deepEqual(result.steps.filter((step) => ["INITIAL_MARKET_FILLED", "BUY_FILLED"].includes(step.event))
    .map((step) => step.slot), [11, 12]);
  assert.equal(result.missedLevels, 0);
  assert.ok(result.steps.some((step) => step.event === "ATH_SIMULATION_COMPLETED"));
});

test("top-15 selection is deterministic across gain ties and preserves physical identity", () => {
  for (let seed = 0; seed < 32; seed++) {
    const input = slots(Array(25).fill(0)).map((slot, index) => ({ ...slot,
      physicalSlotId: `physical-${String(25 - index).padStart(2, "0")}`,
      lifetimeGainCount: (seed * 7 + index * 11) % 29 }));
    const before = structuredClone(input);
    const first = buildPostAthQueue("BTC", input);
    assert.deepEqual(first, buildPostAthQueue("BTC", input));
    assert.deepEqual(input, before);
    assert.deepEqual(new Set(first.map((slot) => slot.physicalSlotId)), new Set(input.map((slot) => slot.physicalSlotId)));
    assert.equal(first.filter((slot) => slot.postAthGroup === "PRIMARY").length, 15);
    assert.equal(first.filter((slot) => slot.postAthGroup === "RESERVE").length, 10);
    assert.deepEqual(orderedPostAthSlots(first).map((slot) => slot.operationalRank), Array.from({ length: 25 }, (_, index) => index + 1));
  }
});

test("active ladder transition freezes OPEN/TP and local reentry, repricing only future grid levels", () => {
  const input = slots().map((slot, index) => ({ ...slot, buyPrice: 100 - index,
    entryOrigin: index === 9 ? "REENTRY" as const : "GRID" as const, operationSequence: index === 9 ? 2 : 1,
    status: index === 0 ? "TP_ACTIVE" : "PENDING", entryState: index === 0 ? "OPEN" : "PLANNED" }));
  const before = structuredClone(input);
  const plan = planAthLadder("BTC", "POST_ATH", 105, OFFICIAL_ATH_DEFAULTS.BTC, .01, input);
  assert.equal(plan.length, 25);
  assert.equal(plan[0]?.frozenReason, "OPEN_OR_TP");
  assert.equal(plan[0]?.nextBuyPrice, 100);
  assert.equal(plan[9]?.frozenReason, "LOCAL_REENTRY");
  assert.equal(plan[9]?.nextBuyPrice, 91);
  assert.equal(plan[10]?.postAthGroup, "PRIMARY");
  assert.equal(plan[10]?.operationalRank, 1);
  assert.equal(plan[10]?.nextBuyPrice, 99.75);
  assert.deepEqual(input, before);
});

test("shared Strategy Engine keeps higher-price reserve reentry ahead of primary grid", () => {
  const context = { asset: "BTC" as const, cycleId: "SIM-price-priority", observedAt: "2026-01-01T00:00:00Z" };
  const candidates = [
    { id: "primary", slotNumber: 11, operationSequence: 1, buyPrice: 95, balanceUsdc: 10,
      operationalRank: 1, postAthGroup: "PRIMARY" as const, entryOrigin: "GRID" as const, state: "PLANNED" as const },
    { id: "reserve", slotNumber: 10, operationSequence: 2, buyPrice: 98, balanceUsdc: 10.1,
      operationalRank: 16, postAthGroup: "RESERVE" as const, entryOrigin: "REENTRY" as const, state: "PLANNED" as const },
    { id: "held", slotNumber: 9, operationSequence: 1, buyPrice: 99, balanceUsdc: 10,
      operationalRank: 17, postAthGroup: "RESERVE" as const, entryOrigin: "GRID" as const, state: "PLANNED" as const },
  ];
  const plan = planStrategyPostAthNextEntry(context, candidates, 100);
  assert.equal(plan.nextCandidateId, "reserve");
  assert.equal(plan.decision.action_type, "ARM_NEXT_BUY");
  assert.equal(plan.missedCandidateIds.length, 0);
});

test("Shadow and Testnet post-ATH adapters produce the same physical queue and decision", () => {
  const physical = slots(Array.from({ length: 25 }, (_, index) => index + 1));
  const shadow = buildPostAthQueue("BTC", physical);
  const testnet = buildPostAthQueue("BTC", structuredClone(physical));
  assert.deepEqual(shadow, testnet);
  const context = { asset: "BTC" as const, cycleId: "SIM-parity", observedAt: "2026-01-01T00:00:00Z" };
  const map = (rows: typeof shadow) => rows.map((slot) => ({ id: slot.physicalSlotId,
    slotNumber: slot.physicalSlotNumber, operationSequence: 1,
    buyPrice: 105 * .95 ** slot.operationalRank!, balanceUsdc: 10,
    operationalRank: slot.operationalRank, postAthGroup: slot.postAthGroup,
    entryOrigin: "GRID" as const, state: "PLANNED" as const }));
  assert.deepEqual(planStrategyPostAthNextEntry(context, map(shadow), 105),
    planStrategyPostAthNextEntry(context, map(testnet), 105));
});

test("scenario C: local reentry outranks deeper grid without a missed level", () => {
  const result = simulateAth({ asset: "BTC", initialPrice: 101, previousAth: 100, floorReference: null,
    parameters: OFFICIAL_ATH_DEFAULTS.BTC, lifetimeGains: Array.from({ length: 25 }, (_, index) => index + 1),
    monthlyGains: Array(25).fill(0), prices: [101, 95.949999, 98, 95.949999] });
  assert.deepEqual(result.steps.filter((step) => step.event === "BUY_FILLED" || step.event === "INITIAL_MARKET_FILLED")
    .map((step) => step.slot), [11, 12, 12]);
  assert.ok(result.steps.some((step) => step.event === "TP_FILLED_COMPOUNDED" && step.slot === 12));
  assert.equal(result.missedLevels, 0);
  assert.ok(result.slots[11]!.balanceUsdc > 10);
});

test("scenario E/F: sourced floor restores normal; new ATH within POST keeps regime and gains", () => {
  const common = { asset: "BTC" as const, initialPrice: 101, previousAth: 100,
    parameters: OFFICIAL_ATH_DEFAULTS.BTC, lifetimeGains: Array.from({ length: 25 }, (_, index) => index + 1),
    monthlyGains: Array(25).fill(0) };
  const floor = simulateAth({ ...common, floorReference: 80, prices: [101, 95.949999, 80] });
  assert.equal(floor.state.regime, "NORMAL");
  assert.ok(floor.steps.some((step) => step.event === "ATH_FLOOR_REACHED"));
  assert.ok(floor.steps.some((step) => step.event === "NORMAL_REGIME_RESTORED"));
  const newAth = simulateAth({ ...common, floorReference: null,
    parameters: { ...common.parameters, gainRate: .055 }, prices: [101, 105] });
  assert.equal(newAth.state.regime, "POST_ATH");
  assert.equal(newAth.state.athPrice, 105);
  assert.equal(newAth.steps.filter((step) => step.event === "POST_ATH_REGIME_ENTERED").length, 1);
  assert.equal(newAth.steps.filter((step) => step.event === "NEW_ATH_CONFIRMED").length, 2);
  assert.equal(newAth.cycleNumber, 1);
});
