import { normalizeToStep } from "./binance-spot-adapter.ts";
import type { ExchangeSymbolInfo } from "./types.ts";

/** Public GET snapshot, 2026-09-22 21:10 UTC. Recheck before any future pilot. */
export const SOL_BRL_PUBLIC_SNAPSHOT = {
  observedAt: "2026-09-22T21:10:17.608Z",
  status: "TRADING",
  priceBrl: 601.6,
  filters: { symbol: "SOLBRL", baseAsset: "SOL", quoteAsset: "BRL", minQuantity: .001, maxQuantity: 9222449, minNotional: 10, quantityStep: .001, priceTick: .1 } satisfies ExchangeSymbolInfo,
  orderTypes: ["LIMIT", "MARKET", "LIMIT_MAKER"]
};

/** Public market-data estimate only. It cannot enable or send LIVE orders. */
export function assessSolBrlPilot(filters: ExchangeSymbolInfo, observedPrice: number, desiredPerSlotBrl = 10) {
  if (filters.symbol !== "SOLBRL" || filters.baseAsset !== "SOL" || filters.quoteAsset !== "BRL" || !Number.isFinite(observedPrice) || observedPrice <= 0 || !Number.isFinite(desiredPerSlotBrl) || desiredPerSlotBrl <= 0) throw new Error("COINOPS_LIVE_SYMBOL_BLOCKED");
  const minimumQuantity = Math.max(filters.minQuantity, Math.ceil((filters.minNotional / observedPrice - 1e-12) / filters.quantityStep) * filters.quantityStep);
  const executableQuantity = normalizeToStep(desiredPerSlotBrl / observedPrice, filters.quantityStep);
  const executableNotional = Number((executableQuantity * observedPrice).toFixed(8));
  const minimumPerSlotBrl = Number((minimumQuantity * observedPrice).toFixed(8));
  return { desiredPerSlotBrl, accepted: executableQuantity >= filters.minQuantity && executableNotional >= filters.minNotional, executableQuantity, executableNotional, minimumQuantity, minimumPerSlotBrl, minimumCapitalFor25SlotsBrl: Number((minimumPerSlotBrl * 25).toFixed(8)) };
}

export function validateFutureSolBrlCaps(asset: "BTC" | "SOL", capitalBrl: number, maxOrderBrl: number, maxExposureBrl: number) {
  if (asset !== "SOL" || ![capitalBrl, maxOrderBrl, maxExposureBrl].every(Number.isFinite) || maxOrderBrl <= 0 || maxExposureBrl < maxOrderBrl || capitalBrl < maxExposureBrl) throw new Error("COINOPS_LIVE_CAP_INVALID");
  return { capitalBrl, maxOrderBrl, maxExposureBrl };
}
