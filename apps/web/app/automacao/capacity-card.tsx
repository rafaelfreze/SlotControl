"use client";

import { useEffect, useRef, useState } from "react";
import type { ExecutorObservation } from "./automation-executor-sync";
import { executorNeedsAttention, selectOverviewExecutors } from "./capacity-card-presentation";
import { PremiumDrawer } from "./premium-primitives";
import { explainAdmission, pressureExplanation, type AdmissionExplanation } from "@/lib/coinops-capacity/admission-explanation";

type Shard = { id: string; state: string; action: string; binanceWeightCurrent: number | null;
  egressIp: string; executorVersion: string | null; binanceWeightAverage: number | null; binanceWeightPeak: number | null;
  heartbeatAt: string | null; observedAt: string | null; reservedWeight: number;
  binanceLimit: number; binancePercent: number | null; cpuPercent: number | null;
  ramUsedMb: number | null; schedulerBacklog: number | null; reconciliationAgeMs: number | null;
  accountCount: number; engineCount: number; canAddEngine: boolean; admissionReason: string;
  canAddTwoEngineAccount: boolean; warningsMuted: boolean;
  admission?: AdmissionExplanation; dualEngineAdmission?: AdmissionExplanation;
  alerts: Array<{ code: string }> };

export function CapacityCard({ onExecutorObservation, overview = false, attentionOnly = false }: {
  onExecutorObservation?: (shards: ExecutorObservation[]) => void;
  overview?: boolean;
  attentionOnly?: boolean;
}) {
  const observationCallback = useRef(onExecutorObservation);
  useEffect(() => { observationCallback.current = onExecutorObservation; }, [onExecutorObservation]);
  const [shards, setShards] = useState<Shard[] | null>(null);
  const [observedNow, setObservedNow] = useState(Date.now);
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
        setObservedNow(Date.now());
        setShards(observed);
        if (observed.length) observationCallback.current?.(observed);
      })
      .catch(() => { if (!abort.signal.aborted) { setObservedNow(Date.now()); setShards([]); } });
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 30_000);
    return () => { abort.abort(); clearInterval(timer); };
  }, []);
  const visibleShards = overview && shards ? selectOverviewExecutors(shards, observedNow)
    : attentionOnly ? shards?.filter((shard) => executorNeedsAttention(shard, observedNow)) : shards;
  // The full observation still feeds sync, even when the home shows only five.
  if (attentionOnly && (shards === null || shards.length > 0 && !visibleShards?.length)) return null;
  return <section className={`px-capacity${overview ? " px-panel px-capacity--overview" : ""}`} id="coinops-infrastructure" aria-label="Infraestrutura CoinOps">
    {overview ? <header className="px-capacity-title"><h2>Executores</h2><small>Falhas primeiro</small></header> : null}
    {shards === null ? <p className="px-panel px-capacity-notice" role="status">Consultando executores…</p> : shards.length === 0
      ? <p className="px-panel px-capacity-notice" role="status">Telemetria indisponível. Novas ativações ficam bloqueadas; motores existentes continuam operando.</p>
      : visibleShards?.map((shard) => <div key={shard.id} className="px-panel px-capacity-shard" id={`infra-${shard.id}`}
        data-attention={executorNeedsAttention(shard, observedNow)}>
        <button type="button" className="px-capacity-summary px-capacity-expand" aria-expanded={expandedShard === shard.id}
          aria-haspopup="dialog"
          aria-controls={`infra-details-${shard.id}`}
          aria-label={`${expandedShard === shard.id ? "Ocultar" : "Ver"} detalhes de ${shard.id.replace("executor-", "Executor ")}`}
          onClick={() => setExpandedShard((current) => current === shard.id ? null : shard.id)}>
          <span className="px-capacity-heading"><strong>{shard.id.replace("executor-", "Executor ")} · {shard.state}</strong>
            <span>{shard.accountCount} contas · {shard.engineCount} motores</span>
            {!overview && executorNeedsAttention(shard, observedNow) && ["HEALTHY", "OBSERVE"].includes(shard.state) && !shard.alerts.length
              ? <small role="status">Telemetria sem confirmação recente.</small> : null}</span>
          {overview ? <span className="px-capacity-availability" data-available={!executorNeedsAttention(shard, observedNow) && shard.canAddEngine}
            title={executorNeedsAttention(shard, observedNow) ? "Verificar saúde e telemetria do executor" : shard.canAddEngine ? "Admissão disponível para +1 motor" : "Sem espaço para nova admissão"}>
            {executorNeedsAttention(shard, observedNow) ? "Verificar" : shard.canAddEngine ? "+1 SIM" : "+1 NÃO"}</span> : null}
          <span className="px-capacity-toggle-label" aria-hidden="true">
            {overview ? expandedShard === shard.id ? "−" : "›" : expandedShard === shard.id ? "Ocultar detalhes" : "Ver detalhes"}</span>
        </button>
        <PremiumDrawer open={expandedShard === shard.id} title={`${shard.id.replace("executor-", "Executor ")} · ${shard.state}`}
          onClose={() => setExpandedShard(null)}>
        <div className="px-capacity-details is-expanded" id={`infra-details-${shard.id}`}>
        <button type="button" className="px-button px-capacity-mute" disabled={mutating === shard.id}
          onClick={() => void toggleWarnings(shard)}>{shard.warningsMuted
            ? "Reativar avisos de capacidade" : "Ocultar avisos de capacidade"}</button>
        {shard.warningsMuted ? <small>Avisos repetitivos de Binance weight/limite ocultos para você. Incidentes operacionais e bloqueio de novas ativações continuam ativos.</small> : null}
        <span>IP fixo / whitelist: <code>{shard.egressIp}</code></span>
        <span>Binance atual: {shard.binanceWeightCurrent?.toFixed(0) ?? "—"} / {shard.binanceLimit} weight/min
          {shard.binanceWeightCurrent !== null && shard.binanceLimit > 0
            ? ` · ${(shard.binanceWeightCurrent / shard.binanceLimit * 100).toFixed(1)}%` : ""}</span>
        <small>Pressão atual/média (pico histórico apenas para OBSERVE): {shard.binancePercent?.toFixed(1) ?? "—"}%</small>
        <small>Média dos máximos por minuto (15 min): {shard.binanceWeightAverage?.toFixed(0) ?? "—"} · Pico 15 min: {shard.binanceWeightPeak?.toFixed(0) ?? "—"}
          {shard.reservedWeight > 0 ? ` · Reservado: ${shard.reservedWeight}` : ""}</small>
        <span>CPU: {shard.cpuPercent?.toFixed(1) ?? "—"}% · RAM: {shard.ramUsedMb?.toFixed(0) ?? "—"} MB</span>
        <span>Fila: {shard.schedulerBacklog === null ? "—" : shard.schedulerBacklog === 0 ? "normal" : shard.schedulerBacklog}
          {` · Reconciliação: ${shard.reconciliationAgeMs === null ? "—" : Math.round(shard.reconciliationAgeMs / 1000) + "s"}`}</span>
        <small>Heartbeat: {shard.heartbeatAt ? new Date(shard.heartbeatAt).toLocaleString("pt-BR") : "sem amostra"}</small>
        <strong>Nova conta +1 motor: {explainAdmission(shard.admission)}</strong>
        <span>Nova conta +2 motores: {explainAdmission(shard.dualEngineAdmission)}</span>
        {shard.admission ? <>
          <small>Cálculo: {shard.admission.observed_weight?.toFixed(0) ?? "—"} sustentado (média de 15 min)
            + {shard.admission.reserved_weight} reservado + {shard.admission.incremental_weight} estimado
            = {shard.admission.projected_weight?.toFixed(0) ?? "—"} / {shard.admission.admission_limit_weight} permitido.</small>
          <small>Reserva de recuperação: {shard.admission.recovery_headroom_weight} weight/min, descontada uma única vez no limite.</small>
          <small>Estimativa incremental conservadora: {shard.admission.policy.incremental_weight} por motor; ainda não é p95 medido.
            Capacidade operacional total não certificada por quantidade de motores.</small>
          {shard.admission.policy.reopen_healthy_seconds ? <small>Histerese: bloqueia acima de 65% sustentado; reabre após 10 min até 60%.
            Consumo atual ≥75% bloqueia imediatamente. OBSERVE é monitoramento.</small> : null}
          {pressureExplanation(shard.admission.pressure_phase) ? <small>{pressureExplanation(shard.admission.pressure_phase)}</small> : null}
        </> : null}
        {shard.state === "WARNING" && !shard.warningsMuted ? <small>{shard.action === "SCALE_UP"
          ? "CPU/RAM com pouca margem: preparar SCALE_UP." : shard.action === "SCALE_OUT"
            ? "Preparar novo executor/IP." : "Verificar fila e reconciliação antes de admitir novas contas."}</small> : null}
        {shard.state === "CAPACITY_LIMIT" ? <small>{shard.action === "SCALE_UP"
          ? "Capacidade atingida — SCALE_UP necessário antes de novas ativações."
          : "Admissão aguarda margem na janela recente. Se a pressão persistir, preparar novo executor/IP."}</small> : null}
        {!shard.canAddEngine && shard.state !== "CAPACITY_LIMIT" ? <small>{shard.state === "OFFLINE"
          ? "Telemetria insuficiente; admissão indisponível." : "Novas ativações aguardam os critérios acima; motores existentes não são pausados."}</small> : null}
        {shard.alerts.map((alert) => <small key={alert.code} role="status">{alert.code}</small>)}
        </div>
        </PremiumDrawer>
      </div>)}
    {overview && shards && shards.length > (visibleShards?.length ?? 0)
      ? <small className="px-capacity-remainder">{visibleShards?.length} de {shards.length} executores neste resumo</small> : null}
    {muteError ? <p role="alert">{muteError}</p> : null}
  </section>;
}
