"use client";

import { useState } from "react";
import { estimateSlotGains } from "@/lib/coinops-viewer/gain-estimate";

type Market = { symbol: string; currency: string; capital: number; gainRate: number; slotCount: number };
const fmt = (value: number, currency: string) => currency === "BRL"
  ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value)
  : `${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} ${currency}`;

function GainEstimate({ market }: { market: Market }) {
  const [count, setCount] = useState(10);
  const slotCount = market.slotCount;
  const valid = market.capital > 0 && market.gainRate > 0 && slotCount > 0;
  // A gain is one completed slot operation, not a return on the whole engine.
  const estimated = estimateSlotGains(market.capital, slotCount, market.gainRate, count);
  return <div className="viewer-sim-market"><h3><span className={`viewer-coin viewer-coin--${market.symbol.startsWith("BTC") ? "btc" : "sol"}`} aria-hidden="true">{market.symbol.startsWith("BTC") ? "₿" : "◎"}</span>{market.symbol.replace(market.currency, `/${market.currency}`)}</h3>
    <div className="viewer-sim-row"><label>Nº de gains<input type="number" inputMode="numeric" min="0" max="10000" value={count} onChange={(event) => setCount(Math.min(10000, Math.max(0, Number(event.target.value) || 0)))} /></label><div><small>Ganho estimado</small><strong>{estimated === null ? "—" : `+${fmt(estimated, market.currency)}`}</strong></div></div>
    <small>Capital por slot: {valid ? fmt(market.capital / slotCount, market.currency) : "—"} · ganho configurado: {market.gainRate > 0 ? `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 }).format(market.gainRate * 100)}%` : "—"}</small>
  </div>;
}

export function ViewerGainSimulator({ markets }: { markets: Market[] }) {
  if (!markets.length) return null;
  return <section className="viewer-panel viewer-simulator"><header><h2>Simulador de ganhos</h2><span>Veja um cenário com sua estratégia atual</span></header><div className="viewer-simulator-grid">{markets.map((market) => <GainEstimate key={market.symbol} market={market} />)}</div><p className="viewer-sim-note">ⓘ Estimativa linear: número de gains × capital por slot × ganho configurado. Não inclui taxas, compounding nem variação de preço; resultados reais podem diferir.</p></section>;
}
