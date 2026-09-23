import { buildPostAthQueue, orderedPostAthSlots, validateAthParameters, type AthParameters, type AthRegime, type AthSlot,
  type PostAthGroup } from "./ath-regime.ts";
import { MONTHLY_SLOT_TARGET } from "./monthly-slot-policy.ts";
import type { V1Asset } from "./robot-v1.ts";

export type AthLadderSlot = AthSlot & {
  buyPrice: number;
  entryOrigin: "GRID" | "REENTRY";
  operationSequence: number;
  status: string;
};

export type AthLadderDecision = {
  physicalSlotId: string;
  physicalSlotNumber: number;
  previousBuyPrice: number;
  nextBuyPrice: number;
  operationalRank: number | null;
  postAthGroup: PostAthGroup | null;
  postAthGroupRank: number | null;
  frozenReason: "OPEN_OR_TP" | "LOCAL_REENTRY" | "MONTHLY_TARGET" | "INELIGIBLE" | null;
};

export function validateAthTransitionedGrid(slots: ReadonlyArray<{ physicalSlotNumber: number;
  buyPrice: number; status: string; operationalRank: number | null }>, tick: number) {
  const errors: string[] = [];
  if (slots.length !== 25) errors.push("SLOT_COUNT_INVALID");
  if (!Number.isFinite(tick) || tick <= 0) errors.push("PRICE_TICK_INVALID");
  const numbers = new Set<number>(), activeRanks = new Set<number>();
  for (const slot of slots) {
    if (!Number.isInteger(slot.physicalSlotNumber) || slot.physicalSlotNumber < 1
      || slot.physicalSlotNumber > 25 || numbers.has(slot.physicalSlotNumber)) errors.push("PHYSICAL_SLOT_INVALID");
    numbers.add(slot.physicalSlotNumber);
    if (!Number.isFinite(slot.buyPrice) || slot.buyPrice <= 0 || tick <= 0
      || Math.abs(slot.buyPrice / tick - Math.round(slot.buyPrice / tick)) > 1e-6)
      errors.push(`PRICE_TICK_INVALID_${slot.physicalSlotNumber}`);
    if (!Number.isInteger(slot.operationalRank) && slot.operationalRank !== null)
      errors.push(`RANK_INVALID_${slot.physicalSlotNumber}`);
    if (slot.operationalRank !== null) {
      if (slot.operationalRank < 1 || slot.operationalRank > 25 || activeRanks.has(slot.operationalRank))
        errors.push(`RANK_DUPLICATE_OR_INVALID_${slot.physicalSlotNumber}`);
      activeRanks.add(slot.operationalRank);
    }
    if (!["PENDING", "PARTIALLY_FILLED", "OPEN", "TP_ACTIVE", "CLOSED", "CANCELLED"].includes(slot.status))
      errors.push(`STATUS_INVALID_${slot.physicalSlotNumber}`);
  }
  return { valid: errors.length === 0, errors };
}

function floorToTick(value: number, tick: number) {
  const steps = Math.floor(value / tick + 1e-8);
  return Number((steps * tick).toPrecision(15));
}

/** Plans prices, never writes. Existing OPEN/TP, partial fills and local
 * reentries remain frozen. A caller must atomically persist all future GRID
 * targets under its cycle/run lease before allowing another BUY. */
export function planAthLadder(asset: V1Asset, regime: AthRegime, anchorPrice: number,
  parameters: AthParameters, tick: number, slots: readonly AthLadderSlot[]): AthLadderDecision[] {
  if (!Number.isFinite(anchorPrice) || anchorPrice <= 0 || !Number.isFinite(tick) || tick <= 0
    || slots.length !== 25) throw new Error("COINOPS_ATH_LADDER_INPUT_INVALID");
  validateAthParameters(parameters);
  const queue = regime === "POST_ATH" ? buildPostAthQueue(asset, slots) : null;
  const ordered = queue ? orderedPostAthSlots(queue) : [...slots]
    .filter((slot) => !slot.blocked && slot.monthlyGainCount !== null
      && slot.monthlyGainCount < MONTHLY_SLOT_TARGET[asset]
      && ["PLANNED", "PENDING", "ARMED", "CLOSED", "NONE"].includes(slot.entryState))
    .sort((left, right) => right.lifetimeGainCount - left.lifetimeGainCount
      || left.physicalSlotId.localeCompare(right.physicalSlotId));
  const rankById = new Map(ordered.map((slot, index) => [slot.physicalSlotId, index + 1]));
  const grouped = new Map(queue?.map((slot) => [slot.physicalSlotId, slot]) ?? []);
  const hasOpen = slots.some((slot) => ["OPEN", "TP_ACTIVE", "PARTIALLY_FILLED"].includes(slot.status));
  const spacing = regime === "POST_ATH" ? parameters.postAthSpacing : parameters.normalSpacing;
  const computed = new Map<string, number>();
  let nextLevel = hasOpen ? 1 : 0;
  for (const slot of ordered) {
    const physical = slots.find((item) => item.physicalSlotId === slot.physicalSlotId)!;
    if (physical.entryOrigin === "REENTRY") continue;
    const target = floorToTick(anchorPrice * (1 - spacing) ** nextLevel, tick);
    if (!Number.isFinite(target) || target <= 0) throw new Error("COINOPS_ATH_LADDER_FILTER_INVALID");
    computed.set(slot.physicalSlotId, target);
    nextLevel++;
  }
  const priceKeys = new Set<string>();
  const decisions = slots.map((slot): AthLadderDecision => {
    const group = grouped.get(slot.physicalSlotId);
    const reached = slot.monthlyGainCount !== null && slot.monthlyGainCount >= MONTHLY_SLOT_TARGET[asset];
    const frozenReason = ["OPEN", "TP_ACTIVE", "PARTIALLY_FILLED"].includes(slot.status) ? "OPEN_OR_TP" as const
      : slot.entryOrigin === "REENTRY" ? "LOCAL_REENTRY" as const
        : reached ? "MONTHLY_TARGET" as const : !rankById.has(slot.physicalSlotId) ? "INELIGIBLE" as const : null;
    const nextBuyPrice = frozenReason ? slot.buyPrice : computed.get(slot.physicalSlotId)!;
    if (!Number.isFinite(nextBuyPrice) || nextBuyPrice <= 0) throw new Error("COINOPS_ATH_LADDER_PRICE_INVALID");
    if (!frozenReason) {
      const key = nextBuyPrice.toFixed(8);
      if (priceKeys.has(key)) throw new Error("COINOPS_ATH_LADDER_PRICE_COLLISION");
      priceKeys.add(key);
    }
    return { physicalSlotId: slot.physicalSlotId, physicalSlotNumber: slot.physicalSlotNumber,
      previousBuyPrice: slot.buyPrice, nextBuyPrice, operationalRank: rankById.get(slot.physicalSlotId) ?? null,
      postAthGroup: group?.postAthGroup ?? null, postAthGroupRank: group?.postAthGroupRank ?? null,
      frozenReason };
  });
  return decisions;
}
