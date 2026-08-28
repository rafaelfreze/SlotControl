"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";

import { createStrategy, deleteStrategy, updateStrategy } from "@/app/dashboard/actions";
import { BrandHeader, MobileScreen, SectionHeader } from "@/components/app/mobile-ui";
import { LogoutButton } from "@/components/auth/logout-button";
import { formatDecimal, formatPercent } from "@/lib/slotgain/format";
import type { SlotView, StrategyView } from "@/lib/slotgain/types";
import { MarketRegimeSettings } from "@/components/slotgain/market-regime-settings";
import type { AssetMarketStrategySettings, BtcMarketState, MarketRegimeSettings as MarketRegimeSettingsType } from "@/lib/slotgain/market-regime";
import { useLivePrices } from "@/lib/slotgain/live-prices";
import { DesktopConfig } from "./desktop-config";

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
  const livePrices = useLivePrices();
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
    <MobileScreen desktop={<DesktopConfig userLabel={userEmail} strategies={strategies} slots={slots} livePrices={livePrices} marketState={marketState} regimeSettings={regimeSettings} assetSettings={assetSettings} />}>
      <BrandHeader compact />
      <h1 className="visually-hidden">Configurações</h1>
      {setupError ? <section className="inline-alert dashboard-alert">Falha ao carregar configurações: {setupError}</section> : null}
      {notice ? <section className="form-success dashboard-notice">{notice}</section> : null}

      <div className="settings-page">
        <section className="settings-account-card">
          <span className="settings-avatar" aria-hidden="true">{userEmail.slice(0, 1).toUpperCase()}</span>
          <div><small>Usuário</small><strong>{userEmail}</strong><button type="button" onClick={() => setNotice("O perfil utiliza os dados seguros da sua conta.")}>Editar perfil</button></div>
          <p><small>Plano</small><strong>Premium</strong></p>
        </section>

        <SettingsGroup title="Configurações">
          <SettingsRow icon="◷" label="Plano de crescimento" value="Metas, referências e ciclos" href="/plano-crescimento" />
          <SettingsRow icon="⊕" label="Gerenciar aportes" value="Ver e adicionar aportes" href="/plano-crescimento" />
          <SettingsRow icon="⌁" label="Estratégia" value="Gains, base e operação" href="/config#estrategia" />
          <SettingsRow icon="♢" label="Notificações" value="Preferências operacionais" />
          <SettingsRow icon="▣" label="Segurança" value="Conta e autenticação" />
          <div className="native-settings-row"><span><i aria-hidden="true">⇩</i><span><b>Dados</b><small>Relatórios e backup</small></span></span><button type="button" onClick={exportBackup}>Exportar</button></div>
          <SettingsRow icon="ⓘ" label="Sistema" value="Sobre o CoinOps" />
        </SettingsGroup>

        <details className="settings-advanced-section" id="estrategia">
          <summary><span>Configurações operacionais</span><small>Estratégias, gains e mercado</small></summary>
          <div className="strategy-settings-grid">
            {btc ? <StrategySection strategy={btc} tone="gold" /> : null}
            {sol ? <StrategySection strategy={sol} tone="purple" /> : null}
          </div>
          <MarketRegimeSettings marketState={marketState} regimeSettings={regimeSettings} assetSettings={assetSettings} editable />
        </details>

        <details className="settings-advanced-section">
          <summary><span>Avançado</span><small>Novas estratégias</small></summary>
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

        <div className="settings-signout"><LogoutButton label="Sair da conta" className="settings-logout" /></div>
      </div>
    </MobileScreen>
  );
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section className="native-settings-group"><SectionHeader title={title} /><div>{children}</div></section>;
}

function SettingsRow({ icon, label, value, href }: { icon?: string; label: string; value: string; href?: string }) {
  const content = <><span>{icon ? <i aria-hidden="true">{icon}</i> : null}<span><b>{label}</b><small>{value}</small></span></span><strong>{href ? <b aria-hidden="true">›</b> : null}</strong></>;
  return href ? <Link className="native-settings-row" href={href}>{content}</Link> : <div className="native-settings-row">{content}</div>;
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
