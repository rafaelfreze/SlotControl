/** Read-only projection: each physical slot reinvests its own balance after each gain. */
export function estimateSlotGains(balances: readonly number[], gainRate: number, gainsPerSlot: number) {
  if (!balances.length || balances.some((balance) => !Number.isFinite(balance) || balance < 0)
    || !Number.isFinite(gainRate) || gainRate <= 0 || gainRate > 1
    || !Number.isInteger(gainsPerSlot) || gainsPerSlot < 0) return null;
  const initial = balances.reduce((sum, balance) => sum + balance, 0);
  const factor = (1 + gainRate) ** gainsPerSlot;
  const projected = balances.reduce((sum, balance) => sum + balance * factor, 0);
  if (initial <= 0 || !Number.isFinite(initial) || !Number.isFinite(projected)) return null;
  return { initial, projected, profit: projected - initial,
    averageSlotInitial: initial / balances.length, averageSlotProjected: projected / balances.length };
}
