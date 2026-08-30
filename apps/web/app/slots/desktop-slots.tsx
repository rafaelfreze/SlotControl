"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { createSlots, openSlot, registerGain, resetSlot } from "@/app/dashboard/actions";
import { DesktopWorkspace } from "@/components/app/desktop-workspace";
import { SlotActionForm, StatusBadge, type MarketTickerState } from "@/components/app/mobile-ui";
import { useCoinOpsWorkspaceData } from "@/lib/coinops-workspace/client";
import type { CoinOpsWorkspaceData } from "@/lib/coinops-workspace/server";
import type { OfficialMonitoringOverview } from "@/lib/coinops-monitoring/server";
import { formatDate, formatDecimal, formatPrice, formatSignedUsdt, formatUsdt, getCurrentValue, getOpenMarketMetrics } from "@/lib/slotgain/format";
import type { CapitalContributionView } from "@/lib/slotgain/capital-contributions";
import type { SlotView, StrategyView } from "@/lib/slotgain/types";

type Asset = "BTC" | "SOL";
type Filter = "all" | "BTC" | "SOL" | "open" | "free" | "pending" | "met" | "zero";
type Sort = "slot" | "gains" | "balance" | "pnl";
const EMPTY_PROGRESS: CoinOpsWorkspaceData["progress"] = [];

type DesktopSlotsProps = {
  userLabel: string;
  strategies: StrategyView[];
  slots: SlotView[];
  contributions: CapitalContributionView[];
  monitoring: OfficialMonitoringOverview;
  livePrices: MarketTickerState;
  initialFilter?: string | null;
  initialFlow?: string | null;
};

function assetOf(slot: SlotView): Asset {
  return slot.strategy?.asset?.toUpperCase() === "SOL" ? "SOL" : "BTC";
}
function gainsOf(slot: SlotView) {
  const value = Number(slot.operational_gains);
  return Number.isFinite(value) ? value : Number(slot.gains || 0);
}

export function DesktopSlots({ userLabel, strategies, slots, monitoring, livePrices, initialFilter, initialFlow }: DesktopSlotsProps) {
  const [filter, setFilter] = useState<Filter>(
    initialFilter === "BTC" || initialFilter === "SOL"
      ? initialFilter
      : initialFlow === "gain"
        ? "open"
        : initialFlow === "abrir"
          ? "free"
          : "all"
  );
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("slot");
  const [selected, setSelected] = useState<SlotView | null>(null);
  const { data: workspace, status: workspaceStatus } = useCoinOpsWorkspaceData();
  const workspaceProgress = workspace?.progress ?? EMPTY_PROGRESS;
  const progressBySlot = useMemo(() => new Map(workspaceProgress.map((item) => [item.slot_id, item])), [workspaceProgress]);
  const rows = useMemo(() => slots.map((slot) => {
    const asset = assetOf(slot);
    const livePrice = livePrices.prices[asset];
    const progress = progressBySlot.get(slot.id);
    return {
      slot,
      asset,
      livePrice,
      gains: gainsOf(slot),
      balance: getCurrentValue(slot),
      pnl: slot.status === "aberto" ? getOpenMarketMetrics(slot, livePrice).resultadoAbertoUsdt : Number(slot.realized_profit || 0),
      progress
    };
  }).filter((row) => {
    if (search && !`#${row.slot.slot_number} ${row.asset}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === "BTC" || filter === "SOL") return row.asset === filter;
    if (filter === "open") return row.slot.status === "aberto";
    if (filter === "free") return row.slot.status !== "aberto";
    if (filter === "pending") return Boolean(row.progress && row.progress.cycle_progress < row.progress.target);
    if (filter === "met") return Boolean(row.progress && row.progress.cycle_progress >= row.progress.target);
    if (filter === "zero") return row.gains === 0;
    return true;
  }).sort((first, second) => sort === "gains" ? second.gains - first.gains : sort === "balance" ? second.balance - first.balance : sort === "pnl" ? second.pnl - first.pnl : first.slot.slot_number - second.slot.slot_number), [filter, livePrices.prices, progressBySlot, search, slots, sort]);

  return (
    <DesktopWorkspace title="Slots" subtitle={`${rows.length} de ${slots.length} exibidos`} livePrices={livePrices} monitoring={monitoring} userLabel={userLabel} actions={<Link href="/plano-crescimento">Plano operacional</Link>}>
      <section className="desktop-toolbar" aria-label="Filtros dos slots">
        <div className="desktop-filter-group">{([
          ["all", "Todos"], ["BTC", "BTC"], ["SOL", "SOL"], ["open", "Abertos"], ["free", "Livres"], ["pending", "Meta pendente"], ["met", "Meta batida"], ["zero", "Zerados"]
        ] as Array<[Filter, string]>).map(([value, label]) => <button key={value} type="button" className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}</div>
        <label className="desktop-search"><span className="visually-hidden">Buscar slot</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar slot..." /></label>
        <label className="desktop-sort"><span>Ordenar</span><select value={sort} onChange={(event) => setSort(event.target.value as Sort)}><option value="slot">Número</option><option value="gains">Gains</option><option value="balance">Saldo</option><option value="pnl">PnL</option></select></label>
      </section>

      <section className="desktop-panel desktop-slots-table-panel">
        <header className="desktop-panel-header"><div><span>Saldo operacional total</span><h2>{formatUsdt(slots.reduce((total, slot) => total + getCurrentValue(slot), 0))}</h2></div><details className="desktop-add-slot"><summary>Adicionar slot</summary><form action={createSlots}><select name="strategyId" required>{strategies.map((strategy) => <option key={strategy.id} value={strategy.id}>{strategy.asset} · {strategy.title}</option>)}</select><input name="quantity" type="number" min="1" max="50" defaultValue="1" required /><button type="submit">Adicionar</button></form></details></header>
        {workspaceStatus === "loading" || workspaceStatus === "idle" ? <p className="desktop-data-note">Carregando progresso oficial do ciclo...</p> : null}
        {workspaceStatus === "error" ? <p className="desktop-data-note">Progresso oficial indisponível; os dados operacionais dos slots continuam visíveis.</p> : null}
        <div className="desktop-table-wrap">
          <table className="desktop-data-table desktop-slots-table">
            <thead><tr><th>#</th><th>Ativo</th><th>Status</th><th>Gains</th><th>Meta</th><th>Saldo</th><th>PnL</th><th>Entry</th><th>Target</th><th>Última operação</th><th>Ação</th><th><span className="visually-hidden">Detalhes</span></th></tr></thead>
            <tbody>{rows.map(({ slot, asset, livePrice, gains, balance, pnl, progress }) => <tr key={slot.id} className={selected?.id === slot.id ? "selected" : ""}>
              <td><button className="desktop-slot-link" type="button" onClick={() => setSelected(slot)}>#{slot.slot_number}</button></td>
              <td><span className={`desktop-asset-pill ${asset.toLowerCase()}`}>{asset}</span></td>
              <td><StatusBadge status={slot.status} /></td>
              <td><strong>{formatDecimal(gains)}</strong></td>
              <td>{progress ? `${formatDecimal(progress.cycle_progress)} / ${formatDecimal(progress.target)}` : "-"}</td>
              <td><strong>{formatUsdt(balance)}</strong></td>
              <td className={pnl >= 0 ? "financial-positive" : "financial-negative"}>{formatSignedUsdt(pnl)}</td>
              <td>{slot.preco_entrada ? formatPrice(Number(slot.preco_entrada)) : "-"}</td>
              <td>{slot.preco_alvo ? formatPrice(Number(slot.preco_alvo)) : "-"}</td>
              <td>{slot.updated_at ? formatDate(slot.updated_at) : "-"}</td>
              <td>{slot.status === "aberto"
                ? <SlotActionForm action={registerGain} slotId={slot.id} label={"\u2713 Gain"} pendingLabel="Gain..." buttonClassName="desktop-row-action gain" hidden={{ returnFilter: filter }} />
                : <SlotActionForm action={openSlot} slotId={slot.id} label="+ Abrir" pendingLabel="Abrindo..." buttonClassName="desktop-row-action open" hidden={livePrice ? { entryPrice: String(Math.round(livePrice)), returnFilter: filter } : { returnFilter: filter }} />}
              </td>
              <td><button type="button" className="desktop-more-button" onClick={() => setSelected(slot)} aria-label={`Ver detalhes do slot ${slot.slot_number}`}>…</button></td>
            </tr>)}</tbody>
          </table>
          {!rows.length ? <p className="desktop-empty">Nenhum slot corresponde aos filtros selecionados.</p> : null}
        </div>
      </section>

      {selected ? <SlotDrawer slot={selected} livePrice={livePrices.prices[assetOf(selected)]} progress={progressBySlot.get(selected.id)} returnFilter={filter} onClose={() => setSelected(null)} /> : null}
    </DesktopWorkspace>
  );
}

function SlotDrawer({ slot, livePrice, progress, returnFilter, onClose }: { slot: SlotView; livePrice?: number; progress?: CoinOpsWorkspaceData["progress"][number]; returnFilter: Filter; onClose: () => void }) {
  const asset = assetOf(slot);
  const pnl = slot.status === "aberto" ? getOpenMarketMetrics(slot, livePrice).resultadoAbertoUsdt : Number(slot.realized_profit || 0);
  return <div className="desktop-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="desktop-slot-drawer" role="dialog" aria-modal="true" aria-labelledby="desktop-slot-title"><header><div><span className={`desktop-asset-orb ${asset.toLowerCase()}`}>{asset === "BTC" ? "₿" : "S"}</span><span><small>Slot operacional</small><h2 id="desktop-slot-title">#{slot.slot_number} {asset}</h2></span></div><button type="button" onClick={onClose} aria-label="Fechar detalhes">×</button></header>
    <div className="desktop-drawer-kpis"><span><small>Saldo atual</small><strong>{formatUsdt(getCurrentValue(slot))}</strong></span><span><small>Gains</small><strong>{formatDecimal(gainsOf(slot))}</strong></span><span><small>PnL</small><strong className={pnl >= 0 ? "financial-positive" : "financial-negative"}>{formatSignedUsdt(pnl)}</strong></span></div>
    <section><h3>Operação atual</h3><dl><div><dt>Status</dt><dd><StatusBadge status={slot.status} /></dd></div><div><dt>Entrada</dt><dd>{slot.preco_entrada ? formatPrice(Number(slot.preco_entrada)) : "-"}</dd></div><div><dt>Target</dt><dd>{slot.preco_alvo ? formatPrice(Number(slot.preco_alvo)) : "-"}</dd></div><div><dt>Atualizado</dt><dd>{slot.updated_at ? formatDate(slot.updated_at) : "-"}</dd></div></dl></section>
    <section><h3>Composição e ciclo</h3><dl><div><dt>Gains reais</dt><dd>{formatDecimal(slot.real_gains)}</dd></div><div><dt>Gains adicionados</dt><dd>{formatDecimal(slot.added_gains)}</dd></div><div><dt>Redistribuição recebida</dt><dd>{formatUsdt(Number(slot.redistribution_received_usdt || 0))}</dd></div><div><dt>Redistribuição enviada</dt><dd>{formatUsdt(Number(slot.redistribution_sent_usdt || 0))}</dd></div><div><dt>Progresso do ciclo</dt><dd>{progress ? `${formatDecimal(progress.cycle_progress)} / ${formatDecimal(progress.target)}` : "-"}</dd></div></dl></section>
    <footer><Link className="desktop-secondary-button" href={`/slots/${slot.id}`}>Ver detalhes completos</Link>{slot.status === "aberto" ? <SlotActionForm action={registerGain} slotId={slot.id} label="✓ Registrar gain" pendingLabel="Registrando..." buttonClassName="desktop-primary-button" hidden={{ returnFilter }} /> : <SlotActionForm action={openSlot} slotId={slot.id} label="+ Abrir operação" pendingLabel="Abrindo..." buttonClassName="desktop-primary-button" hidden={livePrice ? { entryPrice: String(Math.round(livePrice)), returnFilter } : { returnFilter }} />}<SlotActionForm action={resetSlot} slotId={slot.id} label="Zerar" pendingLabel="Zerando..." buttonClassName="desktop-danger-button" /></footer>
  </aside></div>;
}
