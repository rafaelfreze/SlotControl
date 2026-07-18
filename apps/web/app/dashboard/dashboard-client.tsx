"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { MobileScreen } from "@/components/app/mobile-ui";
import { CompactMarketRegimeBadge } from "@/components/slotgain/compact-market-regime-badge";
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
import { formatAccountCreatedDate, getAccountAgeDays } from "@/lib/slotgain/account-age";
import { getFinancialValueTone } from "@/lib/slotgain/financial-tone";
import type { BtcMarketState, MarketRegimeSettings as MarketRegimeSettingsType } from "@/lib/slotgain/market-regime";
import type { SlotView, StrategyView } from "@/lib/slotgain/types";

type DashboardClientProps = {
  userEmail: string;
  accountCreatedAt: string | null;
  strategies: StrategyView[];
  slots: SlotView[];
  setupError: string | null;
  initialNotice: string | null;
  initialAutomationMode: AutomationMode;
  marketState: Partial<BtcMarketState> | null;
  regimeSettings: Partial<MarketRegimeSettingsType> | null;
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

export function DashboardClient({ userEmail, accountCreatedAt, strategies, slots, setupError, initialNotice, initialAutomationMode, marketState, regimeSettings }: DashboardClientProps) {
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
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const accountAgeDays = getAccountAgeDays(accountCreatedAt, new Date(), timeZone);
  const accountCreatedLabel = formatAccountCreatedDate(accountCreatedAt, timeZone);
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
    <MobileScreen>
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
        <MetricCard icon="$" title="Lucro" value={formatUsdt(realizedProfit)} numericValue={realizedProfit} helper="Vendido" tone="green" />
        <MetricCard icon="~" title="Aberto" value={formatSignedUsdt(openResult)} numericValue={openResult} helper="Mercado" tone={openResult < 0 ? "red" : "green"} />
        <MetricCard icon="M" title="Patrimonio" value={formatUsdt(markedEquity)} numericValue={markedEquity} helper="Total" tone="gold" />
        <MetricCard icon="#" title="Slots" value={String(openSlots)} helper={`de ${slots.length}`} tone="purple" />
      </section>

      <CompactMarketRegimeBadge marketState={marketState} regimeSettings={regimeSettings} />

      <StrategyCard summary={btc} accent="gold" />
      <StrategyCard summary={sol} accent="purple" />

      <section className="compact-action-bar" aria-label="Acoes principais">
        <Link href="/slots?flow=abrir">+ Abrir</Link>
        <Link href="/slots?flow=gain">✓ Gain</Link>
        <Link href="/historico">Historico</Link>
      </section>

      <section className="compact-account-age" aria-label="Tempo em operacao">
        <span>Conta em operacao</span>
        <strong>{accountAgeDays} {accountAgeDays === 1 ? "dia" : "dias"}</strong>
        <small>Desde {accountCreatedLabel}</small>
      </section>

      <p className="mobile-session">{userEmail}</p>
    </MobileScreen>
  );
}

function MetricCard({
  icon,
  title,
  value,
  numericValue,
  helper,
  tone
}: {
  icon: string;
  title: string;
  value: string;
  numericValue?: number;
  helper: string;
  tone: "green" | "gold" | "purple" | "blue" | "red";
}) {
  const [amount, unit] = value.split(" USDT");

  return (
    <article className="mobile-metric-card">
      <span className={`metric-icon ${tone}`}>{icon}</span>
      <p>{title}</p>
      <strong className={numericValue === undefined ? undefined : `financial-${getFinancialValueTone(numericValue)}`}>
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
          Total <strong className={`financial-${getFinancialValueTone(summary.total)}`}>{formatUsdt(summary.total)}</strong>
        </span>
        <span>
          Lucro <strong className={`financial-${getFinancialValueTone(summary.realizedProfit)}`}>{formatUsdt(summary.realizedProfit)}</strong>
        </span>
        <span>
          Aberto <strong className={`financial-${getFinancialValueTone(summary.openResult)}`}>{formatSignedUsdt(summary.openResult)}</strong>
        </span>
        <span>
          Slots <strong>{summary.openSlots}</strong>
        </span>
      </div>

      <span className="details-button">Ver detalhes {`\u203A`}</span>
    </Link>
  );
}
