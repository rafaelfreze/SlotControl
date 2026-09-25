import { athLadderLevelPrice } from "./ath-ladder-price.ts";
import { calculateStrategyTakeProfit } from "./strategy-engine.ts";

const fail = (): never => { throw new Error("COINOPS_STRATEGY_PRICE_INVARIANT_FAILED"); };
const samePrice = (left: number, right: number, tick: number) =>
  Math.abs(left - right) <= Math.max(1e-10, tick * 1e-6);

function assertTickPrice(price: number, tick: number) {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tick) || tick <= 0
    || Math.abs(price / tick - Math.round(price / tick)) > 1e-6) fail();
}

/** A BUY is tied to the immutable slot reference, not to the latest quote or
 * to compounding capital. GRID references must also belong to the cycle's
 * geometric 25-level ladder (or to a recorded ATH transition anchor). */
export function assertStrategyBuyPrice(input: { price: number; referencePrice: number;
  anchorPrice: number; spacing: number; tick: number; entryOrigin: "GRID" | "REENTRY" }) {
  assertTickPrice(input.price, input.tick);
  if (!Number.isFinite(input.referencePrice) || !samePrice(input.price, input.referencePrice, input.tick)) fail();
  if (input.entryOrigin === "GRID") {
    if (!Number.isFinite(input.anchorPrice) || input.anchorPrice <= 0
      || !Number.isFinite(input.spacing) || input.spacing <= 0 || input.spacing >= 1) fail();
    if (!Array.from({ length: 25 }, (_, level) => athLadderLevelPrice(input.anchorPrice,
      input.spacing, level, input.tick)).some((expected) => samePrice(input.price, expected, input.tick))) fail();
  } else if (input.entryOrigin !== "REENTRY") fail();
  return input.price;
}

/** TP is computed from the actual average BUY fill, never from the ladder or
 * quoted MARKET price. Binance tick rounding is the only accepted delta. */
export function assertStrategyTakeProfitPrice(input: { price: number; averageFillPrice: number;
  gainRate: number; tick: number; spacing: number }) {
  assertTickPrice(input.price, input.tick);
  const expected = calculateStrategyTakeProfit(input.averageFillPrice, input.tick,
    { gainRate: input.gainRate, entrySpacing: input.spacing });
  if (!samePrice(input.price, expected, input.tick)) fail();
  return expected;
}
