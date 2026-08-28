"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { DesktopWorkspace } from "@/components/app/desktop-workspace";
import type { CoinOpsWorkspaceData } from "@/lib/coinops-workspace/server";
import { useLivePrices } from "@/lib/slotgain/live-prices";

type ReadFilter = "ALL" | "UNREAD" | "READ";
type SeverityFilter = "ALL" | "INFO" | "ATTENTION" | "CRITICAL";

export function DesktopAlerts({ userLabel, workspace }: { userLabel: string; workspace: CoinOpsWorkspaceData }) {
  const livePrices = useLivePrices();
  const [readFilter, setReadFilter] = useState<ReadFilter>("UNREAD");
  const [severity, setSeverity] = useState<SeverityFilter>("ALL");
  const timeZone = workspace.overview.baseline?.timezone || "America/Campo_Grande";
  const visibleAlerts = useMemo(() => workspace.alerts.filter((alert) => {
    const matchesRead = readFilter === "ALL" || (readFilter === "READ" ? Boolean(alert.readAt) : !alert.readAt);
    const matchesSeverity = severity === "ALL" || alert.severity.toUpperCase() === severity;
    return matchesRead && matchesSeverity;
  }), [readFilter, severity, workspace.alerts]);
  const unread = workspace.alerts.filter((alert) => !alert.readAt).length;
  const attention = workspace.alerts.filter((alert) => alert.severity.toUpperCase() === "ATTENTION").length;
  const critical = workspace.alerts.filter((alert) => alert.severity.toUpperCase() === "CRITICAL").length;

  return (
    <DesktopWorkspace
      title="Alertas"
      subtitle="Eventos reais do monitoramento oficial"
      livePrices={livePrices}
      monitoring={workspace.overview}
      userLabel={userLabel}
      actions={<Link className="desktop-row-action" href="/plano-crescimento">Abrir Plano</Link>}
    >
      <section className="desktop-report-kpis desktop-plan-kpis" aria-label="Resumo dos alertas">
        <article className="desktop-kpi"><span>Total</span><strong>{workspace.alerts.length}</strong><small>Desde o baseline</small></article>
        <article className="desktop-kpi"><span>Novos</span><strong>{unread}</strong><small>Ainda não lidos</small></article>
        <article className="desktop-kpi"><span>Atenção</span><strong>{attention}</strong><small>Requer acompanhamento</small></article>
        <article className="desktop-kpi negative"><span>Críticos</span><strong>{critical}</strong><small>Maior severidade</small></article>
      </section>

      <section className="desktop-panel desktop-alerts-page-panel">
        <header className="desktop-panel-header">
          <div><span>Monitoramento</span><h2>Central de alertas</h2></div>
          <div className="desktop-filter-group" aria-label="Filtrar alertas por leitura">
            <button type="button" className={readFilter === "UNREAD" ? "active" : ""} onClick={() => setReadFilter("UNREAD")}>Novos</button>
            <button type="button" className={readFilter === "READ" ? "active" : ""} onClick={() => setReadFilter("READ")}>Lidos</button>
            <button type="button" className={readFilter === "ALL" ? "active" : ""} onClick={() => setReadFilter("ALL")}>Todos</button>
            <select value={severity} onChange={(event) => setSeverity(event.target.value as SeverityFilter)} aria-label="Filtrar por severidade">
              <option value="ALL">Toda severidade</option>
              <option value="INFO">Informação</option>
              <option value="ATTENTION">Atenção</option>
              <option value="CRITICAL">Crítico</option>
            </select>
          </div>
        </header>
        <div className="desktop-alert-list">
          {visibleAlerts.map((alert) => (
            <article className={`desktop-alert-row ${severityClass(alert.severity)}`} key={alert.id}>
              <i aria-hidden="true" />
              <span>
                <strong>{formatAlertType(alert.type)}</strong>
                <small>{alert.message || "Evento registrado pelo monitoramento oficial."}</small>
              </span>
              <time dateTime={alert.occurredAt}>{formatDateTime(alert.occurredAt, timeZone)} · {alert.readAt ? "Lido" : "Novo"}</time>
            </article>
          ))}
          {!visibleAlerts.length ? <div className="desktop-empty"><strong>Nenhum alerta neste filtro</strong><span>Somente eventos confirmados pelo monitoramento são exibidos.</span></div> : null}
        </div>
      </section>

      <p className="desktop-data-note">O backend atual registra leitura, não resolução. Por isso a central distingue Novos e Lidos sem inventar um estado “Resolvido”.</p>
      {workspace.degraded ? <p className="desktop-data-note">Algumas fontes read-only estão temporariamente indisponíveis; a lista mostra apenas eventos confirmados.</p> : null}
    </DesktopWorkspace>
  );
}

function severityClass(severity: string) {
  const normalized = severity.toUpperCase();
  return normalized === "CRITICAL" ? "critical" : normalized === "ATTENTION" ? "attention" : "info";
}

function formatAlertType(type: string) {
  return ({
    NEW_ATH: "Novo ATH do BTC",
    STRONG_BOTTOM_REACHED: "Fundo Forte alcançado",
    MAIN_ATTENTION: "20/25 slots principais usados",
    MAIN_CRITICAL: "23/25 slots principais usados",
    MAIN_EXHAUSTED: "25/25 slots principais usados",
    RESERVE_REQUIRED: "Reserva necessária",
    CYCLE_ENDING: "Ciclo próximo do fim",
    CYCLE_ENDED: "Ciclo encerrado",
    REPORT_READY: "Relatório pronto",
    PRICE_FEED_STALE: "Feed de preço desatualizado"
  } as Record<string, string>)[type] || type.replaceAll("_", " ");
}

function formatDateTime(value: string, timeZone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Data indisponível";
  return new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
