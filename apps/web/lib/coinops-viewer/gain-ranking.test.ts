import assert from "node:assert/strict";
import test from "node:test";
import { rankViewerMarkets } from "./gain-ranking.ts";

test("ranking is per market and preserves net P&L and physical slot identity", () => {
  const ranked = rankViewerMarkets([
    { symbol: "SOLBRL", currency: "BRL", realized: 1.1,
      slots: [{ slot: 2, gains: 1, monthly: 1, realized: .4 }, { slot: 1, gains: 0, monthly: 0, realized: .7 }] },
    { symbol: "BTCBRL", currency: "BRL", realized: 2.5,
      slots: [{ slot: 3, gains: 2, monthly: 1, realized: 2.5 }] },
  ]);
  assert.deepEqual(ranked.map((market) => [market.symbol, market.gains, market.realized]),
    [["BTCBRL", 2, 2.5], ["SOLBRL", 1, 1.1]]);
  assert.deepEqual(ranked[1].rankedSlots.map((slot) => slot.slot), [2, 1]);
});
