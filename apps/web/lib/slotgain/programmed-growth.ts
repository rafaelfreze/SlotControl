export type GrowthAsset = "BTC" | "SOL";
export type GrowthSlotStatus = "zerado" | "aberto" | "gain" | "hold";

export type GrowthPlanSlot = {
  id: string;
  slotNumber: number;
  sortOrder: number;
  status: GrowthSlotStatus;
  gains: number;
  operationalValue: number;
  gainRate: number;
};

export function getGrowthMonthNumber(startedAt: Date, now = new Date()) {
  return Math.max(1, (now.getFullYear() - startedAt.getFullYear()) * 12 + now.getMonth() - startedAt.getMonth() + 1);
}

export function isClosedGrowthSlot(status: GrowthSlotStatus) {
  return status === "gain" || status === "zerado";
}

export function selectGrowthLeader(slots: GrowthPlanSlot[]) {
  return slots
    .filter((slot) => isClosedGrowthSlot(slot.status))
    .toSorted((first, second) => second.gains - first.gains || first.slotNumber - second.slotNumber || first.sortOrder - second.sortOrder || first.id.localeCompare(second.id))[0] || null;
}

export function getRequiredGrowthContribution(operationalValue: number, gainRate: number, missingGains: number) {
  if (!Number.isFinite(operationalValue) || operationalValue < 0 || !Number.isFinite(gainRate) || gainRate <= 0 || !Number.isInteger(missingGains) || missingGains <= 0) {
    return 0;
  }

  return Number((operationalValue * (Math.pow(1 + gainRate, missingGains) - 1)).toFixed(8));
}

export function buildProgrammedGrowthPlan(monthlyGoal: number, startedAt: Date, slots: GrowthPlanSlot[], now = new Date()) {
  const monthNumber = getGrowthMonthNumber(startedAt, now);
  const cumulativeGoal = monthNumber * monthlyGoal;
  const leader = selectGrowthLeader(slots);
  const missingGains = leader ? Math.max(cumulativeGoal - leader.gains, 0) : null;

  return {
    monthNumber,
    cumulativeGoal,
    leader,
    missingGains,
    requiredContribution: leader && missingGains !== null
      ? getRequiredGrowthContribution(leader.operationalValue, leader.gainRate, missingGains)
      : 0
  };
}
