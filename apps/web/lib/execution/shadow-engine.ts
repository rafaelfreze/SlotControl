import { createHash } from "node:crypto";

import { SHADOW_EXECUTION_MODE, type OrderSide, type SupportedAsset, assetSymbol, assertShadowOnly } from "./types.ts";

export type ShadowSafetyLimits = {
  maxOrderNotionalUsdt: number;
  maxDailyNotionalUsdt: number;
  maxMarketAgeSeconds: number;
  dailyNotionalUsdt: number;
};

export type ShadowIntentInput = {
  productId: string;
  tenantId: string;
  userId: string;
  strategyId: string;
  slotId: string;
  cycleId: string | null;
  asset: SupportedAsset;
  side: OrderSide;
  quantity: number;
  referencePrice: number;
  targetPrice: number | null;
  observedMarketPrice: number;
  observedAt: string;
  strategyReason: string;
  strategyRegime: string | null;
  executionMode?: typeof SHADOW_EXECUTION_MODE;
};

export type ShadowIntent = ShadowIntentInput & {
  symbol: string;
  expectedNotionalUsdt: number;
  idempotencyKey: string;
  status: "SHADOW_RECORDED";
  executionMode: typeof SHADOW_EXECUTION_MODE;
};

export interface ShadowIntentStore {
  upsert(intent: ShadowIntent): Promise<{ created: boolean; id?: string }>;
}

export function shouldCreateShadowEntryIntent(slotStatus: string, observedMarketPrice: number, triggerPrice: number | null) {
  return slotStatus === "hold"
    && Number.isFinite(observedMarketPrice)
    && observedMarketPrice > 0
    && triggerPrice !== null
    && Number.isFinite(triggerPrice)
    && triggerPrice > 0
    && observedMarketPrice <= triggerPrice;
}

export function assertSufficientShadowBalance(availableQuoteBalance: number, expectedNotionalUsdt: number) {
  if (!Number.isFinite(availableQuoteBalance) || !Number.isFinite(expectedNotionalUsdt) || availableQuoteBalance < expectedNotionalUsdt) {
    throw new Error("COINOPS_SHADOW_INSUFFICIENT_BALANCE");
  }
}

export function classifyReconciledFill(requestedQuantity: number, executedQuantity: number) {
  if (![requestedQuantity, executedQuantity].every(Number.isFinite) || requestedQuantity <= 0 || executedQuantity < 0 || executedQuantity > requestedQuantity) {
    throw new Error("COINOPS_RECONCILIATION_FILL_INVALID");
  }
  if (executedQuantity === 0) return "PENDING" as const;
  if (executedQuantity < requestedQuantity) return "PARTIALLY_FILLED" as const;
  return "FILLED" as const;
}

export function calculateSlotNotional(capitalUsdt: number, slotCount = 25) {
  if (!Number.isFinite(capitalUsdt) || capitalUsdt <= 0 || !Number.isInteger(slotCount) || slotCount <= 0) {
    throw new Error("COINOPS_SHADOW_CAPITAL_INVALID");
  }
  return capitalUsdt / slotCount;
}

export function buildShadowIntentIdempotencyKey(input: Pick<ShadowIntentInput, "productId" | "tenantId" | "userId" | "cycleId" | "slotId" | "asset" | "side" | "targetPrice" | "strategyReason" | "strategyRegime">) {
  const source = [
    "coinops-shadow-v1", input.productId, input.tenantId, input.userId,
    input.cycleId || "no-cycle", input.slotId, input.asset, input.side,
    input.targetPrice ?? "market", input.strategyReason, input.strategyRegime || "no-regime"
  ].join("|");
  return createHash("sha256").update(source).digest("hex");
}

export function buildShadowIntent(input: ShadowIntentInput, limits: ShadowSafetyLimits, now = new Date()) : ShadowIntent {
  assertShadowOnly(input.executionMode || SHADOW_EXECUTION_MODE);
  const numeric = [input.quantity, input.referencePrice, input.observedMarketPrice, limits.maxOrderNotionalUsdt, limits.maxDailyNotionalUsdt, limits.maxMarketAgeSeconds, limits.dailyNotionalUsdt];
  if (!numeric.every(Number.isFinite) || input.quantity <= 0 || input.referencePrice <= 0 || input.observedMarketPrice <= 0 || limits.maxMarketAgeSeconds <= 0 || limits.dailyNotionalUsdt < 0) {
    throw new Error("COINOPS_SHADOW_INTENT_INVALID");
  }
  const observedAt = new Date(input.observedAt);
  if (Number.isNaN(observedAt.getTime()) || now.getTime() - observedAt.getTime() > limits.maxMarketAgeSeconds * 1000) {
    throw new Error("COINOPS_SHADOW_MARKET_DATA_STALE");
  }
  const expectedNotionalUsdt = Number((input.quantity * input.observedMarketPrice).toFixed(8));
  if (limits.maxOrderNotionalUsdt > 0 && expectedNotionalUsdt > limits.maxOrderNotionalUsdt) {
    throw new Error("COINOPS_SHADOW_MAX_ORDER_NOTIONAL");
  }
  if (limits.maxDailyNotionalUsdt > 0 && limits.dailyNotionalUsdt + expectedNotionalUsdt > limits.maxDailyNotionalUsdt) {
    throw new Error("COINOPS_SHADOW_MAX_DAILY_NOTIONAL");
  }
  return {
    ...input,
    symbol: assetSymbol(input.asset),
    expectedNotionalUsdt,
    idempotencyKey: buildShadowIntentIdempotencyKey(input),
    status: "SHADOW_RECORDED",
    executionMode: SHADOW_EXECUTION_MODE
  };
}

export async function recordShadowIntent(input: ShadowIntentInput, limits: ShadowSafetyLimits, store: ShadowIntentStore, now?: Date) {
  const intent = buildShadowIntent(input, limits, now);
  return { intent, ...(await store.upsert(intent)) };
}
