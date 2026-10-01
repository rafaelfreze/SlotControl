/** Presentation only. Rank is supplied by the Strategy Engine/read model;
 * this comparator never computes a rank, price, eligibility or trading action. */
export type OperationalSlotKey = {
  physicalSlotNumber: number;
  operationalRank: number | null;
  entryState: string;
  eligible?: boolean | null;
};

export const isOperationalOpen = (state: string) => ["OPEN", "TP_ACTIVE", "PARTIALLY_FILLED"].includes(state);
export const isOperationalNextBuy = (state: string) => ["ARMED", "NEXT_BUY"].includes(state);

function group(slot: OperationalSlotKey) {
  if (isOperationalOpen(slot.entryState)) return 0;
  if (isOperationalNextBuy(slot.entryState)) return 1;
  if (slot.eligible === false) return 4;
  if (["CLOSED", "REENTRY_WAITING", "NONE", "PENDING", "ELIGIBLE"].includes(slot.entryState)) return 2;
  if (slot.entryState === "PLANNED") return 3;
  return 4;
}

export function compareOperationalSlots(a: OperationalSlotKey, b: OperationalSlotKey) {
  return group(a) - group(b)
    || (a.operationalRank ?? Number.MAX_SAFE_INTEGER) - (b.operationalRank ?? Number.MAX_SAFE_INTEGER)
    || a.physicalSlotNumber - b.physicalSlotNumber;
}

export function orderOperationalSlots<T>(rows: readonly T[], key: (row: T) => OperationalSlotKey): T[] {
  return [...rows].sort((a, b) => compareOperationalSlots(key(a), key(b)));
}

export const ledgerSlotKey = (slot: { slot_number: number; operational_rank: number | null; entry_state: string }) => ({
  physicalSlotNumber: slot.slot_number, operationalRank: slot.operational_rank, entryState: slot.entry_state,
  eligible: slot.operational_rank !== null,
});
