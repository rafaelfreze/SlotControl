"use client";

import { useEffect, useState } from "react";
import { PremiumDrawer } from "./premium-primitives";

type Watchdog = { status: string; checkedAt: string | null;
  activeCriticalAlerts: number;
  engines: { healthy: number; reconciling: number; recovering: number; blocked: number; stale: number };
  executors: { healthy: number; total: number };
  lastIncident: { detected_condition: string; opened_at: string; result: string } | null;
  autoRecoveries24h: number;
  reliability?: { NORMAL_TRADING_WATCHDOG_DEPENDENCY_RATE: number | null; gains: number; fills: number;
    unattributedEvents: number; engineRecoveries: number; incidentsPer100Gains: number | null;
    autoRecoveriesPer100Gains: number | null; reconciliationFailuresPer100Cycles: number | null;
    meanRecoveryMs: number | null; signatures: Array<{ incident_signature: string; occurrences: number;
      status: string; root_cause: string; safe_recovery: string; permanent_fix_version: string | null }> } };

export function WatchdogCard({ attentionOnly = false }: { attentionOnly?: boolean }) {
  const [status, setStatus] = useState<Watchdog | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [now, setNow] = useState(Date.now);
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => fetch("/api/coinops-watchdog", { cache: "no-store", credentials: "same-origin" })
      .then((response) => response.ok ? response.json() as Promise<Watchdog>
        : Promise.reject(new Error("WATCHDOG_READ_FAILED")))
      .then((value) => { if (active) { setStatus(value); setLoadState("ready"); } })
      .catch(() => { if (active) { setStatus(null); setLoadState("error"); } });
    void refresh();
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const timer = setInterval(onVisible, 60_000);
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => { active = false; clearInterval(timer); clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
  }, []);
  const stale = status?.checkedAt && now - Date.parse(status.checkedAt) >= 3 * 60_000;
  const displayStatus = loadState === "loading" ? "ATUALIZANDO" : stale ? "STALE"
    : status?.status ?? "INDISPONÍVEL";
  // Keep collection mounted; account details expose only actual failures.
  if (attentionOnly && (loadState === "loading" || displayStatus === "HEALTHY")) return null;
  return <section className="px-panel px-watchdog" data-status={displayStatus} aria-label="Watchdog CoinOps">
    <button type="button" className="px-watchdog-summary" aria-haspopup="dialog" aria-expanded={detailsOpen}
      onClick={() => setDetailsOpen(true)}><strong>Watchdog · {displayStatus}</strong><span className="px-watchdog-action">Ver detalhes</span></button>
    <PremiumDrawer open={detailsOpen} title={`Watchdog · ${displayStatus}`} onClose={() => setDetailsOpen(false)}>
      <div className="px-watchdog-details">
        <span>Última checagem: {status?.checkedAt
          ? new Date(status.checkedAt).toLocaleTimeString("pt-BR") : "—"}</span>
        {status ? <><span>Motores: {status.engines.healthy} saudáveis · {status.engines.reconciling ?? 0} reconciliando normalmente · {status.engines.recovering} recuperando · {status.engines.blocked} bloqueados · {status.engines.stale} stale</span>
          <span>Executores: {status.executors.healthy}/{status.executors.total} saudáveis</span>
          <span>Recuperações pelo Watchdog · 24h: {status.autoRecoveries24h}</span>
          {status.reliability && <>
            <span>Recuperações pelo fluxo normal · 24h: {status.reliability.engineRecoveries}</span>
            <span>Dependência do Watchdog no trading: {status.reliability.NORMAL_TRADING_WATCHDOG_DEPENDENCY_RATE === null
              ? "NÃO MENSURÁVEL" : `${status.reliability.NORMAL_TRADING_WATCHDOG_DEPENDENCY_RATE}%`} · objetivo 0%</span>
            <small>{status.reliability.gains} gains · {status.reliability.fills} fills · {status.reliability.unattributedEvents} eventos sem atribuição histórica. Ausência de evidência não significa 0%.</small>
            <span>Incidentes / 100 gains: {status.reliability.incidentsPer100Gains ?? "—"} · Recuperações / 100 gains: {status.reliability.autoRecoveriesPer100Gains ?? "—"}</span>
            <span>Falhas de reconciliação / 100 ciclos: {status.reliability.reconciliationFailuresPer100Cycles ?? "—"} · Recovery médio: {status.reliability.meanRecoveryMs === null ? "—" : `${Math.round(status.reliability.meanRecoveryMs / 1000)}s`}</span>
            {status.reliability.signatures.map(signature => <article key={signature.incident_signature}>
              <strong>{signature.status} · {signature.occurrences} ocorrência(s)</strong>
              <p style={{ overflowWrap: "anywhere" }}>{signature.incident_signature}</p><small>{signature.root_cause} · {signature.safe_recovery}
                {signature.permanent_fix_version ? ` · Fix ${signature.permanent_fix_version}` : " · causa ainda não comprovada"}</small>
            </article>)}
          </>}
          {status.activeCriticalAlerts > 0 && <span>Alertas críticos pendentes: {status.activeCriticalAlerts}</span>}
          <small>Último incidente: {status.lastIncident
            ? `${status.lastIncident.detected_condition} · ${status.lastIncident.result}` : "nenhum"}</small></>
          : <small>{loadState === "loading" ? "Consultando confirmação server-side…"
            : "Confirmação server-side indisponível. Não interpretar a interface como saúde operacional."}</small>}
      </div>
    </PremiumDrawer>
  </section>;
}
