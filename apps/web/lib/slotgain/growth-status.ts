export function getMonthlyGrowthStatus(monthlyGoal: number, realGainsMonth: number) {
  const normalizedGoal = Number.isFinite(monthlyGoal) && monthlyGoal > 0 ? monthlyGoal : 0;
  const normalizedRealGains = Number.isFinite(realGainsMonth) && realGainsMonth > 0 ? realGainsMonth : 0;
  const missing = Math.max(Math.ceil(normalizedGoal - normalizedRealGains), 0);

  return {
    missing,
    label: missing > 0 ? `Faltam ${missing}` : "OK"
  };
}

type OfficialCycleGrowth = {
  target: number | null;
  belowTarget: number;
  nextProgress: number | null;
};

type DashboardGrowthStatusInput = {
  monitoringActive: boolean;
  officialCycle: OfficialCycleGrowth | null;
  legacyGoal: number;
  legacyRealGains: number;
};

export function getDashboardGrowthStatus({
  monitoringActive,
  officialCycle,
  legacyGoal,
  legacyRealGains
}: DashboardGrowthStatusInput) {
  if (!monitoringActive || !officialCycle) {
    return getMonthlyGrowthStatus(legacyGoal, legacyRealGains);
  }

  if (officialCycle.target === null) {
    return { missing: 0, label: "Meta pausada" };
  }

  if (officialCycle.belowTarget <= 0) {
    return { missing: 0, label: "OK" };
  }

  return getMonthlyGrowthStatus(officialCycle.target, officialCycle.nextProgress ?? 0);
}
