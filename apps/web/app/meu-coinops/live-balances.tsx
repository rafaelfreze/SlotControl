"use client";

import { useCallback, useEffect, useState } from "react";

type Balance = { asset: string; free: number; locked: number; total: number };
type Snapshot = { balances: Balance[]; observedAt: string | null };
type Summary = { currency: string; capital: number; committed: number; realized: number; openPnl: number };
const fmt = (value: number, asset: string) => asset === "BRL"
  ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value)
  : `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 8 }).format(value)} ${asset}`;

export function ViewerLiveBalances({ fallback, summaries }: { fallback: Snapshot; summaries: Summary[] }) {
  const [snapshot, setSnapshot] = useState(fallback);
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState(true);
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/coinops-viewer-state", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("read-unavailable");
      const body = await response.json() as Snapshot;
      setSnapshot({ balances: body.balances ?? [], observedAt: body.observedAt ?? null });
      setFresh(true);
    } catch { setFresh(false); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return <section className="viewer-balances" aria-label="Saldo e resultado por moeda">
    {summaries.map((summary) => {
      const balance = snapshot.balances.find((row) => row.asset === summary.currency);
      const pnl = summary.realized + summary.openPnl;
      return <article className="viewer-panel viewer-balance" key={summary.currency}>
        <div className="viewer-balance-main"><span className="viewer-wallet" aria-hidden="true">▱</span><div><span>Saldo na Binance · {summary.currency}</span><strong>{balance ? fmt(balance.total, summary.currency) : "—"}</strong></div>
          <button type="button" onClick={() => void refresh()} disabled={busy} aria-label={`Atualizar saldo ${summary.currency}`}>↻</button></div>
        <div className="viewer-balance-facts"><div><small>Em posições</small><b>{fmt(summary.committed, summary.currency)}</b></div><div><small>Disponível na Binance</small><b>{balance ? fmt(balance.free, summary.currency) : "—"}</b></div><div><small>P&amp;L total estimado</small><b className={pnl >= 0 ? "viewer-up" : "viewer-down"}>{fmt(pnl, summary.currency)}</b></div></div>
        <small className="viewer-balance-source">{busy ? "Consultando Binance..." : fresh ? "Leitura direta da Binance" : "Leitura direta indisponível; dado salvo pode estar desatualizado"} · {snapshot.observedAt ? new Date(snapshot.observedAt).toLocaleString("pt-BR") : "sem horário confirmado"}</small>
        <details className="viewer-balance-detail"><summary>Ver composição do resultado</summary><div><span>Capital operacional CoinOps <strong>{fmt(summary.capital, summary.currency)}</strong></span><span>Resultado realizado <strong>{fmt(summary.realized, summary.currency)}</strong></span><span>Resultado aberto estimado <strong>{fmt(summary.openPnl, summary.currency)}</strong></span></div></details>
      </article>;
    })}
    {!summaries.length ? <article className="viewer-panel viewer-balance"><p>Saldo disponível quando houver um motor ativo.</p></article> : null}
    {snapshot.balances.some((row) => !summaries.some((summary) => summary.currency === row.asset)) ? <details className="viewer-extra-balances"><summary>Outros ativos na Binance</summary>{snapshot.balances.filter((row) => !summaries.some((summary) => summary.currency === row.asset)).map((row) => <p key={row.asset}>{row.asset}: {fmt(row.total, row.asset)} · livre {fmt(row.free, row.asset)}</p>)}</details> : null}
  </section>;
}
