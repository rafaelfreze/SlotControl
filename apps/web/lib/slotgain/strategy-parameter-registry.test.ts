import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { monthlyGoalsComplete, rankMonthlySlots } from "../execution/monthly-slot-policy.ts";
import { parseStrategyParameterValue, strategyParameterAffectsCurrentLadder, STRATEGY_PARAMETER_REGISTRY,
  STRATEGY_PARAMETERS } from "../execution/strategy-parameter-registry.ts";

const root = join(import.meta.dirname, "../../../..");
const migration = readFileSync(join(root,
  "supabase/migrations/20260929214159_generalize_coinops_bulk_strategy_editor.sql"), "utf8");

function slots(count: number) {
  return Array.from({ length: 25 }, (_, index) => ({ physicalSlotNumber: index + 1,
    physicalSlotId: `slot-${index + 1}`, lifetimeGainCount: count,
    monthlyGainCount: count, balanceUsdc: 10, entryState: "PLANNED" }));
}

test("registry exposes only the four official strategy parameters and their policies", () => {
  assert.deepEqual(STRATEGY_PARAMETERS.map((item) => item.key), [
    "gain_rate", "normal_spacing_rate", "post_ath_spacing_rate", "monthly_target",
  ]);
  assert.equal(STRATEGY_PARAMETER_REGISTRY.gain_rate.applyPolicy, "NEXT_CYCLE_ONLY");
  assert.equal(STRATEGY_PARAMETER_REGISTRY.normal_spacing_rate.applyPolicy, "NEXT_BUY_RECONCILE");
  assert.equal(STRATEGY_PARAMETER_REGISTRY.post_ath_spacing_rate.requiresOrderReconciliation, true);
  assert.equal(STRATEGY_PARAMETER_REGISTRY.monthly_target.applyPolicy, "FUTURE_ENTRIES_ONLY");
  assert.equal(strategyParameterAffectsCurrentLadder(STRATEGY_PARAMETER_REGISTRY.normal_spacing_rate, "NORMAL"), true);
  assert.equal(strategyParameterAffectsCurrentLadder(STRATEGY_PARAMETER_REGISTRY.normal_spacing_rate, "POST_ATH"), false);
  assert.equal(strategyParameterAffectsCurrentLadder(STRATEGY_PARAMETER_REGISTRY.post_ath_spacing_rate, "POST_ATH"), true);
  assert.equal(strategyParameterAffectsCurrentLadder(STRATEGY_PARAMETER_REGISTRY.gain_rate, "NORMAL"), false);
});

test("parameter validation uses display percentages and exact monthly integers", () => {
  assert.equal(parseStrategyParameterValue(STRATEGY_PARAMETER_REGISTRY.gain_rate, "5,5"), .055);
  assert.equal(parseStrategyParameterValue(STRATEGY_PARAMETER_REGISTRY.normal_spacing_rate, "2.5"), .025);
  assert.equal(parseStrategyParameterValue(STRATEGY_PARAMETER_REGISTRY.monthly_target, "3"), 3);
  assert.throws(() => parseStrategyParameterValue(STRATEGY_PARAMETER_REGISTRY.gain_rate, "-1"), /VALUE_INVALID/);
  assert.throws(() => parseStrategyParameterValue(STRATEGY_PARAMETER_REGISTRY.normal_spacing_rate, "0"), /VALUE_INVALID/);
  assert.throws(() => parseStrategyParameterValue(STRATEGY_PARAMETER_REGISTRY.monthly_target, "2.5"), /VALUE_INVALID/);
});

test("custom monthly target remains a floor and 25 of 25 stays operational", () => {
  const almost = slots(3); almost[24]!.monthlyGainCount = 2;
  const ranked = rankMonthlySlots("SOL", "2026-09-29T12:00:00-04:00", almost, 3);
  assert.equal(ranked.filter((item) => item.eligibleForNewEntry).length, 1);
  const complete = rankMonthlySlots("SOL", "2026-09-29T12:00:00-04:00", slots(3), 3);
  assert.equal(monthlyGoalsComplete("SOL", complete, 3), true);
  assert.equal(complete.every((item) => item.eligibleForNewEntry), true);
  assert.equal(complete.every((item) => item.monthlyGainTarget === 3), true);
});

test("generic migration keeps engine locks, idempotency and per-parameter audit", () => {
  for (const key of Object.keys(STRATEGY_PARAMETER_REGISTRY)) assert.match(migration, new RegExp(`'${key}'`));
  assert.match(migration, /enqueue_strategy_bulk_update/);
  assert.match(migration, /strategy_config_pending = true/);
  assert.match(migration, /operator_id = p_operator_id and idempotency_key = p_idempotency_key/);
  assert.match(migration, /parameter_key,apply_policy/);
  assert.match(migration, /NEXT_CYCLE_ONLY/);
  assert.match(migration, /NEXT_BUY_RECONCILE/);
  assert.match(migration, /FUTURE_ENTRIES_ONLY/);
});
