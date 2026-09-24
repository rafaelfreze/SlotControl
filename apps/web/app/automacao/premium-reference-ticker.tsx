"use client";

import { useLivePrices } from "@/lib/slotgain/live-prices";
import { displayNumber } from "./premium-primitives";

/** One existing market subscription; USDT reference never enters BRL/USDC accounting. */
export function PremiumReferenceTicker() {
  const market = useLivePrices();
  return <div className="px-reference-ticker" aria-label="Mercado de referência USDT">
    <span>Mercado de referência · USDT</span>
    <span>BTC <strong>{displayNumber(market.prices.BTC)}</strong></span>
    <span>SOL <strong>{displayNumber(market.prices.SOL)}</strong></span>
    <small>{market.status === "online" ? "ONLINE" : market.isStale ? "DESATUALIZADO" : "AGUARDANDO"} · não usado no P&amp;L dos pares BRL/USDC</small>
  </div>;
}
