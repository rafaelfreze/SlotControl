import { createHash } from "node:crypto";

import { normalizePriceToTick, normalizeToStep } from "./binance-spot-adapter.ts";
import type { ExchangeSymbolInfo } from "./types.ts";

export const V1_SLOT_COUNT = 25;
export const ALLOWED_V1_SYMBOLS = ["BTCUSDC", "SOLUSDC"] as const;
export type V1Symbol = typeof ALLOWED_V1_SYMBOLS[number];
export type V1Asset = "BTC" | "SOL";
export type V1ExecutionMode = "SHADOW" | "TESTNET";
export type V1SlotStatus = "PENDING" | "PARTIALLY_FILLED" | "OPEN" | "TP_ACTIVE" | "CLOSED";

export const V1_RULES: Record<V1Asset, { symbol: V1Symbol; entrySpacing: number; gainRate: number }> = {
  BTC: { symbol: "BTCUSDC", entrySpacing: 0.02, gainRate: 0.012 },
  SOL: { symbol: "SOLUSDC", entrySpacing: 0.03, gainRate: 0.055 }
};

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

export type V1GridSlot = { slotNumber: number; buyPrice: number; quantity: number; notional: number; takeProfitPrice: number };

/** V1 grids compound each lower entry from the preceding level. This is isolated
 * from the main CoinOps strategy and never changes its BTC/SOL rules. */
export function buildV1Grid(asset: V1Asset, capitalUsdc: number, anchorPrice: number, filters: ExchangeSymbolInfo): V1GridSlot[] {
  const rule = V1_RULES[asset];
  assertV1Symbol(filters.symbol);
  if (filters.symbol !== rule.symbol || !Number.isFinite(anchorPrice) || anchorPrice <= 0) throw new Error("COINOPS_V1_GRID_INPUT_INVALID");
  const slotNotional = calculateV1SlotNotional(capitalUsdc);
  if (slotNotional < filters.minNotional) throw new Error("COINOPS_V1_MIN_NOTIONAL");
  return Array.from({ length: V1_SLOT_COUNT }, (_, index) => {
    const buyPrice = normalizePriceToTick(anchorPrice * Math.pow(1 - rule.entrySpacing, index), filters.priceTick);
    const quantity = normalizeToStep(slotNotional / buyPrice, filters.quantityStep);
    const notional = Number((buyPrice * quantity).toFixed(12));
    if (quantity < filters.minQuantity || quantity > filters.maxQuantity || notional < filters.minNotional) throw new Error("COINOPS_V1_FILTER_REJECTED");
    return { slotNumber: index + 1, buyPrice, quantity, notional, takeProfitPrice: normalizePriceToTick(buyPrice * (1 + rule.gainRate), filters.priceTick) };
  });
}

export function v1ClientOrderId(asset: V1Asset, cycleId: string, slotNumber: number, side: "BUY" | "SELL") {
  if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > V1_SLOT_COUNT) throw new Error("COINOPS_V1_SLOT_INVALID");
  const suffix = createHash("sha256").update(`${cycleId}|${asset}|${slotNumber}|${side}`).digest("hex").slice(0, 18);
  return `COV1-${asset}-${slotNumber}-${side}-${suffix}`;
}

export function v1IdempotencyKey(cycleId: string, slotNumber: number, side: "BUY" | "SELL") {
  return createHash("sha256").update(`coinops-v1|${cycleId}|${slotNumber}|${side}`).digest("hex");
}

export function classifyV1Fill(requestedQuantity: number, executedQuantity: number): V1SlotStatus {
  if (![requestedQuantity, executedQuantity].every(Number.isFinite) || requestedQuantity <= 0 || executedQuantity < 0 || executedQuantity > requestedQuantity) throw new Error("COINOPS_V1_FILL_INVALID");
  if (executedQuantity === 0) return "PENDING";
  return executedQuantity < requestedQuantity ? "PARTIALLY_FILLED" : "OPEN";
}

export function calculateV1TakeProfit(asset: V1Asset, averageFillPrice: number, filters: ExchangeSymbolInfo) {
  if (!Number.isFinite(averageFillPrice) || averageFillPrice <= 0) throw new Error("COINOPS_V1_FILL_INVALID");
  return normalizePriceToTick(averageFillPrice * (1 + V1_RULES[asset].gainRate), filters.priceTick);
}

export function canResetV1Cycle(slots: Array<{ status: V1SlotStatus; ownedPendingBuy: boolean }>) {
  return slots.length === V1_SLOT_COUNT && slots.every((slot) => slot.status === "CLOSED" || (slot.status === "PENDING" && !slot.ownedPendingBuy));
}
