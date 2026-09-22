import assert from "node:assert/strict";
import test from "node:test";

import { ALLOWED_V1_SYMBOLS, buildV1Grid, calculateV1SlotNotional, calculateV1TakeProfit, canResetV1Cycle, classifyV1Fill, v1ClientOrderId } from "../execution/robot-v1.ts";

const filters = (symbol: "BTCUSDC" | "SOLUSDC") => ({ symbol, baseAsset: symbol.slice(0, -4), quoteAsset: "USDC", minQuantity: 0.00001, maxQuantity: 100000, minNotional: 5, quantityStep: 0.00001, priceTick: 0.01 });

test("V1 creates 25 compounded BTCUSDC levels and bases each slot on configured capital", () => {
  const grid = buildV1Grid("BTC", 250, 100000, filters("BTCUSDC"));
  assert.equal(calculateV1SlotNotional(250), 10);
  assert.equal(grid.length, 25);
  assert.equal(grid[0]?.buyPrice, 100000);
  assert.equal(grid[1]?.buyPrice, 98000);
  assert.equal(grid[0]?.takeProfitPrice, 101200);
  assert.ok((grid[24]?.buyPrice || 0) < (grid[23]?.buyPrice || 0));
});

test("V1 creates SOLUSDC targets from actual fill price and handles partial fills deterministically", () => {
  const grid = buildV1Grid("SOL", 625, 100, filters("SOLUSDC"));
  assert.equal(grid[0]?.notional, 25);
  assert.equal(grid[1]?.buyPrice, 97);
  assert.equal(calculateV1TakeProfit("SOL", 100, filters("SOLUSDC")), 105.5);
  assert.equal(classifyV1Fill(1, 0.4), "PARTIALLY_FILLED");
  assert.equal(classifyV1Fill(1, 1), "OPEN");
});

test("V1 ownership is deterministic, manual USDT symbols are excluded and reset requires no owned pending buy", () => {
  assert.deepEqual(ALLOWED_V1_SYMBOLS, ["BTCUSDC", "SOLUSDC"]);
  assert.throws(() => buildV1Grid("BTC", 250, 100, filters("SOLUSDC")), /SYMBOL_NOT_ALLOWED|GRID_INPUT_INVALID/);
  assert.equal(v1ClientOrderId("BTC", "cycle", 1, "BUY"), v1ClientOrderId("BTC", "cycle", 1, "BUY"));
  assert.equal(canResetV1Cycle(Array.from({ length: 25 }, () => ({ status: "CLOSED" as const, ownedPendingBuy: false }))), true);
  assert.equal(canResetV1Cycle(Array.from({ length: 25 }, () => ({ status: "PENDING" as const, ownedPendingBuy: true }))), false);
});
