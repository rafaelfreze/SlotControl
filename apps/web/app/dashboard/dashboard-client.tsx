"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { AppHeader } from "@/components/app/mobile-ui";
import {
  getAutomationModeLabel,
  isAutomationActive,
  useAutomationSetting,
  useAutomationWatcher,
  type AutomationMode
} from "@/lib/slotgain/auto-gain";
import {
  formatPrice,
  formatSignedUsdt,
  formatUsdt,
  getCurrentValue,
  getMarkedSlotValue,
  getOpenMarketMetrics
} from "@/lib/slotgain/format";
import { useLivePrices } from "@/lib/slotgain/live-prices";
import { MarketRegimeSettings } from "@/components/slotgain/market-regime-settings";
import type { AssetMarketStrategySettings, BtcMarketState, MarketRegimeSettings as MarketRegimeSettingsType } from "@/lib/slotgain/market-regime";
import type { SlotView, StrategyView } from "@/lib/slotgain/types";

type DashboardClientProps = {
  userEmail: string;
  strategies: StrategyView[];
  slots: SlotView[];
  setupError: string | null;
  initialNotice: string | null;
  initialAutomationMode: AutomationMode;
  marketState: Partial<BtcMarketState> | null;
  regimeSettings: Partial<MarketRegimeSettingsType> | null;
  assetSettings: Partial<AssetMarketStrategySettings>[];
};

type StrategySummary = {
  strategy: StrategyView | null;
  asset: "BTC" | "SOL";
  name: string;
  total: number;
  realizedProfit: number;
  openResult: number;
  markedEquity: number;
  openSlots: number;
  totalSlots: number;
};

function getStrategySummary(strategies: StrategyView[], slots: SlotView[], asset: "BTC" | "SOL", livePrice?: number): StrategySummary {
  const strategy = strategies.find((item) => item.asset.toUpperCase() === asset) || null;
  const strategySlots = strategy ? slots.filter((slot) => slot.strategy_id === strategy.id) : [];
  const base = strategySlots.reduce((sum, slot) => sum + Number(slot.base_value || 0), 0);
  const total = strategySlots.reduce((sum, slot) => sum + getMarkedSlotValue(slot, livePrice), 0);
  const markedEquity = strategySlots.reduce((sum, slot) => sum + getMarkedSlotValue(slot, livePrice), 0);
  const openResult = strategySlots
    .filter((slot) => slot.status === "aberto")
    .reduce((sum, slot) => sum + getOpenMarketMetrics(slot, livePrice).resultadoAbertoUsdt, 0);

  return {
    strategy,
    asset,
    name: asset === "BTC" ? "Bitcoin" : "Solana",
    total,
    realizedProfit: total - base,
    openResult,
    markedEquity,
    openSlots: strategySlots.filter((slot) => slot.status === "aberto").length,
    totalSlots: strategySlots.length
  };
}

export function DashboardClient({ userEmail, strategies, slots, setupError, initialNotice, initialAutomationMode, marketState, regimeSettings, assetSettings }: DashboardClientProps) {
  const livePrices = useLivePrices();
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const { mode: automationMode } = useAutomationSetting(initialAutomationMode);
  const totalBase = slots.reduce((sum, slot) => sum + Number(slot.base_value || 0), 0);
  const totalUpdated = slots.reduce((sum, slot) => sum + getCurrentValue(slot), 0);
  const realizedProfit = totalUpdated - totalBase;
  const openSlotsList = slots.filter((slot) => slot.status === "aberto");
  const openResult = openSlotsList.reduce(
    (sum, slot) => sum + getOpenMarketMetrics(slot, livePrices.prices[slot.strategy?.asset?.toUpperCase() === "SOL" ? "SOL" : "BTC"]).resultadoAbertoUsdt,
    0
  );
  const markedEquity = slots.reduce(
    (sum, slot) => sum + getMarkedSlotValue(slot, livePrices.prices[slot.strategy?.asset?.toUpperCase() === "SOL" ? "SOL" : "BTC"]),
    0
  );
  const openSlots = openSlotsList.length;
  const btc = useMemo(() => getStrategySummary(strategies, slots, "BTC", livePrices.prices.BTC), [strategies, slots, livePrices.prices.BTC]);
  const sol = useMemo(() => getStrategySummary(strategies, slots, "SOL", livePrices.prices.SOL), [strategies, slots, livePrices.prices.SOL]);

  useAutomationWatcher({
    mode: automationMode,
    slots,
    prices: { BTC: livePrices.prices.BTC, SOL: livePrices.prices.SOL },
    readKey: livePrices.lastUpdated?.getTime() || null,
    onRegistered: ({ message }) => setNotice(message)
  });

  return (
    <main className="mobile-dashboard-shell">
      <AppHeader title="SLOTGAIN" subtitle="CONTROL" />

      {setupError ? <section className="inline-alert dashboard-alert">Falha ao carregar dados do Supabase: {setupError}</section> : null}
      {notice ? (
        <section className="form-success dashboard-notice" role="status">
          {notice}
        </section>
      ) : null}
      <section className={`auto-gain-badge ${isAutomationActive(automationMode) ? "active" : ""}`}>
        Automacao: {getAutomationModeLabel(automationMode)}
      </section>

      <section className={`live-price-strip ${livePrices.status}`}>
        <div>
          <span>BTCUSDT</span>
          <strong>{formatPrice(livePrices.prices.BTC)}</strong>
        </div>
        <div>
          <span>SOLUSDT</span>
          <strong>{formatPrice(livePrices.prices.SOL)}</strong>
        </div>
        <div>
          <span>{livePrices.status === "online" ? "Online" : livePrices.isStale ? "Preco desatualizado" : "Offline"}</span>
          <strong>
            {livePrices.lastUpdated
              ? new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(livePrices.lastUpdated)
              : "--:--"}
          </strong>
        </div>
      </section>

      <section className="mobile-metrics" aria-label="Resumo principal">
        <MetricCard icon="$" title="Lucro" value={formatUsdt(realizedProfit)} helper="Vendido" tone="green" />
        <MetricCard icon="~" title="Aberto" value={formatSignedUsdt(openResult)} helper="Mercado" tone={openResult < 0 ? "red" : "green"} />
        <MetricCard icon="M" title="Patrimonio" value={formatUsdt(markedEquity)} helper="Total" tone="gold" />
        <MetricCard icon="#" title="Slots" value={String(openSlots)} helper={`de ${slots.length}`} tone="purple" />
      </section>

      <MarketRegimeSettings marketState={marketState} regimeSettings={regimeSettings} assetSettings={assetSettings} />

      <StrategyCard summary={btc} accent="gold" />
      <StrategyCard summary={sol} accent="purple" />

      <section className="primary-actions-grid" aria-label="Acoes principais">
        <ActionLink href="/slots?flow=abrir" icon="+" title="Abrir" subtitle="" tone="green" />
        <ActionLink href="/slots?flow=gain" icon="G" title="Gain" subtitle="" tone="gold" />
        <ActionLink href="/historico" icon="H" title="Historico" subtitle="" tone="blue" />
      </section>

      <section className="quick-summary-card" aria-label="Resumo rapido">
        <h2>Resumo rapido</h2>
        <div>
          <SummaryItem icon="+" title="Melhor mes" value="+8,75 USDT" detail="Junho/2025" tone="green" />
          <SummaryItem icon="-" title="Pior mes" value="-1,23 USDT" detail="Maio/2025" tone="red" />
          <SummaryItem icon="T" title="Tempo em operacao" value="128 dias" detail="Desde 06/02/2025" tone="blue" />
        </div>
      </section>

      <p className="mobile-session">{userEmail}</p>
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
  tone: "green" | "gold" | "purple" | "blue" | "red";
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
  return (
    <Link className={`asset-card ${accent}`} href={`/slots?asset=${summary.asset}`}>
      <div className="asset-heading">
        <div className="asset-title">
          <span className={`asset-icon ${summary.asset.toLowerCase()}`}>{summary.asset === "BTC" ? `\u20BF` : "S"}</span>
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
          Lucro <strong>{formatUsdt(summary.realizedProfit)}</strong>
        </span>
        <span>
          Aberto <strong className={summary.openResult < 0 ? "negative-value" : ""}>{formatSignedUsdt(summary.openResult)}</strong>
        </span>
        <span>
          Slots <strong>{summary.openSlots}</strong>
        </span>
      </div>

      <span className="details-button">Ver detalhes {`\u203A`}</span>
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
        {subtitle ? <em>{subtitle}</em> : null}
      </span>
      <b>{`\u203A`}</b>
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
