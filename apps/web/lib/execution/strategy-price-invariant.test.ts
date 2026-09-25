import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { athLadderLevelPrice } from "./ath-ladder-price.ts";
import { calculateStrategyTakeProfit } from "./strategy-engine.ts";
import { assertStrategyBuyPrice, assertStrategyTakeProfitPrice } from "./strategy-price-invariant.ts";

for (const [symbol, anchor, spacing, tick] of [
  ["BTCBRL", 440_199, 0.01, 1], ["BTCUSDT", 84_446, 0.02, 0.01],
  ["SOLBRL", 629, 0.015, 0.1], ["SOLUSDT", 117.02, 0.03, 0.01],
] as const) {
  test(`${symbol}: all 25 BUY levels use the immutable geometric cycle anchor`, () => {
    for (let level = 0; level < 25; level++) {
      const reference = athLadderLevelPrice(anchor, spacing, level, tick);
      assert.equal(assertStrategyBuyPrice({ price: reference, referencePrice: reference,
        anchorPrice: anchor, spacing, tick, entryOrigin: "GRID" }), reference);
      assert.throws(() => assertStrategyBuyPrice({ price: reference + tick, referencePrice: reference,
        anchorPrice: anchor, spacing, tick, entryOrigin: "GRID" }), /COINOPS_STRATEGY_PRICE_INVARIANT_FAILED/);
    }
  });
  test(`${symbol}: reentry, compounding and manual aportes do not change a slot price`, () => {
    const reference = athLadderLevelPrice(anchor, spacing, 7, tick);
    for (const capital of [16.76, 20.5, 419]) {
      const quantity = capital / reference;
      assert.ok(quantity > 0);
      for (let gain = 0; gain < 3; gain++)
        assert.equal(assertStrategyBuyPrice({ price: reference, referencePrice: reference,
          anchorPrice: anchor, spacing, tick, entryOrigin: "REENTRY" }), reference);
    }
  });
}

for (const [symbol, averageFillPrice, gainRate, spacing, tick] of [
  ["BTCBRL", 438_371, 0.012, 0.01, 1], ["BTCUSDT", 84_395.41, 0.012, 0.02, 0.01],
  ["SOLBRL", 627, 0.055, 0.015, 0.1], ["SOLUSDT", 117.05, 0.055, 0.03, 0.01],
] as const) {
  test(`${symbol}: TP comes from actual average BUY fill and exact Binance tick`, () => {
    const price = calculateStrategyTakeProfit(averageFillPrice, tick, { gainRate, entrySpacing: spacing });
    assert.equal(assertStrategyTakeProfitPrice({ price, averageFillPrice, gainRate, spacing, tick }), price);
    assert.throws(() => assertStrategyTakeProfitPrice({ price: price + tick,
      averageFillPrice, gainRate, spacing, tick }), /COINOPS_STRATEGY_PRICE_INVARIANT_FAILED/);
  });
}

test("ATH transition or cycle reset may establish a new recorded anchor; old anchor may not leak", () => {
  const oldAnchor = 100, newAnchor = 110, spacing = 0.05, tick = 0.01;
  const price = athLadderLevelPrice(newAnchor, spacing, 1, tick);
  assert.equal(assertStrategyBuyPrice({ price, referencePrice: price, anchorPrice: newAnchor,
    spacing, tick, entryOrigin: "GRID" }), price);
  assert.throws(() => assertStrategyBuyPrice({ price, referencePrice: price, anchorPrice: oldAnchor,
    spacing, tick, entryOrigin: "GRID" }), /COINOPS_STRATEGY_PRICE_INVARIANT_FAILED/);
});

test("both exchange paths gate dispatch and reconciliation with the shared price invariant", () => {
  const live = readFileSync(new URL("./robot-v1-live-server.ts", import.meta.url), "utf8");
  const testnet = readFileSync(new URL("./robot-v1-testnet-server.ts", import.meta.url), "utf8");
  const liveReconcile = live.slice(live.indexOf("async function reconcileOrder("),
    live.indexOf("async function ensureTakeProfits("));
  assert.ok(liveReconcile.indexOf("assertLiveOrderPrice(") < liveReconcile.indexOf("submission_guarded_at: new Date"));
  assert.match(live, /assertLiveResidentPrices\(run, ledger, state\)/);
  assert.match(live, /assertLiveResidentPrices\(run, ledger, await readLiveExecutorState\(run\)\)/);
  const testnetSync = testnet.slice(testnet.indexOf("async function syncOrder("),
    testnet.indexOf("async function applyTestnetAthTransition("));
  assert.ok(testnetSync.indexOf("assertTestnetOrderPrice(") < testnetSync.indexOf("adapter.ensureOwnedOrder("));
  assert.match(testnetSync, /assertTestnetOrderPrice\(run, slot, order, orders, filters, actual.price\)/);
});
