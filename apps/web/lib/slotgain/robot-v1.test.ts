import assert from "node:assert/strict";
import test from "node:test";

import { ALLOWED_V1_SYMBOLS, assertV1ShadowParameters, buildV1Grid, buildV1InitialShadowPosition, buildV1RecycledEntries, calculateV1SlotNotional, calculateV1TakeProfit, canResetV1Cycle, classifyV1Fill, evaluateV1Candle, planV1ShadowCycleRestart, v1ClientOrderId, v1IdempotencyKey } from "../execution/robot-v1.ts";

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

test("V1 test parameters create the initial virtual fill and 0.5% take profit without changing official rules", () => {
  const parameters = { entrySpacing: 0.01, gainRate: 0.005 };
  const grid = buildV1Grid("BTC", 250, 100000, filters("BTCUSDC"), parameters);
  const initial = buildV1InitialShadowPosition(grid);
  assert.equal(grid.length, 25);
  assert.equal(grid[1]?.buyPrice, 99000);
  assert.deepEqual(initial, { slotNumber: 1, quantity: grid[0]?.quantity, buyPrice: 100000, takeProfitPrice: 100500 });
  assert.equal(calculateV1TakeProfit("BTC", initial.buyPrice, filters("BTCUSDC"), parameters), 100500);
  assert.throws(() => assertV1ShadowParameters({ entrySpacing: 0, gainRate: 0.005 }), /PARAMETERS_INVALID/);
});

test("V1 ownership is deterministic, manual USDT symbols are excluded and reset requires no owned pending buy", () => {
  assert.deepEqual(ALLOWED_V1_SYMBOLS, ["BTCUSDC", "SOLUSDC"]);
  assert.throws(() => buildV1Grid("BTC", 250, 100, filters("SOLUSDC")), /SYMBOL_NOT_ALLOWED|GRID_INPUT_INVALID/);
  assert.equal(v1ClientOrderId("BTC", "cycle", 1, "BUY"), v1ClientOrderId("BTC", "cycle", 1, "BUY"));
  assert.equal(canResetV1Cycle(Array.from({ length: 25 }, () => ({ status: "CLOSED" as const, ownedPendingBuy: false }))), true);
  assert.equal(canResetV1Cycle(Array.from({ length: 25 }, () => ({ status: "PENDING" as const, ownedPendingBuy: true }))), false);
});

test("one-minute candle detects crossed buys without inventing an intrabar TP", () => {
  const crossed = evaluateV1Candle("BTC", { openTime: "2026-01-01T00:00:00.000Z", closeTime: "2026-01-01T00:00:59.000Z", low: 98, high: 102, close: 101 }, [{ slotNumber: 1, status: "PENDING", buyPrice: 100, averageFillPrice: null, takeProfitPrice: null }], filters("BTCUSDC"));
  assert.deepEqual(crossed.map((item) => item.kind), ["BUY_TRIGGERED", "AMBIGUOUS"]);
  assert.equal(crossed[0]?.kind === "BUY_TRIGGERED" && crossed[0].fillPrice, 100);
  const exit = evaluateV1Candle("BTC", { openTime: "2026-01-01T00:01:00.000Z", closeTime: "2026-01-01T00:01:59.000Z", low: 100, high: 101.2, close: 101 }, [{ slotNumber: 1, status: "TP_ACTIVE", buyPrice: 100, averageFillPrice: 100, takeProfitPrice: 101.2 }], filters("BTCUSDC"));
  assert.deepEqual(exit.map((item) => item.kind), ["TP_TRIGGERED"]);
});

test("only resets an exhausted Shadow cycle and invalidates pending entries without touching open positions", () => {
  const isolatedSlotOneExit = [{ slotNumber: 1, status: "CLOSED" as const }, ...Array.from({ length: 24 }, (_, index) => ({ slotNumber: index + 2, status: "PENDING" as const }))];
  assert.deepEqual(planV1ShadowCycleRestart(isolatedSlotOneExit), { shouldRestart: true, pendingSlotNumbers: Array.from({ length: 24 }, (_, index) => index + 2) });
  const withAnotherPosition = [...isolatedSlotOneExit.slice(0, 1), { slotNumber: 2, status: "TP_ACTIVE" as const }, ...isolatedSlotOneExit.slice(2)];
  assert.deepEqual(planV1ShadowCycleRestart(withAnotherPosition), { shouldRestart: false, pendingSlotNumbers: Array.from({ length: 23 }, (_, index) => index + 3) });
  assert.deepEqual(planV1ShadowCycleRestart(Array.from({ length: 25 }, (_, index) => ({ slotNumber: index + 1, status: "CLOSED" as const }))), { shouldRestart: true, pendingSlotNumbers: [] });
});

test("recycles closed Shadow slots below the current ladder without changing active positions", () => {
  const parameters = { entrySpacing: 0.01, gainRate: 0.005 };
  const grid = buildV1Grid("BTC", 250, 100000, filters("BTCUSDC"), parameters);
  const afterThreeGains = [
    ...grid.slice(0, 3).map((slot) => ({ slotNumber: slot.slotNumber, status: "CLOSED" as const })),
    ...grid.slice(3, 5).map((slot) => ({ slotNumber: slot.slotNumber, status: "TP_ACTIVE" as const })),
    ...grid.slice(5).map((slot) => ({ slotNumber: slot.slotNumber, status: "PENDING" as const }))
  ];
  assert.deepEqual(planV1ShadowCycleRestart(afterThreeGains), { shouldRestart: false, pendingSlotNumbers: Array.from({ length: 20 }, (_, index) => index + 6) });
  const remainingActiveLevels = grid.slice(3).map((slot) => slot.buyPrice);
  const recycled = buildV1RecycledEntries("BTC", 250, [1, 2, 3], remainingActiveLevels, filters("BTCUSDC"), parameters);
  assert.equal(recycled.length, 3);
  assert.equal(new Set([...remainingActiveLevels, ...recycled.map((slot) => slot.buyPrice)]).size, 25);
  assert.ok(recycled.every((slot) => slot.buyPrice < Math.min(...remainingActiveLevels)));
  assert.deepEqual(buildV1RecycledEntries("BTC", 250, [1, 2, 3], remainingActiveLevels, filters("BTCUSDC"), parameters), recycled);
  assert.equal(v1IdempotencyKey("cycle", 1, "BUY", 2) === v1IdempotencyKey("cycle", 1, "BUY", 3), false);
  assert.equal(v1ClientOrderId("BTC", "cycle", 1, "BUY", 2) === v1ClientOrderId("BTC", "cycle", 1, "BUY", 3), false);
});
