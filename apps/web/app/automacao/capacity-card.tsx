"use client";

import { useEffect, useRef, useState } from "react";
import type { ExecutorObservation } from "./automation-executor-sync";

type Shard = { id: string; state: string; action: string; binanceWeightCurrent: number | null;
  egressIp: string; executorVersion: string | null; binanceWeightAverage: number | null; binanceWeightPeak: number | null;
  heartbeatAt: string | null; observedAt: string | null; reservedWeight: number;
  binanceLimit: number; binancePercent: number | null; cpuPercent: number | null;
  ramUsedMb: number | null; schedulerBacklog: number | null; reconciliationAgeMs: number | null;
  accountCount: number; engineCount: number; canAddEngine: boolean; admissionReason: string;
  canAddTwoEngineAccount: boolean; warningsMuted: boolean;
  alerts: Array<{ code: string }> };

export function CapacityCard({ onExecutorObservation }: {
  onExecutorObservation?: (shards: ExecutorObservation[]) => void;
}) {
  const observationCallback = useRef(onExecutorObservation);
  useEffect(() => { observationCallback.current = onExecutorObservation; }, [onExecutorObservation]);
  const [shards, setShards] = useState<Shard[] | null>(null);
  const [mutating, setMutating] = useState<string | null>(null);
  const [muteError, setMuteError] = useState<string | null>(null);
  const [expandedShard, setExpandedShard] = useState<string | null>(null);
  async function toggleWarnings(shard: Shard) {
    setMutating(shard.id);
    setMuteError(null);
    try {
      const response = await fetch("/api/coinops-capacity", { method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", "x-coinops-admin-intent": "capacity-warning-mute" },
        body: JSON.stringify({ action: shard.warningsMuted ? "UNMUTE_WARNINGS" : "MUTE_WARNINGS", shardId: shard.id }) });
      if (!response.ok) throw new Error("Falha ao salvar preferência; os avisos não foram alterados.");
      const result = await response.json();
      setShards((current) => current?.map((item) => item.id === shard.id
        ? { ...item, warningsMuted: result.warningsMuted,
          alerts: result.warningsMuted ? item.alerts.filter((alert) => !["BINANCE_WEIGHT_WARNING", "EXECUTOR_CAPACITY_WARNING", "CAPACITY_LIMIT"].includes(alert.code)) : item.alerts }
        : item) ?? null);
    } catch { setMuteError("Não foi possível salvar a preferência. Tente novamente."); }
    finally { setMutating(null); }
  }
  useEffect(() => {
    const abort = new AbortController();
    const refresh = () => fetch("/api/coinops-capacity", { cache: "no-store", signal: abort.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((result) => {
        if (abort.signal.aborted) return;
        const observed = Array.isArray(result?.shards) ? result.shards : [];
        setShards(observed);
        if (observed.length) observationCallback.current?.(observed);
      })
      .catch(() => { if (!abort.signal.aborted) setShards([]); });
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 30_000);
    return () => { abort.abort(); clearInterval(timer); };
  }, []);
  return <section className="px-capacity" id="coinops-infrastructure" aria-label="Infraestrutura CoinOps">
    {shards === null ? <p>Consultando capacidade do executor…</p> : shards.length === 0
      ? <p role="status">Capacidade indisponível. Novas ativações ficam bloqueadas; motores existentes continuam operando.</p>
      : shards.map((shard) => <div key={shard.id} className="px-panel px-capacity-shard" id={`infra-${shard.id}`}>
        <div className="px-capacity-heading"><strong>{shard.id.replace("executor-", "Executor ")} · {shard.state}</strong>
          <span>{shard.accountCount} contas · {shard.engineCount} motores</span></div>
        <button type="button" className="px-capacity-expand" aria-expanded={expandedShard === shard.id}
          aria-controls={`infra-details-${shard.id}`}
          onClick={() => setExpandedShard((current) => current === shard.id ? null : shard.id)}>
          {expandedShard === shard.id ? "Ocultar detalhes" : "Ver detalhes"}</button>
        <div className={`px-capacity-details${expandedShard === shard.id ? " is-expanded" : ""}`} id={`infra-details-${shard.id}`}>
        <button type="button" className="px-button px-capacity-mute" disabled={mutating === shard.id}
          onClick={() => void toggleWarnings(shard)}>{shard.warningsMuted
            ? "Reativar avisos de capacidade" : "Ocultar avisos de capacidade"}</button>
        {shard.warningsMuted ? <small>Avisos repetitivos de Binance weight/limite ocultos para você. Incidentes operacionais e bloqueio de novas ativações continuam ativos.</small> : null}
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
        {shard.state === "WARNING" && !shard.warningsMuted ? <small>{shard.action === "SCALE_UP"
          ? "CPU/RAM com pouca margem: preparar SCALE_UP." : shard.action === "SCALE_OUT"
            ? "Preparar novo executor/IP." : "Verificar fila e reconciliação antes de admitir novas contas."}</small> : null}
        {shard.state === "CAPACITY_LIMIT" ? <small>{shard.action === "SCALE_UP"
          ? "Capacidade atingida — SCALE_UP necessário antes de novas ativações."
          : "Capacidade atingida — provisionar novo executor antes de ativar novas contas."}</small> : null}
        {!shard.canAddEngine && shard.state !== "CAPACITY_LIMIT" ? <small>{shard.state === "OFFLINE"
          ? "Telemetria insuficiente; admissão indisponível." : "Headroom de recuperação reservado; não ativar novo motor neste shard."}</small> : null}
        {shard.alerts.map((alert) => <small key={alert.code} role="status">{alert.code}</small>)}
        </div>
      </div>)}
    {muteError ? <p role="alert">{muteError}</p> : null}
  </section>;
}
