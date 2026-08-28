"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { DesktopWorkspace } from "@/components/app/desktop-workspace";
import type { CoinOpsWorkspaceData } from "@/lib/coinops-workspace/server";
import { useLivePrices } from "@/lib/slotgain/live-prices";

type CycleFilter = "ALL" | "ACTIVE" | "CLOSED";

export function DesktopCycles({ userLabel, workspace }: { userLabel: string; workspace: CoinOpsWorkspaceData }) {
  const livePrices = useLivePrices();
  const [filter, setFilter] = useState<CycleFilter>("ALL");
  const timeZone = workspace.overview.baseline?.timezone || "America/Campo_Grande";
  const reportsByCycle = useMemo(() => new Map(workspace.reports.map((report) => [report.cycleId, report])), [workspace.reports]);
  const visibleCycles = useMemo(() => workspace.cycles.filter((cycle) => {
    if (filter === "ACTIVE") return cycle.status === "ACTIVE";
    if (filter === "CLOSED") return cycle.status !== "ACTIVE";
    return true;
  }), [filter, workspace.cycles]);
  const active = workspace.cycles.filter((cycle) => cycle.status === "ACTIVE").length;
  const defensive = workspace.cycles.filter((cycle) => cycle.mode === "DEFENSIVE_POST_ATH").length;
  const partialByAth = workspace.cycles.filter((cycle) => cycle.closeReason === "NEW_ATH").length;

  return (
    <DesktopWorkspace
      title="Ciclos"
      subtitle="Períodos oficiais pós-baseline"
      livePrices={livePrices}
      monitoring={workspace.overview}
      userLabel={userLabel}
      actions={<Link className="desktop-row-action" href="/plano-crescimento/relatorios">Relatórios</Link>}
    >
      <section className="desktop-report-kpis desktop-plan-kpis" aria-label="Resumo dos ciclos">
        <article className="desktop-kpi"><span>Ciclos registrados</span><strong>{workspace.cycles.length}</strong><small>Somente pós-baseline</small></article>
        <article className="desktop-kpi"><span>Em andamento</span><strong>{active}</strong><small>Ciclo operacional ativo</small></article>
        <article className="desktop-kpi"><span>Finalizados</span><strong>{workspace.cycles.length - active}</strong><small>Encerrados ou parciais</small></article>
        <article className="desktop-kpi"><span>Parciais por ATH</span><strong>{partialByAth}</strong><small>Encerramento auditado</small></article>
        <article className="desktop-kpi"><span>Defensivos</span><strong>{defensive}</strong><small>Períodos pós-ATH</small></article>
        <article className="desktop-kpi"><span>Relatórios</span><strong>{workspace.reports.length}</strong><small>Rascunhos e finalizados</small></article>
      </section>

      <section className="desktop-panel desktop-cycles-panel">
        <header className="desktop-panel-header">
          <div><span>Linha do tempo oficial</span><h2>Ciclos operacionais</h2></div>
          <div className="desktop-filter-group" aria-label="Filtrar ciclos">
            <button type="button" className={filter === "ALL" ? "active" : ""} onClick={() => setFilter("ALL")}>Todos</button>
            <button type="button" className={filter === "ACTIVE" ? "active" : ""} onClick={() => setFilter("ACTIVE")}>Em andamento</button>
            <button type="button" className={filter === "CLOSED" ? "active" : ""} onClick={() => setFilter("CLOSED")}>Encerrados</button>
          </div>
        </header>
        <div className="desktop-table-wrap">
          <table className="desktop-data-table desktop-cycles-table">
            <caption className="visually-hidden">Ciclos oficiais registrados desde o baseline</caption>
            <thead><tr><th>Ciclo</th><th>Período</th><th>Modo</th><th>Status</th><th>Encerramento</th><th>Redistribuição</th><th>Relatório</th><th>Ação</th></tr></thead>
            <tbody>
              {visibleCycles.map((cycle) => {
                const report = reportsByCycle.get(cycle.id);
                return (
                  <tr key={cycle.id}>
                    <td><strong>#{cycle.number}</strong></td>
                    <td>{formatPeriod(cycle.startAt, cycle.endAt, timeZone)}</td>
                    <td><span className={`desktop-status ${cycle.mode === "DEFENSIVE_POST_ATH" ? "critical" : "open"}`}>{formatMode(cycle.mode)}</span></td>
                    <td>{formatCycleStatus(cycle.status)}</td>
                    <td>{formatCloseReason(cycle.closeReason)}</td>
                    <td>{formatRedistribution(cycle.redistributionStatus)}</td>
                    <td>{report ? formatReportStatus(report.status) : "Não gerado"}</td>
                    <td>{report ? <Link className="desktop-row-action" href={`/plano-crescimento/relatorios/${report.id}`}>Abrir</Link> : <span className="desktop-status paused">Aguardando</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!visibleCycles.length ? <div className="desktop-empty"><strong>Nenhum ciclo neste filtro</strong><span>Os ciclos surgem somente após a ativação do baseline oficial.</span></div> : null}
        </div>
      </section>

      {workspace.degraded ? <p className="desktop-data-note">Algumas fontes read-only estão temporariamente indisponíveis; os dados exibidos são os registros que puderam ser confirmados.</p> : null}
    </DesktopWorkspace>
  );
}

function formatPeriod(start: string, end: string | null, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" });
  return `${formatter.format(new Date(start))} → ${end ? formatter.format(new Date(end)) : "em andamento"}`;
}

function formatMode(mode: string) {
  return mode === "DEFENSIVE_POST_ATH" ? "Defensivo" : mode === "NORMAL_GROWTH" ? "Normal" : mode;
}

function formatCycleStatus(status: string) {
  return ({ ACTIVE: "Em andamento", CLOSED: "Finalizado", PARTIAL: "Parcial" } as Record<string, string>)[status] || status;
}

function formatCloseReason(reason: string | null) {
  if (!reason) return "—";
  return ({ NEW_ATH: "Novo ATH", PERIOD_ENDED: "Fim do período", STRONG_BOTTOM_REACHED: "Fundo Forte" } as Record<string, string>)[reason] || reason.replaceAll("_", " ");
}

function formatRedistribution(status: string) {
  return ({ PENDING: "Pendente", CONFIRMED: "Confirmada", SKIPPED: "Não realizada" } as Record<string, string>)[status] || status || "—";
}

function formatReportStatus(status: string) {
  return ({ DRAFT: "Rascunho", AWAITING_CLOSURE: "Aguardando fechamento", FINALIZED: "Finalizado" } as Record<string, string>)[status] || status;
}
