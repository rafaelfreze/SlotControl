"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { redistributeGains } from "@/app/dashboard/actions";
import { formatUsdt, getCurrentValue } from "@/lib/slotgain/format";
import type { SlotView, StrategyView } from "@/lib/slotgain/types";

type DashboardClientProps = {
  userEmail: string;
  strategies: StrategyView[];
  slots: SlotView[];
  setupError: string | null;
  initialNotice: string | null;
};

type StrategySummary = {
  strategy: StrategyView | null;
  asset: "BTC" | "SOL";
  name: string;
  total: number;
  profit: number;
  openSlots: number;
  totalSlots: number;
  gains: number;
  target: number;
};

function getStrategySummary(strategies: StrategyView[], slots: SlotView[], asset: "BTC" | "SOL"): StrategySummary {
  const strategy = strategies.find((item) => item.asset.toUpperCase() === asset) || null;
  const strategySlots = strategy ? slots.filter((slot) => slot.strategy_id === strategy.id) : [];
  const base = strategySlots.reduce((sum, slot) => sum + Number(slot.base_value || 0), 0);
  const total = strategySlots.reduce((sum, slot) => sum + getCurrentValue(slot), 0);
  const gains = strategySlots.reduce((sum, slot) => sum + Number(slot.gains || 0), 0);
  const fallbackTarget = asset === "BTC" ? 50 : 10;
  const target = Math.max(1, Number(strategy?.redistribution_target || fallbackTarget));

  return {
    strategy,
    asset,
    name: asset === "BTC" ? "Bitcoin" : "Solana",
    total,
    profit: total - base,
    openSlots: strategySlots.filter((slot) => slot.status === "aberto").length,
    totalSlots: strategySlots.length,
    gains,
    target
  };
}

export function DashboardClient({ userEmail, strategies, slots, setupError, initialNotice }: DashboardClientProps) {
  const [showRedistribute, setShowRedistribute] = useState(false);
  const totalBase = slots.reduce((sum, slot) => sum + Number(slot.base_value || 0), 0);
  const totalUpdated = slots.reduce((sum, slot) => sum + getCurrentValue(slot), 0);
  const profit = totalUpdated - totalBase;
  const openSlots = slots.filter((slot) => slot.status === "aberto").length;
  const totalGains = slots.reduce((sum, slot) => sum + Number(slot.gains || 0), 0);

  const btc = useMemo(() => getStrategySummary(strategies, slots, "BTC"), [strategies, slots]);
  const sol = useMemo(() => getStrategySummary(strategies, slots, "SOL"), [strategies, slots]);
  const defaultRedistributionStrategy = btc.strategy?.id || sol.strategy?.id || strategies[0]?.id || "";

  return (
    <main className="mobile-dashboard-shell">
      <header className="mobile-app-header">
        <Link className="mobile-icon-button" href="/slots" aria-label="Abrir menu de slots">
          <span />
          <span />
          <span />
        </Link>
        <div className="mobile-brand">
          <span className="mobile-brand-mark">SG</span>
          <div>
            <strong>SLOTGAIN</strong>
            <span>CONTROL</span>
          </div>
        </div>
        <Link className="mobile-icon-button settings-icon" href="/config" aria-label="Abrir configuracoes">
          ⚙
        </Link>
      </header>

      {setupError ? <section className="inline-alert dashboard-alert">Falha ao carregar dados do Supabase: {setupError}</section> : null}
      {initialNotice ? (
        <section className="form-success dashboard-notice" role="status">
          {initialNotice}
        </section>
      ) : null}

      <section className="mobile-metrics" aria-label="Resumo principal">
        <MetricCard icon="▱" title="Total atualizado" value={formatUsdt(totalUpdated)} helper="+ 2,75% hoje ↗" tone="green" />
        <MetricCard icon="▥" title="Lucro acumulado" value={formatUsdt(profit)} helper="+ 1,25% hoje ↗" tone="gold" />
        <MetricCard icon="▰" title="Slots abertos" value={String(openSlots)} helper={`de ${slots.length} disponiveis`} tone="purple" />
        <MetricCard icon="♕" title="Total de gains" value={String(totalGains)} helper={`de ${Math.max(60, btc.target + sol.target)} para redistribuir`} tone="blue" />
      </section>

      <StrategyCard summary={btc} accent="gold" />
      <StrategyCard summary={sol} accent="purple" />

      <section className="primary-actions-grid" aria-label="Acoes principais">
        <ActionLink href="/slots?flow=abrir" icon="+" title="Abrir" subtitle="Operacao" tone="green" />
        <ActionLink href="/slots?flow=gain" icon="↗" title="Registrar" subtitle="Gain" tone="gold" />
        <button className="dashboard-action-card" type="button" onClick={() => setShowRedistribute(true)}>
          <span className="action-orb purple">◔</span>
          <span>
            <strong>Redistribuir</strong>
            <em>Saldo</em>
          </span>
          <b>›</b>
        </button>
        <ActionLink href="/historico" icon="▤" title="Historico" subtitle="De operacoes" tone="blue" />
      </section>

      <section className="quick-summary-card" aria-label="Resumo rapido">
        <h2>Resumo rapido</h2>
        <div>
          <SummaryItem icon="↑" title="Melhor mes" value="+8,75 USDT" detail="Junho/2025" tone="green" />
          <SummaryItem icon="↓" title="Pior mes" value="-1,23 USDT" detail="Maio/2025" tone="red" />
          <SummaryItem icon="◷" title="Tempo em operacao" value="128 dias" detail="Desde 06/02/2025" tone="blue" />
        </div>
      </section>

      <p className="mobile-session">{userEmail}</p>

      {showRedistribute ? (
        <div className="confirm-backdrop" role="dialog" aria-modal="true" aria-label="Confirmar redistribuicao">
          <div className="confirm-card">
            <h2>Redistribuir saldo?</h2>
            <p>Os gains serao redistribuidos apenas nos slots fechados da estrategia escolhida.</p>
            <form action={redistributeGains}>
              <label>
                Estrategia
                <select name="strategyId" defaultValue={defaultRedistributionStrategy} required>
                  {strategies.map((strategy) => (
                    <option key={strategy.id} value={strategy.id}>
                      {strategy.title}
                    </option>
                  ))}
                </select>
              </label>
              <div className="confirm-actions">
                <button className="ghost-button" type="button" onClick={() => setShowRedistribute(false)}>
                  Cancelar
                </button>
                <button className="solid-button" type="submit" disabled={!defaultRedistributionStrategy}>
                  Confirmar
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function MetricCard({
  icon,
  title,
  value,
  helper,
  tone
}: {
  icon: string;
  title: string;
  value: string;
  helper: string;
  tone: "green" | "gold" | "purple" | "blue";
}) {
  const [amount, unit] = value.split(" USDT");

  return (
    <article className="mobile-metric-card">
      <span className={`metric-icon ${tone}`}>{icon}</span>
      <p>{title}</p>
      <strong>
        {amount}
        {unit !== undefined ? <small>USDT</small> : null}
      </strong>
      <em>{helper}</em>
    </article>
  );
}

function StrategyCard({ summary, accent }: { summary: StrategySummary; accent: "gold" | "purple" }) {
  const progress = Math.min(100, Math.round((summary.gains / summary.target) * 100));

  return (
    <Link className={`asset-card ${accent}`} href={`/slots?asset=${summary.asset}`}>
      <div className="asset-heading">
        <div className="asset-title">
          <span className={`asset-icon ${summary.asset.toLowerCase()}`}>{summary.asset === "BTC" ? "₿" : "S"}</span>
          <div>
            <strong>{summary.asset}</strong>
            <em>{summary.name}</em>
          </div>
        </div>
        <span className="slot-count">{summary.totalSlots} slots</span>
      </div>

      <div className="asset-stats">
        <span>
          Total <strong>{formatUsdt(summary.total)}</strong>
        </span>
        <span>
          Lucro <strong>{formatUsdt(summary.profit)}</strong>
        </span>
        <span>
          Slots abertos <strong>{summary.openSlots}</strong>
        </span>
      </div>

      <div className="redistribution-line">
        <p>Redistribuicao</p>
        <div>
          <strong>
            {summary.gains} / {summary.target}
          </strong>
          <span>gains</span>
          <i>
            <b style={{ width: `${progress}%` }} />
          </i>
          <em>{progress}%</em>
        </div>
      </div>

      <span className="details-button">Ver detalhes ›</span>
    </Link>
  );
}

function ActionLink({
  href,
  icon,
  title,
  subtitle,
  tone
}: {
  href: string;
  icon: string;
  title: string;
  subtitle: string;
  tone: "green" | "gold" | "purple" | "blue";
}) {
  return (
    <Link className="dashboard-action-card" href={href}>
      <span className={`action-orb ${tone}`}>{icon}</span>
      <span>
        <strong>{title}</strong>
        <em>{subtitle}</em>
      </span>
      <b>›</b>
    </Link>
  );
}

function SummaryItem({
  icon,
  title,
  value,
  detail,
  tone
}: {
  icon: string;
  title: string;
  value: string;
  detail: string;
  tone: "green" | "red" | "blue";
}) {
  return (
    <article className={`summary-item ${tone}`}>
      <span>{icon}</span>
      <div>
        <p>{title}</p>
        <strong>{value}</strong>
        <em>{detail}</em>
      </div>
    </article>
  );
}
