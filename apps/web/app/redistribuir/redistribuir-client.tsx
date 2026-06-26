"use client";

import { useMemo, useState } from "react";

import { redistributeGains } from "@/app/dashboard/actions";
import { AppHeader, FilterChips, MobileScreen, ProgressBar, SectionCard, StatCard } from "@/components/app/mobile-ui";
import { formatUsdt, getCurrentValue } from "@/lib/slotgain/format";
import type { SlotView, StrategyView } from "@/lib/slotgain/types";

type AssetFilter = "BTC" | "SOL";

export function RedistribuirClient({
  userEmail,
  strategies,
  slots,
  initialAsset,
  setupError,
  notice
}: {
  userEmail: string;
  strategies: StrategyView[];
  slots: SlotView[];
  initialAsset: string | null;
  setupError: string | null;
  notice: string | null;
}) {
  const [asset, setAsset] = useState<AssetFilter>(initialAsset?.toUpperCase() === "SOL" ? "SOL" : "BTC");
  const strategy = strategies.find((item) => item.asset.toUpperCase() === asset) || strategies[0];
  const scopedSlots = useMemo(() => slots.filter((slot) => slot.strategy_id === strategy?.id), [slots, strategy?.id]);
  const affected = scopedSlots.filter((slot) => slot.status === "gain" || slot.status === "zerado");
  const gains = affected.reduce((sum, slot) => sum + Number(slot.gains || 0), 0);
  const target = Math.max(1, Number(strategy?.redistribution_target || (asset === "SOL" ? 10 : 50)));
  const totalValue = affected.reduce((sum, slot) => sum + getCurrentValue(slot), 0);
  const progress = Math.min(100, (gains / target) * 100);
  const tone = asset === "SOL" ? "purple" : "gold";

  return (
    <MobileScreen>
      <AppHeader title="REDISTRIBUIR" subtitle={userEmail} backHref="/dashboard" />
      {setupError ? <section className="inline-alert dashboard-alert">Falha ao carregar dados: {setupError}</section> : null}
      {notice ? <section className="form-success dashboard-notice">{notice}</section> : null}
      <FilterChips value={asset} onChange={setAsset} options={[{ label: "BTC", value: "BTC" }, { label: "SOL", value: "SOL" }]} />
      <SectionCard title={`Redistribuir ${asset}`} subtitle="Confirmacao" tone={tone}>
        <div className="asset-summary-stats">
          <StatCard title="Gains" value={`${gains}/${target}`} tone={tone} />
          <StatCard title="Slots afetados" value={String(affected.length)} tone="blue" />
          <StatCard title="Valor total" value={formatUsdt(totalValue)} tone="green" />
        </div>
        <div className="redistribution-line">
          <p>Progresso para redistribuicao</p>
          <div>
            <strong>
              {gains} / {target}
            </strong>
            <span>gains</span>
            <ProgressBar value={progress} tone={tone} />
            <em>{Math.round(progress)}%</em>
          </div>
        </div>
        <form className="redistribute-confirm-form" action={redistributeGains}>
          <input type="hidden" name="strategyId" value={strategy?.id || ""} />
          <button className="solid-button" type="submit" disabled={!strategy}>
            Confirmar redistribuicao
          </button>
          <a className="ghost-link" href="/dashboard">
            Cancelar
          </a>
        </form>
      </SectionCard>
    </MobileScreen>
  );
}
