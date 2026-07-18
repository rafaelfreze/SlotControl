export type RedistributionAsset = "BTC" | "SOL";
export type RedistributionSlotStatus = "zerado" | "aberto" | "gain" | "hold";

export type RedistributionSlot = {
  id: string;
  slotNumber: number;
  sortOrder: number;
  status: RedistributionSlotStatus;
  gains: number;
};

export type RedistributionSelectionReason = "OPEN_SLOT" | "CLOSED_LOWEST_GAIN";

export type RedistributionPreviewSlot = RedistributionSlot & {
  gainsAfter: number;
  selectionReason: RedistributionSelectionReason;
};

export type RedistributionPreview =
  | {
      ok: true;
      asset: RedistributionAsset;
      targetSlotCount: number;
      openSlotCount: number;
      closedSlotCount: number;
      totalGainsBefore: number;
      totalGainsAfter: number;
      baseGain: number;
      remainderGain: number;
      selectedSlots: RedistributionPreviewSlot[];
    }
  | {
      ok: false;
      code: "INSUFFICIENT_SLOTS" | "INVALID_SLOT";
      message: string;
      targetSlotCount: number;
    };

export const REDISTRIBUTION_TARGETS: Record<RedistributionAsset, number> = {
  BTC: 15,
  SOL: 6
};

function naturalOrder(first: RedistributionSlot, second: RedistributionSlot) {
  return first.slotNumber - second.slotNumber || first.sortOrder - second.sortOrder || first.id.localeCompare(second.id);
}

function lowestGainOrder(first: RedistributionSlot, second: RedistributionSlot) {
  return first.gains - second.gains || naturalOrder(first, second);
}

function isValidSlot(slot: RedistributionSlot) {
  return (
    Boolean(slot.id) &&
    Number.isInteger(slot.slotNumber) &&
    slot.slotNumber > 0 &&
    Number.isInteger(slot.sortOrder) &&
    slot.sortOrder > 0 &&
    Number.isInteger(slot.gains) &&
    slot.gains >= 0
  );
}

export function selectSlotsForGainRedistribution(asset: RedistributionAsset, slots: RedistributionSlot[]) {
  const targetSlotCount = REDISTRIBUTION_TARGETS[asset];
  const openSlots = slots.filter((slot) => slot.status === "aberto");
  const closedSlots = slots.filter((slot) => slot.status !== "aberto");

  const selectedOpenSlots =
    openSlots.length > targetSlotCount ? [...openSlots].sort(lowestGainOrder).slice(0, targetSlotCount) : [...openSlots].sort(naturalOrder);
  const selectedClosedSlots =
    selectedOpenSlots.length >= targetSlotCount
      ? []
      : [...closedSlots].sort(lowestGainOrder).slice(0, targetSlotCount - selectedOpenSlots.length);

  return [
    ...selectedOpenSlots.map((slot) => ({ slot, selectionReason: "OPEN_SLOT" as const })),
    ...selectedClosedSlots.map((slot) => ({ slot, selectionReason: "CLOSED_LOWEST_GAIN" as const }))
  ];
}

export function buildGainRedistributionPreview(asset: RedistributionAsset, slots: RedistributionSlot[]): RedistributionPreview {
  const targetSlotCount = REDISTRIBUTION_TARGETS[asset];
  const selected = selectSlotsForGainRedistribution(asset, slots);

  if (selected.some(({ slot }) => !isValidSlot(slot))) {
    return {
      ok: false,
      code: "INVALID_SLOT",
      message: "Ha dados invalidos nos slots selecionados.",
      targetSlotCount
    };
  }

  if (selected.length !== targetSlotCount) {
    return {
      ok: false,
      code: "INSUFFICIENT_SLOTS",
      message: "Nao ha slots suficientes para completar a redistribuicao.",
      targetSlotCount
    };
  }

  const totalGainsBefore = selected.reduce((sum, { slot }) => sum + slot.gains, 0);
  const baseGain = Math.floor(totalGainsBefore / targetSlotCount);
  const remainderGain = totalGainsBefore % targetSlotCount;
  const distributionOrder = [...selected].sort((first, second) => lowestGainOrder(first.slot, second.slot));
  const gainsAfterById = new Map(distributionOrder.map(({ slot }, index) => [slot.id, baseGain + (index < remainderGain ? 1 : 0)]));
  const selectedSlots = selected
    .map(({ slot, selectionReason }) => ({ ...slot, selectionReason, gainsAfter: gainsAfterById.get(slot.id) ?? baseGain }))
    .sort((first, second) => naturalOrder(first, second));

  return {
    ok: true,
    asset,
    targetSlotCount,
    openSlotCount: selected.filter(({ selectionReason }) => selectionReason === "OPEN_SLOT").length,
    closedSlotCount: selected.filter(({ selectionReason }) => selectionReason === "CLOSED_LOWEST_GAIN").length,
    totalGainsBefore,
    totalGainsAfter: selectedSlots.reduce((sum, slot) => sum + slot.gainsAfter, 0),
    baseGain,
    remainderGain,
    selectedSlots
  };
}
