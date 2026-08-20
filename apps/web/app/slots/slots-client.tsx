"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { createSlots, moveSlot, openSlot, registerGain, resetSlot, updateSlot } from "@/app/dashboard/actions";
import { AppHeader, EmptyState, FilterChips, MobileScreen, PnLValue, StatusBadge } from "@/components/app/mobile-ui";
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
import {
  indexCapitalContributionsBySlot,
  summarizeCapitalContributions,
  summarizeSlotCapitalFlow,
  type CapitalContributionSummary,
  type CapitalContributionView
} from "@/lib/slotgain/capital-contributions";
import type { SlotView, StrategyView } from "@/lib/slotgain/types";

type DisplayFilter = "all" | "BTC" | "SOL" | "aberto" | "closed";
type AssetFilter = "BTC" | "SOL" | "ALL";

type SlotsClientProps = {
  strategies: StrategyView[];
  slots: SlotView[];
  contributions: CapitalContributionView[];
  setupError: string | null;
  initialNotice: string | null;
  initialAsset: string | null;
  initialFlow: string | null;
};

function getAsset(slot: SlotView) {
  return slot.strategy?.asset?.toUpperCase() === "SOL" ? "SOL" : "BTC";
}

function getOperationalGains(slot: SlotView) {
  const value = Number(slot.operational_gains);
  return Number.isFinite(value) ? value : Number(slot.gains || 0);
}

function sortSlots(slots: SlotView[]) {
  return [...slots].sort((first, second) => {
    const statusOrder = (slot: SlotView) => slot.status === "aberto" ? 0 : 1;
    return statusOrder(first) - statusOrder(second)
      || getOperationalGains(second) - getOperationalGains(first)
      || first.slot_number - second.slot_number
      || first.id.localeCompare(second.id);
  });
}

function rankSlots(slots: SlotView[]) {
  return [...slots]
    .sort((a, b) => getOperationalGains(b) - getOperationalGains(a) || a.slot_number - b.slot_number || a.id.localeCompare(b.id))
    .reduce<Record<string, number>>((ranking, slot, index) => {
      ranking[slot.id] = index + 1;
      return ranking;
    }, {});
}

export function SlotsClient({ strategies, slots, contributions, setupError, initialNotice, initialAsset, initialFlow }: SlotsClientProps) {
  const livePrices = useLivePrices();
  const initialFilter: DisplayFilter = initialFlow === "abrir"
    ? "closed"
    : initialAsset?.toUpperCase() === "SOL"
      ? "SOL"
      : initialAsset?.toUpperCase() === "BTC"
        ? "BTC"
        : "all";
  const [activeFilter, setActiveFilter] = useState<DisplayFilter>(initialFilter);
  const [expandedSlotId, setExpandedSlotId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice);

  const visibleSlots = useMemo(() => sortSlots(slots.filter((slot) => {
    if (activeFilter === "BTC" || activeFilter === "SOL") return getAsset(slot) === activeFilter;
    if (activeFilter === "aberto") return slot.status === "aberto";
    if (activeFilter === "closed") return slot.status === "gain" || slot.status === "zerado";
    return true;
  })), [activeFilter, slots]);
  const openRanks = useMemo(() => rankSlots(slots.filter((slot) => slot.status === "aberto")), [slots]);
  const closedRanks = useMemo(() => rankSlots(slots.filter((slot) => slot.status === "gain" || slot.status === "zerado")), [slots]);
  const contributionBySlot = useMemo(() => indexCapitalContributionsBySlot(contributions), [contributions]);
  const contributionSummary = useMemo(() => summarizeCapitalContributions(contributions), [contributions]);
  const totalOperationalBalance = useMemo(
    () => slots.reduce((sum, slot) => sum + getCurrentValue(slot), 0),
    [slots]
  );

  return (
    <MobileScreen>
      <AppHeader title="Slots" action={<span className="header-count">{slots.length}</span>} />
      {setupError ? <section className="inline-alert dashboard-alert">Falha ao carregar dados: {setupError}</section> : null}
      {notice ? <section className="form-success dashboard-notice" role="status">{notice}</section> : null}

      <section className={`live-price-strip compact-internal-ticker ${livePrices.status}`} aria-label="Cotações">
        <Ticker label="BTCUSDT" value={formatPrice(livePrices.prices.BTC)} />
        <Ticker label="SOLUSDT" value={formatPrice(livePrices.prices.SOL)} />
        <Ticker
          label={livePrices.status === "online" ? "ONLINE" : livePrices.isStale ? "ATUALIZANDO" : "OFFLINE"}
          value={livePrices.lastUpdated ? new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(livePrices.lastUpdated) : "--:--"}
        />
      </section>

      <FilterChips
        value={activeFilter}
        onChange={(value) => { setActiveFilter(value); setExpandedSlotId(null); }}
        options={[
          { label: "Todos", value: "all" },
          { label: "BTC", value: "BTC" },
          { label: "SOL", value: "SOL" },
          { label: "Abertos", value: "aberto" },
          { label: "Fechados", value: "closed" }
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

function Ticker({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function CompactSlotRow({ slot, livePrice, rank, contribution, expanded, onToggle, announce }: {
  slot: SlotView;
  livePrice?: number;
  rank?: number;
  contribution: CapitalContributionSummary;
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
      <button className="compact-slot-trigger" type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={`slot-panel-${slot.id}`}>
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
        <span className="compact-slot-metric pnl"><small>PnL</small><PnLValue value={pnl}>{formatSignedUsdt(pnl)}</PnLValue></span>
        <span className="compact-slot-chevron" aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
      </button>

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
            {slot.status === "aberto"
              ? <button className="slot-button" type="button" disabled>Aberto</button>
              : <SlotAction action={openSlot} slotId={slot.id} label="Abrir" hidden={livePrice ? { entryPrice: String(Math.round(livePrice)) } : undefined} onClick={() => announce("Abrindo slot...")} />}
            <SlotAction action={registerGain} slotId={slot.id} label="Adicionar gain" disabled={slot.status === "zerado" || slot.status === "hold"} onClick={() => announce("Registrando gain...")} />
            <SlotAction action={resetSlot} slotId={slot.id} label="Zerar" onClick={() => announce("Zerando slot...")} />
          </div>
          <details className="slot-advanced-actions">
            <summary>Editar e organizar</summary>
            <div className="slot-card-actions">
              <SlotAction action={moveSlot} slotId={slot.id} label="Subir" hidden={{ direction: "up" }} onClick={() => announce("Movendo slot...")} />
              <SlotAction action={moveSlot} slotId={slot.id} label="Descer" hidden={{ direction: "down" }} onClick={() => announce("Movendo slot...")} />
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

function SlotAction({ action, slotId, label, disabled = false, hidden, onClick }: {
  action: (formData: FormData) => void | Promise<void>;
  slotId: string;
  label: string;
  disabled?: boolean;
  hidden?: Record<string, string>;
  onClick: () => void;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="slotId" value={slotId} />
      {hidden ? Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />) : null}
      <button className="slot-button" type="submit" disabled={disabled} onClick={onClick}>{label}</button>
    </form>
  );
}
