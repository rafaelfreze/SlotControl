"use client";

import { useEffect, useState } from "react";

type Balance = { asset: string; free: number; locked: number; total: number };
type Snapshot = { balances: Balance[]; observedAt: string | null };
const fmt = (value: number, asset: string) => asset === "BRL"
  ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value)
  : `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 8 }).format(value)} ${asset}`;

export function ViewerLiveBalances({ fallback }: { fallback: Snapshot }) {
  const [snapshot, setSnapshot] = useState(fallback);
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState(true);
  const refresh = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/coinops-viewer-state", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("read-unavailable");
      const body = await response.json() as Snapshot;
      setSnapshot({ balances: body.balances ?? [], observedAt: body.observedAt ?? null });
      setFresh(true);
    } catch { setFresh(false); } finally { setBusy(false); }
  };
  useEffect(() => { void refresh(); }, []);
  return <section className="viewer-panel viewer-live-balance"><div className="viewer-section-title"><h2>Saldo na Binance</h2><button type="button" onClick={() => void refresh()} disabled={busy}>Atualizar</button></div>
    <p className="viewer-footnote">{busy ? "Consultando sua conta pelo executor..." : fresh ? "Leitura direta da Binance · somente consulta" : "Leitura direta indisponível; último registro salvo abaixo, que pode estar desatualizado."}</p>
    <div className="viewer-balance-grid">{snapshot.balances.map((row) => <div key={row.asset}><strong>{row.asset}</strong><span>Livre {fmt(row.free, row.asset)}</span><span>Em ordens {fmt(row.locked, row.asset)}</span></div>)}
      {!snapshot.balances.length ? <p>Saldo ainda não disponível.</p> : null}</div>
    <small className="viewer-footnote">{snapshot.observedAt ? `Observado em ${new Date(snapshot.observedAt).toLocaleString("pt-BR")}` : "Sem horário de leitura confirmado"}</small>
  </section>;
}
