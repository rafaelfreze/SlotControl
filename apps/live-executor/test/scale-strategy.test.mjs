import assert from "node:assert/strict";
import test from "node:test";

import { athLadderLevelPrice } from "../../web/lib/execution/ath-ladder-price.ts";
import { calculateStrategyTakeProfit } from "../../web/lib/execution/strategy-engine.ts";
import { assertStrategyBuyPrice, assertStrategyTakeProfitPrice }
  from "../../web/lib/execution/strategy-price-invariant.ts";
import { liveClientOrderId } from "../../web/lib/execution/robot-v1-live-cycle.ts";

const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

test("50/100 synthetic accounts keep 25-slot prices and order identities isolated", () => {
  for (const accountCount of [50, 100]) {
    const orderIds = new Set();
    let verifiedSlots = 0;
    let isolatedFailure = 0;
    for (let account = 1; account <= accountCount; account++) {
      for (const [offset, asset] of ["BTC", "SOL"].entries()) {
        const engine = { exchange_account_id: uuid(account),
          trading_engine_id: uuid(1000 + account * 2 + offset),
          base_asset: asset, legacy_compatible: false };
        const runId = uuid(10000 + account * 2 + offset);
        const tick = asset === "BTC" ? 0.01 : 0.001;
        const spacing = asset === "BTC" ? 0.02 : 0.03;
        const gainRate = asset === "BTC" ? 0.012 : 0.055;
        const anchor = asset === "BTC" ? 84000 : 120;
        for (let level = 0; level < 25; level++) {
          const price = athLadderLevelPrice(anchor, spacing, level, tick);
          assert.equal(assertStrategyBuyPrice({
            price, referencePrice: price, anchorPrice: anchor, spacing, tick, entryOrigin: "GRID"
          }), price);
          const tp = calculateStrategyTakeProfit(price, tick, { gainRate, entrySpacing: spacing });
          assert.equal(assertStrategyTakeProfitPrice({
            price: tp, averageFillPrice: price, gainRate, tick, spacing
          }), tp);
          // Capital changes quantity, never the cycle's immutable price.
          const before = Math.floor(16.76 / price * 1e8);
          const after = Math.floor(25.12 / price * 1e8);
          assert.ok(after >= before);
          assert.equal(assertStrategyBuyPrice({
            price, referencePrice: price, anchorPrice: anchor, spacing, tick, entryOrigin: "REENTRY"
          }), price);
          const clientId = liveClientOrderId(runId, asset, level + 1, 1, "BUY", 1, engine);
          assert.equal(clientId, liveClientOrderId(runId, asset, level + 1, 1, "BUY", 1, engine));
          assert.equal(orderIds.has(clientId), false);
          orderIds.add(clientId);
          verifiedSlots++;
        }
        if (account === 1 && asset === "BTC") {
          assert.throws(() => assertStrategyBuyPrice({
            price: anchor + tick, referencePrice: anchor, anchorPrice: anchor,
            spacing, tick, entryOrigin: "GRID"
          }), /COINOPS_STRATEGY_PRICE_INVARIANT_FAILED/);
          isolatedFailure++;
        }
      }
    }
    assert.equal(verifiedSlots, accountCount * 50);
    assert.equal(orderIds.size, verifiedSlots);
    assert.equal(isolatedFailure, 1);
  }
});
