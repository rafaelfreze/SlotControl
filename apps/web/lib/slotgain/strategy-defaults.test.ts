import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { newEngineStrategyPercentDefaults, NEW_ENGINE_STRATEGY_DEFAULTS } from "../execution/strategy-defaults.ts";
import { OFFICIAL_ATH_DEFAULTS as legacyDefaults } from "../execution/ath-regime.ts";
import { validateEnginePlan } from "../execution/operator-engine-plan.ts";
import { planAthLadder } from "../execution/ath-ladder.ts";

const accountId = "10000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000002";

test("BTC 2/2 and SOL 3/3 proposals preserve the gain and monthly-target defaults", () => {
  assert.equal(legacyDefaults.BTC.postAthSpacing, .05);
  assert.equal(legacyDefaults.SOL.postAthSpacing, .08);
  assert.deepEqual(newEngineStrategyPercentDefaults("BTC"), {
    gainPercent: "1.2", spacingPercent: "2", postAthPercent: "2", monthlyTarget: "7",
  });
  assert.deepEqual(newEngineStrategyPercentDefaults("SOL"), {
    gainPercent: "5.5", spacingPercent: "3", postAthPercent: "3", monthlyTarget: "2",
  });
  const first = newEngineStrategyPercentDefaults("BTC");
  first.spacingPercent = "1.5";
  assert.equal(newEngineStrategyPercentDefaults("BTC").spacingPercent, "2");
});

for (const asset of ["BTC", "SOL"] as const) {
  for (const quote of ["BRL", "USDT", "USDC"] as const) {
    test(`${asset}/${quote} new-engine proposal uses the same spacing in both regimes and accepts individual edits`, () => {
      const defaults = newEngineStrategyPercentDefaults(asset);
      const input = { accountId, requestId, quote, capital: "250.00", engines: [{
        asset, capital: "250.00", ...defaults, monthlyTarget: Number(defaults.monthlyTarget),
      }] };
      const engine = validateEnginePlan(input).engines[0]!;
      assert.equal(engine.spacing, asset === "BTC" ? .02 : .03);
      assert.equal(engine.postAth, engine.spacing);
      assert.equal(engine.allocation.length, 25);
      assert.equal(engine.capital, 250);
      const custom = validateEnginePlan({ ...input, engines: [{ ...input.engines[0]!,
        spacingPercent: "1.5", postAthPercent: "8", gainPercent: "0.8", monthlyTarget: 4 }] }).engines[0]!;
      assert.equal(custom.spacing, .015);
      assert.equal(custom.postAth, .08);
      assert.equal(custom.gain, .008);
      assert.equal(custom.monthlyTarget, 4);
    });
  }
  test(`${asset} equal spacing retains ATH 15+10 ordering, physical slots and OPEN/TP freeze`, () => {
    const parameters = NEW_ENGINE_STRATEGY_DEFAULTS[asset];
    const slots = Array.from({ length: 25 }, (_, index) => ({
      physicalSlotId: `slot-${String(index + 1).padStart(2, "0")}`, physicalSlotNumber: index + 1,
      lifetimeGainCount: index + 1, monthlyGainCount: 0, entryState: "PLANNED", status: "PENDING",
      buyPrice: 100 - index, entryOrigin: "GRID" as const, operationSequence: 1,
    }));
    const before = structuredClone(slots);
    const post = planAthLadder(asset, "POST_ATH", 100, parameters, .01, slots);
    const ordered = [...post].sort((a, b) => a.operationalRank! - b.operationalRank!);
    assert.deepEqual(ordered.map((slot) => slot.physicalSlotNumber), [
      11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
    ]);
    assert.equal(ordered.filter((slot) => slot.postAthGroup === "PRIMARY").length, 15);
    assert.equal(ordered.filter((slot) => slot.postAthGroup === "RESERVE").length, 10);
    const normal = planAthLadder(asset, "NORMAL", 100, parameters, .01, slots);
    assert.equal(post.find((slot) => slot.operationalRank === 1)?.nextBuyPrice,
      normal.find((slot) => slot.operationalRank === 1)?.nextBuyPrice);
    assert.deepEqual(slots, before);
    const withOpen = slots.map((slot, index) => index === 0 ? { ...slot, entryState: "OPEN", status: "TP_ACTIVE" } : slot);
    assert.equal(planAthLadder(asset, "POST_ATH", 100, parameters, .01, withOpen)[0]!.nextBuyPrice, 100);
    assert.equal(planAthLadder(asset, "POST_ATH", 100, parameters, .01, withOpen)[0]!.frozenReason, "OPEN_OR_TP");
  });
}

test("official proposal forms consume browser-safe canonical defaults without order dispatch", () => {
  for (const path of ["engine-control-center.tsx", "engine-append-builder.tsx", "operator-onboarding-panel.tsx",
    "simulador-ath/simulator-client.tsx"]) {
    const source = readFileSync(new URL(`../../app/automacao/${path}`, import.meta.url), "utf8");
    assert.match(source, /newEngineStrategyPercentDefaults/);
    assert.doesNotMatch(source, /from ["'][^"']*ath-regime["']/);
    assert.doesNotMatch(source, /postAthPercent: ["'](?:5|8)["']/);
  }
  const helper = readFileSync(new URL("../execution/strategy-defaults.ts", import.meta.url), "utf8");
  assert.doesNotMatch(helper, /node:crypto|fetch\(|supabase|createOrder|cancelOrder/);
});
