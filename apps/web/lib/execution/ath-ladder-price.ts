/** Shared executable GRID price. Browser-safe: no identity, state or I/O. */
export function athLadderLevelPrice(anchorPrice: number, spacing: number, level: number, tick: number) {
  const value = anchorPrice * (1 - spacing) ** level;
  const steps = Math.floor(value / tick + 1e-8);
  return Number((steps * tick).toPrecision(15));
}
