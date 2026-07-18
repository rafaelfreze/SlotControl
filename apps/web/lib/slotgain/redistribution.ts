export type RedistributionAsset = "BTC" | "SOL";
export type RedistributionSlotStatus = "zerado" | "aberto" | "gain" | "hold";

export type RedistributionSlot = {
  id: string;
  slotNumber: number;
  sortOrder: number;
  status: RedistributionSlotStatus;
  gainsDistribuidos: number;
  gains?: number;
  baseValue?: number;
  reinvestedProfit?: number;
  operationalSlotValue?: number;
};

export type RedistributionSlotRole = "RECIPIENT" | "ZEROED";

export type RedistributionPreviewSlot = RedistributionSlot & {
  gainsBefore: number;
  gainsAfter: number;
  role: RedistributionSlotRole;
  reinvestedProfitBefore: number;
  reinvestedProfitAfter: number;
  operationalSlotValueBefore: number;
  operationalSlotValueAfter: number;
};

export type RedistributionPreview =
  | {
      ok: true;
      asset: RedistributionAsset;
      targetSlotCount: number;
      recipientSlotCount: number;
      closedSlotCount: number;
      ignoredOpenSlotCount: number;
      zeroedSlotCount: number;
      totalGainsBefore: number;
      totalGainsAfter: number;
      baseGain: number;
      remainderGain: number;
      totalReinvestedBefore: number;
      totalReinvestedAfter: number;
      baseReinvested: number;
      remainderReinvestedUnits: number;
      closedSlots: RedistributionPreviewSlot[];
      ignoredOpenSlots: RedistributionSlot[];
    }
  | {
      ok: false;
      code: "NO_CLOSED_SLOTS" | "INVALID_SLOT";
      message: string;
      targetSlotCount: number;
    };

export const REDISTRIBUTION_TARGETS: Record<RedistributionAsset, number> = {
  BTC: 15,
  SOL: 6
};

export const CLOSED_SLOT_STATUSES: readonly RedistributionSlotStatus[] = ["gain", "zerado"];
export const OPEN_SLOT_STATUSES: readonly RedistributionSlotStatus[] = ["aberto", "hold"];

export function isClosedSlot(slot: Pick<RedistributionSlot, "status"> | RedistributionSlotStatus) {
  const status = typeof slot === "string" ? slot : slot.status;
  return CLOSED_SLOT_STATUSES.includes(status);
}

export function isOpenSlot(slot: Pick<RedistributionSlot, "status"> | RedistributionSlotStatus) {
  const status = typeof slot === "string" ? slot : slot.status;
  return OPEN_SLOT_STATUSES.includes(status);
}

function naturalOrder(first: RedistributionSlot, second: RedistributionSlot) {
  return first.slotNumber - second.slotNumber || first.sortOrder - second.sortOrder || first.id.localeCompare(second.id);
}

function highestGainOrder(first: RedistributionSlot, second: RedistributionSlot) {
  return second.gainsDistribuidos - first.gainsDistribuidos || naturalOrder(first, second);
}

function isValidSlot(slot: RedistributionSlot) {
  return (
    Boolean(slot.id) &&
    Number.isInteger(slot.slotNumber) &&
    slot.slotNumber > 0 &&
    Number.isInteger(slot.sortOrder) &&
    slot.sortOrder > 0 &&
    Number.isInteger(slot.gainsDistribuidos) &&
    slot.gainsDistribuidos >= 0 &&
    (slot.gains === undefined || (Number.isInteger(slot.gains) && slot.gains >= 0)) &&
    (slot.baseValue === undefined || (Number.isFinite(slot.baseValue) && slot.baseValue >= 0)) &&
    (slot.reinvestedProfit === undefined || (Number.isFinite(slot.reinvestedProfit) && slot.reinvestedProfit >= 0))
  );
}

const MONEY_SCALE = 100_000_000;

function toMoneyUnits(value: number) {
  const units = Math.round(value * MONEY_SCALE);
  if (!Number.isSafeInteger(units) || units < 0) throw new Error("Valor operacional invalido.");
  return units;
}

function fromMoneyUnits(units: number) {
  return units / MONEY_SCALE;
}

export function selectSlotsForGainRedistribution(asset: RedistributionAsset, slots: RedistributionSlot[]) {
  const targetSlotCount = REDISTRIBUTION_TARGETS[asset];
  return slots.filter(isClosedSlot).sort(highestGainOrder).slice(0, targetSlotCount);
}

export function buildGainRedistributionPreview(asset: RedistributionAsset, slots: RedistributionSlot[]): RedistributionPreview {
  const targetSlotCount = REDISTRIBUTION_TARGETS[asset];
  const closedSlots = slots.filter(isClosedSlot);
  const ignoredOpenSlots = slots.filter(isOpenSlot).sort(naturalOrder);

  if (closedSlots.some((slot) => !isValidSlot(slot))) {
    return {
      ok: false,
      code: "INVALID_SLOT",
      message: "Ha dados invalidos nos slots fechados.",
      targetSlotCount
    };
  }

  if (closedSlots.length === 0) {
    return {
      ok: false,
      code: "NO_CLOSED_SLOTS",
      message: "Nao ha slots fechados para redistribuir.",
      targetSlotCount
    };
  }

  const recipients = selectSlotsForGainRedistribution(asset, slots);
  const recipientSlotCount = recipients.length;
  const totalGainsBefore = closedSlots.reduce((sum, slot) => sum + slot.gainsDistribuidos, 0);
  let totalReinvestedUnits = 0;
  try {
    totalReinvestedUnits = closedSlots.reduce((sum, slot) => sum + toMoneyUnits(slot.reinvestedProfit ?? 0), 0);
  } catch {
    return { ok: false, code: "INVALID_SLOT", message: "Ha dados invalidos nos slots fechados.", targetSlotCount };
  }
  const baseGain = Math.floor(totalGainsBefore / recipientSlotCount);
  const remainderGain = totalGainsBefore % recipientSlotCount;
  const baseReinvestedUnits = Math.floor(totalReinvestedUnits / recipientSlotCount);
  const remainderReinvestedUnits = totalReinvestedUnits % recipientSlotCount;
  const recipientIds = new Set(recipients.map((slot) => slot.id));
  const recipientRank = new Map(recipients.map((slot, index) => [slot.id, index]));
  const closedPreviewSlots = closedSlots
    .map((slot): RedistributionPreviewSlot => {
      const rank = recipientRank.get(slot.id);
      const role: RedistributionSlotRole = recipientIds.has(slot.id) ? "RECIPIENT" : "ZEROED";
      const baseValue = Number(slot.baseValue ?? 0);
      const reinvestedProfitBefore = Number(slot.reinvestedProfit ?? 0);
      const reinvestedProfitAfter = role === "RECIPIENT" ? fromMoneyUnits(baseReinvestedUnits + ((rank ?? 0) < remainderReinvestedUnits ? 1 : 0)) : 0;
      return {
        ...slot,
        gainsBefore: slot.gainsDistribuidos,
        gainsAfter: role === "RECIPIENT" ? baseGain + ((rank ?? 0) < remainderGain ? 1 : 0) : 0,
        role,
        reinvestedProfitBefore,
        reinvestedProfitAfter,
        operationalSlotValueBefore: Number(slot.operationalSlotValue ?? baseValue + reinvestedProfitBefore),
        operationalSlotValueAfter: baseValue + reinvestedProfitAfter
      };
    })
    .sort((first, second) => {
      if (first.role !== second.role) return first.role === "RECIPIENT" ? -1 : 1;
      return first.role === "RECIPIENT" ? highestGainOrder(first, second) : naturalOrder(first, second);
    });

  return {
    ok: true,
    asset,
    targetSlotCount,
    recipientSlotCount,
    closedSlotCount: closedSlots.length,
    ignoredOpenSlotCount: ignoredOpenSlots.length,
    zeroedSlotCount: closedSlots.length - recipientSlotCount,
    totalGainsBefore,
    totalGainsAfter: closedPreviewSlots.reduce((sum, slot) => sum + slot.gainsAfter, 0),
    baseGain,
    remainderGain,
    totalReinvestedBefore: fromMoneyUnits(totalReinvestedUnits),
    totalReinvestedAfter: fromMoneyUnits(totalReinvestedUnits),
    baseReinvested: fromMoneyUnits(baseReinvestedUnits),
    remainderReinvestedUnits,
    closedSlots: closedPreviewSlots,
    ignoredOpenSlots
  };
}
