import Link from "next/link";

import { MARKET_REGIME_LABELS, asMarketRegime, type BtcMarketState, type MarketRegimeSettings } from "@/lib/slotgain/market-regime";
import { formatPercent } from "@/lib/slotgain/format";

type CompactMarketRegimeBadgeProps = {
  marketState: Partial<BtcMarketState> | null;
  regimeSettings: Partial<MarketRegimeSettings> | null;
};

export function CompactMarketRegimeBadge({ marketState, regimeSettings }: CompactMarketRegimeBadgeProps) {
  const calculated = asMarketRegime(marketState?.calculated_mode) || "NORMAL";
  const effective = regimeSettings?.mode_source === "MANUAL"
    ? asMarketRegime(regimeSettings.manual_mode) || calculated
    : asMarketRegime(regimeSettings?.last_effective_mode) || asMarketRegime(marketState?.effective_mode) || calculated;
  const distance = Number(marketState?.distance_from_ath_percent || 0);
  const source = regimeSettings?.mode_source === "MANUAL" ? "Manual" : "Automatico";

  return (
    <Link className="compact-market-regime-badge" href="/config" title="Abrir detalhes do regime do BTC em Configuracoes">
      <span>BTC</span>
      <strong>{MARKET_REGIME_LABELS[effective]}</strong>
      <em>{formatPercent(distance / 100)}% do ATH</em>
      <small>{source}</small>
    </Link>
  );
}
