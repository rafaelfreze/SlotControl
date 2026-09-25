import { distributeLiveCapital } from "./live-capital-distribution.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BulkEngineShare = { engineId: string; amount: number };
export type SlotAllocation = { engineId: string; slotNumber: number; amount: number };
export type SlotAdjustmentInput = { balanceBefore: number; committed: number; amount: number;
  gainUnits: number; monthlyBefore: number; lifetimeBefore: number; open: boolean };

/** Projection only. A live OPEN position is immutable; any credit remains in
 * the slot account until a future operation consumes it. */
export function projectSlotAdjustment<T extends SlotAdjustmentInput>(slot: T): T & {
  balanceAfter: number; monthlyAfter: number; lifetimeAfter: number;
  committedAfter: number; pendingForNextOperation: number;
} {
  if (!Number.isFinite(slot.balanceBefore) || !Number.isFinite(slot.committed)
    || !Number.isFinite(slot.amount) || !Number.isInteger(slot.gainUnits))
    throw new Error("COINOPS_ADJUSTMENT_SLOT_INVALID");
  return { ...slot, balanceAfter: Number((slot.balanceBefore + slot.amount).toFixed(8)),
    monthlyAfter: slot.monthlyBefore + slot.gainUnits,
    lifetimeAfter: slot.lifetimeBefore + slot.gainUnits,
    committedAfter: slot.committed,
    pendingForNextOperation: slot.open ? slot.amount : 0 };
}

function cents(value: number): number {
  const rounded = Math.round(value * 100);
  if (!Number.isSafeInteger(rounded) || rounded <= 0 || Math.abs(value * 100 - rounded) > 1e-7)
    throw new Error("COINOPS_ADJUSTMENT_PRECISION_INVALID");
  return rounded;
}

export function splitBulkEngines(total: number, engineIds: string[], firstEnginePercent = 50): BulkEngineShare[] {
  const totalCents = cents(total);
  if (engineIds.length < 1 || engineIds.length > 2 || new Set(engineIds).size !== engineIds.length
    || engineIds.some((id) => !UUID.test(id)) || !Number.isFinite(firstEnginePercent)
    || firstEnginePercent <= 0 || firstEnginePercent >= 100 && engineIds.length === 2)
    throw new Error("COINOPS_ADJUSTMENT_ENGINE_SELECTION_INVALID");
  if (engineIds.length === 1) return [{ engineId: engineIds[0], amount: total }];
  const first = Math.round(totalCents * firstEnginePercent / 100);
  if (first < 25 || totalCents - first < 25)
    throw new Error("COINOPS_ADJUSTMENT_SLOT_MINIMUM_INVALID");
  return [{ engineId: engineIds[0], amount: first / 100 },
    { engineId: engineIds[1], amount: (totalCents - first) / 100 }];
}

export function allocateBulkSlots(total: number, shares: BulkEngineShare[]): SlotAllocation[] {
  const totalCents = cents(total);
  if (shares.length < 1 || shares.length > 2 || new Set(shares.map((share) => share.engineId)).size !== shares.length
    || shares.some((share) => !UUID.test(share.engineId))
    || shares.reduce((sum, share) => sum + cents(share.amount), 0) !== totalCents)
    throw new Error("COINOPS_ADJUSTMENT_DISTRIBUTION_INVALID");
  return shares.flatMap((share) => distributeLiveCapital(share.amount).map((amount, index) => ({
    engineId: share.engineId, slotNumber: index + 1, amount,
  })));
}
