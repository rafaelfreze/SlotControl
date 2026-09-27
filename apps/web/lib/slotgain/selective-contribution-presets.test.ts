import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { resolveSelectiveContributionPresetRegion,
  resolveSelectiveContributionPresetRegions } from "../execution/selective-contribution-presets.ts";

const preset14 = { id: "p14", name: "1 aberto + 4 abaixo", totalSlots: 5, openSlots: 1, followingSlots: 4 };
const preset23 = { id: "p23", name: "2 abertos + 3 abaixo", totalSlots: 5, openSlots: 2, followingSlots: 3 };
const slots = (open: number[], rankToSlot = Array.from({ length: 25 }, (_, index) => index + 1)) =>
  rankToSlot.map((slotNumber, index) => ({ slotNumber, operationalRank: index + 1,
    entryState: open.includes(slotNumber) ? "OPEN" : index === open.length ? "ARMED" : "PLANNED" }));

test("1 OPEN + 4 abaixo resolves the official strategy order", () => {
  const shuffledIdentity = [8, 3, 20, 1, 17, 6, 2, 24, 4, 5, 7, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 21, 22, 23, 25];
  const region = resolveSelectiveContributionPresetRegion(preset14, slots([8], shuffledIdentity), 8);
  assert.deepEqual(region.slotNumbers, [8, 3, 20, 1, 17]);
  assert.deepEqual(region.openAnchorSlotNumbers, [8]);
});

test("2 OPEN + 3 abaixo requires a consecutive OPEN anchor region", () => {
  assert.deepEqual(resolveSelectiveContributionPresetRegion(preset23, slots([7, 8]), 7).slotNumbers,
    [7, 8, 9, 10, 11]);
  assert.equal(resolveSelectiveContributionPresetRegions(preset23, slots([7, 9])).length, 0);
});

test("multiple OPEN regions remain explicit choices", () => {
  const regions = resolveSelectiveContributionPresetRegions(preset14, slots([3, 12]));
  assert.deepEqual(regions.map((region) => region.anchorSlotNumber), [3, 12]);
  assert.deepEqual(regions[1].slotNumbers, [12, 13, 14, 15, 16]);
});

test("grid end never wraps upward or invents slots", () => {
  assert.equal(resolveSelectiveContributionPresetRegions(preset14, slots([23])).length, 0);
  assert.throws(() => resolveSelectiveContributionPresetRegion(preset14, slots([23]), 23),
    /PRESET_REGION_UNAVAILABLE/);
});

test("custom preset is generic and exact over 25 slots", () => {
  const custom = { id: "custom", name: "3 + 2", totalSlots: 5, openSlots: 3, followingSlots: 2 };
  assert.deepEqual(resolveSelectiveContributionPresetRegion(custom, slots([1, 2, 3]), 1).slotNumbers,
    [1, 2, 3, 4, 5]);
  assert.throws(() => resolveSelectiveContributionPresetRegions(
    { ...custom, totalSlots: 6 }, slots([1, 2, 3])), /CONFIGURATION_INVALID/);
});

test("missing, duplicated or incomplete operational rank fails closed", () => {
  assert.throws(() => resolveSelectiveContributionPresetRegions(preset14,
    slots([1]).map((slot) => ({ ...slot, operationalRank: null }))), /STRATEGY_ORDER_UNAVAILABLE/);
  assert.throws(() => resolveSelectiveContributionPresetRegions(preset14,
    slots([1]).map((slot, index) => ({ ...slot, operationalRank: index === 24 ? 24 : slot.operationalRank }))),
  /STRATEGY_ORDER_UNAVAILABLE/);
});

test("preset layer stays selection-only and delegates to the official contribution route", () => {
  const route = readFileSync(resolve("app/api/coinops-live-adjustments/route.ts"), "utf8");
  const helper = readFileSync(resolve("lib/execution/selective-contribution-presets.ts"), "utf8");
  assert.match(route, /resolveSelectiveContributionPresetRegion/);
  assert.match(route, /apply_live_selective_contribution/);
  assert.doesNotMatch(helper, /fetch|Binance|MARKET|BUY|SELL|robot_v1_live_orders/);
});
