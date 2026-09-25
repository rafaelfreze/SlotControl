/** Linear illustration for a number of completed slot gains; never a trading decision. */
export function estimateSlotGains(capital: number, slotCount: number, gainRate: number, count: number): number | null {
  if (![capital, slotCount, gainRate, count].every(Number.isFinite) || capital <= 0 || slotCount <= 0
    || !Number.isInteger(slotCount) || gainRate <= 0 || count < 0 || !Number.isInteger(count)) return null;
  return count * (capital / slotCount) * gainRate;
}
