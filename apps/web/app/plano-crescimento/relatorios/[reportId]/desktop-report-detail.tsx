"use client";

import Link from "next/link";

import { DesktopKpiCard, DesktopPanel, DesktopWorkspace } from "@/components/app/desktop-workspace";
import { useCoinOpsWorkspaceData } from "@/lib/coinops-workspace/client";
import type { ReportSlotRow } from "@/lib/coinops-monitoring/report-export";
import { formatPrice, formatUsdt } from "@/lib/slotgain/format";
import { useLivePrices } from "@/lib/slotgain/live-prices";

type DesktopReportData = {
  report: {
    id: string;
    status: string;
    report_version: number;
    generated_at: string | null;
    finalized_at: string | null;
  };
  cycle: {
    cycle_number: number;
    mode: string;
    status: string;
    start_at: string;
    end_at: string | null;
    close_reason: string | null;
    redistribution_status: string;
  };
  strategyVersion: { version: number };
  rows: ReportSlotRow[];
  regimeEvents: Array<{
    event_type: string;
    previous_mode: string | null;
    new_mode: string | null;
    btc_price: number | string | null;
    official_ath: number | string | null;
    defensive_anchor_ath: number | string | null;
    occurred_at: string;
  }>;
};

export function DesktopReportDetail({
  data,
  userLabel
}: {
  data: DesktopReportData;
  userLabel: string;
}) {
  const livePrices = useLivePrices();
  const { data: workspace } = useCoinOpsWorkspaceData();
  const monitoring = workspace?.overview;
  const timeZone = monitoring?.baseline?.timezone || "America/Campo_Grande";
  const summary = summarizeRows(data.rows);
  const reportStatus = formatReportStatus(data.report.status);
  const modeLabel = formatMode(data.cycle.mode);

  return (
    <DesktopWorkspace
      title={`Relatório · Ciclo ${data.cycle.cycle_number}`}
      subtitle={`${formatPeriod(data.cycle.start_at, data.cycle.end_at, timeZone)} · legado excluído`}
      livePrices={livePrices}
      monitoring={monitoring}
      userLabel={userLabel}
      actions={<Link className="desktop-row-action" href="/plano-crescimento/relatorios">Voltar aos relatórios</Link>}
    >
      <section className="desktop-report-detail-header desktop-panel">
        <div>
          <span className={`desktop-report-status-label ${data.report.status.toLowerCase()}`}>{reportStatus}</span>
          <h2>{data.cycle.mode === "DEFENSIVE_POST_ATH" ? "Período defensivo" : "Ciclo operacional de 30 dias"}</h2>
          <p>Estratégia v{data.strategyVersion.version} · relatório v{data.report.report_version} · dados somente pós-baseline.</p>
        </div>
        <div className="desktop-report-export-actions" aria-label="Exportar relatório">
          <Link href={`/api/reports/${data.report.id}/pdf`}>Exportar PDF</Link>
          <Link href={`/api/reports/${data.report.id}/csv`}>CSV</Link>
          <Link href={`/api/reports/${data.report.id}/json`}>JSON</Link>
        </div>
      </section>

      <section className="desktop-report-detail-kpis desktop-dashboard-kpis" aria-label="Resumo executivo">
        <DesktopKpiCard label="Capital inicial" value={formatUsdt(summary.initial)} helper="Snapshot do início do ciclo" />
        <DesktopKpiCard label="Capital atual" value={formatUsdt(summary.current)} helper="Saldo operacional observado agora" tone="positive" />
        <DesktopKpiCard label="Gains reais" value={formatNumber(summary.realGains)} helper={`${summary.gainEvents} eventos de gain`} tone="positive" />
        <DesktopKpiCard label="Progresso equivalente" value={formatNumber(summary.progress)} helper="Real + recebido − enviado + aporte" tone="gold" />
        <DesktopKpiCard label="Metas batidas" value={summary.targetedSlots ? `${summary.targetsMet}/${summary.targetedSlots}` : "Pausada"} helper={summary.targetedSlots ? `${summary.targetRate}% dos slots com meta` : "Sem cobrança no modo defensivo"} />
        <DesktopKpiCard label="Entradas" value={formatNumber(summary.entries)} helper={`${data.rows.length} slots acompanhados`} />
      </section>

      <section className="desktop-report-detail-layout">
        <DesktopPanel title="Resumo executivo" eyebrow="Ciclo auditável" className="desktop-report-executive-panel">
          <dl className="desktop-report-definition-grid">
            <div><dt>Período</dt><dd>{formatPeriod(data.cycle.start_at, data.cycle.end_at, timeZone)}</dd></div>
            <div><dt>Status</dt><dd>{reportStatus}</dd></div>
            <div><dt>Modo do ciclo</dt><dd>{modeLabel}</dd></div>
            <div><dt>Estratégia</dt><dd>Versão {data.strategyVersion.version}</dd></div>
            <div><dt>Redistribuição</dt><dd>{formatRedistributionStatus(data.cycle.redistribution_status)}</dd></div>
            <div><dt>Encerramento</dt><dd>{formatCloseReason(data.cycle.close_reason)}</dd></div>
          </dl>
        </DesktopPanel>

        <DesktopPanel title="Integridade do relatório" eyebrow="Separação dos dados" className="desktop-report-integrity-panel">
          <div className="desktop-report-integrity-list">
            <p><strong>Legado</strong><span>Eventos anteriores ao baseline não entram nestes totais.</span></p>
            <p><strong>Capital atual</strong><span>É o saldo operacional observado; não representa fechamento imutável do ciclo.</span></p>
            <p><strong>PnL aberto</strong><span>Não é inferido neste relatório quando o payload não o fornece.</span></p>
          </div>
        </DesktopPanel>
      </section>

      <DesktopPanel title="Progresso dos slots" eyebrow="Real + recebido − enviado + aporte equivalente" className="desktop-report-progress-panel">
        <div className="desktop-table-wrap">
          <table className="desktop-data-table desktop-report-progress-table">
            <caption className="visually-hidden">Progresso de cada slot no ciclo</caption>
            <thead>
              <tr>
                <th>Ativo</th><th>Slot</th><th>Status</th><th>Inicial</th><th>Atual</th><th>Real</th><th>Recebido</th><th>Enviado</th><th>Aporte eq.</th><th>Progresso</th><th>Meta</th><th>Entradas</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => {
                const targetStatus = row.target > 0 && row.cycle_progress >= row.target ? "met" : row.target > 0 ? "pending" : "paused";
                return (
                  <tr key={`${row.asset}-${row.slot_number}`}>
                    <td><span className={`desktop-asset-pill ${row.asset.toLowerCase()}`}>{row.asset}</span></td>
                    <td><strong>#{row.slot_number}</strong></td>
                    <td><span className={`desktop-status ${normalizeStatus(row.status)}`}>{formatSlotStatus(row.status)}</span></td>
                    <td>{formatUsdt(row.operational_value_start)}</td>
                    <td>{formatUsdt(Number(row.operational_value_end || 0))}</td>
                    <td>{formatNumber(row.cycle_real_gains)}</td>
                    <td>+{formatNumber(row.cycle_redistribution_in)}</td>
                    <td>−{formatNumber(row.cycle_redistribution_out)}</td>
                    <td>+{formatNumber(row.cycle_external_gain_equivalent)}</td>
                    <td><strong>{formatNumber(row.cycle_progress)}</strong></td>
                    <td><span className={`desktop-status ${targetStatus}`}>{row.target > 0 ? formatNumber(row.target) : "Pausada"}</span></td>
                    <td>{formatNumber(row.entries_count)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!data.rows.length ? <div className="desktop-empty"><strong>Nenhum progresso registrado</strong><span>O ciclo ainda não possui slots elegíveis.</span></div> : null}
      </DesktopPanel>

      <DesktopPanel title="Eventos do regime" eyebrow="ATH e Fundo Forte auditáveis" className="desktop-report-regime-panel">
        {data.regimeEvents.length ? (
          <div className="desktop-table-wrap">
            <table className="desktop-data-table desktop-report-regime-table">
              <caption className="visually-hidden">Mudanças de regime registradas durante o ciclo</caption>
              <thead><tr><th>Data</th><th>Evento</th><th>Transição</th><th>BTC</th><th>ATH oficial</th><th>Âncora defensiva</th></tr></thead>
              <tbody>
                {data.regimeEvents.map((event, index) => (
                  <tr key={`${event.occurred_at}-${event.event_type}-${index}`}>
                    <td>{formatDateTime(event.occurred_at, timeZone)}</td>
                    <td><strong>{formatRegimeEvent(event.event_type)}</strong></td>
                    <td>{formatModeTransition(event.previous_mode, event.new_mode)}</td>
                    <td>{formatPrice(toFiniteNumber(event.btc_price))}</td>
                    <td>{formatPrice(toFiniteNumber(event.official_ath))}</td>
                    <td>{formatPrice(toFiniteNumber(event.defensive_anchor_ath))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="desktop-empty"><strong>Nenhuma mudança de regime</strong><span>O modo permaneceu estável durante o período registrado.</span></div>}
      </DesktopPanel>
    </DesktopWorkspace>
  );
}

function summarizeRows(rows: ReportSlotRow[]) {
  const totals = rows.reduce((summary, row) => ({
    initial: summary.initial + Number(row.operational_value_start || 0),
    current: summary.current + Number(row.operational_value_end || 0),
    realGains: summary.realGains + Number(row.cycle_real_gains || 0),
    progress: summary.progress + Number(row.cycle_progress || 0),
    entries: summary.entries + Number(row.entries_count || 0),
    gainEvents: summary.gainEvents + Number(row.gains_count || 0),
    targetsMet: summary.targetsMet + Number(row.target > 0 && row.cycle_progress >= row.target),
    targetedSlots: summary.targetedSlots + Number(row.target > 0)
  }), { initial: 0, current: 0, realGains: 0, progress: 0, entries: 0, gainEvents: 0, targetsMet: 0, targetedSlots: 0 });
  return { ...totals, targetRate: totals.targetedSlots ? Math.round((totals.targetsMet / totals.targetedSlots) * 100) : 0 };
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(Number(value || 0));
}

function formatPeriod(start: string, end: string | null, timeZone: string) {
  return `${formatDate(start, timeZone)} → ${end ? formatDate(end, timeZone) : "em andamento"}`;
}

function formatDate(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

function formatDateTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatReportStatus(status: string) {
  return ({ DRAFT: "Rascunho", AWAITING_CLOSURE: "Aguardando fechamento", FINALIZED: "Finalizado" } as Record<string, string>)[status] || status;
}

function formatMode(mode: string | null) {
  if (!mode) return "—";
  return mode === "DEFENSIVE_POST_ATH" ? "Defensivo pós-ATH" : mode === "NORMAL_GROWTH" ? "Crescimento normal" : mode;
}

function formatModeTransition(previous: string | null, next: string | null) {
  if (!previous && !next) return "—";
  return `${formatMode(previous)} → ${formatMode(next)}`;
}

function formatRegimeEvent(event: string) {
  return ({ NEW_ATH: "Novo ATH", STRONG_BOTTOM_REACHED: "Fundo Forte alcançado" } as Record<string, string>)[event] || event.replaceAll("_", " ");
}

function formatRedistributionStatus(status: string) {
  return ({ PENDING: "Pendente", CONFIRMED: "Confirmada", SKIPPED: "Não realizada" } as Record<string, string>)[status] || status || "—";
}

function formatCloseReason(reason: string | null) {
  if (!reason) return "Em andamento";
  return ({ NEW_ATH: "Parcial por novo ATH", PERIOD_ENDED: "Fim dos 30 dias", STRONG_BOTTOM_REACHED: "Fundo Forte alcançado" } as Record<string, string>)[reason] || reason.replaceAll("_", " ");
}

function normalizeStatus(status: string) {
  const normalized = status.toLowerCase();
  return normalized === "aberto" || normalized === "open" ? "open" : "free";
}

function formatSlotStatus(status: string) {
  return normalizeStatus(status) === "open" ? "OPEN" : "LIVRE";
}

function toFiniteNumber(value: number | string | null) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
