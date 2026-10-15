import { isOperationalNextBuy, isOperationalOpen } from "../../lib/slotgain/operational-slot-order.ts";

/** UI ordering only. Never use this helper to select an entry, assign a rank,
 * determine eligibility or change a financial/strategy record. */
export type SlotDisplayKey = {
  physicalSlotNumber: number;
  entryState: string;
};

function displayGroup(slot: SlotDisplayKey) {
  if (isOperationalOpen(slot.entryState)) return 0;
  if (isOperationalNextBuy(slot.entryState)) return 1;
  return 2;
}

export function compareSlotDisplayRows(a: SlotDisplayKey, b: SlotDisplayKey) {
  const group = displayGroup(a) - displayGroup(b);
  if (group) return group;
  // Keep the existing order of future entries. The visual preference for OPEN
  // positions must not reimplement or override the Strategy Engine's ladder.
  if (!isOperationalOpen(a.entryState)) return 0;
  return a.physicalSlotNumber - b.physicalSlotNumber;
}

/** Returns a new array, preserving records and incoming future-entry order. */
export function orderSlotDisplayRows<T>(rows: readonly T[], key: (row: T) => SlotDisplayKey): T[] {
  return [...rows].sort((a, b) => compareSlotDisplayRows(key(a), key(b)));
}
