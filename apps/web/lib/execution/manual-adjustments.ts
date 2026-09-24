import { MONTHLY_SLOT_TARGET } from "./monthly-slot-policy.ts";
import type { V1Asset } from "./robot-v1.ts";

export const MANUAL_ADJUSTMENT_VERSION = "4.4" as const;
export const FX_SOURCE = "BINANCE_SPOT_USDCBRL_ASK" as const;
export const FX_MAX_AGE_MS = 120_000;

export type AdjustmentEnvironment = "SHADOW" | "TESTNET" | "REAL";
export type AdjustmentKind = "MANUAL_TARGET_GAIN" | "MANUAL_CONTRIBUTION";
export type FxQuote = { rateBrlPerUsdc: number; rateBrlPerQuote?: number; quoteAsset?: "USDC" | "USDT";
  source: typeof FX_SOURCE | "BINANCE_SPOT_USDTBRL_ASK"; observedAt: string };
export type AdjustmentSnapshot = {
  environment: AdjustmentEnvironment;
  asset: V1Asset;
  physicalSlotNumber: number;
  balanceUsdc: number;
  committedNotionalUsdc: number | null;
  entryState: string;
  monthlyGainCount: number;
  lifetimeGainCount: number;
  gainRate: number;
  quoteAsset?: "USDC" | "USDT";
};
export type AdjustmentRequest = {
  kind: AdjustmentKind;
  gainUnits?: number;
  explicitGainAmountUsdc?: number;
  currency?: "USD" | "BRL";
  amount?: number;
};
export type AdjustmentPreview = {
  kind: AdjustmentKind;
  gainUnits: number;
  currency: "USD" | "BRL";
  originalAmount: number;
  convertedAmountUsdc: number;
  fx: FxQuote | null;
  balanceBeforeUsdc: number;
  balanceAfterUsdc: number;
  committedNotionalUsdc: number | null;
  monthlyBefore: number;
  monthlyAfter: number;
  monthlyTarget: number;
  lifetimeBefore: number;
  lifetimeAfter: number;
  targetReachedAfter: boolean;
  appliesTo: "NEXT_OPERATION";
  quoteAsset: "USDC" | "USDT";
};

export function roundAdjustment(value: number): number {
  if (!Number.isFinite(value)) throw new Error("COINOPS_ADJUSTMENT_AMOUNT_INVALID");
  return Math.round((value + Number.EPSILON) * 1e8) / 1e8;
}

/** Fills, not the slot projection, prove an existing position. A partial BUY
 * can still be ARMED while its executed capital already needs preservation. */
export function adjustmentCommittedNotional(orders: readonly {
  side: "BUY" | "SELL"; executed_quantity: number | string; fee_base: number | string;
  cumulative_quote: number | string;
}[]): number | null {
  let remaining = 0, committed = 0;
  for (const order of orders) {
    const quantity = Number(order.executed_quantity), fee = Number(order.fee_base), quote = Number(order.cumulative_quote);
    if (![quantity, fee, quote].every((value) => Number.isFinite(value) && value >= 0))
      throw new Error("COINOPS_ADJUSTMENT_POSITION_UNAVAILABLE");
    remaining += (order.side === "BUY" ? quantity : -quantity) - fee;
    if (order.side === "BUY") committed += quote;
  }
  if (remaining < -1e-10) throw new Error("COINOPS_ADJUSTMENT_POSITION_UNAVAILABLE");
  if (remaining <= 1e-10) return null;
  if (committed <= 0) throw new Error("COINOPS_ADJUSTMENT_POSITION_UNAVAILABLE");
  return roundAdjustment(committed);
}

export function validateFxQuote(quote: FxQuote, now = Date.now(), quoteAsset: "USDC" | "USDT" = "USDC"): FxQuote {
  const observed = Date.parse(quote.observedAt);
  if (quote.source !== `BINANCE_SPOT_${quoteAsset}BRL_ASK` || (quote.quoteAsset ?? "USDC") !== quoteAsset
    || !Number.isFinite(quote.rateBrlPerUsdc) || quote.rateBrlPerUsdc <= 0
    || quote.rateBrlPerQuote !== undefined && quote.rateBrlPerQuote !== quote.rateBrlPerUsdc
    || !Number.isFinite(observed) || observed > now + 10_000 || now - observed > FX_MAX_AGE_MS) {
    throw new Error("COINOPS_ADJUSTMENT_FX_STALE_OR_INVALID");
  }
  return quote;
}

export function previewManualAdjustment(snapshot: AdjustmentSnapshot, request: AdjustmentRequest,
  fx: FxQuote | null = null, now = Date.now()): AdjustmentPreview {
  const quoteAsset = snapshot.quoteAsset ?? "USDC";
  if (!["SHADOW", "TESTNET", "REAL"].includes(snapshot.environment)
    || !["BTC", "SOL"].includes(snapshot.asset) || !["USDC", "USDT"].includes(quoteAsset)
    || !Number.isInteger(snapshot.physicalSlotNumber) || snapshot.physicalSlotNumber < 1 || snapshot.physicalSlotNumber > 25
    || !Number.isFinite(snapshot.balanceUsdc) || snapshot.balanceUsdc < 0
    || snapshot.environment !== "REAL" && snapshot.balanceUsdc <= 0
    || !Number.isInteger(snapshot.monthlyGainCount) || snapshot.monthlyGainCount < 0
    || !Number.isInteger(snapshot.lifetimeGainCount) || snapshot.lifetimeGainCount < snapshot.monthlyGainCount
    || !Number.isFinite(snapshot.gainRate) || snapshot.gainRate <= 0 || snapshot.gainRate >= 1
    || snapshot.committedNotionalUsdc !== null && (!Number.isFinite(snapshot.committedNotionalUsdc) || snapshot.committedNotionalUsdc <= 0)) {
    throw new Error("COINOPS_ADJUSTMENT_SNAPSHOT_INVALID");
  }
  let gainUnits = 0, currency: "USD" | "BRL" = "USD", originalAmount: number, converted: number;
  let verifiedFx: FxQuote | null = null;
  if (request.kind === "MANUAL_TARGET_GAIN") {
    gainUnits = request.gainUnits ?? 0;
    if (!Number.isInteger(gainUnits) || gainUnits < 1 || gainUnits > 25) throw new Error("COINOPS_ADJUSTMENT_GAIN_UNITS_INVALID");
    const computed = roundAdjustment(snapshot.balanceUsdc * (Math.pow(1 + snapshot.gainRate, gainUnits) - 1));
    converted = request.explicitGainAmountUsdc ?? computed;
    if (!Number.isFinite(converted) || converted <= 0 || converted > 100_000) throw new Error("COINOPS_ADJUSTMENT_AMOUNT_INVALID");
    converted = roundAdjustment(converted);
    originalAmount = converted;
  } else if (request.kind === "MANUAL_CONTRIBUTION") {
    currency = request.currency ?? "USD";
    originalAmount = request.amount ?? NaN;
    if (!Number.isFinite(originalAmount) || originalAmount <= 0 || originalAmount > 1_000_000
      || !["USD", "BRL"].includes(currency)) throw new Error("COINOPS_ADJUSTMENT_AMOUNT_INVALID");
    originalAmount = roundAdjustment(originalAmount);
    if (currency === "BRL") {
      if (!fx) throw new Error("COINOPS_ADJUSTMENT_FX_REQUIRED");
      verifiedFx = validateFxQuote(fx, now, quoteAsset);
      converted = roundAdjustment(originalAmount / verifiedFx.rateBrlPerUsdc);
    } else converted = originalAmount;
  } else throw new Error("COINOPS_ADJUSTMENT_KIND_INVALID");
  if (converted <= 0) throw new Error("COINOPS_ADJUSTMENT_AMOUNT_TOO_SMALL");
  const monthlyAfter = snapshot.monthlyGainCount + gainUnits;
  const lifetimeAfter = snapshot.lifetimeGainCount + gainUnits;
  return {
    kind: request.kind, gainUnits, currency, originalAmount, convertedAmountUsdc: converted, fx: verifiedFx,
    balanceBeforeUsdc: snapshot.balanceUsdc, balanceAfterUsdc: roundAdjustment(snapshot.balanceUsdc + converted),
    committedNotionalUsdc: snapshot.committedNotionalUsdc,
    monthlyBefore: snapshot.monthlyGainCount, monthlyAfter, monthlyTarget: MONTHLY_SLOT_TARGET[snapshot.asset],
    lifetimeBefore: snapshot.lifetimeGainCount, lifetimeAfter,
    targetReachedAfter: monthlyAfter >= MONTHLY_SLOT_TARGET[snapshot.asset], appliesTo: "NEXT_OPERATION", quoteAsset
  };
}

/** The position is an independent frozen fill; only equity carries the manual credit. */
export function settleAfterOpenPosition(preview: AdjustmentPreview, realisedMarketPnlUsdc: number) {
  if (!Number.isFinite(realisedMarketPnlUsdc)) throw new Error("COINOPS_ADJUSTMENT_PNL_INVALID");
  return roundAdjustment(preview.balanceAfterUsdc + realisedMarketPnlUsdc);
}
