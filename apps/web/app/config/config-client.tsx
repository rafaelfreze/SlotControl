"use client";

import { type ReactNode, useState, useTransition } from "react";

import { createStrategy, deleteStrategy, updateAutomationMode, updateStrategy } from "@/app/dashboard/actions";
import { AppHeader, MobileScreen, SectionCard, StatCard } from "@/components/app/mobile-ui";
import { LogoutButton } from "@/components/auth/logout-button";
import { getAutomationModeLabel, useAutomationSetting, type AutomationMode } from "@/lib/slotgain/auto-gain";
import { formatDecimal, formatPercent } from "@/lib/slotgain/format";
import type { SlotView, StrategyView } from "@/lib/slotgain/types";

type ConfigClientProps = {
  userEmail: string;
  strategies: StrategyView[];
  slots: SlotView[];
  setupError: string | null;
  initialNotice: string | null;
  initialAutomationMode: AutomationMode;
  notifications: ReactNode;
};

export function ConfigClient({ userEmail, strategies, slots, setupError, initialNotice, initialAutomationMode, notifications }: ConfigClientProps) {
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [isSavingAutomation, startAutomationTransition] = useTransition();
  const { mode: automationMode, setMode: setAutomationMode } = useAutomationSetting(initialAutomationMode);
  const btc = strategies.find((strategy) => strategy.asset.toUpperCase() === "BTC");
  const sol = strategies.find((strategy) => strategy.asset.toUpperCase() === "SOL");

  function exportBackup() {
    const backup = { app: "SlotGain Control", exportedAt: new Date().toISOString(), user: userEmail, strategies, slots };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `slotgain-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setNotice("Backup exportado com dados carregados do Supabase.");
  }

  return (
    <MobileScreen>
      <AppHeader title="CONFIG" subtitle={userEmail} backHref="/dashboard" />
      {setupError ? <section className="inline-alert dashboard-alert">Falha ao carregar configuracoes: {setupError}</section> : null}
      {notice ? <section className="form-success dashboard-notice">{notice}</section> : null}

      <div className="asset-summary-stats">
        <StatCard title="Estrategias" value={String(strategies.length)} tone="gold" />
        <StatCard title="Slots" value={String(slots.length)} tone="purple" />
      </div>

      <SectionCard title="Estrategias" subtitle="Operacional" tone="gold">
        <div className="strategy-settings-grid">
          {btc ? <StrategySection strategy={btc} tone="gold" /> : null}
          {sol ? <StrategySection strategy={sol} tone="purple" /> : null}
        </div>
      </SectionCard>

      <SectionCard title="Conta" subtitle="Acesso" tone="green">
        <div className="settings-list modern-settings">
          <div><span>Usuario logado</span><strong>{userEmail}</strong></div>
          <div><span>Email</span><strong>{userEmail}</strong></div>
          <div><span>Plano</span><strong>Gratuito</strong></div>
        </div>
      </SectionCard>

      <SectionCard title="Backup" subtitle="Dados" tone="blue">
        <div className="settings-list modern-settings account-settings">
          <div><span>Exportacao</span><button className="ghost-button compact-action" type="button" onClick={exportBackup}>Exportar JSON</button></div>
          <div className="account-actions">
            <LogoutButton label="Trocar conta" className="ghost-button compact-action" />
            <LogoutButton label="Sair da conta" className="danger-button compact-action" />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Preferencias" subtitle="Interface" tone="purple">
        <div className="settings-list modern-settings">
          <div className="settings-action-row automation-mode-row">
            <span>Automacao</span>
            <strong>{getAutomationModeLabel(automationMode)}</strong>
          </div>
          <div className="automation-mode-grid" role="group" aria-label="Modo de automacao">
            {[
              ["off", "Desligada"],
              ["exit_only", "Somente saida"],
              ["entry_exit", "Entrada e saida"]
            ].map(([value, label]) => (
              <button
                key={value}
                className={`auto-gain-toggle ${automationMode === value ? "active" : ""}`}
                type="button"
                aria-pressed={automationMode === value}
                disabled={isSavingAutomation}
                onClick={() => {
                  const nextMode = value as AutomationMode;
                  setAutomationMode(nextMode);
                  startAutomationTransition(async () => {
                    try {
                      const result = await updateAutomationMode(nextMode);
                      setAutomationMode(result.mode);
                      setNotice("Modo de automacao salvo para app e Vercel Cron.");
                    } catch {
                      setAutomationMode(initialAutomationMode);
                      setNotice("Nao foi possivel salvar a automacao no Supabase.");
                    }
                  });
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div><span>Tema</span><strong>Dark premium</strong></div>
          <div><span>Moedas</span><strong>BTC e SOL</strong></div>
          <div><span>Backend</span><strong>Vercel Cron ativo</strong></div>
        </div>
      </SectionCard>

      {notifications}

      <SectionCard title="Sistema" subtitle="Aplicativo" tone="neutral">
        <div className="settings-list modern-settings">
          <div><span>Versao</span><strong>SlotGain Control</strong></div>
          <div><span>Ambiente</span><strong>Supabase</strong></div>
        </div>
      </SectionCard>

      <details className="section-card mini-drawer">
        <summary>Estrategias avancadas</summary>
        <form className="tool-form stacked-form" action={createStrategy}>
          <label>Nome<input name="title" placeholder="ETH 2%" required /></label>
          <label>Chave<input name="key" placeholder="eth" /></label>
          <label>Ativo<input name="asset" placeholder="ETH" required /></label>
          <label>Base USDT<input name="baseValue" type="number" min="0" step="0.01" required /></label>
          <label>Gain %<input name="gainRate" type="number" min="0" step="0.01" required /></label>
          <label>Queda %<input name="dropPercent" type="number" min="0" step="0.01" /></label>
          <label>Reinicio<input name="restartAmount" type="number" min="0" step="1" /></label>
          <button className="solid-button" type="submit">Criar estrategia</button>
        </form>
      </details>
    </MobileScreen>
  );
}

function StrategySection({ strategy, tone }: { strategy: StrategyView; tone: "gold" | "purple" }) {
  return (
    <article className={`strategy-setting-card ${tone}`}>
      <div className="strategy-setting-heading">
        <span>{strategy.asset}</span>
        <strong>{strategy.title}</strong>
      </div>
      <details className="mini-drawer strategy-editor modern-editor">
        <summary>
          <strong>{strategy.asset}</strong>
          <span>{formatPercent(strategy.gain_rate)}% gain</span>
        </summary>
        <form className="tool-form stacked-form" action={updateStrategy}>
          <input type="hidden" name="strategyId" value={strategy.id} />
          <label>Nome<input name="title" defaultValue={strategy.title} required /></label>
          <label>Ativo<input name="asset" defaultValue={strategy.asset} required /></label>
          <label>Base USDT<input name="baseValue" type="number" min="0" step="0.01" defaultValue={Number(strategy.base_value)} /></label>
          <label>Gain %<input name="gainRate" type="number" min="0" step="0.01" defaultValue={formatPercent(strategy.gain_rate)} /></label>
          <label>Queda %<input name="dropPercent" type="number" min="0" step="0.01" defaultValue={formatDecimal(strategy.drop_percent)} /></label>
          <label>Reinicio<input name="restartAmount" type="number" min="0" step="1" defaultValue={strategy.restart_amount} /></label>
          <button className="slot-button edit" type="submit">Salvar</button>
        </form>
        <form action={deleteStrategy}>
          <input type="hidden" name="strategyId" value={strategy.id} />
          <input type="hidden" name="title" value={strategy.title} />
          <button className="danger-button full-width-button" type="submit">Remover estrategia</button>
        </form>
      </details>
    </article>
  );
}
