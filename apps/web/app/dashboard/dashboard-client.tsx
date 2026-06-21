"use client";

import { AppShell } from "@/components/app/app-shell";
import { formatUsdt, getCurrentValue } from "@/lib/slotgain/format";
import type { SlotView, StrategyView } from "@/lib/slotgain/types";

type DashboardClientProps = {
  userEmail: string;
  strategies: StrategyView[];
  slots: SlotView[];
  setupError: string | null;
  initialNotice: string | null;
};

export function DashboardClient({ userEmail, strategies, slots, setupError, initialNotice }: DashboardClientProps) {
  const totalBase = slots.reduce((sum, slot) => sum + Number(slot.base_value || 0), 0);
  const totalUpdated = slots.reduce((sum, slot) => sum + getCurrentValue(slot), 0);
  const openSlots = slots.filter((slot) => slot.status === "aberto").length;
  const priorityStrategies = strategies.filter((strategy) => ["BTC", "SOL"].includes(strategy.asset.toUpperCase()));
  const summaryStrategies = priorityStrategies.length > 0 ? priorityStrategies : strategies.slice(0, 2);

  return (
    <AppShell userEmail={userEmail}>
      {setupError ? (
        <section className="inline-alert dashboard-alert">
          Falha ao carregar dados do Supabase: {setupError}
        </section>
      ) : null}

      {initialNotice ? (
        <section className="form-success dashboard-notice" role="status">
          {initialNotice}
        </section>
      ) : null}

      <section className="metric-grid dashboard-only-summary" aria-label="Resumo principal">
        <article className="metric-card">
          <span>Total atualizado</span>
          <strong>{formatUsdt(totalUpdated)}</strong>
        </article>
        <article className="metric-card positive">
          <span>Lucro acumulado</span>
          <strong>{formatUsdt(totalUpdated - totalBase)}</strong>
        </article>
        <article className="metric-card">
          <span>Slots abertos</span>
          <strong>{openSlots}</strong>
        </article>
      </section>

      <section className="crypto-summary-grid compact-crypto-grid" aria-label="Resumo BTC e SOL">
        {summaryStrategies.map((strategy) => {
          const strategySlots = slots.filter((slot) => slot.strategy_id === strategy.id);
          const strategyBase = strategySlots.reduce((sum, slot) => sum + Number(slot.base_value || 0), 0);
          const strategyUpdated = strategySlots.reduce((sum, slot) => sum + getCurrentValue(slot), 0);
          const strategyOpen = strategySlots.filter((slot) => slot.status === "aberto").length;

          return (
            <article key={strategy.id} className="crypto-card">
              <div className="crypto-card-header">
                <h2>{strategy.asset}</h2>
                <span>{strategySlots.length} slots</span>
              </div>
              <p>
                Total <strong>{formatUsdt(strategyUpdated)}</strong>
              </p>
              <div className="crypto-stats">
                <span>
                  Lucro <strong>{formatUsdt(strategyUpdated - strategyBase)}</strong>
                </span>
                <span>
                  Abertos <strong>{strategyOpen}</strong>
                </span>
              </div>
            </article>
          );
        })}
      </section>

      <section className="quick-flow-grid" aria-label="Acoes principais">
        <a className="quick-flow-card hot" href="/slots">
          <span>Fluxo principal</span>
          <strong>Abrir, +Gain, Zerar</strong>
        </a>
        <a className="quick-flow-card" href="/slots">
          <span>Manutencao</span>
          <strong>Redistribuir saldo</strong>
        </a>
      </section>
    </AppShell>
  );
}
