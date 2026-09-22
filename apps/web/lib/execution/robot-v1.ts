import { createHash } from "node:crypto";

import { normalizePriceToTick, normalizeToStep } from "./binance-spot-adapter.ts";
import type { ExchangeSymbolInfo } from "./types.ts";

export const V1_SLOT_COUNT = 25;
export const ALLOWED_V1_SYMBOLS = ["BTCUSDC", "SOLUSDC"] as const;
export type V1Symbol = typeof ALLOWED_V1_SYMBOLS[number];
export type V1Asset = "BTC" | "SOL";
export type V1ExecutionMode = "SHADOW" | "TESTNET";
export type V1SlotStatus = "PENDING" | "PARTIALLY_FILLED" | "OPEN" | "TP_ACTIVE" | "CLOSED" | "CANCELLED";

export const V1_RULES: Record<V1Asset, { symbol: V1Symbol; entrySpacing: number; gainRate: number }> = {
  BTC: { symbol: "BTCUSDC", entrySpacing: 0.02, gainRate: 0.012 },
  SOL: { symbol: "SOLUSDC", entrySpacing: 0.03, gainRate: 0.055 }
};

export type V1ShadowParameters = { entrySpacing: number; gainRate: number };

export function assertV1ShadowParameters(parameters: V1ShadowParameters) {
  if (!Number.isFinite(parameters.entrySpacing) || !Number.isFinite(parameters.gainRate)
    || parameters.entrySpacing < 0.001 || parameters.entrySpacing > 0.20
    || parameters.gainRate < 0.001 || parameters.gainRate > 0.20) throw new Error("COINOPS_V1_PARAMETERS_INVALID");
  return parameters;
}

export function assertV1Symbol(symbol: string): asserts symbol is V1Symbol {
  if (!(ALLOWED_V1_SYMBOLS as readonly string[]).includes(symbol)) throw new Error("COINOPS_V1_SYMBOL_NOT_ALLOWED");
}

export function assertV1ExecutionMode(mode: string): asserts mode is V1ExecutionMode {
  if (mode !== "SHADOW" && mode !== "TESTNET") throw new Error("COINOPS_V1_LIVE_BLOCKED");
}

export function calculateV1SlotNotional(capitalUsdc: number) {
  if (!Number.isFinite(capitalUsdc) || capitalUsdc <= 0) throw new Error("COINOPS_V1_CAPITAL_INVALID");
  return capitalUsdc / V1_SLOT_COUNT;
}

export type V1GridSlot = { slotNumber: number; logicalLevel: number; buyPrice: number; quantity: number; notional: number; takeProfitPrice: number };
export type V1InitialShadowPosition = Pick<V1GridSlot, "slotNumber" | "quantity" | "buyPrice" | "takeProfitPrice">;
export type V1RecycledEntry = Pick<V1GridSlot, "slotNumber" | "quantity" | "buyPrice" | "notional">;
export type V1ActiveGridSlot = { slotNumber: number; logicalLevel: number; buyPrice: number; status: V1SlotStatus };
export type V1ActiveGridValidation = { valid: boolean; errors: string[]; logicalLevels: Map<number, number> };

function normalizeV1TargetPrice(value: number, priceTick: number) {
  const steps = value / priceTick;
  const roundedSteps = Math.round(steps);
  const safeSteps = Math.abs(steps - roundedSteps) < 1e-7 ? roundedSteps : Math.floor(steps);
  const decimals = Math.max(0, (String(priceTick).split(".")[1] || "").length);
  return Number((safeSteps * priceTick).toFixed(decimals));
}

/** V1 grids compound each lower entry from the preceding level. This is isolated
 * from the main CoinOps strategy and never changes its BTC/SOL rules. */
export function quantityForV1SlotBalance(balanceUsdc: number, buyPrice: number, filters: ExchangeSymbolInfo) {
  if (!Number.isFinite(balanceUsdc) || balanceUsdc <= 0 || !Number.isFinite(buyPrice) || buyPrice <= 0 || balanceUsdc < filters.minNotional) throw new Error("COINOPS_V1_SLOT_BALANCE_INVALID");
  const quantity = normalizeToStep(balanceUsdc / buyPrice, filters.quantityStep);
  const notional = Number((buyPrice * quantity).toFixed(12));
  if (quantity < filters.minQuantity || quantity > filters.maxQuantity || notional < filters.minNotional) throw new Error("COINOPS_V1_FILTER_REJECTED");
  return { quantity, notional };
}

export function buildV1Grid(asset: V1Asset, capitalUsdc: number, anchorPrice: number, filters: ExchangeSymbolInfo, parameters: V1ShadowParameters = V1_RULES[asset], slotBalances?: readonly number[]): V1GridSlot[] {
  const assetRule = V1_RULES[asset];
  const rule = assertV1ShadowParameters(parameters);
  assertV1Symbol(filters.symbol);
  if (filters.symbol !== assetRule.symbol || !Number.isFinite(anchorPrice) || anchorPrice <= 0) throw new Error("COINOPS_V1_GRID_INPUT_INVALID");
  const slotNotional = calculateV1SlotNotional(capitalUsdc);
  if (slotNotional < filters.minNotional) throw new Error("COINOPS_V1_MIN_NOTIONAL");
  if (slotBalances && (slotBalances.length !== V1_SLOT_COUNT || slotBalances.some((balance) => !Number.isFinite(balance) || balance <= 0))) throw new Error("COINOPS_V1_SLOT_BALANCE_INVALID");
  return Array.from({ length: V1_SLOT_COUNT }, (_, index) => {
    const buyPrice = normalizePriceToTick(anchorPrice * Math.pow(1 - rule.entrySpacing, index), filters.priceTick);
    const { quantity, notional } = quantityForV1SlotBalance(slotBalances?.[index] ?? slotNotional, buyPrice, filters);
    return { slotNumber: index + 1, logicalLevel: index + 1, buyPrice, quantity, notional, takeProfitPrice: normalizeV1TargetPrice(buyPrice * (1 + rule.gainRate), filters.priceTick) };
  });
}

/** Returns the immutable position in the compounded ladder for one price.
 * Physical slot numbers may be reused after a realised Shadow gain; their
 * logical level therefore intentionally differs from the physical number. */
export function findV1LogicalLevel(anchorPrice: number, buyPrice: number, filters: ExchangeSymbolInfo, parameters: V1ShadowParameters): number | null {
  const rule = assertV1ShadowParameters(parameters);
  if (![anchorPrice, buyPrice, filters.priceTick].every(Number.isFinite) || anchorPrice <= 0 || buyPrice <= 0 || filters.priceTick <= 0) return null;
  const rawIndex = Math.log(buyPrice / anchorPrice) / Math.log(1 - rule.entrySpacing);
  const index = Math.round(rawIndex);
  if (!Number.isFinite(index) || index < 0) return null;
  const expected = normalizePriceToTick(anchorPrice * Math.pow(1 - rule.entrySpacing, index), filters.priceTick);
  return Math.abs(expected - buyPrice) <= (filters.priceTick / 2) + 1e-9 ? index + 1 : null;
}

/**
 * Validates the active Shadow ladder before the worker creates another BUY.
 * A recycled physical slot can occupy a later logical level, so gaps in
 * physical slot numbers are valid; each price must still be on the frozen
 * compounded ladder and every live logical level must be unique.
 */
export function validateActiveGrid(anchorPrice: number, filters: ExchangeSymbolInfo, parameters: V1ShadowParameters, slots: V1ActiveGridSlot[]): V1ActiveGridValidation {
  const errors: string[] = [];
  const logicalLevels = new Map<number, number>();
  const activeStatuses: V1SlotStatus[] = ["PENDING", "PARTIALLY_FILLED", "OPEN", "TP_ACTIVE"];
  if (slots.length !== V1_SLOT_COUNT) errors.push("SLOT_COUNT_INVALID");
  const slotNumbers = new Set<number>();
  const prices = new Set<number>();
  for (const slot of slots) {
    if (!Number.isInteger(slot.slotNumber) || slot.slotNumber < 1 || slot.slotNumber > V1_SLOT_COUNT || slotNumbers.has(slot.slotNumber)) errors.push("PHYSICAL_SLOT_INVALID");
    slotNumbers.add(slot.slotNumber);
    if (!activeStatuses.includes(slot.status)) errors.push("ACTIVE_STATUS_INVALID");
    if (!Number.isFinite(slot.buyPrice) || slot.buyPrice <= 0 || prices.has(slot.buyPrice)) errors.push("BUY_PRICE_DUPLICATE_OR_INVALID");
    prices.add(slot.buyPrice);
    const inferredLevel = findV1LogicalLevel(anchorPrice, slot.buyPrice, filters, parameters);
    if (inferredLevel === null) errors.push(`PRICE_OFF_LADDER_${slot.slotNumber}`);
    else {
      if (slot.logicalLevel !== inferredLevel) errors.push(`LOGICAL_LEVEL_MISMATCH_${slot.slotNumber}`);
      if (logicalLevels.has(inferredLevel)) errors.push(`LOGICAL_LEVEL_DUPLICATE_${inferredLevel}`);
      logicalLevels.set(inferredLevel, slot.slotNumber);
    }
  }
  const descending = [...slots].sort((a, b) => b.buyPrice - a.buyPrice);
  for (let index = 1; index < descending.length; index += 1) if (descending[index - 1]!.buyPrice <= descending[index]!.buyPrice) errors.push("LADDER_NOT_DESCENDING");
  return { valid: errors.length === 0, errors: [...new Set(errors)], logicalLevels };
}

/** Describes the initial virtual Shadow position. It never creates an exchange order. */
export function buildV1InitialShadowPosition(grid: V1GridSlot[]): V1InitialShadowPosition {
  const firstSlot = grid[0];
  if (!firstSlot || firstSlot.slotNumber !== 1) throw new Error("COINOPS_V1_GRID_EMPTY");
  return { slotNumber: firstSlot.slotNumber, quantity: firstSlot.quantity, buyPrice: firstSlot.buyPrice, takeProfitPrice: firstSlot.takeProfitPrice };
}

/** Extends the existing V1 ladder below its current lowest active level. This
 * never reanchors a cycle and leaves active positions and their TPs untouched. */
export function buildV1RecycledEntries(asset: V1Asset, capitalUsdc: number, slotNumbers: number[], activeBuyPrices: number[], filters: ExchangeSymbolInfo, parameters: V1ShadowParameters = V1_RULES[asset], slotBalances?: ReadonlyMap<number, number>): V1RecycledEntry[] {
  const rule = assertV1ShadowParameters(parameters);
  const slotNotional = calculateV1SlotNotional(capitalUsdc);
  if (!slotNumbers.length || !activeBuyPrices.length || slotNotional < filters.minNotional) throw new Error("COINOPS_V1_RECYCLE_INPUT_INVALID");
  const knownPrices = new Set(activeBuyPrices.map((price) => normalizePriceToTick(price, filters.priceTick)));
  let lowerBound = Math.min(...activeBuyPrices);
  return [...slotNumbers].sort((a, b) => a - b).map((slotNumber) => {
    let buyPrice = normalizePriceToTick(lowerBound * (1 - rule.entrySpacing), filters.priceTick);
    while (knownPrices.has(buyPrice)) buyPrice = normalizePriceToTick(buyPrice * (1 - rule.entrySpacing), filters.priceTick);
    const { quantity, notional } = quantityForV1SlotBalance(slotBalances?.get(slotNumber) ?? slotNotional, buyPrice, filters);
    knownPrices.add(buyPrice);
    lowerBound = buyPrice;
    return { slotNumber, buyPrice, quantity, notional };
  });
}

export function v1ClientOrderId(asset: V1Asset, cycleId: string, slotNumber: number, side: "BUY" | "SELL", operationSequence = 1) {
  if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > V1_SLOT_COUNT) throw new Error("COINOPS_V1_SLOT_INVALID");
  if (!Number.isInteger(operationSequence) || operationSequence < 1) throw new Error("COINOPS_V1_OPERATION_INVALID");
  const sequence = operationSequence === 1 ? "" : `-${operationSequence}`;
  const suffixSource = operationSequence === 1 ? `${cycleId}|${asset}|${slotNumber}|${side}` : `${cycleId}|${asset}|${slotNumber}|${side}|${operationSequence}`;
  const suffix = createHash("sha256").update(suffixSource).digest("hex").slice(0, 18);
  return `COV1-${asset}-${slotNumber}${sequence}-${side}-${suffix}`;
}

export function v1IdempotencyKey(cycleId: string, slotNumber: number, side: "BUY" | "SELL", operationSequence = 1) {
  const source = operationSequence === 1 ? `coinops-v1|${cycleId}|${slotNumber}|${side}` : `coinops-v1|${cycleId}|${slotNumber}|${side}|${operationSequence}`;
  return createHash("sha256").update(source).digest("hex");
}

export function classifyV1Fill(requestedQuantity: number, executedQuantity: number): V1SlotStatus {
  if (![requestedQuantity, executedQuantity].every(Number.isFinite) || requestedQuantity <= 0 || executedQuantity < 0 || executedQuantity > requestedQuantity) throw new Error("COINOPS_V1_FILL_INVALID");
  if (executedQuantity === 0) return "PENDING";
  return executedQuantity < requestedQuantity ? "PARTIALLY_FILLED" : "OPEN";
}

export function calculateV1TakeProfit(asset: V1Asset, averageFillPrice: number, filters: ExchangeSymbolInfo, parameters: V1ShadowParameters = V1_RULES[asset]) {
  if (!Number.isFinite(averageFillPrice) || averageFillPrice <= 0) throw new Error("COINOPS_V1_FILL_INVALID");
  return normalizeV1TargetPrice(averageFillPrice * (1 + assertV1ShadowParameters(parameters).gainRate), filters.priceTick);
}

export function canResetV1Cycle(slots: Array<{ status: V1SlotStatus; ownedPendingBuy: boolean }>) {
  return slots.length === V1_SLOT_COUNT && slots.every((slot) => slot.status === "CLOSED" || (slot.status === "PENDING" && !slot.ownedPendingBuy));
}

/** Determines whether a reconciled Shadow cycle can safely start a new grid.
 * Pending entries are virtual only and are cancelled only after every position
 * and TP has closed; an active position always keeps the current cycle alive. */
export function planV1ShadowCycleRestart(slots: Array<{ slotNumber: number; status: V1SlotStatus }>) {
  if (slots.length !== V1_SLOT_COUNT) return { shouldRestart: false, pendingSlotNumbers: [] as number[] };
  const hasOpenPosition = slots.some((slot) => slot.status === "TP_ACTIVE" || slot.status === "OPEN" || slot.status === "PARTIALLY_FILLED");
  const hasInvalidState = slots.some((slot) => !["PENDING", "TP_ACTIVE", "OPEN", "PARTIALLY_FILLED", "CLOSED", "CANCELLED"].includes(slot.status));
  const pendingSlotNumbers = slots.filter((slot) => slot.status === "PENDING").map((slot) => slot.slotNumber);
  return { shouldRestart: !hasOpenPosition && !hasInvalidState, pendingSlotNumbers };
}

export type V1Candle = { openTime: string; closeTime: string; high: number; low: number; close: number };
export type V1CandleSlot = { slotNumber: number; status: V1SlotStatus; buyPrice: number; averageFillPrice: number | null; takeProfitPrice: number | null };
export type V1CandleTransition =
  | { kind: "BUY_TRIGGERED"; slotNumber: number; fillPrice: number; takeProfitPrice: number; observedPrice: number; ambiguous: boolean }
  | { kind: "TP_TRIGGERED"; slotNumber: number; observedPrice: number }
  | { kind: "AMBIGUOUS"; slotNumber: number; observedPrice: number };

/**
 * Candle-only Shadow evaluation. Exits already active at the start of a candle
 * can use its high; an entry first observed through that candle cannot also
 * close in it because their order cannot be proven from OHLC alone.
 */
export function evaluateV1Candle(asset: V1Asset, candle: V1Candle, slots: V1CandleSlot[], filters: ExchangeSymbolInfo, parameters: V1ShadowParameters = V1_RULES[asset]): V1CandleTransition[] {
  if (![candle.high, candle.low, candle.close].every(Number.isFinite) || candle.low <= 0 || candle.high < candle.low) throw new Error("COINOPS_V1_CANDLE_INVALID");
  const transitions: V1CandleTransition[] = [];
  for (const slot of slots) {
    if (slot.status === "TP_ACTIVE" && slot.takeProfitPrice && candle.high >= slot.takeProfitPrice) {
      transitions.push({ kind: "TP_TRIGGERED", slotNumber: slot.slotNumber, observedPrice: candle.high });
    }
  }
  for (const slot of slots) {
    if (slot.status !== "PENDING" || candle.low > slot.buyPrice) continue;
    const fillPrice = slot.buyPrice;
    const takeProfitPrice = calculateV1TakeProfit(asset, fillPrice, filters, parameters);
    const ambiguous = candle.high >= takeProfitPrice;
    transitions.push({ kind: "BUY_TRIGGERED", slotNumber: slot.slotNumber, fillPrice, takeProfitPrice, observedPrice: candle.low, ambiguous });
    if (ambiguous) transitions.push({ kind: "AMBIGUOUS", slotNumber: slot.slotNumber, observedPrice: candle.high });
  }
  return transitions;
}
