export type AutomationAsset = "BTC" | "SOL";
export type AutomationEventType = "ENTRY" | "EXIT";

export type PriceWindow = {
  asset: AutomationAsset;
  windowStart: string;
  windowEnd: string;
  open: number;
  high: number;
  low: number;
  close: number;
  source: string;
};

export function isValidPriceWindow(window: PriceWindow) {
  return [window.open, window.high, window.low, window.close].every((value) => Number.isFinite(value) && value > 0)
    && window.low <= window.high
    && window.low <= Math.min(window.open, window.close)
    && window.high >= Math.max(window.open, window.close);
}

export function entryWasCrossed(window: PriceWindow, triggerPrice: number, previousPrice?: number | null) {
  if (!isValidPriceWindow(window) || !Number.isFinite(triggerPrice) || triggerPrice <= 0) return false;
  return window.low <= triggerPrice || (Number.isFinite(previousPrice) && Number(previousPrice) > triggerPrice && window.close <= triggerPrice);
}

export function exitWasCrossed(window: PriceWindow, targetPrice: number, previousPrice?: number | null) {
  if (!isValidPriceWindow(window) || !Number.isFinite(targetPrice) || targetPrice <= 0) return false;
  return window.high >= targetPrice || (Number.isFinite(previousPrice) && Number(previousPrice) < targetPrice && window.close >= targetPrice);
}

export function findFirstCrossedWindow(
  eventType: AutomationEventType,
  windows: PriceWindow[],
  triggerPrice: number,
  slotUpdatedAt?: string | null
) {
  const updatedAt = slotUpdatedAt ? new Date(slotUpdatedAt).getTime() : Number.NEGATIVE_INFINITY;
  let previousPrice: number | null = null;

  for (const window of windows) {
    if (!isValidPriceWindow(window)) continue;
    const windowStart = new Date(window.windowStart).getTime();
    const crossed = eventType === "ENTRY"
      ? entryWasCrossed(window, triggerPrice, previousPrice)
      : exitWasCrossed(window, triggerPrice, previousPrice);
    previousPrice = window.close;
    if (windowStart >= updatedAt && crossed) return window;
  }

  return null;
}

export function automationIdempotencyKey(input: {
  asset: AutomationAsset;
  slotId: string;
  eventType: AutomationEventType;
  triggerPrice: number;
  windowStart: string;
}) {
  return [input.asset, input.slotId, input.eventType, input.triggerPrice.toFixed(8), input.windowStart].join(":");
}
