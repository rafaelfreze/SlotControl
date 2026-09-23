import { athLadderLevelPrice } from "./ath-ladder-price.ts";

export const ATH_SIMULATION_PRICE_TICK = 0.01;

/** Artificial candles reach the shared ladder's executable prices, not its
 * unrounded formula. This is scenario data only: no operational state or I/O. */
export function buildAthDescentPrices(input: { anchor: number; spacing: number; priceTick?: number }): number[] {
  const tick = input.priceTick ?? ATH_SIMULATION_PRICE_TICK;
  if (!Number.isFinite(input.anchor) || input.anchor <= 0 || !Number.isFinite(input.spacing)
    || input.spacing <= 0 || input.spacing >= 1 || !Number.isFinite(tick) || tick <= 0)
    throw new Error("COINOPS_ATH_SCENARIO_INPUT_INVALID");
  const levels = Array.from({ length: 25 }, (_, level) => athLadderLevelPrice(input.anchor, input.spacing, level, tick));
  if (levels.some((price, index) => price <= 0 || index > 0 && price >= levels[index - 1]!))
    throw new Error("COINOPS_ATH_SCENARIO_FILTER_INVALID");
  // INITIAL MARKET uses the scenario's anchor, including an off-tick input.
  return [input.anchor, ...levels.slice(1)];
}
