export function getValueForGains(baseValue: number, growthContribution: number, gainRate: number, gains: number) {
  const capital = baseValue + growthContribution;
  if (!Number.isFinite(capital) || capital < 0 || !Number.isFinite(gainRate) || gainRate < 0 || !Number.isInteger(gains) || gains < 0) {
    return capital;
  }

  return Number((capital * ((1 + gainRate) ** gains)).toFixed(8));
}
