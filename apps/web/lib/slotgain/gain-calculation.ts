export function getValueAfterGains(currentValue: number, gainRate: number, gainCount = 1) {
  if (!Number.isFinite(currentValue) || currentValue < 0 || !Number.isFinite(gainRate) || gainRate < 0 || !Number.isInteger(gainCount) || gainCount < 0) {
    return currentValue;
  }

  return currentValue * Math.pow(1 + gainRate, gainCount);
}
