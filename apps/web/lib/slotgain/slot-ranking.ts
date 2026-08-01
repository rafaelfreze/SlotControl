export type RankableSlot = {
  id: string;
  gains: number;
  slot_number: number;
  sort_order: number;
};

export function sortSlotsByGains<T extends RankableSlot>(slots: T[]) {
  return [...slots].sort((first, second) => {
    const gainsDiff = Number(second.gains || 0) - Number(first.gains || 0);
    return gainsDiff || first.slot_number - second.slot_number || first.sort_order - second.sort_order || first.id.localeCompare(second.id);
  });
}

export function rankSlotIds<T extends RankableSlot>(slots: T[]) {
  return sortSlotsByGains(slots).reduce<Record<string, number>>((ranks, slot, index) => {
    ranks[slot.id] = index + 1;
    return ranks;
  }, {});
}
