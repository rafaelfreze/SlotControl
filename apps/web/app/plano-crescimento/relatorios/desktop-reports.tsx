"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { DesktopWorkspace } from "@/components/app/desktop-workspace";
import { useCoinOpsWorkspaceData } from "@/lib/coinops-workspace/client";
import { useLivePrices } from "@/lib/slotgain/live-prices";

export type DesktopReportListItem = {
  id: string;
  status: string;
  report_version: number;
  generated_at: string | null;
  finalized_at: string | null;
  cycle: { cycle_number: number; mode: string; start_at: string; end_at: string | null; status: string } | null;
};

type ReportFilter = "ALL" | "ACTIVE" | "FINALIZED";

export function DesktopReports({
  userLabel,
  reports,
  error
}: {
  userLabel: string;
  reports: DesktopReportListItem[];
  error?: string | null;
}) {
  const livePrices = useLivePrices();
  const { data: workspace } = useCoinOpsWorkspaceData();
  const monitoring = workspace?.overview;
  const [filter, setFilter] = useState<ReportFilter>("ALL");
  const current = reports.find((report) => report.cycle?.status === "ACTIVE") || null;
  const finalized = reports.filter((report) => report.status === "FINALIZED").length;
  const timeZone = monitoring?.baseline?.timezone || "America/Campo_Grande";
  const visibleReports = useMemo(() => reports.filter((report) => {
    if (filter === "ACTIVE") return report.cycle?.status === "ACTIVE";
    if (filter === "FINALIZED") return report.status === "FINALIZED";
    return true;
  }), [filter, reports]);

  return (
    <DesktopWorkspace
      title="Relatórios"
      subtitle="Ciclos reais pós-baseline"
      livePrices={livePrices}
      monitoring={monitoring}
      userLabel={userLabel}
      actions={<Link className="desktop-row-action" href="/ciclos">Ver ciclos</Link>}
    >
      <section className="desktop-report-kpis desktop-plan-kpis" aria-label="Resumo dos relatórios">
        <article className="desktop-kpi"><span>Relatórios</span><strong>{reports.length}</strong><small>Somente pós-baseline</small></article>
        <article className="desktop-kpi"><span>Finalizados</span><strong>{finalized}</strong><small>Imutáveis e versionados</small></article>
        <article className="desktop-kpi"><span>Ciclo atual</span><strong>{current?.cycle ? `#${current.cycle.cycle_number}` : "—"}</strong><small>{current?.cycle ? statusLabel(current.cycle.status) : "Sem ciclo ativo"}</small></article>
        <article className="desktop-kpi"><span>Estratégia</span><strong>v{monitoring?.strategy?.version ?? "—"}</strong><small>Versão oficial</small></article>
      </section>

      <section className="desktop-panel desktop-reports-panel">
        <header className="desktop-panel-header">
          <div><span>Relatórios de ciclo</span><h2>Resumo executivo e auditoria</h2></div>
          <div className="desktop-filter-group" aria-label="Filtrar relatórios">
            <button type="button" className={filter === "ALL" ? "active" : ""} onClick={() => setFilter("ALL")}>Todos</button>
            <button type="button" className={filter === "ACTIVE" ? "active" : ""} onClick={() => setFilter("ACTIVE")}>Em andamento</button>
            <button type="button" className={filter === "FINALIZED" ? "active" : ""} onClick={() => setFilter("FINALIZED")}>Finalizados</button>
          </div>
        </header>

        {error ? <div className="desktop-empty"><strong>Relatórios indisponíveis</strong><span>Não foi possível carregar a listagem neste momento.</span></div> : null}
        {!error ? (
          <div className="desktop-report-list">
            {visibleReports.map((report) => (
              <Link href={`/plano-crescimento/relatorios/${report.id}`} key={report.id} className="desktop-report-row">
                <span className={`desktop-report-status ${report.status.toLowerCase()}`} aria-hidden="true" />
                <span><strong>Ciclo {report.cycle?.cycle_number ?? "—"}</strong><small>{formatPeriod(report.cycle?.start_at, report.cycle?.end_at, timeZone)}</small></span>
                <span><small>Modo</small><strong>{report.cycle?.mode === "DEFENSIVE_POST_ATH" ? "Defensivo" : "Normal"}</strong></span>
                <span><small>Status</small><strong>{statusLabel(report.status)}</strong></span>
                <span><small>Versão</small><strong>v{report.report_version}</strong></span>
                <b>Ver relatório ›</b>
              </Link>
            ))}
          </div>
        ) : null}
        {!error && !visibleReports.length ? <div className="desktop-empty"><strong>Nenhum relatório neste filtro</strong><span>Os relatórios aparecem depois que o ciclo oficial é iniciado.</span></div> : null}
      </section>

      <section className="desktop-report-sections" aria-label="Conteúdo dos relatórios">
        {["Resumo executivo", "Progresso dos slots", "Eventos de regime", "PDF, CSV e JSON"].map((label) => (
          <article className="desktop-panel" key={label}>
            <span className="desktop-action-icon report" aria-hidden="true" />
            <strong>{label}</strong>
            <small>Dados reais do ciclo, sem misturar legado.</small>
          </article>
        ))}
      </section>
    </DesktopWorkspace>
  );
}

function formatPeriod(start: string | undefined, end: string | null | undefined, timeZone: string) {
  if (!start) return "Período indisponível";
  const formatter = new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" });
  return `${formatter.format(new Date(start))} → ${end ? formatter.format(new Date(end)) : "em andamento"}`;
}

function statusLabel(status: string) {
  return ({
    ACTIVE: "Em andamento",
    DRAFT: "Rascunho",
    AWAITING_CLOSURE: "Aguardando fechamento",
    FINALIZED: "Finalizado"
  } as Record<string, string>)[status] || status;
}
