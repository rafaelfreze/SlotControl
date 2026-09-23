import assert from "node:assert/strict";
import test from "node:test";

import { ALLOWED_V1_SYMBOLS, assertV1PhysicalSlotInvariant, assertV1ShadowParameters, buildV1Grid, buildV1InitialShadowPosition, buildV1LocalReentry, calculateV1SlotNotional, calculateV1TakeProfit, canResetV1Cycle, classifyV1Fill, evaluateV1Candle, planV1ClosedSlotTransition, planV1NextEntry, planV1ShadowCycleRestart, quantityForV1SlotBalance, selectV1CandleResidentSlots, validateActiveGrid, v1ClientOrderId, v1IdempotencyKey, type V1EntryCandidate } from "../execution/robot-v1.ts";

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

test("real SOL regression keeps physical Slot #2 at its 117.90 entry while Slot #1 remains open", () => {
  const parameters = { entrySpacing: 0.01, gainRate: 0.005 };
  const anchor = 119.10;
  const grid = buildV1Grid("SOL", 250, anchor, filters("SOLUSDC"), parameters);
  assert.equal(grid[1]?.buyPrice, 117.9);
  assert.equal(grid[2]?.buyPrice, 116.72);
  const states = grid.map((slot) => ({ slotNumber: slot.slotNumber, status: slot.slotNumber === 1 ? "TP_ACTIVE" as const : slot.slotNumber === 2 ? "CLOSED" as const : "PENDING" as const }));
  assert.deepEqual(planV1ClosedSlotTransition(states, 2), { mode: "LOCAL_REENTRY", otherOpenPositions: 1 });
  const reentry = buildV1LocalReentry(2, 117.9, 10.0986, { ...filters("SOLUSDC"), quantityStep: 0.001 });
  assert.equal(reentry.buyPrice, 117.9);
  assert.equal(reentry.quantity, 0.085);
  const activeGrid = grid.map((slot) => ({ slotNumber: slot.slotNumber, logicalLevel: slot.logicalLevel, buyPrice: slot.slotNumber === 2 ? reentry.buyPrice : slot.buyPrice, status: slot.slotNumber === 1 ? "TP_ACTIVE" as const : "PENDING" as const }));
  assert.equal(validateActiveGrid(anchor, filters("SOLUSDC"), parameters, activeGrid).valid, true);
  assert.equal(assertV1PhysicalSlotInvariant(activeGrid.map((slot) => ({ slotNumber: slot.slotNumber, current: true, armed: slot.slotNumber === 2 }))), true);
  assert.throws(() => assertV1PhysicalSlotInvariant(activeGrid.slice(1).map((slot) => ({ slotNumber: slot.slotNumber, current: true, armed: false }))), /SLOT_INVARIANT_INVALID/);
  assert.equal(v1IdempotencyKey("cycle", 2, "BUY", 2) === v1IdempotencyKey("cycle", 2, "BUY", 3), false);
  assert.equal(v1ClientOrderId("SOL", "cycle", 2, "BUY", 2) === v1ClientOrderId("SOL", "cycle", 2, "BUY", 3), false);
});

test("a physical slot compounds its next virtual BUY without changing other slots or the ladder", () => {
  const parameters = { entrySpacing: 0.01, gainRate: 0.005 };
  const symbolFilters = filters("SOLUSDC");
  const first = buildV1Grid("SOL", 250, 100, symbolFilters, parameters);
  const balances = [10.05, ...Array.from({ length: 24 }, () => 10)];
  const second = buildV1Grid("SOL", 250.05, 100, symbolFilters, parameters, balances);
  assert.equal(second[0]?.quantity, quantityForV1SlotBalance(10.05, 100, symbolFilters).quantity);
  assert.equal(second[0]?.notional, 10.05);
  assert.equal(second[1]?.quantity, first[1]?.quantity);
  assert.deepEqual(second.map((slot) => slot.buyPrice), first.map((slot) => slot.buyPrice));
  const third = buildV1Grid("SOL", 250.10025, 100, symbolFilters, parameters, [10.10025, ...balances.slice(1)]);
  assert.equal(third[0]?.quantity, quantityForV1SlotBalance(10.10025, 100, symbolFilters).quantity);
  assert.ok(third[0]!.notional > second[0]!.notional);
});

test("local reentry compounds at the same price and final OPEN uses global reset", () => {
  const symbolFilters = filters("SOLUSDC");
  const reentry = buildV1LocalReentry(2, 117.9, 10.0986, symbolFilters);
  assert.equal(reentry.buyPrice, 117.9);
  assert.equal(reentry.quantity, quantityForV1SlotBalance(10.0986, 117.9, symbolFilters).quantity);
  const lastOpenClosed = Array.from({ length: 25 }, (_, index) => ({ slotNumber: index + 1, status: index === 0 ? "CLOSED" as const : "PENDING" as const }));
  assert.deepEqual(planV1ClosedSlotTransition(lastOpenClosed, 1), { mode: "GLOBAL_RESET", otherOpenPositions: 0 });
});

test("compounded budget remains visible even when the Binance lot step keeps executable quantity unchanged", () => {
  const symbolFilters = { ...filters("SOLUSDC"), quantityStep: 0.001 };
  const initial = quantityForV1SlotBalance(10, 117.06, symbolFilters);
  const compounded = quantityForV1SlotBalance(10.0493, 117.06, symbolFilters);
  assert.equal(initial.quantity, 0.085);
  assert.equal(compounded.quantity, initial.quantity);
  assert.equal(compounded.notional, initial.notional);
  assert.equal(compounded.notional, 9.9501);
  assert.ok(10.0493 - compounded.notional > 10 - initial.notional);
});

test("one resident BUY is evaluated while the other 23 levels stay planned", () => {
  const armedAt = "2026-09-22T20:00:30.000Z";
  const slots: V1EntryCandidate[] = [
    { slotNumber: 1, buyPrice: 100, status: "TP_ACTIVE", entryState: "NONE", armedAt: null, missedAt: null },
    { slotNumber: 2, buyPrice: 99, status: "PENDING", entryState: "ARMED", armedAt, missedAt: null },
    ...Array.from({ length: 23 }, (_, index) => ({ slotNumber: index + 3, buyPrice: 98 - index, status: "PENDING" as const, entryState: "PLANNED" as const, armedAt: null, missedAt: null }))
  ];
  assert.equal(selectV1CandleResidentSlots(slots, "2026-09-22T20:00:00.000Z").length, 1);
  assert.deepEqual(selectV1CandleResidentSlots(slots, "2026-09-22T20:01:00.000Z").map((slot) => slot.slotNumber), [1, 2]);
  assert.deepEqual(planV1NextEntry(slots, 99.5), { current: 2, missed: [], next: null });
  assert.throws(() => planV1NextEntry([...slots, { ...slots[1]!, slotNumber: 3 }], 99), /MULTIPLE_ARMED_BUYS/);
});

test("fast candle records crossed unarmed levels and selects the next untouched BUY", () => {
  const planned: V1EntryCandidate[] = [98, 97, 96].map((buyPrice, index) => ({ slotNumber: index + 3, buyPrice, status: "PENDING", entryState: "PLANNED", armedAt: null, missedAt: null }));
  assert.deepEqual(planV1NextEntry(planned, 97.5), { current: null, missed: [3], next: 4 });
  assert.deepEqual(planV1NextEntry(planned, 95), { current: null, missed: [3, 4, 5], next: null });
  assert.deepEqual(planV1NextEntry([{ ...planned[0]!, missedAt: "2026-09-22T20:00:00.000Z" }, ...planned.slice(1)], 97.5), { current: null, missed: [], next: 4 });
});
