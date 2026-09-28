import assert from "node:assert/strict";
import test from "node:test";
import { rankViewerMarkets } from "./gain-ranking.ts";

test("ranking is per market and preserves net P&L and physical slot identity", () => {
  const ranked = rankViewerMarkets([
    { symbol: "SOLBRL", currency: "BRL", realized: 1.1,
      slots: [{ slot: 2, gains: 1, monthly: 1, realized: .4, balance: 30, contributed: 10, pendingContribution: 0, openPnl: -.1, open: true },
        { slot: 1, gains: 0, monthly: 0, realized: .7, balance: 20, contributed: 0, pendingContribution: 5, openPnl: null, open: false }] },
    { symbol: "BTCBRL", currency: "BRL", realized: 2.5,
      slots: [{ slot: 3, gains: 2, monthly: 1, realized: 2.5, balance: 40, contributed: 20, pendingContribution: 0, openPnl: 1, open: true }] },
  ]);
  assert.deepEqual(ranked.map((market) => [market.symbol, market.gains, market.realized]),
    [["BTCBRL", 2, 2.5], ["SOLBRL", 1, 1.1]]);
  assert.deepEqual(ranked[1].rankedSlots.map((slot) => slot.slot), [2, 1]);
});
