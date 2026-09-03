export function getMonthlyGrowthStatus(monthlyGoal: number, realGainsMonth: number) {
  const normalizedGoal = Number.isFinite(monthlyGoal) && monthlyGoal > 0 ? monthlyGoal : 0;
  const normalizedRealGains = Number.isFinite(realGainsMonth) && realGainsMonth > 0 ? realGainsMonth : 0;
  const missing = Math.max(Math.ceil(normalizedGoal - normalizedRealGains), 0);

  return {
    missing,
    label: missing > 0 ? `Faltam ${missing}` : "OK"
  };
}
