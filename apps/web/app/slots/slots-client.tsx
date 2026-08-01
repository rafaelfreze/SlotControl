"use client";

import { useMemo, useState } from "react";

import {
  createSlots,
  moveSlot,
  openSlot,
  registerGain,
  resetSlot,
  updateSlot,
  updateSlotGains
} from "@/app/dashboard/actions";
import { AppHeader, FilterChips, MobileScreen, SectionCard, StatCard } from "@/components/app/mobile-ui";
import {
  formatDate,
  formatPrice,
  formatWholePrice,
  formatUsdt,
  getCurrentValue,
  getMarkedSlotValue,
  getOpenMarketMetrics,
  getStatusLabel
} from "@/lib/slotgain/format";
import { useLivePrices } from "@/lib/slotgain/live-prices";
import { getFinancialValueTone } from "@/lib/slotgain/financial-tone";
import { rankSlotIds, sortSlotsByGains } from "@/lib/slotgain/slot-ranking";
import { DEFAULT_ASSET_MARKET_SETTINGS, activeBuyDropPercent, asMarketRegime, effectiveMarketRegime, type AssetMarketStrategySettings, type BtcMarketState, type MarketRegimeSettings } from "@/lib/slotgain/market-regime";
import type { SlotView, StrategyView } from "@/lib/slotgain/types";

type SlotFilter = "aberto" | "gain" | "closed" | "all";
type AssetFilter = "BTC" | "SOL" | "ALL";

type SlotsClientProps = {
  userEmail: string;
  strategies: StrategyView[];
  slots: SlotView[];
  setupError: string | null;
  initialNotice: string | null;
  initialAsset: string | null;
  initialFlow: string | null;
  marketState: Partial<BtcMarketState> | null;
  regimeSettings: Partial<MarketRegimeSettings> | null;
  assetSettings: Partial<AssetMarketStrategySettings>[];
};

function getAssetFromStrategy(slot: SlotView) {
  return slot.strategy?.asset?.toUpperCase() || "BTC";
}

function getOpenTimestamp(slot: SlotView) {
  const timestamp = slot.updated_at ? new Date(slot.updated_at).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortByOpenDate(slots: SlotView[]) {
  return [...slots].sort((first, second) => {
    const priceDiff = Number(second.preco_entrada || 0) - Number(first.preco_entrada || 0);
    return priceDiff || getOpenTimestamp(first) - getOpenTimestamp(second) || first.sort_order - second.sort_order;
  });
}

function getSuggestedEntryPrice(slot: SlotView, slots: SlotView[], dropPercent: number, livePrice?: number) {
  const asset = getAssetFromStrategy(slot);
  const lastOpenSlot = sortByOpenDate(
    slots.filter(
      (candidate) =>
        candidate.id !== slot.id &&
        candidate.status === "aberto" &&
        getAssetFromStrategy(candidate) === asset &&
        Number(candidate.preco_entrada || 0) > 0
    )
  ).at(-1);

  if (lastOpenSlot) {
    return Math.round(Number(lastOpenSlot.preco_entrada || 0) * (1 - dropPercent / 100));
  }

  return livePrice ? Math.round(livePrice) : 0;
}

export function SlotsClient({ userEmail, strategies, slots, setupError, initialNotice, initialAsset, initialFlow, marketState, regimeSettings, assetSettings }: SlotsClientProps) {
  const livePrices = useLivePrices();
  const liveBtcPrice = livePrices.prices.BTC;
  const liveSolPrice = livePrices.prices.SOL;
  const initialSelectedAsset: AssetFilter = initialAsset?.toUpperCase() === "SOL" ? "SOL" : initialAsset?.toUpperCase() === "BTC" ? "BTC" : "ALL";
  const [selectedAsset, setSelectedAsset] = useState<AssetFilter>(initialSelectedAsset);
  const [slotFilter, setSlotFilter] = useState<SlotFilter>(initialFlow === "abrir" ? "closed" : "aberto");
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const automaticRegime = asMarketRegime(regimeSettings?.last_effective_mode) || asMarketRegime(marketState?.effective_mode) || "NORMAL";
  const effectiveRegime = effectiveMarketRegime({
    mode_source: regimeSettings?.mode_source === "MANUAL" ? "MANUAL" : "AUTO",
    manual_mode: asMarketRegime(regimeSettings?.manual_mode)
  }, automaticRegime);
  const btcDropPercent = activeBuyDropPercent("BTC", effectiveRegime, assetSettings.find((item) => item.asset === "BTC") || DEFAULT_ASSET_MARKET_SETTINGS.BTC);
  const solDropPercent = activeBuyDropPercent("SOL", effectiveRegime, assetSettings.find((item) => item.asset === "SOL") || DEFAULT_ASSET_MARKET_SETTINGS.SOL);

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
        return sortSlotsByGains(filtered);
      }

      if (slotFilter === "closed") {
        return sortSlotsByGains(filtered);
      }

      return [...filtered].sort((first, second) => {
        const group = (slot: SlotView) => slot.status === "gain" || slot.status === "zerado" ? 0 : slot.status === "aberto" ? 1 : 2;
        return group(first) - group(second) || Number(second.gains || 0) - Number(first.gains || 0) || first.slot_number - second.slot_number;
      });
    },
    [scopedSlots, slotFilter]
  );
  const openRankById = useMemo(() => rankSlotIds(scopedSlots.filter((slot) => slot.status === "aberto")), [scopedSlots]);
  const closedRankById = useMemo(() => rankSlotIds(scopedSlots.filter((slot) => slot.status === "gain" || slot.status === "zerado")), [scopedSlots]);

  const suggestedEntryById = useMemo(() => {
    return scopedSlots.reduce<Record<string, number>>((suggestions, slot) => {
      const asset = getAssetFromStrategy(slot) === "SOL" ? "SOL" : "BTC";
      suggestions[slot.id] = getSuggestedEntryPrice(slot, scopedSlots, asset === "SOL" ? solDropPercent : btcDropPercent, asset === "SOL" ? liveSolPrice : liveBtcPrice);
      return suggestions;
    }, {});
  }, [scopedSlots, liveBtcPrice, liveSolPrice, btcDropPercent, solDropPercent]);

  const total = scopedSlots.reduce((sum, slot) => sum + getMarkedSlotValue(slot, getAssetFromStrategy(slot) === "SOL" ? liveSolPrice : liveBtcPrice), 0);
  const base = scopedSlots.reduce((sum, slot) => sum + Number(slot.base_value || 0), 0);
  const gains = scopedSlots.reduce((sum, slot) => sum + slot.gains, 0);
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
            <StatCard title="Lucro realizado" value={formatUsdt(total - base)} financialValue={total - base} tone="green" />
            <StatCard title="Abertos" value={String(open)} tone="gold" />
            <StatCard title="Gains totais" value={String(gains)} helper={`Reais: ${realGains} · Adicionados: ${addedGains}`} tone="blue" />
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
            suggestedEntryPrice={suggestedEntryById[slot.id] || 0}
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
  suggestedEntryPrice,
  openRank,
  closedRank,
  announce
}: {
  slot: SlotView;
  livePrice?: number;
  suggestedEntryPrice: number;
  openRank: number | null;
  closedRank: number | null;
  announce: (message: string) => void;
}) {
  const asset = getAssetFromStrategy(slot);
  const tone = asset === "SOL" ? "purple" : "gold";
  const market = getOpenMarketMetrics(slot, livePrice);
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
        <span>Valor operacional<strong className={`financial-${getFinancialValueTone(slot.status === "aberto" ? market.valorMarcado : getCurrentValue(slot))}`}>{formatUsdt(slot.status === "aberto" ? market.valorMarcado : getCurrentValue(slot))}</strong></span>
        <span>Lucro realizado<strong className={`financial-${getFinancialValueTone(Number(slot.realized_profit || 0))}`}>{formatUsdt(Number(slot.realized_profit || 0))}</strong></span>
        <span>Gains totais<strong>{slot.gains}</strong></span>
      </div>
      <div className="slot-card-meta">
        <div className="slot-gain-breakdown">
          <span>Gains reais<strong>{slot.real_gains}</strong></span>
          <span>Gains adicionados<strong>{slot.added_gains}</strong></span>
        </div>
        {slot.status === "aberto" || slot.status === "hold" ? (
          <span className="slot-gain-readonly">Gains adicionados somente em slots fechados.</span>
        ) : (
        <form className="slot-gain-editor" action={updateSlotGains}>
          <input type="hidden" name="slotId" value={slot.id} />
          <label>Adicionar gains<input name="addedGains" type="number" min={slot.added_gains} step="1" defaultValue={slot.added_gains} aria-label={`Gains adicionados do slot ${slot.slot_number}`} /></label>
          <button type="submit">Salvar</button>
        </form>
        )}
        <span>Operação<strong>{formatDate(slot.updated_at)}</strong></span>
      </div>
      {slot.status === "aberto" || slot.status === "hold" ? (
        <div className="slot-market-strip">
          <span>Entrada<strong>{formatWholePrice(slot.status === "hold" ? Number(slot.preco_entrada || 0) : market.precoEntrada)}</strong></span>
          <span>Alvo<strong>{formatWholePrice(slot.status === "hold" ? Number(slot.preco_alvo || 0) : market.precoAlvo)}</strong></span>
        </div>
      ) : null}
      <details className="mini-drawer slot-more-drawer">
        <summary>Ver mais</summary>
        <div className="slot-internal-id">ID interno: {slot.slot_number}</div>
        <div className="slot-internal-id">Gains reais: {slot.real_gains}</div>
        <div className="slot-internal-id">Gains adicionados: {slot.added_gains}</div>
        <div className="slot-card-actions">
          <SlotAction action={moveSlot} slotId={slot.id} label="Subir" hidden={{ direction: "up" }} onClick={() => announce("Movendo slot...")} />
          <SlotAction action={moveSlot} slotId={slot.id} label="Descer" hidden={{ direction: "down" }} onClick={() => announce("Movendo slot...")} />
          {slot.status === "aberto" ? (
            <button className="slot-button" type="button" disabled>
              Abrir
            </button>
          ) : (
            <form className="tool-form stacked-form slot-open-form" action={openSlot}>
              <input type="hidden" name="slotId" value={slot.id} />
              <label>
                Preco entrada
                <input name="entryPrice" type="number" min="0" step="1" defaultValue={suggestedEntryPrice ? Math.round(suggestedEntryPrice) : ""} />
              </label>
              <button className="slot-button" type="submit" onClick={() => announce("Abrindo slot...")}>
                Abrir
              </button>
            </form>
          )}
          <SlotAction action={registerGain} slotId={slot.id} label="+Gain" disabled={slot.status === "zerado" || slot.status === "hold"} onClick={() => announce("Registrando gain...")} />
          <SlotAction action={resetSlot} slotId={slot.id} label="Zerar" onClick={() => announce("Zerando slot...")} />
        </div>
        <details className="mini-drawer edit-drawer">
          <summary>Editar dados</summary>
          <form className="tool-form stacked-form" action={updateSlot}>
            <input type="hidden" name="slotId" value={slot.id} />
            <label>Status<select name="status" defaultValue={slot.status}><option value="zerado">Zerado</option><option value="hold">Aguardando entrada</option><option value="aberto">Aberto</option><option value="gain">Gain</option></select></label>
            <label>Base USDT<input name="baseValue" type="number" min="0" step="0.01" defaultValue={Number(slot.base_value)} /></label>
            <label>Preco entrada<input name="entryPrice" type="number" min="0" step="1" defaultValue={slot.preco_entrada ? Math.round(Number(slot.preco_entrada)) : ""} /></label>
            <label>Preco atual<input name="currentPrice" type="number" min="0" step="0.00000001" defaultValue={Number(slot.preco_atual || 0) || ""} /></label>
            <label>Preco alvo<input name="targetPrice" type="number" min="0" step="1" defaultValue={slot.preco_alvo ? Math.round(Number(slot.preco_alvo)) : ""} /></label>
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
