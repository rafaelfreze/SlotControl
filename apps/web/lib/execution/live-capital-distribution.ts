export const LIVE_SLOT_COUNT = 25;

/** Whole quote cents; the first physical slots receive residual cents. */
export function distributeLiveCapital(capital: number, slots = LIVE_SLOT_COUNT): number[] {
  const cents = Math.round(capital * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0 || Math.abs(capital * 100 - cents) > 1e-7
    || !Number.isInteger(slots) || slots < 1 || slots > LIVE_SLOT_COUNT)
    throw new Error("COINOPS_LIVE_CAP_PRECISION_INVALID");
  const base = Math.floor(cents / slots), remainder = cents % slots;
  if (base <= 0) throw new Error("COINOPS_LIVE_SLOT_CAP_INVALID");
  return Array.from({ length: slots }, (_, index) => (base + (index < remainder ? 1 : 0)) / 100);
}
