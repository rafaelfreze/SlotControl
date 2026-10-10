import assert from "node:assert/strict";
import test from "node:test";

import { planAthLadder, type AthLadderSlot } from "../execution/ath-ladder.ts";
import { athLadderLevelPrice } from "../execution/ath-ladder-price.ts";
import type { AthRegime } from "../execution/ath-regime.ts";
import { NEW_ENGINE_STRATEGY_DEFAULTS } from "../execution/strategy-defaults.ts";
import { strategyRatesForOrder } from "../execution/live-strategy-snapshot.ts";
import { rankMonthlySlots } from "../execution/monthly-slot-policy.ts";
import { planStrategyNextEntry, planStrategyPostAthNextEntry,
  type StrategyCandidate, type StrategyContext } from "../execution/strategy-engine.ts";
import { STRATEGY_PARAMETER_REGISTRY, strategyParameterAffectsCurrentLadder } from "../execution/strategy-parameter-registry.ts";
import { assertStrategyTakeProfitPrice } from "../execution/strategy-price-invariant.ts";

const markets = [
  { asset: "BTC" as const, quote: "BRL", anchor: 450_000, tick: .01, spacing: .02 },
  { asset: "BTC" as const, quote: "USDT", anchor: 85_000, tick: .01, spacing: .02 },
  { asset: "SOL" as const, quote: "BRL", anchor: 640, tick: .01, spacing: .03 },
  { asset: "SOL" as const, quote: "USDT", anchor: 120, tick: .01, spacing: .03 },
];
const regimes: AthRegime[] = ["NORMAL", "POST_ATH"];
const physicalSlots = (namespace: string, anchor: number): AthLadderSlot[] =>
  Array.from({ length: 25 }, (_, index) => ({
    physicalSlotId: `${namespace}:slot-${index + 1}`, physicalSlotNumber: index + 1,
    lifetimeGainCount: index + 1, monthlyGainCount: 0, entryState: "PLANNED",
    buyPrice: anchor * .9, entryOrigin: "GRID", operationSequence: 1, status: "PENDING",
  }));

test("new BTC and SOL profiles have equal spacing across ATH without changing gain defaults", () => {
  assert.deepEqual(NEW_ENGINE_STRATEGY_DEFAULTS.BTC, { gainRate: .012, normalSpacing: .02, postAthSpacing: .02 });
  assert.deepEqual(NEW_ENGINE_STRATEGY_DEFAULTS.SOL, { gainRate: .055, normalSpacing: .03, postAthSpacing: .03 });
});

for (const market of markets) {
  const symbol = `${market.asset}${market.quote}`;
  for (const regime of regimes) {
    test(`${symbol} ${regime}: canonical geometric spacing and physical 25 slots survive equal-rate policy`, () => {
      const slots = physicalSlots(`engine-a:${symbol}`, market.anchor);
      const before = structuredClone(slots);
      const parameters = { ...NEW_ENGINE_STRATEGY_DEFAULTS[market.asset], gainRate: .0175 };
      const plan = planAthLadder(market.asset, regime, market.anchor, parameters, market.tick, slots, 9);
      const ranked = [...plan].sort((left, right) => left.operationalRank! - right.operationalRank!);
      assert.equal(plan.length, 25);
      assert.deepEqual(plan.map((row) => row.physicalSlotId), slots.map((row) => row.physicalSlotId));
      assert.deepEqual(plan.map((row) => row.physicalSlotNumber), slots.map((row) => row.physicalSlotNumber));
      assert.deepEqual(ranked.map((row) => row.operationalRank), Array.from({ length: 25 }, (_, index) => index + 1));
      assert.deepEqual(ranked.map((row) => row.nextBuyPrice), Array.from({ length: 25 }, (_, level) =>
        athLadderLevelPrice(market.anchor, market.spacing, level, market.tick)));
      if (regime === "POST_ATH") {
        assert.deepEqual(ranked.slice(0, 15).map((row) => row.physicalSlotNumber),
          Array.from({ length: 15 }, (_, index) => index + 11));
        assert.deepEqual(ranked.slice(15).map((row) => row.physicalSlotNumber),
          Array.from({ length: 10 }, (_, index) => 10 - index));
        assert.equal(plan.filter((row) => row.postAthGroup === "PRIMARY").length, 15);
        assert.equal(plan.filter((row) => row.postAthGroup === "RESERVE").length, 10);
      }
      assert.deepEqual(slots, before);
      assert.equal(parameters.gainRate, .0175);
    });

    test(`${symbol} ${regime}: OPEN, partial fills, local reentry, gain and monthly target remain frozen`, () => {
      const monthlyTarget = market.asset === "BTC" ? 9 : 4;
      const slots = physicalSlots(`engine-a:${symbol}`, market.anchor);
      slots[0] = { ...slots[0]!, status: "TP_ACTIVE", entryState: "OPEN" };
      slots[1] = { ...slots[1]!, status: "PARTIALLY_FILLED", entryState: "PARTIALLY_FILLED" };
      slots[9] = { ...slots[9]!, entryOrigin: "REENTRY", operationSequence: 3 };
      slots[24]!.monthlyGainCount = monthlyTarget;
      const before = structuredClone(slots);
      const parameters = { gainRate: .0065, normalSpacing: market.spacing, postAthSpacing: market.spacing };
      const plan = planAthLadder(market.asset, regime, market.anchor, parameters, market.tick, slots, monthlyTarget);
      for (const index of [0, 1, 9, 24]) assert.equal(plan[index]!.nextBuyPrice, slots[index]!.buyPrice);
      assert.equal(plan[0]!.frozenReason, "OPEN_OR_TP");
      assert.equal(plan[1]!.frozenReason, "OPEN_OR_TP");
      assert.equal(plan[9]!.frozenReason, "LOCAL_REENTRY");
      assert.equal(plan[24]!.frozenReason, "MONTHLY_TARGET");
      const ranked = rankMonthlySlots(market.asset, "2026-10-10T01:00:00Z",
        slots.map((slot) => ({ ...slot, balanceUsdc: 10 })), monthlyTarget);
      assert.ok(ranked.every((slot) => slot.monthlyGainTarget === monthlyTarget));
      assert.deepEqual(slots, before);
      assert.equal(parameters.gainRate, .0065);
      const future = plan.filter((row) => row.frozenReason === null)
        .sort((left, right) => left.operationalRank! - right.operationalRank!);
      assert.equal(future[0]!.nextBuyPrice,
        athLadderLevelPrice(market.anchor, market.spacing, 1, market.tick));
    });

    test(`${symbol} ${regime}: canonical NEXT BUY replay is single-entry, scoped and partial-fill safe`, () => {
      const slots = physicalSlots(`engine-a:${symbol}`, market.anchor);
      slots[0] = { ...slots[0]!, status: "TP_ACTIVE", entryState: "OPEN" };
      const plan = planAthLadder(market.asset, regime, market.anchor,
        NEW_ENGINE_STRATEGY_DEFAULTS[market.asset], market.tick, slots);
      const candidates: StrategyCandidate[] = plan.filter((row) => row.frozenReason === null).map((row) => ({
        id: row.physicalSlotId, slotNumber: row.physicalSlotNumber,
        operationSequence: 1, buyPrice: row.nextBuyPrice, balanceQuote: 10,
        operationalRank: row.operationalRank, postAthGroup: row.postAthGroup,
        entryOrigin: "GRID", state: "PLANNED",
      }));
      const context: StrategyContext = { asset: market.asset, quoteAsset: market.quote,
        cycleId: `engine-a:${symbol}:run-1`, observedAt: "2026-10-10T01:00:00Z" };
      const choose = regime === "POST_ATH" ? planStrategyPostAthNextEntry : planStrategyNextEntry;
      const first = choose(context, candidates, market.anchor);
      assert.equal(first.decision.action_type, "ARM_NEXT_BUY");
      assert.equal(first.missedCandidateIds.length, 0);
      assert.ok(first.nextCandidateId);
      assert.equal(first.decision.decision_id, choose({ ...context,
        observedAt: "2026-10-10T01:01:00Z" }, [...candidates].reverse(), market.anchor).decision.decision_id);
      assert.notEqual(first.decision.operation_id, choose({ ...context,
        cycleId: `engine-b:${symbol}:run-1` }, candidates, market.anchor).decision.operation_id);
      const residentCandidates = candidates.map((slot): StrategyCandidate => ({ ...slot,
        state: slot.id === first.nextCandidateId ? "ARMED" : "PLANNED" }));
      const resident = { candidateId: first.nextCandidateId!, executedQuantity: 0 };
      assert.equal(choose(context, residentCandidates, market.anchor, resident).decision.action_type, "WAIT");
      assert.equal(choose(context, residentCandidates, market.anchor, { ...resident,
        executedQuantity: .001 }).decision.reason, "RESIDENT_BUY_PARTIAL_FILL_PROTECTED");
      residentCandidates.find((slot) => slot.id !== resident.candidateId)!.state = "ARMED";
      assert.throws(() => choose(context, residentCandidates, market.anchor, resident), /MULTIPLE_ARMED_BUYS/);
    });
  }

  test(`${symbol}: an old TP retains original order snapshot after spacing becomes uniform`, () => {
    const priorSpacing = market.asset === "BTC" ? .05 : .08;
    const run = { config_snapshot: { regime: "POST_ATH", post_ath_spacing_rate: market.spacing,
      gain_rate: .0175, ladder_anchor_price: 100 }, entry_spacing: market.spacing,
    gain_rate: .0175, anchor_price: 100 };
    const original = { config_snapshot: { regime: "POST_ATH", post_ath_spacing_rate: priorSpacing,
      gain_rate: .0065, ladder_anchor_price: 100 } };
    const before = structuredClone(original);
    const rates = strategyRatesForOrder(original, run);
    assert.deepEqual(rates, { gain: .0065, spacing: priorSpacing, anchor: 100 });
    assert.equal(assertStrategyTakeProfitPrice({ price: 100.65, averageFillPrice: 100,
      gainRate: rates.gain, spacing: rates.spacing, tick: .01 }), 100.65);
    assert.deepEqual(original, before);
  });
}

test("bulk spacing reconciliation remains limited to the parameter's active regime", () => {
  for (const regime of regimes) {
    assert.equal(strategyParameterAffectsCurrentLadder(STRATEGY_PARAMETER_REGISTRY.normal_spacing_rate, regime),
      regime === "NORMAL");
    assert.equal(strategyParameterAffectsCurrentLadder(STRATEGY_PARAMETER_REGISTRY.post_ath_spacing_rate, regime),
      regime === "POST_ATH");
    assert.equal(strategyParameterAffectsCurrentLadder(STRATEGY_PARAMETER_REGISTRY.gain_rate, regime), false);
    assert.equal(strategyParameterAffectsCurrentLadder(STRATEGY_PARAMETER_REGISTRY.monthly_target, regime), false);
  }
});
