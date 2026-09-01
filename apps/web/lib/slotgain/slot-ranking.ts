export type RankableSlot = {
  id: string;
  gains: number | string;
  operational_gains?: number | string | null;
  slot_number: number;
  sort_order: number;
  position_opened_at?: string | null;
};

type OperationalListSlot = RankableSlot & { status: string };

export function getOperationalGains(slot: RankableSlot) {
  const operationalGains = Number(slot.operational_gains);
  return Number.isFinite(operationalGains) ? operationalGains : Number(slot.gains || 0);
}

function compareStableSlotOrder(first: RankableSlot, second: RankableSlot) {
  return first.slot_number - second.slot_number
    || first.sort_order - second.sort_order
    || first.id.localeCompare(second.id);
}

function parsePositionOpenedAt(slot: RankableSlot) {
  if (!slot.position_opened_at) return null;
  const timestamp = Date.parse(slot.position_opened_at);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function compareSlotsByOldestOpenPosition(first: RankableSlot, second: RankableSlot) {
  const firstOpenedAt = parsePositionOpenedAt(first);
  const secondOpenedAt = parsePositionOpenedAt(second);

  if (firstOpenedAt !== null && secondOpenedAt !== null && firstOpenedAt !== secondOpenedAt) {
    return firstOpenedAt - secondOpenedAt;
  }
  if (firstOpenedAt !== null) return -1;
  if (secondOpenedAt !== null) return 1;
  return compareStableSlotOrder(first, second);
}

export function sortSlotsByGains<T extends RankableSlot>(slots: T[]) {
  return [...slots].sort((first, second) => {
    const gainsDiff = getOperationalGains(second) - getOperationalGains(first);
    return gainsDiff || compareStableSlotOrder(first, second);
  });
}

export function sortOpenSlotsByOldestPosition<T extends RankableSlot>(slots: T[]) {
  return [...slots].sort(compareSlotsByOldestOpenPosition);
}

export function sortSlotsForOperationalList<T extends OperationalListSlot>(slots: T[]) {
  return [...slots].sort((first, second) => {
    const firstIsOpen = first.status === "aberto";
    const secondIsOpen = second.status === "aberto";

    if (firstIsOpen !== secondIsOpen) return firstIsOpen ? -1 : 1;
    if (firstIsOpen) return compareSlotsByOldestOpenPosition(first, second);

    const gainsDiff = getOperationalGains(second) - getOperationalGains(first);
    return gainsDiff || compareStableSlotOrder(first, second);
  });
}

export function rankSlotIds<T extends RankableSlot>(slots: T[]) {
  return sortSlotsByGains(slots).reduce<Record<string, number>>((ranks, slot, index) => {
    ranks[slot.id] = index + 1;
    return ranks;
  }, {});
}

export function rankOpenSlotIds<T extends RankableSlot>(slots: T[]) {
  return sortOpenSlotsByOldestPosition(slots).reduce<Record<string, number>>((ranks, slot, index) => {
    ranks[slot.id] = index + 1;
    return ranks;
  }, {});
}
