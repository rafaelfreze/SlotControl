"use client";

import { useEffect, useState } from "react";

type Watchdog = { status: string; checkedAt: string | null;
  activeCriticalAlerts: number;
  engines: { healthy: number; recovering: number; blocked: number; stale: number };
  executors: { healthy: number; total: number };
  lastIncident: { detected_condition: string; opened_at: string; result: string } | null;
  autoRecoveries24h: number };

export function WatchdogCard() {
  const [status, setStatus] = useState<Watchdog | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [now, setNow] = useState(Date.now);
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
  return <section className="px-panel px-watchdog" aria-label="Watchdog CoinOps">
    <details>
      <summary><strong>Watchdog · {displayStatus}</strong><span className="px-watchdog-action"><i>Ver detalhes</i><b>Ocultar</b></span></summary>
      <div className="px-watchdog-details">
        <span>Última checagem: {status?.checkedAt
          ? new Date(status.checkedAt).toLocaleTimeString("pt-BR") : "—"}</span>
        {status ? <><span>Motores: {status.engines.healthy} saudáveis · {status.engines.recovering} recuperando · {status.engines.blocked} bloqueados · {status.engines.stale} stale</span>
          <span>Executores: {status.executors.healthy}/{status.executors.total} saudáveis</span>
          <span>Auto-recuperações 24h: {status.autoRecoveries24h}</span>
          {status.activeCriticalAlerts > 0 && <span>Alertas críticos pendentes: {status.activeCriticalAlerts}</span>}
          <small>Último incidente: {status.lastIncident
            ? `${status.lastIncident.detected_condition} · ${status.lastIncident.result}` : "nenhum"}</small></>
          : <small>{loadState === "loading" ? "Consultando confirmação server-side…"
            : "Confirmação server-side indisponível. Não interpretar a interface como saúde operacional."}</small>}
      </div>
    </details>
  </section>;
}
