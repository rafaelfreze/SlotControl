"use client";

import Link from "next/link";
import { useMemo, useState, type CSSProperties } from "react";

import { DesktopWorkspace } from "@/components/app/desktop-workspace";
import type { MarketTickerState } from "@/components/app/mobile-ui";
import { useCoinOpsWorkspaceData } from "@/lib/coinops-workspace/client";
import type { CoinOpsWorkspaceData } from "@/lib/coinops-workspace/server";
import { formatSignedUsdt, formatUsdt, getMarkedSlotValue, getOpenMarketMetrics } from "@/lib/slotgain/format";
import type { CapitalContributionView } from "@/lib/slotgain/capital-contributions";
import type { SlotView, StrategyView } from "@/lib/slotgain/types";
import type { OfficialMonitoringOverview } from "@/lib/coinops-monitoring/server";

type DesktopDashboardProps = {
  userLabel: string;
  strategies: StrategyView[];
  slots: SlotView[];
  contributions: CapitalContributionView[];
  monitoring: OfficialMonitoringOverview;
  livePrices: MarketTickerState;
};

type Asset = "BTC" | "SOL";
const EMPTY_PROGRESS: CoinOpsWorkspaceData["progress"] = [];
const EMPTY_SNAPSHOTS: CoinOpsWorkspaceData["snapshots"] = [];
const EMPTY_ALERTS: CoinOpsWorkspaceData["alerts"] = [];
const EMPTY_QUEUE: CoinOpsWorkspaceData["queue"] = [];

function assetOf(slot: SlotView): Asset {
  return slot.strategy?.asset?.toUpperCase() === "SOL" ? "SOL" : "BTC";
}

function operationalGains(slot: SlotView) {
  const value = Number(slot.operational_gains);
  return Number.isFinite(value) ? value : Number(slot.gains || 0);
}

export function DesktopDashboard({ userLabel, slots, monitoring, livePrices }: DesktopDashboardProps) {
  const [range, setRange] = useState<7 | 30 | 90 | 0>(30);
  const { data: workspace, status: workspaceStatus } = useCoinOpsWorkspaceData();
  const workspaceProgress = workspace?.progress ?? EMPTY_PROGRESS;
  const workspaceSnapshots = workspace?.snapshots ?? EMPTY_SNAPSHOTS;
  const workspaceAlerts = workspace?.alerts ?? EMPTY_ALERTS;
  const workspaceQueue = workspace?.queue ?? EMPTY_QUEUE;
  const summaries = useMemo(() => (["BTC", "SOL"] as const).map((asset) => {
    const assetSlots = slots.filter((slot) => assetOf(slot) === asset);
    const price = livePrices.prices[asset];
    return {
      asset,
      slots: assetSlots.length,
      total: assetSlots.reduce((total, slot) => total + getMarkedSlotValue(slot, price), 0),
      open: assetSlots.filter((slot) => slot.status === "aberto").length
    };
  }), [livePrices.prices, slots]);
  const realized = slots.reduce((total, slot) => total + Number(slot.realized_profit || 0), 0);
  const openSlots = slots.filter((slot) => slot.status === "aberto");
  const openPnl = openSlots.reduce((total, slot) => total + getOpenMarketMetrics(slot, livePrices.prices[assetOf(slot)]).resultadoAbertoUsdt, 0);
  const equity = slots.reduce((total, slot) => total + getMarkedSlotValue(slot, livePrices.prices[assetOf(slot)]), 0);
  const cycleMode = monitoring.strategy ? (monitoring.strategy.mode === "DEFENSIVE_POST_ATH" ? "Defensivo" : "Normal") : "Aguardando";
  const snapshots = range === 0 ? workspaceSnapshots : workspaceSnapshots.slice(-range);
  const targetMet = workspaceProgress.filter((item) => item.cycle_progress >= item.target).length;
  const belowTarget = workspaceProgress.filter((item) => item.cycle_progress < item.target).length;
  const zeroed = slots.filter((slot) => operationalGains(slot) === 0).length;
  const distributionTotal = summaries.reduce((total, item) => total + Math.max(0, item.total), 0);

  return (
    <DesktopWorkspace title="Resumo geral" subtitle="Visão completa da operação" livePrices={livePrices} monitoring={monitoring} userLabel={userLabel} actions={<><Link href="/plano-crescimento/relatorios">Relatórios</Link><Link href="/alertas">Alertas</Link></>}>
      <section className="desktop-kpi-grid" aria-label="Indicadores principais">
        <Kpi label="Patrimônio" value={formatUsdt(equity)} helper={`${slots.length} slots operacionais`} tone="positive" />
        <Kpi label="Lucro realizado" value={formatSignedUsdt(realized)} helper="Acumulado registrado" tone={realized >= 0 ? "positive" : "negative"} />
        <Kpi label="PnL aberto" value={formatSignedUsdt(openPnl)} helper={`${openSlots.length} posições`} tone={openPnl >= 0 ? "positive" : "negative"} />
        {summaries.map((summary) => <Kpi key={summary.asset} label={summary.asset} value={formatUsdt(summary.total)} helper={`${summary.open}/${summary.slots} abertos`} asset={summary.asset} />)}
        <Kpi label="Slots ativos" value={`${openSlots.length} / ${slots.length}`} helper="Posições abertas" />
        <Kpi label="Modo atual" value={cycleMode} helper={monitoring.strategy ? `BTC ${monitoring.strategy.btc_spacing}% · SOL ${monitoring.strategy.sol_spacing}%` : "Baseline ainda inativo"} tone={cycleMode === "Normal" ? "positive" : "attention"} />
      </section>

      <section className="desktop-dashboard-grid">
        <article className="desktop-panel desktop-chart-panel">
          <header className="desktop-panel-header"><div><span>Monitoramento oficial</span><h2>Saldo operacional do ciclo</h2></div><div className="desktop-segmented" aria-label="Período do gráfico">{([7, 30, 90, 0] as const).map((value) => <button key={value} type="button" className={range === value ? "active" : ""} onClick={() => setRange(value)}>{value === 0 ? "Tudo" : `${value}D`}</button>)}</div></header>
          <OperationalChart snapshots={snapshots} loading={workspaceStatus === "idle" || workspaceStatus === "loading"} />
        </article>

        <article className="desktop-panel desktop-distribution-panel">
          <header className="desktop-panel-header"><div><span>Composição atual</span><h2>Distribuição BTC / SOL</h2></div></header>
          <div className="desktop-donut" style={{ "--btc-share": `${distributionTotal ? (summaries[0].total / distributionTotal) * 100 : 50}%` } as CSSProperties}><span><strong>{formatUsdt(distributionTotal)}</strong><small>Total marcado</small></span></div>
          <div className="desktop-distribution-legend">{summaries.map((summary) => <div key={summary.asset}><i className={summary.asset.toLowerCase()} /><span>{summary.asset}<small>{distributionTotal ? ((summary.total / distributionTotal) * 100).toFixed(1).replace(".", ",") : "0,0"}%</small></span><strong>{formatUsdt(summary.total)}</strong></div>)}</div>
          <p className="desktop-data-note">USDT disponível não é rastreado separadamente e não foi estimado.</p>
        </article>

        <article className="desktop-panel desktop-alerts-panel">
          <header className="desktop-panel-header"><div><span>Monitoramento</span><h2>Alertas recentes</h2></div><Link href="/alertas">Ver todos</Link></header>
          <div className="desktop-alert-list">
            {workspaceAlerts.slice(0, 4).map((alert) => <Link href="/alertas" className={`desktop-alert-row ${alert.severity.toLowerCase()}`} key={alert.id}><i aria-hidden="true" /><span><strong>{alert.title}</strong><small>{alert.message}</small></span><time>{formatCompactDate(alert.occurred_at)}</time></Link>)}
            {workspaceStatus === "loading" || workspaceStatus === "idle" ? <p className="desktop-empty">Carregando alertas oficiais...</p> : null}
            {workspaceStatus === "error" ? <p className="desktop-empty">Alertas oficiais indisponíveis no momento.</p> : null}
            {workspaceStatus === "success" && !workspaceAlerts.length ? <p className="desktop-empty">Nenhum alerta registrado desde o baseline.</p> : null}
            {livePrices.isStale ? <div className="desktop-alert-row critical"><i aria-hidden="true" /><span><strong>Feed de preço desatualizado</strong><small>Os últimos preços não estão atualizando no intervalo esperado.</small></span></div> : null}
          </div>
        </article>

        <article className="desktop-panel desktop-slot-overview">
          <header className="desktop-panel-header"><div><span>Capacidade e meta</span><h2>Visão geral dos slots</h2></div><Link href="/slots">Abrir tabela</Link></header>
          <div className="desktop-slot-metrics">
            <MiniMetric label="Total" value={slots.length} helper="slots" />
            <MiniMetric label="Abertos" value={openSlots.length} helper={`${slots.length ? Math.round((openSlots.length / slots.length) * 100) : 0}%`} tone="green" />
            <MiniMetric label="Livres" value={slots.length - openSlots.length} helper="disponíveis" />
            <MiniMetric label="Abaixo da meta" value={belowTarget} helper="no ciclo" tone="blue" />
            <MiniMetric label="Meta batida" value={targetMet} helper="no ciclo" tone="gold" />
            <MiniMetric label="Zerados" value={zeroed} helper="operacionais" />
          </div>
        </article>

        <article className="desktop-panel desktop-next-slots">
          <header className="desktop-panel-header"><div><span>Prioridade oficial</span><h2>Próximos slots para operação</h2></div><Link href="/slots">Ver todos</Link></header>
          <div className="desktop-table-wrap">
            <table className="desktop-data-table"><thead><tr><th>Prioridade</th><th>Ativo</th><th>Slot</th><th>Gains</th><th>Meta</th><th>Saldo</th><th>Status</th><th>Ação</th></tr></thead><tbody>{workspaceQueue.slice(0, 7).map((item, index) => <tr key={item.slot_id}><td>#{index + 1}</td><td><span className={`desktop-asset-pill ${item.asset.toLowerCase()}`}>{item.asset}</span></td><td>Slot #{item.slot_number}</td><td>{item.operational_gains}</td><td>{item.target === null ? "Pausada" : `${item.cycle_progress}/${item.target}`}</td><td>{formatUsdt(item.operational_value)}</td><td><span className="desktop-status pending">Elegível</span></td><td><Link className="desktop-row-action" href={`/slots?asset=${item.asset}`}>Operar</Link></td></tr>)}</tbody></table>
            {workspaceStatus === "loading" || workspaceStatus === "idle" ? <p className="desktop-empty">Carregando fila oficial...</p> : null}
            {workspaceStatus === "error" ? <p className="desktop-empty">Fila oficial indisponível no momento.</p> : null}
            {workspaceStatus === "success" && !workspaceQueue.length ? <p className="desktop-empty">A fila aparecerá quando o baseline e o ciclo oficial estiverem ativos.</p> : null}
          </div>
        </article>

        <aside className="desktop-dashboard-aside">
          <article className="desktop-panel desktop-quick-actions">
            <header className="desktop-panel-header"><div><span>Fluxos existentes</span><h2>Ações rápidas</h2></div></header>
            <div><QuickAction href="/slots?flow=abrir" label="Abrir operação" icon="plus" /><QuickAction href="/slots?flow=gain" label="Registrar gain" icon="check" /><QuickAction href="/plano-crescimento" label="Redistribuir" icon="swap" /><QuickAction href="/slots" label="Adicionar slot" icon="grid" /><QuickAction href="/plano-crescimento/relatorios" label="Relatórios" icon="report" /><QuickAction href="/config" label="Configurações" icon="settings" /></div>
          </article>
          <article className="desktop-panel desktop-cycle-card">
            <header className="desktop-panel-header"><div><span>Monitoramento oficial</span><h2>Ciclo atual</h2></div><Link href="/ciclos">Detalhes</Link></header>
            {monitoring.active && monitoring.cycle ? <dl><div><dt>Ciclo</dt><dd>#{monitoring.cycle.number}</dd></div><div><dt>Início</dt><dd>{formatCompactDate(monitoring.cycle.start_at)}</dd></div><div><dt>Dias restantes</dt><dd>{monitoring.cycle.days_remaining ?? "-"}</dd></div><div><dt>Modo</dt><dd>{cycleMode}</dd></div><div><dt>Meta BTC</dt><dd>{monitoring.assets?.BTC?.target ?? "Pausada"}</dd></div><div><dt>Meta SOL</dt><dd>{monitoring.assets?.SOL?.target ?? "Pausada"}</dd></div></dl> : <p className="desktop-empty">Ative o baseline oficial no Plano para iniciar os ciclos.</p>}
          </article>
        </aside>
      </section>
    </DesktopWorkspace>
  );
}

function Kpi({ label, value, helper, tone = "neutral", asset }: { label: string; value: string; helper: string; tone?: "neutral" | "positive" | "negative" | "attention"; asset?: Asset }) {
  return <article className={`desktop-kpi ${tone}${asset ? ` ${asset.toLowerCase()}` : ""}`}><span>{asset ? <i className={`desktop-asset-dot ${asset.toLowerCase()}`} /> : null}{label}</span><strong>{value}</strong><small>{helper}</small></article>;
}

function MiniMetric({ label, value, helper, tone = "neutral" }: { label: string; value: number; helper: string; tone?: "neutral" | "green" | "blue" | "gold" }) {
  return <div className={`desktop-mini-metric ${tone}`}><strong>{value}</strong><span>{label}</span><small>{helper}</small></div>;
}

function OperationalChart({ snapshots, loading }: { snapshots: CoinOpsWorkspaceData["snapshots"]; loading: boolean }) {
  if (loading) return <div className="desktop-chart-empty"><strong>Carregando dados do ciclo...</strong></div>;
  const points = snapshots.map((item) => ({ date: item.snapshot_date, value: Number(item.operational_total || 0) })).filter((item) => Number.isFinite(item.value));
  if (points.length < 2) return <div className="desktop-chart-empty"><span aria-hidden="true">·</span><strong>A coleta histórica começa no baseline</strong><small>O gráfico será formado somente com snapshots reais do ciclo.</small></div>;
  const min = Math.min(...points.map((item) => item.value));
  const max = Math.max(...points.map((item) => item.value));
  const spread = Math.max(max - min, Math.max(1, max * 0.01));
  const path = points.map((point, index) => `${index ? "L" : "M"} ${(index / Math.max(1, points.length - 1)) * 1000} ${230 - ((point.value - min) / spread) * 190}`).join(" ");
  const area = `${path} L 1000 250 L 0 250 Z`;
  return <div className="desktop-line-chart"><svg role="img" aria-label={`Saldo operacional de ${formatUsdt(points[0].value)} a ${formatUsdt(points.at(-1)?.value || 0)}`} viewBox="0 0 1000 260" preserveAspectRatio="none"><defs><linearGradient id="operational-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#35d39a" stopOpacity=".32" /><stop offset="1" stopColor="#35d39a" stopOpacity="0" /></linearGradient></defs><path className="chart-grid" d="M0 50H1000M0 100H1000M0 150H1000M0 200H1000" /><path className="chart-area" d={area} /><path className="chart-line" d={path} /></svg><div><span>{formatCompactDate(points[0].date)}</span><strong>{formatUsdt(points.at(-1)?.value || 0)}</strong><span>{formatCompactDate(points.at(-1)?.date || "")}</span></div></div>;
}

function QuickAction({ href, label, icon }: { href: string; label: string; icon: string }) {
  return <Link href={href}><span className={`desktop-action-icon ${icon}`} aria-hidden="true" /><strong>{label}</strong></Link>;
}

function formatCompactDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" }).format(date);
}
