"use client";

import Link from "next/link";
import Image from "next/image";
import { useMemo } from "react";

import { MobileScreen } from "@/components/app/mobile-ui";
import { CompactMarketRegimeBadge } from "@/components/slotgain/compact-market-regime-badge";
import {
  formatDecimal,
  formatPrice,
  formatSignedUsdt,
  formatUsdt,
  getMarkedSlotValue,
  getOpenMarketMetrics
} from "@/lib/slotgain/format";
import { useLivePrices } from "@/lib/slotgain/live-prices";
import { formatAccountCreatedDate, getAccountAgeDays } from "@/lib/slotgain/account-age";
import { getFinancialValueTone } from "@/lib/slotgain/financial-tone";
import { getMonthlyGrowthStatus } from "@/lib/slotgain/growth-status";
import { summarizeCapitalContributions, type CapitalContributionView } from "@/lib/slotgain/capital-contributions";
import type { BtcMarketState, MarketRegimeSettings as MarketRegimeSettingsType } from "@/lib/slotgain/market-regime";
import type { SlotView, StrategyView } from "@/lib/slotgain/types";

type DashboardClientProps = {
  userEmail: string;
  operationStartedAt: string | null;
  operationElapsedDays: number | null;
  strategies: StrategyView[];
  slots: SlotView[];
  contributions: CapitalContributionView[];
  setupError: string | null;
  initialNotice: string | null;
  marketState: Partial<BtcMarketState> | null;
  regimeSettings: Partial<MarketRegimeSettingsType> | null;
  btcLadderPlan: DashboardAssetLadderPlan | null;
  solLadderPlan: DashboardAssetLadderPlan | null;
};

type DashboardAssetLadderPlan = {
  monthly_goal?: number;
  month_reference?: string;
  real_gains_month?: number | string;
  real_gains_month_source?: string;
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
  contributionAmount: number;
  contributionGains: number;
};

function getStrategySummary(strategies: StrategyView[], slots: SlotView[], contributions: CapitalContributionView[], asset: "BTC" | "SOL", livePrice?: number): StrategySummary {
  const strategy = strategies.find((item) => item.asset.toUpperCase() === asset) || null;
  const strategySlots = strategy ? slots.filter((slot) => slot.strategy_id === strategy.id) : [];
  const total = strategySlots.reduce((sum, slot) => sum + getMarkedSlotValue(slot, livePrice), 0);
  const markedEquity = strategySlots.reduce((sum, slot) => sum + getMarkedSlotValue(slot, livePrice), 0);
  const openResult = strategySlots
    .filter((slot) => slot.status === "aberto")
    .reduce((sum, slot) => sum + getOpenMarketMetrics(slot, livePrice).resultadoAbertoUsdt, 0);
  const contributionSummary = summarizeCapitalContributions(contributions, { asset });

  return {
    strategy,
    asset,
    name: asset === "BTC" ? "Bitcoin" : "Solana",
    total,
    realizedProfit: strategySlots.reduce((sum, slot) => sum + Number(slot.realized_profit || 0), 0),
    openResult,
    markedEquity,
    openSlots: strategySlots.filter((slot) => slot.status === "aberto").length,
    totalSlots: strategySlots.length,
    contributionAmount: contributionSummary.amountUsdt,
    contributionGains: contributionSummary.gains
  };
}

export function DashboardClient({ userEmail, operationStartedAt, operationElapsedDays, strategies, slots, contributions, setupError, initialNotice, marketState, regimeSettings, btcLadderPlan, solLadderPlan }: DashboardClientProps) {
  const livePrices = useLivePrices();
  const notice = initialNotice;
  const realizedProfit = slots.reduce((sum, slot) => sum + Number(slot.realized_profit || 0), 0);
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
  const planElapsedDays = Number(operationElapsedDays);
  const accountAgeDays = operationElapsedDays !== null && Number.isFinite(planElapsedDays) && planElapsedDays >= 0
    ? Math.trunc(planElapsedDays)
    : getAccountAgeDays(operationStartedAt, new Date(), timeZone);
  const accountCreatedLabel = formatAccountCreatedDate(operationStartedAt, timeZone);
  const liveStatusLabel = livePrices.status === "online" ? "Online" : livePrices.isStale ? "Atualizando" : "Offline";
  const contributedCapital = slots.reduce((sum, slot) => sum + Number(slot.growth_contribution || 0), 0);
  const btc = useMemo(() => getStrategySummary(strategies, slots, contributions, "BTC", livePrices.prices.BTC), [strategies, slots, contributions, livePrices.prices.BTC]);
  const sol = useMemo(() => getStrategySummary(strategies, slots, contributions, "SOL", livePrices.prices.SOL), [strategies, slots, contributions, livePrices.prices.SOL]);

  return (
    <MobileScreen>
      <div className="dashboard-workspace">
      {setupError ? <section className="inline-alert dashboard-alert">Falha ao carregar dados do Supabase: {setupError}</section> : null}
      {notice ? (
        <section className="form-success dashboard-notice" role="status">
          {notice}
        </section>
      ) : null}
      <header className="dashboard-brand-header" aria-label="CoinOps">
        <Image src="/icon-96x96.png" alt="" width={28} height={28} priority />
        <span>COINOPS</span>
      </header>

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
          <span>{liveStatusLabel}</span>
          <strong>
            {livePrices.lastUpdated
              ? new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(livePrices.lastUpdated)
              : "--:--"}
          </strong>
        </div>
      </section>

      <GrowthPlanStrip btcPlan={btcLadderPlan} solPlan={solLadderPlan} />

      <section className="mobile-metrics" aria-label="Resumo principal">
        <MetricRow title="Lucro" value={formatSignedUsdt(realizedProfit)} numericValue={realizedProfit} helper="Vendido" />
        <MetricRow title="Aberto" value={formatSignedUsdt(openResult)} numericValue={openResult} helper="Mercado" />
        <MetricRow title="Patrimonio" value={formatUsdt(markedEquity)} numericValue={markedEquity} helper={`Inclui ${formatUsdt(contributedCapital)} em aportes`} />
        <MetricRow title="Slots" value={`${openSlots} de ${slots.length}`} helper="Ativos" />
      </section>

      <CompactMarketRegimeBadge marketState={marketState} regimeSettings={regimeSettings} />

      <StrategyCard summary={btc} accent="gold" />
      <StrategyCard summary={sol} accent="purple" />

      <section className="compact-action-bar" aria-label="Acoes principais">
        <Link href="/slots?flow=abrir">+ Abrir</Link>
        <Link href="/slots?flow=gain">✓ Gain</Link>
        <Link href="/plano-crescimento">Plano</Link>
      </section>

      <Link className="compact-account-age" href="/plano-crescimento#inicio-operacao" aria-label="Tempo em operação; editar data inicial no Plano">
        <span>Conta em operacao</span>
        <strong>{accountAgeDays} {accountAgeDays === 1 ? "dia" : "dias"}</strong>
        <small>Desde {accountCreatedLabel} · editar no Plano</small>
      </Link>

      <p className="mobile-session">{userEmail}</p>
      </div>
    </MobileScreen>
  );
}

function GrowthPlanStrip({ btcPlan, solPlan }: { btcPlan: DashboardAssetLadderPlan | null; solPlan: DashboardAssetLadderPlan | null }) {
  return (
    <section className="growth-dashboard-strip" aria-label="Metas mensais de crescimento">
      {(["BTC", "SOL"] as const).map((asset) => {
        const ladderPlan = asset === "BTC" ? btcPlan : solPlan;
        const monthlyGoal = Number(ladderPlan?.monthly_goal || (asset === "BTC" ? 7 : 1));
        const realGainsMonth = Number(ladderPlan?.real_gains_month || 0);
        const status = getMonthlyGrowthStatus(monthlyGoal, realGainsMonth);

        return (
          <Link className={`growth-dashboard-link ${asset.toLowerCase()} ${status.missing > 0 ? "missing" : "ok"}`} href="/plano-crescimento" key={asset}>
            <strong>{asset}</strong>
            <span>{status.label}</span>
          </Link>
        );
      })}
    </section>
  );
}

function MetricRow({
  title,
  value,
  numericValue,
  helper
}: {
  title: string;
  value: string;
  numericValue?: number;
  helper: string;
}) {
  const [amount, unit] = value.split(" USDT");

  return (
    <article className="mobile-metric-row">
      <div>
        <p>{title}</p>
        <small>{helper}</small>
      </div>
      <strong className={numericValue === undefined ? undefined : `financial-${getFinancialValueTone(numericValue)}`}>
        <span>{amount}</span>
        {unit !== undefined ? <small>USDT</small> : null}
      </strong>
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

      <div className="asset-contribution-line">
        <span>Aportes adicionados</span>
        <strong>+{formatDecimal(summary.contributionGains)} gains · +{formatUsdt(summary.contributionAmount)}</strong>
      </div>

      <span className="details-button">Ver detalhes {`\u203A`}</span>
    </Link>
  );
}
