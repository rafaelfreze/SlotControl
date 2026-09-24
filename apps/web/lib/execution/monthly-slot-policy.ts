import type { V1Asset } from "./robot-v1.ts";

export const MONTHLY_SLOT_TIMEZONE = "America/Campo_Grande";
export const MONTHLY_SLOT_TARGET: Readonly<Record<V1Asset, number>> = { BTC: 7, SOL: 2 };

const monthFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MONTHLY_SLOT_TIMEZONE, year: "numeric", month: "2-digit",
});

export function monthlyPeriodKey(instant: string | Date): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new Error("COINOPS_MONTHLY_PERIOD_INVALID");
  const parts = monthFormatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("COINOPS_MONTHLY_PERIOD_INVALID");
  return `${year}-${month}`;
}

/** Find the next local calendar boundary with the runtime's IANA timezone data. */
export function nextMonthlyResetAt(instant: string | Date): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  const key = monthlyPeriodKey(date);
  let low = date.getTime(), high = low + 35 * 86_400_000;
  if (monthlyPeriodKey(new Date(high)) <= key) throw new Error("COINOPS_MONTHLY_PERIOD_INVALID");
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (monthlyPeriodKey(new Date(middle)) > key) high = middle;
    else low = middle;
  }
  return new Date(high).toISOString();
}

export type MonthlySlotInput = {
  physicalSlotNumber: number;
  physicalSlotId: string;
  lifetimeGainCount: number;
  monthlyGainCount: number | null;
  balanceUsdc: number;
  entryState: string;
  marketGainCount?: number | null;
  manualGainCount?: number | null;
  monthlyMarketGainCount?: number | null;
  monthlyManualGainCount?: number | null;
};

export type MonthlySlotStatus = MonthlySlotInput & {
  monthlyGainTarget: number;
  periodKey: string;
  timezone: typeof MONTHLY_SLOT_TIMEZONE;
  monthlyTargetReached: boolean;
  eligibleForNewEntry: boolean;
  blockedReason: "MONTHLY_TARGET_REACHED" | "GAIN_EVIDENCE_INCOMPLETE" | null;
  operationalRank: number | null;
};

/** Gain rank is independent of price. The engine still decides which priced
 * opportunity is valid; an OPEN position can finish after reaching its goal. */
export function rankMonthlySlots(asset: V1Asset, instant: string | Date, inputs: readonly MonthlySlotInput[]): MonthlySlotStatus[] {
  const target = MONTHLY_SLOT_TARGET[asset];
  const periodKey = monthlyPeriodKey(instant);
  const ids = new Set<string>(), numbers = new Set<number>();
  const statuses = inputs.map((input): MonthlySlotStatus => {
    if (!Number.isInteger(input.physicalSlotNumber) || input.physicalSlotNumber < 1 || input.physicalSlotNumber > 25
      || !input.physicalSlotId || ids.has(input.physicalSlotId) || numbers.has(input.physicalSlotNumber)
      || !Number.isInteger(input.lifetimeGainCount) || input.lifetimeGainCount < 0
      || input.monthlyGainCount !== null && (!Number.isInteger(input.monthlyGainCount) || input.monthlyGainCount < 0 || input.monthlyGainCount > input.lifetimeGainCount)
      || !Number.isFinite(input.balanceUsdc) || input.balanceUsdc <= 0
      || input.marketGainCount != null && input.manualGainCount != null
        && input.marketGainCount + input.manualGainCount !== input.lifetimeGainCount
      || input.monthlyGainCount != null && input.monthlyMarketGainCount != null && input.monthlyManualGainCount != null
        && input.monthlyMarketGainCount + input.monthlyManualGainCount !== input.monthlyGainCount)
      throw new Error("COINOPS_MONTHLY_SLOT_EVIDENCE_INVALID");
    ids.add(input.physicalSlotId); numbers.add(input.physicalSlotNumber);
    const reached = input.monthlyGainCount !== null && input.monthlyGainCount >= target;
    const blockedReason = input.monthlyGainCount === null ? "GAIN_EVIDENCE_INCOMPLETE" as const
      : reached ? "MONTHLY_TARGET_REACHED" as const : null;
    return { ...input, monthlyGainTarget: target, periodKey, timezone: MONTHLY_SLOT_TIMEZONE,
      monthlyTargetReached: reached, eligibleForNewEntry: blockedReason === null, blockedReason, operationalRank: null };
  });
  const eligible = statuses.filter((slot) => slot.eligibleForNewEntry)
    .sort((left, right) => right.lifetimeGainCount - left.lifetimeGainCount || left.physicalSlotNumber - right.physicalSlotNumber);
  eligible.forEach((slot, index) => { slot.operationalRank = index + 1; });
  return statuses;
}

export function physicalSlotIdentity(environment: "SHADOW" | "TESTNET" | "REAL", scope: {
  productId: string; tenantId: string; userId: string; asset: V1Asset; configId?: string;
  tradingEngineId?: string; legacyCompatible?: boolean;
}, physicalSlotNumber: number): string {
  if (!Number.isInteger(physicalSlotNumber) || physicalSlotNumber < 1 || physicalSlotNumber > 25) {
    throw new Error("COINOPS_MONTHLY_PHYSICAL_SLOT_INVALID");
  }
  if (scope.tradingEngineId && scope.legacyCompatible === false)
    return `${environment}:${scope.tradingEngineId}:${physicalSlotNumber}`;
  if (environment === "SHADOW") {
    if (!scope.configId) throw new Error("COINOPS_MONTHLY_PHYSICAL_SLOT_INVALID");
    return `SHADOW:${scope.configId}:${physicalSlotNumber}`;
  }
  return `${environment}:${scope.productId}:${scope.tenantId}:${scope.userId}:${scope.asset}:${physicalSlotNumber}`;
}
