"use client";

import { useState } from "react";
import { estimateSlotGains } from "@/lib/coinops-viewer/gain-estimate";

type Market = { symbol: string; currency: string; balances: number[]; gainRate: number };
const fmt = (value: number, currency: string) => currency === "BRL"
  ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value)
  : `${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} ${currency}`;

function GainEstimate({ market }: { market: Market }) {
  const [count, setCount] = useState(10);
  const estimated = estimateSlotGains(market.balances, market.gainRate, count);
  return <div className="viewer-sim-market"><h3><span className={`viewer-coin viewer-coin--${market.symbol.startsWith("BTC") ? "btc" : "sol"}`} aria-hidden="true">{market.symbol.startsWith("BTC") ? "₿" : "◎"}</span>{market.symbol.replace(market.currency, `/${market.currency}`)}</h3>
    <div className="viewer-sim-row"><label>Gains por slot<input type="number" inputMode="numeric" min="0" max="10000" value={count} onChange={(event) => setCount(Math.min(10000, Math.max(0, Number(event.target.value) || 0)))} /></label><div><small>Capital projetado por slot (média)</small><strong>{estimated === null ? "—" : fmt(estimated.averageSlotProjected, market.currency)}</strong></div></div>
    <small>Saldo médio atual por slot: {estimated ? fmt(estimated.averageSlotInitial, market.currency) : "—"} · ganho configurado: {market.gainRate > 0 ? `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 }).format(market.gainRate * 100)}%` : "—"}</small>
    <div className="viewer-sim-total"><small>Capital projetado do motor ({market.balances.length} slots)</small><strong>{estimated ? fmt(estimated.projected, market.currency) : "—"}</strong><small>Lucro adicional teórico: {estimated ? fmt(estimated.profit, market.currency) : "—"}</small></div>
  </div>;
}

export function ViewerGainSimulator({ markets }: { markets: Market[] }) {
  if (!markets.length) return null;
  return <section className="viewer-panel viewer-simulator"><header><h2>Simulador de ganhos</h2><span>Veja um cenário com sua estratégia atual</span></header><div className="viewer-simulator-grid">{markets.map((market) => <GainEstimate key={market.symbol} market={market} />)}</div><p className="viewer-sim-note">ⓘ Projeção matemática com reinvestimento em cada slot: saldo atual × (1 + ganho configurado) ^ gains por slot. Pressupõe que todos os slots completem esse número de gains. Não é previsão: não inclui taxas futuras, aportes, variações de preço nem tempo necessário.</p></section>;
}
