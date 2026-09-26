"use client";

import { useEffect, useState } from "react";

type Shard = { id: string; state: string; binanceWeightCurrent: number | null;
  binanceLimit: number; binancePercent: number | null; cpuPercent: number | null;
  ramUsedMb: number | null; schedulerBacklog: number | null; reconciliationAgeMs: number | null;
  accountCount: number; engineCount: number; canAddEngine: boolean; admissionReason: string;
  canAddTwoEngineAccount: boolean;
  alerts: Array<{ code: string }> };

export function CapacityCard() {
  const [shards, setShards] = useState<Shard[] | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/coinops-capacity", { cache: "no-store", signal: abort.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((result) => setShards(Array.isArray(result?.shards) ? result.shards : []))
      .catch(() => { if (!abort.signal.aborted) setShards([]); });
    return () => abort.abort();
  }, []);
  return <section className="px-panel px-capacity" id="coinops-infrastructure" aria-label="Infraestrutura CoinOps">
    <h2>Infraestrutura</h2>
    {shards === null ? <p>Consultando capacidade do executor…</p> : shards.length === 0
      ? <p role="status">Capacidade indisponível. Novas ativações ficam bloqueadas; motores existentes continuam operando.</p>
      : shards.map((shard) => <div key={shard.id} className="px-capacity-shard">
        <strong>{shard.id.replace("executor-", "Executor ")} · {shard.state}</strong>
        <span>{shard.accountCount} contas · {shard.engineCount} motores</span>
        <span>Binance: {shard.binanceWeightCurrent?.toFixed(0) ?? "—"} / {shard.binanceLimit} weight/min
          {shard.binancePercent !== null ? ` · ${shard.binancePercent.toFixed(1)}%` : ""}</span>
        <span>CPU: {shard.cpuPercent?.toFixed(1) ?? "—"}% · RAM: {shard.ramUsedMb?.toFixed(0) ?? "—"} MB</span>
        <span>Fila: {shard.schedulerBacklog === null ? "—" : shard.schedulerBacklog === 0 ? "normal" : shard.schedulerBacklog}
          {` · Reconciliação: ${shard.reconciliationAgeMs === null ? "—" : Math.round(shard.reconciliationAgeMs / 1000) + "s"}`}</span>
        <strong>Nova conta com 1 motor: {shard.canAddEngine ? "SIM" : "NÃO"}</strong>
        <span>Nova conta com 2 motores: {shard.canAddTwoEngineAccount ? "SIM" : "NÃO"}</span>
        {shard.state === "WARNING" ? <small>Preparar novo executor/IP.</small> : null}
        {shard.state === "CAPACITY_LIMIT" ? <small>Capacidade atingida — provisionar novo executor antes de ativar novas contas.</small> : null}
        {!shard.canAddEngine && shard.state !== "CAPACITY_LIMIT" ? <small>{shard.state === "OFFLINE"
          ? "Telemetria insuficiente; admissão indisponível." : "Headroom de recuperação reservado; não ativar novo motor neste shard."}</small> : null}
        {shard.alerts.map((alert) => <small key={alert.code} role="status">{alert.code}</small>)}
      </div>)}
  </section>;
}
