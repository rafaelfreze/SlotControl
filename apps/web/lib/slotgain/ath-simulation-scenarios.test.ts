import assert from "node:assert/strict";
import test from "node:test";

import { buildAthDescentPrices } from "../execution/ath-simulation-scenarios.ts";
import { simulateAth } from "../execution/ath-simulator.ts";
import { OFFICIAL_ATH_DEFAULTS } from "../execution/ath-regime.ts";

const expectedOrder = [...Array.from({ length: 15 }, (_, index) => 11 + index),
  ...Array.from({ length: 10 }, (_, index) => 10 - index)];
const counts = { lifetimeGains: Array.from({ length: 25 }, (_, index) => index + 1), monthlyGains: Array(25).fill(0) };
const buySlots = (result: ReturnType<typeof simulateAth>) => result.steps
  .filter((step) => ["INITIAL_MARKET_FILLED", "BUY_FILLED"].includes(step.event)).map((step) => step.slot);

test("default BTC UI descent reaches the last tick-rounded level and executes PRIMARY 15 then RESERVE 10", () => {
  const parameters = OFFICIAL_ATH_DEFAULTS.BTC;
  const input = { asset: "BTC" as const, initialPrice: 105, previousAth: 100, floorReference: null, parameters, ...counts };
  const oldPrices = [105, ...Array.from({ length: 24 }, (_, index) => Number((105 * .95 ** (index + 1) - .000001).toFixed(8)))];
  assert.equal(buySlots(simulateAth({ ...input, prices: oldPrices })).length, 24, "negative control reproduces the published smoke failure");
  const prices = buildAthDescentPrices({ anchor: 105, spacing: parameters.postAthSpacing });
  assert.equal(prices.length, 25);
  assert.equal(prices.at(-1), 30.65);
  assert.ok(prices.every((price, index) => index === 0 || price < prices[index - 1]!));
  const result = simulateAth({ ...input, prices });
  assert.deepEqual(buySlots(result), expectedOrder);
  assert.equal(result.missedLevels, 0);
  assert.equal(result.slots.filter((slot) => slot.entryState === "OPEN").length, 25);
});

for (const asset of ["BTC", "SOL"] as const) {
  test(`${asset} generated scenario follows a custom spacing and tick without skipping the final reserve slot`, () => {
    const parameters = { gainRate: .005, normalSpacing: .01, postAthSpacing: .013 };
    const prices = buildAthDescentPrices({ anchor: 123.456, spacing: parameters.postAthSpacing, priceTick: .001 });
    const result = simulateAth({ asset, initialPrice: 123.456, previousAth: 100, floorReference: null,
      parameters, priceTick: .001, prices, ...counts });
    assert.deepEqual(buySlots(result), expectedOrder);
    assert.equal(result.missedLevels, 0);
    assert.ok(prices.slice(1).every((price) => Math.abs(price / .001 - Math.round(price / .001)) < 1e-6));
  });
}

test("invalid generated scenarios fail before replacing the editable price sequence", () => {
  assert.throws(() => buildAthDescentPrices({ anchor: NaN, spacing: .05 }), /INPUT_INVALID/);
  assert.throws(() => buildAthDescentPrices({ anchor: 105, spacing: 0 }), /INPUT_INVALID/);
  assert.throws(() => buildAthDescentPrices({ anchor: .1, spacing: .05 }), /FILTER_INVALID/);
});
