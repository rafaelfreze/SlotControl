"use client";

import { useState } from "react";

import { createStrategy, deleteStrategy, updateStrategy } from "@/app/dashboard/actions";
import { AppHeader, MobileScreen, SectionCard } from "@/components/app/mobile-ui";
import { LogoutButton } from "@/components/auth/logout-button";
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
  marketState: Partial<BtcMarketState> | null;
  regimeSettings: Partial<MarketRegimeSettingsType> | null;
  assetSettings: Partial<AssetMarketStrategySettings>[];
};

export function ConfigClient({ userEmail, strategies, slots, setupError, initialNotice, marketState, regimeSettings, assetSettings }: ConfigClientProps) {
  const [activeSection, setActiveSection] = useState<"strategies" | "account" | "system">("strategies");
  const [notice, setNotice] = useState<string | null>(initialNotice);
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
      <AppHeader title="Configurações" backHref="/dashboard" />
      {setupError ? <section className="inline-alert dashboard-alert">Falha ao carregar configurações: {setupError}</section> : null}
      {notice ? <section className="form-success dashboard-notice">{notice}</section> : null}

      <nav className="config-category-nav" aria-label="Categorias de configuração">
        {[["strategies", "Estratégias"], ["account", "Conta"], ["system", "Sistema"]].map(([key, label]) => <button key={key} type="button" className={activeSection === key ? "active" : ""} onClick={() => setActiveSection(key as typeof activeSection)}>{label}</button>)}
      </nav>

      {activeSection === "strategies" ? <>
        <SectionCard title="Estratégias" subtitle="Operacional" tone="gold">
          <div className="strategy-settings-grid">
            {btc ? <StrategySection strategy={btc} tone="gold" /> : null}
            {sol ? <StrategySection strategy={sol} tone="purple" /> : null}
          </div>
        </SectionCard>
        <MarketRegimeSettings marketState={marketState} regimeSettings={regimeSettings} assetSettings={assetSettings} editable />
      </> : null}

      {activeSection === "account" ? <>
        <SectionCard title="Conta" subtitle="Acesso" tone="green">
          <div className="settings-list modern-settings">
            <div><span>Usuário logado</span><strong>{userEmail}</strong></div>
            <div><span>Plano de crescimento</span><strong>Disponível no menu principal</strong></div>
          </div>
        </SectionCard>
        <SectionCard title="Backup" subtitle="Dados" tone="blue">
          <div className="settings-list modern-settings account-settings">
            <div><span>Exportação</span><button className="ghost-button compact-action" type="button" onClick={exportBackup}>Exportar JSON</button></div>
            <div className="account-actions">
              <LogoutButton label="Trocar conta" className="ghost-button compact-action" />
              <LogoutButton label="Sair da conta" className="danger-button compact-action" />
            </div>
          </div>
        </SectionCard>
      </> : null}

      {activeSection === "system" ? <>
        <SectionCard title="Sistema" subtitle="Aplicativo" tone="neutral">
          <div className="settings-list modern-settings">
            <div><span>Versão</span><strong>CoinOps</strong></div>
            <div><span>Ambiente</span><strong>Supabase</strong></div>
            <div><span>Operação</span><strong>Manual</strong></div>
          </div>
        </SectionCard>
        <details className="section-card mini-drawer">
          <summary>Estratégias avançadas</summary>
          <form className="tool-form stacked-form" action={createStrategy}>
            <label>Nome<input name="title" placeholder="ETH 2%" required /></label>
            <label>Chave<input name="key" placeholder="eth" /></label>
            <label>Ativo<input name="asset" placeholder="ETH" required /></label>
            <label>Base USDT<input name="baseValue" type="number" min="0" step="0.01" required /></label>
            <label>Gain %<input name="gainRate" type="number" min="0" step="0.01" required /></label>
            <label>Queda %<input name="dropPercent" type="number" min="0" step="0.01" /></label>
            <label>Reinício<input name="restartAmount" type="number" min="0" step="1" /></label>
            <button className="solid-button" type="submit">Criar estratégia</button>
          </form>
        </details>
      </> : null}
    </MobileScreen>
  );
}

function StrategySection({ strategy, tone }: { strategy: StrategyView; tone: "gold" | "purple" }) {
  return (
    <details className={`strategy-settings-card ${tone}`} open>
      <summary><strong>{strategy.asset}</strong><span>{strategy.title}</span></summary>
      <form className="tool-form stacked-form" action={updateStrategy}>
        <input type="hidden" name="strategyId" value={strategy.id} />
        <input type="hidden" name="asset" value={strategy.asset} />
        <label>Nome<input name="title" defaultValue={strategy.title} required /></label>
        <label>Chave<input name="key" defaultValue={strategy.key} required /></label>
        <label>Base USDT<input name="baseValue" type="number" min="0" step="0.01" defaultValue={formatDecimal(strategy.base_value)} required /></label>
        <label>Gain %<input name="gainRate" type="number" min="0" step="0.01" defaultValue={Number(strategy.gain_rate || 0) * 100} required /></label>
        <label>Queda %<input name="dropPercent" type="number" min="0" step="0.01" defaultValue={formatDecimal(strategy.drop_percent)} /></label>
        <label>Reinício<input name="restartAmount" type="number" min="0" step="1" defaultValue={strategy.restart_amount} /></label>
        <div className="form-actions">
          <button className="solid-button" type="submit">Salvar estratégia</button>
          {!(["BTC", "SOL"].includes(strategy.asset.toUpperCase())) ? <button className="danger-button" type="submit" formAction={deleteStrategy}>Excluir</button> : null}
        </div>
      </form>
    </details>
  );
}
