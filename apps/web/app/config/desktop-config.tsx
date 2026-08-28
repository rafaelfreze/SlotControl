"use client";

import Link from "next/link";
import { useState } from "react";

import { createStrategy, deleteStrategy, updateStrategy } from "@/app/dashboard/actions";
import { DesktopWorkspace } from "@/components/app/desktop-workspace";
import type { MarketTickerState } from "@/components/app/mobile-ui";
import { LogoutButton } from "@/components/auth/logout-button";
import { MarketRegimeSettings } from "@/components/slotgain/market-regime-settings";
import { useCoinOpsWorkspaceData } from "@/lib/coinops-workspace/client";
import type { AssetMarketStrategySettings, BtcMarketState, MarketRegimeSettings as MarketRegimeSettingsType } from "@/lib/slotgain/market-regime";
import type { SlotView, StrategyView } from "@/lib/slotgain/types";

type Section = "account" | "strategy" | "slots" | "notifications" | "data" | "security" | "system";
type DesktopConfigProps = {
  userLabel: string;
  strategies: StrategyView[];
  slots: SlotView[];
  livePrices: MarketTickerState;
  marketState: Partial<BtcMarketState> | null;
  regimeSettings: Partial<MarketRegimeSettingsType> | null;
  assetSettings: Partial<AssetMarketStrategySettings>[];
};


export function DesktopConfig({ userLabel, strategies, slots, livePrices, marketState, regimeSettings, assetSettings }: DesktopConfigProps) {
  const [section, setSection] = useState<Section>("account");
  const { data: workspace } = useCoinOpsWorkspaceData();
  const monitoring = workspace?.overview;
  function exportBackup() {
    const payload = { app: "CoinOps", exportedAt: new Date().toISOString(), strategies, slots };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `coinops-backup-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  const items: Array<[Section, string, string]> = [
    ["account", "Conta", "Perfil e sessão"],
    ["strategy", "Estratégia", "Gains e parâmetros"],
    ["slots", "Slots", "Capacidade e reserva"],
    ["notifications", "Notificações", "Alertas operacionais"],
    ["data", "Dados", "Exportações e backup"],
    ["security", "Segurança", "Acesso e autenticação"],
    ["system", "Sistema", "Versão e conexão"]
  ];

  return <DesktopWorkspace title="Configurações" subtitle="Preferências, estratégia e segurança" livePrices={livePrices} monitoring={monitoring} userLabel={userLabel}>
    <section className="desktop-settings-layout">
      <nav className="desktop-settings-nav" aria-label="Áreas das configurações">{items.map(([value, label, helper]) => <button type="button" key={value} className={section === value ? "active" : ""} onClick={() => setSection(value)}><strong>{label}</strong><small>{helper}</small></button>)}</nav>
      <div className="desktop-settings-content">
        {section === "account" ? <SettingsPanel eyebrow="Conta" title="Perfil do usuário"><div className="desktop-account-profile"><span>{userLabel.slice(0, 1).toUpperCase()}</span><div><strong>{userLabel}</strong><small>Conta autenticada · plano Premium</small></div></div><div className="desktop-setting-list"><Setting label="E-mail" value={userLabel} /><Setting label="Plano" value="Premium" /><Setting label="Sessão" value="Ativa e protegida" /></div><LogoutButton label="Sair da conta" className="desktop-danger-button" /></SettingsPanel> : null}
        {section === "strategy" ? (
          <StrategySettings
            strategies={strategies}
            marketState={marketState}
            regimeSettings={regimeSettings}
            assetSettings={assetSettings}
          />
        ) : null}
        {section === "slots" ? <SettingsPanel eyebrow="Capacidade" title="Slots e reservas"><div className="desktop-setting-list"><Setting label="Slots existentes" value={String(slots.length)} /><Setting label="BTC principais abertos" value={`${monitoring?.pools?.BTC?.main_open ?? 0}/25`} /><Setting label="SOL principais abertos" value={`${monitoring?.pools?.SOL?.main_open ?? 0}/25`} /><Setting label="Reserva BTC habilitada" value={String(monitoring?.pools?.BTC?.reserve_enabled ?? 0)} /><Setting label="Reserva SOL habilitada" value={String(monitoring?.pools?.SOL?.reserve_enabled ?? 0)} /></div><Link className="desktop-secondary-button" href="/slots">Gerenciar slots</Link></SettingsPanel> : null}
        {section === "notifications" ? <SettingsPanel eyebrow="Monitoramento" title="Alertas e notificações"><p className="desktop-empty">Os alertas internos oficiais estão disponíveis na central. Preferências adicionais permanecem no fluxo atual do aplicativo.</p><Link className="desktop-primary-button" href="/alertas">Abrir central de alertas</Link></SettingsPanel> : null}
        {section === "data" ? <SettingsPanel eyebrow="Privacidade" title="Dados e exportações"><div className="desktop-setting-list"><Setting label="Histórico" value="CSV por evento, ativo e slot" /><Setting label="Relatórios" value="PDF, CSV e JSON por ciclo" /><Setting label="Backup" value="JSON dos dados carregados" /></div><div className="desktop-button-row"><button type="button" className="desktop-primary-button" onClick={exportBackup}>Exportar backup</button><Link className="desktop-secondary-button" href="/plano-crescimento/relatorios">Relatórios de ciclo</Link></div></SettingsPanel> : null}
        {section === "security" ? <SettingsPanel eyebrow="Segurança" title="Conta e autenticação"><div className="desktop-setting-list"><Setting label="Autenticação" value="Supabase Auth" /><Setting label="Dados privados" value="Protegidos por RLS" /><Setting label="Sessão" value="Gerenciada no servidor" /></div></SettingsPanel> : null}
        {section === "system" ? <SettingsPanel eyebrow="CoinOps" title="Sistema"><div className="desktop-setting-list"><Setting label="Feed de preços" value={livePrices.status === "online" ? "Conectado" : "Atualizando"} /><Setting label="Monitoramento oficial" value={monitoring?.active ? "Ativo" : "Ainda não ativado"} /><Setting label="Interface desktop" value="Workspace premium" /></div></SettingsPanel> : null}
      </div>
    </section>
  </DesktopWorkspace>;
}

function StrategySettings({
  strategies,
  marketState,
  regimeSettings,
  assetSettings
}: {
  strategies: StrategyView[];
  marketState: Partial<BtcMarketState> | null;
  regimeSettings: Partial<MarketRegimeSettingsType> | null;
  assetSettings: Partial<AssetMarketStrategySettings>[];
}) {
  const primaryStrategies = strategies.filter((strategy) => ["BTC", "SOL"].includes(strategy.asset.toUpperCase()));
  const additionalStrategies = strategies.filter((strategy) => !["BTC", "SOL"].includes(strategy.asset.toUpperCase()));

  return (
    <SettingsPanel eyebrow="Operação" title="Estratégias BTC e SOL">
      <p className="desktop-data-note">Alterações afetam novas operações. Revise os valores antes de salvar.</p>
      <div className="desktop-strategy-grid">
        {primaryStrategies.map((strategy) => <StrategyEditor key={strategy.id} strategy={strategy} />)}
      </div>

      <details className="desktop-settings-details">
        <summary><span>Regime de mercado e entradas</span><small>ATH, modo e espaçamentos BTC/SOL</small></summary>
        <div className="desktop-settings-details-body">
          <MarketRegimeSettings marketState={marketState} regimeSettings={regimeSettings} assetSettings={assetSettings} editable />
        </div>
      </details>

      <details className="desktop-settings-details">
        <summary><span>Estratégias avançadas</span><small>Criar, editar e excluir estratégias adicionais</small></summary>
        <div className="desktop-settings-details-body">
          {additionalStrategies.length > 0 ? (
            <div className="desktop-strategy-grid desktop-strategy-grid-advanced">
              {additionalStrategies.map((strategy) => <StrategyEditor key={strategy.id} strategy={strategy} deletable />)}
            </div>
          ) : <p className="desktop-data-note">Nenhuma estratégia adicional criada.</p>}

          <form action={createStrategy} className="desktop-strategy-form desktop-create-strategy">
            <header><strong>Criar estratégia</strong><small>Configuração avançada</small></header>
            <label>Nome<input name="title" placeholder="ETH 2%" required /></label>
            <label>Chave<input name="key" placeholder="eth" /></label>
            <label>Ativo<input name="asset" placeholder="ETH" required /></label>
            <label>Base USDT<input name="baseValue" type="number" min="0" step="0.01" required /></label>
            <label>Gain %<input name="gainRate" type="number" min="0" step="0.01" required /></label>
            <label>Queda %<input name="dropPercent" type="number" min="0" step="0.01" /></label>
            <label>Reinício<input name="restartAmount" type="number" min="0" step="1" /></label>
            <button className="desktop-primary-button" type="submit">Criar estratégia</button>
          </form>
        </div>
      </details>

      <Link className="desktop-secondary-button" href="/plano-crescimento/regras">Ver regras oficiais atuais</Link>
    </SettingsPanel>
  );
}

function StrategyEditor({ strategy, deletable = false }: { strategy: StrategyView; deletable?: boolean }) {
  return (
    <form action={updateStrategy} className="desktop-strategy-form">
      <header><span className={"desktop-asset-pill " + strategy.asset.toLowerCase()}>{strategy.asset}</span><strong>{strategy.title}</strong></header>
      <input type="hidden" name="strategyId" value={strategy.id} />
      <input type="hidden" name="asset" value={strategy.asset} />
      {deletable ? (
        <>
          <label>Nome<input name="title" defaultValue={strategy.title} required /></label>
          <label>Chave<input name="key" defaultValue={strategy.key} required /></label>
        </>
      ) : (
        <>
          <input type="hidden" name="title" value={strategy.title} />
          <input type="hidden" name="key" value={strategy.key} />
        </>
      )}
      <label>Base USDT<input name="baseValue" type="number" step="0.01" min="0" defaultValue={Number(strategy.base_value || 0)} required /></label>
      <label>Gain %<input name="gainRate" type="number" step="0.01" min="0" defaultValue={Number(strategy.gain_rate || 0) * 100} required /></label>
      <label>Queda %<input name="dropPercent" type="number" step="0.01" min="0" defaultValue={Number(strategy.drop_percent || 0)} /></label>
      {deletable ? <label>Reinício<input name="restartAmount" type="number" min="0" step="1" defaultValue={Number(strategy.restart_amount || 0)} /></label> : <input type="hidden" name="restartAmount" value={Number(strategy.restart_amount || 0)} />}
      <div className="desktop-form-actions">
        <button className="desktop-primary-button" type="submit">Salvar estratégia</button>
        {deletable ? <button className="desktop-danger-button" type="submit" formAction={deleteStrategy}>Excluir</button> : null}
      </div>
    </form>
  );
}

function SettingsPanel({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return <section className="desktop-panel desktop-settings-panel"><header className="desktop-panel-header"><div><span>{eyebrow}</span><h2>{title}</h2></div></header>{children}</section>;
}
function Setting({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}
