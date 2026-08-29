export type OfficialAsset = "BTC" | "SOL";
export type OfficialStrategyMode = "NORMAL_GROWTH" | "DEFENSIVE_POST_ATH";
export type SlotPool = "MAIN" | "RESERVE";

export const OFFICIAL_MONITORING_TIME_ZONE = "America/Campo_Grande";
export const OFFICIAL_CYCLE_DAYS = 30;

export const OFFICIAL_TARGETS: Record<OfficialAsset, number> = { BTC: 7, SOL: 2 };
export const OFFICIAL_ENTRY_SPACING: Record<OfficialStrategyMode, Record<OfficialAsset, number>> = {
  NORMAL_GROWTH: { BTC: 2, SOL: 3 },
  DEFENSIVE_POST_ATH: { BTC: 5, SOL: 8 }
};

export type OfficialRegimeState = {
  mode: OfficialStrategyMode;
  officialAth: number;
  defensiveAnchorAth: number | null;
  modeStartedAt: string;
};

export type OfficialRegimeTransition = {
  state: OfficialRegimeState;
  event: "NONE" | "NEW_ATH" | "DEFENSIVE_PEAK_UPDATED" | "STRONG_BOTTOM_REACHED";
  closeCycleReason: "NEW_ATH" | "STRONG_BOTTOM_REACHED" | null;
  startNormalCycle: boolean;
};

export function reduceOfficialRegime(current: OfficialRegimeState, btcPrice: number, observedAt: string): OfficialRegimeTransition {
  if (!Number.isFinite(btcPrice) || btcPrice <= 0) throw new Error("COINOPS_OFFICIAL_BTC_PRICE_INVALID");
  if (current.mode === "NORMAL_GROWTH") {
    if (btcPrice <= current.officialAth) return { state: current, event: "NONE", closeCycleReason: null, startNormalCycle: false };
    return {
      state: { mode: "DEFENSIVE_POST_ATH", officialAth: btcPrice, defensiveAnchorAth: btcPrice, modeStartedAt: observedAt },
      event: "NEW_ATH", closeCycleReason: "NEW_ATH", startNormalCycle: false
    };
  }
  const anchor = current.defensiveAnchorAth ?? current.officialAth;
  if (btcPrice > anchor) {
    return {
      state: { ...current, officialAth: Math.max(current.officialAth, btcPrice), defensiveAnchorAth: btcPrice },
      event: "DEFENSIVE_PEAK_UPDATED", closeCycleReason: null, startNormalCycle: false
    };
  }
  if (btcPrice <= anchor * 0.6) {
    return {
      state: { mode: "NORMAL_GROWTH", officialAth: Math.max(current.officialAth, anchor), defensiveAnchorAth: null, modeStartedAt: observedAt },
      event: "STRONG_BOTTOM_REACHED", closeCycleReason: "STRONG_BOTTOM_REACHED", startNormalCycle: true
    };
  }
  return { state: current, event: "NONE", closeCycleReason: null, startNormalCycle: false };
}

export function getEntrySpacing(asset: OfficialAsset, mode: OfficialStrategyMode) {
  return OFFICIAL_ENTRY_SPACING[mode][asset];
}

export function getCycleEnd(startAt: string | Date) {
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) throw new Error("COINOPS_OFFICIAL_CYCLE_START_INVALID");
  return new Date(start.getTime() + OFFICIAL_CYCLE_DAYS * 86_400_000);
}

export function isInsideCycle(at: string | Date, startAt: string | Date) {
  const value = new Date(at).getTime();
  const start = new Date(startAt).getTime();
  const end = getCycleEnd(startAt).getTime();
  return value >= start && value < end;
}

export type CycleProgressParts = { real: number; redistributionIn: number; redistributionOut: number; externalEquivalent: number };
export function calculateCycleProgress(parts: CycleProgressParts) {
  const values = [parts.real, parts.redistributionIn, parts.redistributionOut, parts.externalEquivalent];
  if (!values.every(Number.isFinite)) throw new Error("COINOPS_OFFICIAL_PROGRESS_INVALID");
  return parts.real + parts.redistributionIn - parts.redistributionOut + parts.externalEquivalent;
}

export type QueueSlot = {
  id: string;
  slotNumber: number;
  pool: SlotPool;
  enabled: boolean;
  funded: boolean;
  activeFromCycleNumber: number;
  operationalGains: number;
  operationalValue: number;
  cycleProgress: number;
  lastOperatedAt: string | null;
};

function stableSlotOrder(first: QueueSlot, second: QueueSlot) {
  const firstTime = first.lastOperatedAt ? new Date(first.lastOperatedAt).getTime() : 0;
  const secondTime = second.lastOperatedAt ? new Date(second.lastOperatedAt).getTime() : 0;
  return firstTime - secondTime || first.slotNumber - second.slotNumber || first.id.localeCompare(second.id);
}

export function isPoolEligible(slot: QueueSlot, cycleNumber: number, allowReserve: boolean) {
  return slot.enabled && slot.funded && slot.activeFromCycleNumber <= cycleNumber && (slot.pool === "MAIN" || allowReserve);
}

export function rankNormalCandidates(slots: QueueSlot[], target: number, cycleNumber: number, allowReserve = false) {
  return slots
    .filter((slot) => isPoolEligible(slot, cycleNumber, allowReserve) && slot.cycleProgress < target)
    .sort((first, second) => first.cycleProgress - second.cycleProgress
      || first.operationalGains - second.operationalGains
      || stableSlotOrder(first, second));
}

export function rankDefensiveCandidates(slots: QueueSlot[], cycleNumber: number, allowReserve = false) {
  return slots
    .filter((slot) => isPoolEligible(slot, cycleNumber, allowReserve))
    .sort((first, second) => Number(first.operationalGains !== 0) - Number(second.operationalGains !== 0)
      || first.operationalGains - second.operationalGains
      || first.operationalValue - second.operationalValue
      || stableSlotOrder(first, second));
}

export function allNormalTargetsMet(slots: QueueSlot[], target: number, cycleNumber: number) {
  const eligible = slots.filter((slot) => isPoolEligible(slot, cycleNumber, false));
  return eligible.length > 0 && eligible.every((slot) => slot.cycleProgress >= target);
}

export function poolForSlotNumber(slotNumber: number): SlotPool {
  if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > 50) throw new Error("COINOPS_OFFICIAL_SLOT_NUMBER_INVALID");
  return slotNumber <= 25 ? "MAIN" : "RESERVE";
}
