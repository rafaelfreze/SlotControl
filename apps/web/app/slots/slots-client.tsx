"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { createSlots, moveSlot, openSlot, registerGain, resetSlot, updateSlot } from "@/app/dashboard/actions";
import { BrandHeader, EmptyState, FilterChips, MarketTicker, MobileScreen, PnLValue, SlotActionForm, StatusBadge } from "@/components/app/mobile-ui";
import {
  formatDate,
  formatDecimal,
  formatPrice,
  formatSignedUsdt,
  formatUsdt,
  getCurrentValue,
  getOpenMarketMetrics
} from "@/lib/slotgain/format";
import { useLivePrices } from "@/lib/slotgain/live-prices";
import { getOperationalGains, rankOpenSlotIds, rankSlotIds, sortSlotsForOperationalList } from "@/lib/slotgain/slot-ranking";
import type { OfficialMonitoringOverview } from "@/lib/coinops-monitoring/server";
import {
  indexCapitalContributionsBySlot,
  summarizeCapitalContributions,
  summarizeSlotCapitalFlow,
  type CapitalContributionSummary,
  type CapitalContributionView
} from "@/lib/slotgain/capital-contributions";
import type { SlotView, StrategyView } from "@/lib/slotgain/types";
import { DesktopSlots } from "./desktop-slots";

type DisplayFilter = "all" | "BTC" | "SOL" | "aberto" | "closed";
type AssetFilter = "BTC" | "SOL" | "ALL";

type SlotsClientProps = {
  userLabel: string;
  strategies: StrategyView[];
  slots: SlotView[];
  contributions: CapitalContributionView[];
  monitoring: OfficialMonitoringOverview;
  setupError: string | null;
  initialNotice: string | null;
  initialAsset: string | null;
  initialFlow: string | null;
};

function getAsset(slot: SlotView) {
  return slot.strategy?.asset?.toUpperCase() === "SOL" ? "SOL" : "BTC";
}

export function SlotsClient({ userLabel, strategies, slots, contributions, setupError, initialNotice, initialAsset, initialFlow, monitoring }: SlotsClientProps) {
  const livePrices = useLivePrices();
  const initialFilter: DisplayFilter = initialFlow === "abrir"
    ? "closed"
    : initialFlow === "gain"
      ? "aberto"
    : initialAsset?.toUpperCase() === "SOL"
      ? "SOL"
      : initialAsset?.toUpperCase() === "BTC"
        ? "BTC"
        : "all";
  const [activeFilter, setActiveFilter] = useState<DisplayFilter>(initialFilter);
  const [expandedSlotId, setExpandedSlotId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice);

  const visibleSlots = useMemo(() => sortSlotsForOperationalList(slots.filter((slot) => {
    if (activeFilter === "BTC" || activeFilter === "SOL") return getAsset(slot) === activeFilter;
    if (activeFilter === "aberto") return slot.status === "aberto";
    if (activeFilter === "closed") return slot.status === "gain" || slot.status === "zerado";
    return true;
  })), [activeFilter, slots]);
  const openRanks = useMemo(() => rankOpenSlotIds(slots.filter((slot) => slot.status === "aberto")), [slots]);
  const closedRanks = useMemo(() => rankSlotIds(slots.filter((slot) => slot.status === "gain" || slot.status === "zerado")), [slots]);
  const contributionBySlot = useMemo(() => indexCapitalContributionsBySlot(contributions), [contributions]);
  const contributionSummary = useMemo(() => summarizeCapitalContributions(contributions), [contributions]);
  const totalOperationalBalance = useMemo(
    () => slots.reduce((sum, slot) => sum + getCurrentValue(slot), 0),
    [slots]
  );

  return (
    <MobileScreen desktop={<DesktopSlots userLabel={userLabel} strategies={strategies} slots={slots} contributions={contributions} monitoring={monitoring} livePrices={livePrices} initialFilter={initialAsset} initialFlow={initialFlow} />}>
      <BrandHeader compact />
      {setupError ? <section className="inline-alert dashboard-alert">Falha ao carregar dados: {setupError}</section> : null}
      {notice ? <section className="form-success dashboard-notice" role="status">{notice}</section> : null}

      <MarketTicker livePrices={livePrices} />
      {monitoring.active ? <details className="official-slot-queue">
        <summary>Próximos slots <span>{monitoring.strategy?.mode === "DEFENSIVE_POST_ATH" ? "Defensivo" : "Normal"}</span></summary>
        <div><b>BTC · {monitoring.strategy?.btc_spacing}%</b><span>Meta {monitoring.assets?.BTC?.target ?? "pausada"}</span><strong>#{monitoring.assets?.BTC?.next_slot?.slot_number ?? "—"}</strong></div>
        <div><b>SOL · {monitoring.strategy?.sol_spacing}%</b><span>Meta {monitoring.assets?.SOL?.target ?? "pausada"}</span><strong>#{monitoring.assets?.SOL?.next_slot?.slot_number ?? "—"}</strong></div>
        <small>Principais abertos: BTC {monitoring.pools?.BTC?.main_open ?? 0}/25 · SOL {monitoring.pools?.SOL?.main_open ?? 0}/25</small>
      </details> : null}



      <FilterChips
        value={activeFilter}
        onChange={(value) => { setActiveFilter(value); setExpandedSlotId(null); }}
        options={[
          { label: "Todos", value: "all", count: slots.length },
          { label: "BTC", value: "BTC", count: slots.filter((slot) => getAsset(slot) === "BTC").length },
          { label: "SOL", value: "SOL", count: slots.filter((slot) => getAsset(slot) === "SOL").length },
          { label: "Abertos", value: "aberto", count: slots.filter((slot) => slot.status === "aberto").length },
          { label: "Fechados", value: "closed", count: slots.filter((slot) => slot.status !== "aberto").length }
        ]}
      />

      <details className="slot-overview-drawer">
        <summary>Saldo operacional total <span>{formatUsdt(totalOperationalBalance)}</span></summary>
        <div><span>Gains aportados</span><strong>{formatDecimal(contributionSummary.gains)}</strong></div>
        <div><span>Lucro realizado</span><strong>{formatUsdt(slots.reduce((sum, slot) => sum + Number(slot.realized_profit || 0), 0))}</strong></div>
        <div><span>Aportes</span><strong>{formatUsdt(contributionSummary.amountUsdt)}</strong></div>
      </details>

      <div className="compact-slot-list">
        {visibleSlots.map((slot) => (
          <CompactSlotRow
            key={slot.id}
            slot={slot}
            livePrice={getAsset(slot) === "SOL" ? livePrices.prices.SOL : livePrices.prices.BTC}
            rank={slot.status === "aberto" ? openRanks[slot.id] : closedRanks[slot.id]}
            contribution={contributionBySlot[slot.id] || { amountUsdt: 0, gains: 0 }}
            returnFilter={activeFilter}
            expanded={expandedSlotId === slot.id}
            onToggle={() => setExpandedSlotId((current) => current === slot.id ? null : slot.id)}
            announce={setNotice}
          />
        ))}
        {!visibleSlots.length ? <EmptyState>Nenhum slot neste filtro.</EmptyState> : null}
      </div>

      <details className="section-card mini-drawer add-slots-drawer">
        <summary>Adicionar slots</summary>
        <form className="tool-form stacked-form" action={createSlots}>
          <label>Moeda<SelectStrategy name="strategyId" strategies={strategies} selectedAsset={activeFilter === "BTC" || activeFilter === "SOL" ? activeFilter : "ALL"} /></label>
          <label>Quantidade<input name="quantity" type="number" min="1" max="50" defaultValue="1" required /></label>
          <button className="solid-button" type="submit">Adicionar</button>
        </form>
      </details>
    </MobileScreen>
  );
}

function CompactSlotRow({ slot, livePrice, rank, contribution, returnFilter, expanded, onToggle, announce }: {
  slot: SlotView;
  livePrice?: number;
  rank?: number;
  contribution: CapitalContributionSummary;
  returnFilter: DisplayFilter;
  expanded: boolean;
  onToggle: () => void;
  announce: (message: string) => void;
}) {
  const asset = getAsset(slot);
  const openMarket = getOpenMarketMetrics(slot, livePrice).resultadoAbertoUsdt;
  const pnl = slot.status === "aberto" ? openMarket : Number(slot.realized_profit || 0);
  const capitalFlow = summarizeSlotCapitalFlow(slot);

  return (
    <article className={`compact-slot-row ${asset.toLowerCase()} ${expanded ? "expanded" : ""}`}>
      <div className="compact-slot-operational-row">
        <button className="compact-slot-trigger" type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={`slot-panel-${slot.id}`} aria-label={`Ver resumo do slot ${slot.slot_number} ${asset}`}>
          <span className={`compact-asset-icon ${asset.toLowerCase()}`} aria-hidden="true">{asset === "BTC" ? "₿" : "S"}</span>
          <span className="compact-slot-identity"><strong>#{slot.slot_number} {asset}</strong><span className="compact-slot-status-line"><StatusBadge status={slot.status} />{rank ? <small>rank {rank}</small> : null}</span></span>
          <span className="compact-slot-metric">
            <small>Gains op.</small>
            <strong>{formatDecimal(getOperationalGains(slot))}</strong>
          </span>
          <span className="compact-slot-metric value">
            <small>Saldo atual</small>
            <strong>{formatUsdt(getCurrentValue(slot))}</strong>
          </span>
        </button>

        {slot.status === "aberto" ? (
          <SlotActionForm
            action={registerGain}
            slotId={slot.id}
            label="✓ Gain"
            pendingLabel="Gain..."
            className="slot-quick-action"
            buttonClassName="slot-quick-button gain"
            hidden={{ returnFilter }}
            onSubmit={() => announce("Registrando gain...")}
          />
        ) : (
          <SlotActionForm
            action={openSlot}
            slotId={slot.id}
            label="+ Abrir"
            pendingLabel="Abrindo..."
            className="slot-quick-action"
            buttonClassName="slot-quick-button open"
            hidden={livePrice ? { entryPrice: String(Math.round(livePrice)), returnFilter } : { returnFilter }}
            onSubmit={() => announce("Abrindo slot...")}
          />
        )}

        <button className="compact-slot-menu" type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={`slot-panel-${slot.id}`} aria-label={`Mais ações do slot ${slot.slot_number}`}>
          {expanded ? "×" : "⋯"}
        </button>
      </div>

      {expanded ? (
        <div className="slot-detail-panel" id={`slot-panel-${slot.id}`}>
          <header><div><span>Slot #{slot.slot_number}</span><h3>{asset}</h3></div><StatusBadge status={slot.status} /></header>
          <div className="slot-detail-hero">
            <Metric label="Gains totais" value={formatDecimal(getOperationalGains(slot))} />
            <Metric label="Valor operacional" value={formatUsdt(getCurrentValue(slot))} />
            <Metric label="PnL" value={formatSignedUsdt(pnl)} tone={pnl} />
          </div>
          <dl className="slot-detail-list">
            <Detail label="Gains reais" value={formatDecimal(slot.real_gains)} />
            <Detail label="Gains operacionais" value={formatDecimal(getOperationalGains(slot))} />
            <Detail label="Gains aportados" value={formatDecimal(contribution.gains)} />
            <Detail label="Lucro realizado" value={formatUsdt(Number(slot.realized_profit || 0))} />
            <Detail label="Legado (adicionados)" value={formatDecimal(slot.added_gains)} />
            <Detail label="Aporte externo" value={formatUsdt(contribution.amountUsdt)} />
            <Detail label="Redistribuição líquida" value={formatSignedUsdt(capitalFlow.redistributionNetUsdt)} />
            <Detail label="Capital adicional líquido" value={formatSignedUsdt(capitalFlow.additionalCapitalNetUsdt)} />
            <Detail label="Preço médio (entrada)" value={slot.preco_entrada ? formatPrice(Number(slot.preco_entrada)) : "—"} />
            <Detail label="Alvo" value={slot.preco_alvo ? formatPrice(Number(slot.preco_alvo)) : "—"} />
            <Detail label="Última atualização" value={slot.updated_at ? formatDate(slot.updated_at) : "—"} />
          </dl>
          <div className="slot-detail-actions">
            <Link className="slot-button slot-detail-link" href={`/slots/${slot.id}`}>Ver detalhes</Link>
            {slot.status === "aberto"
              ? <button className="slot-button" type="button" disabled>Aberto</button>
              : <SlotActionForm action={openSlot} slotId={slot.id} label="Abrir" buttonClassName="slot-button" hidden={livePrice ? { entryPrice: String(Math.round(livePrice)), returnFilter } : { returnFilter }} onSubmit={() => announce("Abrindo slot...")} />}
            <SlotActionForm action={registerGain} slotId={slot.id} label="Adicionar gain" buttonClassName="slot-button" disabled={slot.status === "zerado" || slot.status === "hold"} hidden={{ returnFilter }} onSubmit={() => announce("Registrando gain...")} />
            <SlotActionForm action={resetSlot} slotId={slot.id} label="Zerar" buttonClassName="slot-button" onSubmit={() => announce("Zerando slot...")} />
          </div>
          <details className="slot-advanced-actions">
            <summary>Editar e organizar</summary>
            <div className="slot-card-actions">
              <SlotActionForm action={moveSlot} slotId={slot.id} label="Subir" buttonClassName="slot-button" hidden={{ direction: "up" }} onSubmit={() => announce("Movendo slot...")} />
              <SlotActionForm action={moveSlot} slotId={slot.id} label="Descer" buttonClassName="slot-button" hidden={{ direction: "down" }} onSubmit={() => announce("Movendo slot...")} />
            </div>
            <form className="tool-form stacked-form" action={updateSlot}>
              <input type="hidden" name="slotId" value={slot.id} />
              <input type="hidden" name="status" value={slot.status} />
              <input type="hidden" name="baseValue" value={Number(slot.base_value)} />
              <label>Observações<input name="notes" type="text" defaultValue={slot.notes || ""} /></label>
              <button className="slot-button edit" type="submit">Salvar</button>
            </form>
            <Link className="slot-plan-link" href="/plano-crescimento">Aportes e redistribuição no Plano</Link>
          </details>
        </div>
      ) : null}
    </article>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: number }) {
  return <span><small>{label}</small>{tone === undefined ? <strong>{value}</strong> : <PnLValue value={tone}>{value}</PnLValue>}</span>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function SelectStrategy({ name, strategies, selectedAsset }: { name: string; strategies: StrategyView[]; selectedAsset: AssetFilter }) {
  const filtered = selectedAsset === "ALL" ? strategies : strategies.filter((strategy) => strategy.asset.toUpperCase() === selectedAsset);
  return <select name={name} required>{filtered.map((strategy) => <option key={strategy.id} value={strategy.id}>{strategy.title}</option>)}</select>;
}
