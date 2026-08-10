export type LeaderGrowthTarget = {
  targetGains: number;
  missingGains: number;
  suggestedManualGains: number;
};

export function getLeaderGrowthTarget(monthlyGoal: number, cycleNumber: number, leaderOperationalGains: number): LeaderGrowthTarget {
  if (!Number.isInteger(monthlyGoal) || monthlyGoal < 1) {
    throw new Error("Meta mensal inválida.");
  }
  if (!Number.isInteger(cycleNumber) || cycleNumber < 1) {
    throw new Error("Ciclo inválido.");
  }
  if (!Number.isFinite(leaderOperationalGains) || leaderOperationalGains < 0) {
    throw new Error("Gains operacionais inválidos.");
  }

  const targetGains = monthlyGoal * cycleNumber;
  const missingGains = Math.max(0, targetGains - leaderOperationalGains);
  return {
    targetGains,
    missingGains,
    suggestedManualGains: missingGains > 0 ? Math.ceil(missingGains - 0.00000001) : 1
  };
}
