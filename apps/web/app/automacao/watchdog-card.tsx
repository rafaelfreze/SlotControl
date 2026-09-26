"use client";

import { useEffect, useState } from "react";

type Watchdog = { status: string; checkedAt: string | null;
  engines: { healthy: number; recovering: number; blocked: number; stale: number };
  executors: { healthy: number; total: number };
  lastIncident: { detected_condition: string; opened_at: string; result: string } | null;
  autoRecoveries24h: number };

export function WatchdogCard() {
  const [status, setStatus] = useState<Watchdog | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => fetch("/api/coinops-watchdog", { cache: "no-store", credentials: "same-origin" })
      .then((response) => response.ok ? response.json() as Promise<Watchdog> : null)
      .then((value) => { if (active) setStatus(value); })
      .catch(() => { if (active) setStatus(null); });
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  return <section className="px-panel px-watchdog" aria-label="Watchdog CoinOps">
    <strong>Watchdog · {status?.status ?? "SEM TELEMETRIA"}</strong>
    <span>Última checagem: {status?.checkedAt
      ? new Date(status.checkedAt).toLocaleTimeString("pt-BR") : "—"}</span>
    {status ? <><span>Motores: {status.engines.healthy} saudáveis · {status.engines.recovering} recuperando · {status.engines.blocked} bloqueados · {status.engines.stale} stale</span>
      <span>Executores: {status.executors.healthy}/{status.executors.total} saudáveis</span>
      <span>Auto-recuperações 24h: {status.autoRecoveries24h}</span>
      <small>Último incidente: {status.lastIncident
        ? `${status.lastIncident.detected_condition} · ${status.lastIncident.result}` : "nenhum"}</small></>
      : <small>Sem confirmação server-side. Não interpretar a interface como saúde operacional.</small>}
  </section>;
}
