"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import {
  createSlots,
  moveSlot,
  openSlot,
  registerGain,
  resetSlot,
  updateSlot
} from "@/app/dashboard/actions";
import { AppHeader, FilterChips, MobileScreen, SectionCard, StatCard } from "@/components/app/mobile-ui";
import {
  formatDecimal,
  formatPrice,
  formatUsdt,
  getCurrentValue,
  getStatusLabel
} from "@/lib/slotgain/format";
import { useLivePrices } from "@/lib/slotgain/live-prices";
import { getFinancialValueTone } from "@/lib/slotgain/financial-tone";
import type { SlotView, StrategyView } from "@/lib/slotgain/types";

type SlotFilter = "aberto" | "gain" | "closed" | "all";
type AssetFilter = "BTC" | "SOL" | "ALL";

type SlotsClientProps = {
  strategies: StrategyView[];
  slots: SlotView[];
  setupError: string | null;
  initialNotice: string | null;
  initialAsset: string | null;
  initialFlow: string | null;
};

function getAssetFromStrategy(slot: SlotView) {
  return slot.strategy?.asset?.toUpperCase() || "BTC";
}

function getRankingGains(slot: SlotView) {
  if (getAssetFromStrategy(slot) !== "BTC") return Number(slot.gains || 0);
  const operationalGains = Number(slot.operational_gains);
  return Number.isFinite(operationalGains) ? operationalGains : Number(slot.gains || 0);
}

function sortSlotsForRanking(slots: SlotView[]) {
  return [...slots].sort((first, second) =>
    getRankingGains(second) - getRankingGains(first)
    || first.slot_number - second.slot_number
    || first.sort_order - second.sort_order
    || first.id.localeCompare(second.id)
  );
}

function rankSlots(slots: SlotView[]) {
  return sortSlotsForRanking(slots).reduce<Record<string, number>>((ranking, slot, index) => {
    ranking[slot.id] = index + 1;
    return ranking;
  }, {});
}

export function SlotsClient({ strategies, slots, setupError, initialNotice, initialAsset, initialFlow }: SlotsClientProps) {
  const livePrices = useLivePrices();
  const liveBtcPrice = livePrices.prices.BTC;
  const liveSolPrice = livePrices.prices.SOL;
  const initialSelectedAsset: AssetFilter = initialAsset?.toUpperCase() === "SOL" ? "SOL" : initialAsset?.toUpperCase() === "BTC" ? "BTC" : "ALL";
  const [selectedAsset, setSelectedAsset] = useState<AssetFilter>(initialSelectedAsset);
  const [slotFilter, setSlotFilter] = useState<SlotFilter>(initialFlow === "abrir" ? "closed" : "aberto");
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const scopedSlots = useMemo(
    () => slots.filter((slot) => selectedAsset === "ALL" || getAssetFromStrategy(slot) === selectedAsset),
    [selectedAsset, slots]
  );
  const visibleSlots = useMemo(
    () => {
      const filtered = scopedSlots.filter((slot) => {
        if (slotFilter === "closed") return slot.status === "gain" || slot.status === "zerado";
        if (slotFilter === "all") return true;
        return slot.status === slotFilter;
      });

      if (slotFilter === "aberto") {
        return sortSlotsForRanking(filtered);
      }

      if (slotFilter === "closed") {
        return sortSlotsForRanking(filtered);
      }

      return [...filtered].sort((first, second) => {
        const group = (slot: SlotView) => slot.status === "gain" || slot.status === "zerado" ? 0 : slot.status === "aberto" ? 1 : 2;
        return group(first) - group(second) || getRankingGains(second) - getRankingGains(first) || first.slot_number - second.slot_number;
      });
    },
    [scopedSlots, slotFilter]
  );
  const openRankById = useMemo(() => rankSlots(scopedSlots.filter((slot) => slot.status === "aberto")), [scopedSlots]);
  const closedRankById = useMemo(() => rankSlots(scopedSlots.filter((slot) => slot.status === "gain" || slot.status === "zerado")), [scopedSlots]);

  const total = scopedSlots.reduce((sum, slot) => sum + getCurrentValue(slot), 0);
  const realizedProfit = scopedSlots.reduce((sum, slot) => sum + Number(slot.realized_profit || 0), 0);
  const gains = scopedSlots.reduce((sum, slot) => sum + getRankingGains(slot), 0);
  const realGains = scopedSlots.reduce((sum, slot) => sum + Number(slot.real_gains || 0), 0);
  const addedGains = scopedSlots.reduce((sum, slot) => sum + Number(slot.added_gains || 0), 0);
  const open = scopedSlots.filter((slot) => slot.status === "aberto").length;
  const tone = selectedAsset === "SOL" ? "purple" : "gold";
  const title = selectedAsset === "ALL" ? "Slots" : `Slots ${selectedAsset}`;

  function announce(message: string) {
    setNotice(message);
  }

  return (
    <MobileScreen>
      <AppHeader title={title} backHref="/dashboard" />
      {setupError ? <section className="inline-alert dashboard-alert">Falha ao carregar dados: {setupError}</section> : null}
      {notice ? <section className="form-success dashboard-notice">{notice}</section> : null}
      <section className={`live-price-strip ${livePrices.status}`}>
        <div>
          <span>BTCUSDT</span>
          <strong>{formatPrice(liveBtcPrice)}</strong>
        </div>
        <div>
          <span>SOLUSDT</span>
          <strong>{formatPrice(liveSolPrice)}</strong>
        </div>
        <div>
          <span>{livePrices.status === "online" ? "Online" : livePrices.isStale ? "preço desatualizado" : "Offline"}</span>
          <strong>
            {livePrices.lastUpdated
              ? new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(livePrices.lastUpdated)
              : "--:--"}
          </strong>
        </div>
      </section>

      <FilterChips
        value={selectedAsset}
        onChange={setSelectedAsset}
        options={[
          { label: "BTC", value: "BTC", count: slots.filter((slot) => getAssetFromStrategy(slot) === "BTC").length },
          { label: "SOL", value: "SOL", count: slots.filter((slot) => getAssetFromStrategy(slot) === "SOL").length },
          { label: "Todos", value: "ALL", count: slots.length }
        ]}
      />

      <SectionCard tone={tone}>
        <div className="asset-page-summary">
          <div className="asset-heading">
            <div className="asset-title">
              <span className={`asset-icon ${selectedAsset === "SOL" ? "sol" : "btc"}`}>{selectedAsset === "SOL" ? "S" : "₿"}</span>
              <div>
                <strong>{title}</strong>
                <em>{scopedSlots.length} slots encontrados</em>
              </div>
            </div>
          </div>
          <div className="asset-summary-stats">
            <StatCard title="Total" value={formatUsdt(total)} financialValue={total} tone={tone} />
            <StatCard title="Lucro realizado" value={formatUsdt(realizedProfit)} financialValue={realizedProfit} tone="green" />
            <StatCard title="Abertos" value={String(open)} tone="gold" />
            <StatCard title="Gains operacionais" value={formatDecimal(gains)} helper={`Reais: ${realGains} · Legado: ${addedGains}`} tone="blue" />
          </div>
        </div>
      </SectionCard>

      <FilterChips
        value={slotFilter}
        onChange={setSlotFilter}
        options={[
          { label: "Abertos", value: "aberto", count: scopedSlots.filter((slot) => slot.status === "aberto").length },
          { label: "Gain", value: "gain", count: scopedSlots.filter((slot) => slot.status === "gain").length },
          { label: "Fechados", value: "closed", count: scopedSlots.filter((slot) => slot.status === "gain" || slot.status === "zerado").length },
          { label: "Todos", value: "all", count: scopedSlots.length }
        ]}
      />

      <div className="modern-slot-list">
        {visibleSlots.map((slot) => (
          <SlotCard
            key={slot.id}
            slot={slot}
            livePrice={getAssetFromStrategy(slot) === "SOL" ? liveSolPrice : liveBtcPrice}
            openRank={openRankById[slot.id] || null}
            closedRank={closedRankById[slot.id] || null}
            announce={announce}
          />
        ))}
        {visibleSlots.length === 0 ? <p className="empty-copy padded-empty">Nenhum slot neste filtro.</p> : null}
      </div>

      <details className="section-card mini-drawer">
        <summary>Adicionar slots</summary>
        <form className="tool-form stacked-form" action={createSlots}>
          <label>Moeda<SelectStrategy name="strategyId" strategies={strategies} selectedAsset={selectedAsset} /></label>
          <label>Quantidade<input name="quantity" type="number" min="1" max="50" defaultValue="1" required /></label>
          <button className="solid-button" type="submit">Adicionar</button>
        </form>
      </details>
    </MobileScreen>
  );
}

function SelectStrategy({ name, strategies, selectedAsset }: { name: string; strategies: StrategyView[]; selectedAsset: AssetFilter }) {
  const filtered = selectedAsset === "ALL" ? strategies : strategies.filter((strategy) => strategy.asset.toUpperCase() === selectedAsset);
  return (
    <select name={name} required>
      {filtered.map((strategy) => (
        <option key={strategy.id} value={strategy.id}>{strategy.title}</option>
      ))}
    </select>
  );
}

function SlotCard({
  slot,
  livePrice,
  openRank,
  closedRank,
  announce
}: {
  slot: SlotView;
  livePrice?: number;
  openRank: number | null;
  closedRank: number | null;
  announce: (message: string) => void;
}) {
  const asset = getAssetFromStrategy(slot);
  const tone = asset === "SOL" ? "purple" : "gold";
  const statusClass = slot.status === "aberto" ? "open" : slot.status === "gain" ? "gain" : "closed";
  const visualLabel = slot.status === "aberto" && openRank
    ? `Aberto #${openRank}`
    : closedRank
      ? `Fechado #${closedRank}`
      : getStatusLabel(slot.status);

  return (
    <article className={`modern-slot-card ${tone} ${statusClass}`}>
      <div className="slot-card-top">
        <div>
          <span>{visualLabel}</span>
          <strong>{asset}</strong>
        </div>
        <em>{getStatusLabel(slot.status)}</em>
      </div>
      <div className="slot-card-values">
        <span>Valor operacional<strong className={`financial-${getFinancialValueTone(getCurrentValue(slot))}`}>{formatUsdt(getCurrentValue(slot))}</strong></span>
        <span>Lucro realizado<strong className={`financial-${getFinancialValueTone(Number(slot.realized_profit || 0))}`}>{formatUsdt(Number(slot.realized_profit || 0))}</strong></span>
        <span>Gains operacionais<strong>{formatDecimal(getRankingGains(slot))}</strong></span>
      </div>
      <div className="slot-card-meta">
        <div className="slot-gain-breakdown">
          <span>Gains reais<strong>{slot.real_gains}</strong></span>
          <span>Gains adicionados (legado)<strong>{slot.added_gains}</strong></span>
        </div>
      </div>
      <details className="mini-drawer slot-more-drawer">
        <summary>Ver mais</summary>
        <div className="slot-internal-id">ID interno: {slot.slot_number}</div>
        <div className="slot-internal-id">Gains reais: {slot.real_gains}</div>
        <div className="slot-internal-id">Gains adicionados: {slot.added_gains}</div>
        <div className="slot-internal-id">
          Redistribuição líquida: {formatUsdt(Number(slot.redistribution_received_usdt || 0) - Number(slot.redistribution_sent_usdt || 0))}
        </div>
        <div className="slot-card-actions">
          <SlotAction action={moveSlot} slotId={slot.id} label="Subir" hidden={{ direction: "up" }} onClick={() => announce("Movendo slot...")} />
          <SlotAction action={moveSlot} slotId={slot.id} label="Descer" hidden={{ direction: "down" }} onClick={() => announce("Movendo slot...")} />
          {slot.status === "aberto" ? (
            <button className="slot-button" type="button" disabled>
              Abrir
            </button>
          ) : (
            <SlotAction action={openSlot} slotId={slot.id} label="Abrir" hidden={livePrice ? { entryPrice: String(Math.round(livePrice)) } : undefined} onClick={() => announce("Abrindo slot...")} />
          )}
          <SlotAction action={registerGain} slotId={slot.id} label="+Gain" disabled={slot.status === "zerado" || slot.status === "hold"} onClick={() => announce("Registrando gain...")} />
          <SlotAction action={resetSlot} slotId={slot.id} label="Zerar" onClick={() => announce("Zerando slot...")} />
        </div>
        <details className="mini-drawer edit-drawer">
          <summary>Editar dados</summary>
          <form className="tool-form stacked-form" action={updateSlot}>
            <input type="hidden" name="slotId" value={slot.id} />
            <input type="hidden" name="status" value={slot.status} />
            {asset === "BTC" ? (
              <>
                <input type="hidden" name="baseValue" value={Number(slot.base_value)} />
                <div className="slot-internal-id">Base USDT (somente leitura): {formatUsdt(Number(slot.base_value || 0))}</div>
                <Link className="slot-button" href="/plano-crescimento">Registrar aporte no Plano</Link>
              </>
            ) : (
              <label>Base USDT<input name="baseValue" type="number" min="0" step="0.01" defaultValue={Number(slot.base_value)} /></label>
            )}
            <label>Observacoes<input name="notes" type="text" defaultValue={slot.notes || ""} /></label>
            <button className="slot-button edit" type="submit">Salvar</button>
          </form>
        </details>
      </details>
    </article>
  );
}

function SlotAction({
  action,
  slotId,
  label,
  disabled = false,
  hidden,
  onClick
}: {
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
