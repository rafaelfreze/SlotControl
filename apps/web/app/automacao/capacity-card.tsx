"use client";

import { useEffect, useState } from "react";

type Shard = { id: string; state: string; action: string; binanceWeightCurrent: number | null;
  egressIp: string; binanceWeightAverage: number | null; binanceWeightPeak: number | null;
  heartbeatAt: string | null; observedAt: string | null; reservedWeight: number;
  binanceLimit: number; binancePercent: number | null; cpuPercent: number | null;
  ramUsedMb: number | null; schedulerBacklog: number | null; reconciliationAgeMs: number | null;
  accountCount: number; engineCount: number; canAddEngine: boolean; admissionReason: string;
  canAddTwoEngineAccount: boolean;
  alerts: Array<{ code: string }> };

export function CapacityCard() {
  const [shards, setShards] = useState<Shard[] | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    const refresh = () => fetch("/api/coinops-capacity", { cache: "no-store", signal: abort.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((result) => { if (!abort.signal.aborted) setShards(Array.isArray(result?.shards) ? result.shards : []); })
      .catch(() => { if (!abort.signal.aborted) setShards([]); });
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 30_000);
    return () => { abort.abort(); clearInterval(timer); };
  }, []);
  return <section className="px-panel px-capacity" id="coinops-infrastructure" aria-label="Infraestrutura CoinOps">
    <h2>Infraestrutura</h2>
    {shards === null ? <p>Consultando capacidade do executor…</p> : shards.length === 0
      ? <p role="status">Capacidade indisponível. Novas ativações ficam bloqueadas; motores existentes continuam operando.</p>
      : shards.map((shard) => <div key={shard.id} className="px-capacity-shard" id={`infra-${shard.id}`}>
        <strong>{shard.id.replace("executor-", "Executor ")} · {shard.state}</strong>
        <span>{shard.accountCount} contas · {shard.engineCount} motores</span>
        <span>IP fixo / whitelist: <code>{shard.egressIp}</code></span>
        <span>Binance atual: {shard.binanceWeightCurrent?.toFixed(0) ?? "—"} / {shard.binanceLimit} weight/min
          {shard.binanceWeightCurrent !== null && shard.binanceLimit > 0
            ? ` · ${(shard.binanceWeightCurrent / shard.binanceLimit * 100).toFixed(1)}%` : ""}</span>
        <small>Pressão conservadora (maior entre atual, média e pico 15 min): {shard.binancePercent?.toFixed(1) ?? "—"}%</small>
        <small>Média dos máximos por minuto (15 min): {shard.binanceWeightAverage?.toFixed(0) ?? "—"} · Pico 15 min: {shard.binanceWeightPeak?.toFixed(0) ?? "—"}
          {shard.reservedWeight > 0 ? ` · Reservado: ${shard.reservedWeight}` : ""}</small>
        <span>CPU: {shard.cpuPercent?.toFixed(1) ?? "—"}% · RAM: {shard.ramUsedMb?.toFixed(0) ?? "—"} MB</span>
        <span>Fila: {shard.schedulerBacklog === null ? "—" : shard.schedulerBacklog === 0 ? "normal" : shard.schedulerBacklog}
          {` · Reconciliação: ${shard.reconciliationAgeMs === null ? "—" : Math.round(shard.reconciliationAgeMs / 1000) + "s"}`}</span>
        <small>Heartbeat: {shard.heartbeatAt ? new Date(shard.heartbeatAt).toLocaleString("pt-BR") : "sem amostra"}</small>
        <strong>Nova conta com 1 motor: {shard.canAddEngine ? "SIM" : "NÃO"}</strong>
        <span>Nova conta com 2 motores: {shard.canAddTwoEngineAccount ? "SIM" : "NÃO"}</span>
        {shard.state === "WARNING" ? <small>{shard.action === "SCALE_UP"
          ? "CPU/RAM com pouca margem: preparar SCALE_UP." : shard.action === "SCALE_OUT"
            ? "Preparar novo executor/IP." : "Verificar fila e reconciliação antes de admitir novas contas."}</small> : null}
        {shard.state === "CAPACITY_LIMIT" ? <small>{shard.action === "SCALE_UP"
          ? "Capacidade atingida — SCALE_UP necessário antes de novas ativações."
          : "Capacidade atingida — provisionar novo executor antes de ativar novas contas."}</small> : null}
        {!shard.canAddEngine && shard.state !== "CAPACITY_LIMIT" ? <small>{shard.state === "OFFLINE"
          ? "Telemetria insuficiente; admissão indisponível." : "Headroom de recuperação reservado; não ativar novo motor neste shard."}</small> : null}
        {shard.alerts.map((alert) => <small key={alert.code} role="status">{alert.code}</small>)}
      </div>)}
  </section>;
}
