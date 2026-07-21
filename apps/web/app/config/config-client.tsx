"use client";

import { type ReactNode, useState, useTransition } from "react";

import { createStrategy, deleteStrategy, updateAutomationMode, updateStrategy } from "@/app/dashboard/actions";
import { AppHeader, MobileScreen, SectionCard } from "@/components/app/mobile-ui";
import { LogoutButton } from "@/components/auth/logout-button";
import { getAutomationModeLabel, useAutomationSetting, type AutomationMode } from "@/lib/slotgain/auto-gain";
import type { AutomationDiagnostics } from "@/lib/slotgain/automation-server";
import { formatDecimal, formatPercent } from "@/lib/slotgain/format";
import type { SlotView, StrategyView } from "@/lib/slotgain/types";
import { MarketRegimeSettings } from "@/components/slotgain/market-regime-settings";
import type { AssetMarketStrategySettings, BtcMarketState, MarketRegimeSettings as MarketRegimeSettingsType } from "@/lib/slotgain/market-regime";

type ConfigClientProps = {
  userEmail: string;
  strategies: StrategyView[];
  slots: SlotView[];
  setupError: string | null;
  initialNotice: string | null;
  initialAutomationMode: AutomationMode;
  notifications: ReactNode;
  marketState: Partial<BtcMarketState> | null;
  regimeSettings: Partial<MarketRegimeSettingsType> | null;
  assetSettings: Partial<AssetMarketStrategySettings>[];
  automationDiagnostics: AutomationDiagnostics | null;
};

export function ConfigClient({ userEmail, strategies, slots, setupError, initialNotice, initialAutomationMode, notifications, marketState, regimeSettings, assetSettings, automationDiagnostics }: ConfigClientProps) {
  const [activeSection, setActiveSection] = useState<"strategies" | "automation" | "notifications" | "account" | "system">("strategies");
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [isSavingAutomation, startAutomationTransition] = useTransition();
  const { mode: automationMode, setMode: setAutomationMode } = useAutomationSetting(initialAutomationMode);
  const btc = strategies.find((strategy) => strategy.asset.toUpperCase() === "BTC");
  const sol = strategies.find((strategy) => strategy.asset.toUpperCase() === "SOL");

  function exportBackup() {
    const backup = { app: "CoinOps", exportedAt: new Date().toISOString(), user: userEmail, strategies, slots };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `coinops-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setNotice("Backup exportado com dados carregados do Supabase.");
  }

  return (
    <MobileScreen>
      <AppHeader title="Configuracoes" backHref="/dashboard" />
      {setupError ? <section className="inline-alert dashboard-alert">Falha ao carregar configuracoes: {setupError}</section> : null}
      {notice ? <section className="form-success dashboard-notice">{notice}</section> : null}

      <nav className="config-category-nav" aria-label="Categorias de configuracao">
        {[['strategies','Estrategias'],['automation','Automacao'],['notifications','Notificacoes'],['account','Conta'],['system','Sistema']].map(([key,label]) => <button key={key} type="button" className={activeSection === key ? "active" : ""} onClick={() => setActiveSection(key as typeof activeSection)}>{label}</button>)}
      </nav>

      {activeSection === "strategies" ? <><SectionCard title="Estrategias" subtitle="Operacional" tone="gold">
        <div className="strategy-settings-grid">
          {btc ? <StrategySection strategy={btc} tone="gold" /> : null}
          {sol ? <StrategySection strategy={sol} tone="purple" /> : null}
        </div>
      </SectionCard>

      <MarketRegimeSettings marketState={marketState} regimeSettings={regimeSettings} assetSettings={assetSettings} editable />
      </> : null}

      {activeSection === "account" ? <><SectionCard title="Conta" subtitle="Acesso" tone="green">
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
      </> : null}

      {activeSection === "automation" ? <SectionCard title="Automacao" subtitle="Operacao" tone="purple">
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
          <div className="automation-explanation">Entradas usam a minima do candle de 1 minuto; saidas usam a maxima. Nao e necessario o preco bater exatamente no gatilho.</div>
        </div>
        <AutomationDiagnosticsPanel diagnostics={automationDiagnostics} slots={slots} />
      </SectionCard>
      : null}

      {activeSection === "notifications" ? notifications : null}

      {activeSection === "system" ? <><SectionCard title="Sistema" subtitle="Aplicativo" tone="neutral">
        <div className="settings-list modern-settings">
          <div><span>Versao</span><strong>CoinOps</strong></div>
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
      </> : null}
    </MobileScreen>
  );
}

function formatAutomationMoment(value: string | null) {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--" : new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit", day: "2-digit", month: "2-digit" }).format(date);
}

function AutomationDiagnosticsPanel({ diagnostics, slots }: { diagnostics: AutomationDiagnostics | null; slots: SlotView[] }) {
  const worker = diagnostics?.worker;
  const stats = worker?.stats || {};
  const status = worker?.status === "COMPLETED" ? "Saudavel" : worker?.status === "DEGRADED" ? "Degradado" : worker?.status === "FAILED" ? "Com falha" : worker?.status === "RUNNING" ? "Em execucao" : "Aguardando primeira execucao";
  const perAsset = (["BTC", "SOL"] as const).map((asset) => {
    const scoped = slots.filter((slot) => slot.strategy?.asset?.toUpperCase() === asset);
    const waiting = scoped.filter((slot) => slot.status === "hold");
    const open = scoped.filter((slot) => slot.status === "aberto");
    const nextEntry = waiting.map((slot) => Number(slot.preco_entrada || 0)).filter((value) => value > 0).sort((a, b) => b - a).at(-1);
    const nextExit = open.map((slot) => Number(slot.preco_alvo || 0)).filter((value) => value > 0).sort((a, b) => a - b).at(0);
    const cursor = diagnostics?.cursors.find((item) => item.asset === asset);
    const latestWindow = diagnostics?.latestWindows.find((item) => item.asset === asset);
    return { asset, waiting: waiting.length, open: open.length, nextEntry, nextExit, cursor, latestWindow };
  });

  return (
    <div className="automation-diagnostics" aria-label="Diagnostico da automacao">
      <div className="automation-health-grid">
        <div><span>Worker</span><strong>{status}</strong></div>
        <div><span>Ultima verificacao</span><strong>{formatAutomationMoment(worker?.completedAt || worker?.startedAt || null)}</strong></div>
        <div><span>Candles processados</span><strong>{String(stats.candlesProcessed ?? 0)}</strong></div>
        <div><span>Backlog</span><strong>{String(stats.backlogCandles ?? 0)} min</strong></div>
        <div><span>Fonte</span><strong title={worker?.source || undefined}>{worker?.source || "Aguardando"}</strong></div>
      </div>
      <div className="automation-asset-grid">
        {perAsset.map((item) => (
          <article key={item.asset} className="automation-asset-card">
            <strong>{item.asset}</strong>
            <span>Aguardando entrada: {item.waiting}</span>
            <span>Aguardando saida: {item.open}</span>
            <span>Proxima entrada: {item.nextEntry ? formatDecimal(item.nextEntry) : "--"}</span>
            <span>Proxima saida: {item.nextExit ? formatDecimal(item.nextExit) : "--"}</span>
            <span>Janela lida: {formatAutomationMoment(item.cursor?.lastWindowEnd || null)}</span>
            <span>Low / High: {item.latestWindow ? `${formatDecimal(Number(item.latestWindow.low))} / ${formatDecimal(Number(item.latestWindow.high))}` : "--"}</span>
          </article>
        ))}
      </div>
      {diagnostics?.decisions.length ? <details className="mini-drawer automation-decision-history">
        <summary>Ultimas decisoes ({diagnostics.decisions.length})</summary>
        <div className="automation-decision-list">
          {diagnostics.decisions.map((decision) => <div key={decision.id}>
            <strong>{decision.decision} {decision.asset} {decision.eventType === "ENTRY" ? "entrada" : "saida"}</strong>
            <span>Slot {decision.slotId.slice(0, 8)} · {decision.reason} · {formatAutomationMoment(decision.windowEnd)}</span>
          </div>)}
        </div>
      </details> : null}
      {worker?.error ? <div className="inline-alert automation-error">{worker.error}</div> : null}
    </div>
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
