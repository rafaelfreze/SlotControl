"use client";

import type { AutomationMarketState } from "./use-automation-market-prices";
import { displayNumber } from "./premium-primitives";

/** Public market reference never enters exchange execution or the ledger. */
export function PremiumReferenceTicker({ market }: { market: AutomationMarketState }) {
  return <div className="px-reference-ticker" aria-label="Mercado de referência USDT">
    <span>Mercado de referência · USDT</span>
    <span>BTC <strong>{displayNumber(market.prices.BTCUSDT)}</strong></span>
    <span>SOL <strong>{displayNumber(market.prices.SOLUSDT)}</strong></span>
    <small>{market.status === "online" ? "AO VIVO" : market.status === "reconnecting" ? "RECONECTANDO" : "DESATUALIZADO"} · referência pública USDT</small>
  </div>;
}
