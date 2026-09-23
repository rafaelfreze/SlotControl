"use client";

import Image from "next/image";
import type { FormEvent } from "react";
import { useState } from "react";

import type { diagnoseBinanceSpotTestnet } from "@/lib/execution/binance-spot-testnet-adapter";
import { reconcileV1PhysicalSlotAccounts, summarizeV1ShadowOperations } from "@/lib/execution/robot-v1-audit";
import { COINOPS_TIME_ZONE } from "@/lib/slotgain/format";

import { controlRobotV1Shadow, saveRobotV1Parameters } from "./robot-v1-actions";

type Asset = "BTC" | "SOL";
type Config = { id: string; asset: Asset; symbol: string; execution_mode: "SHADOW" | "TESTNET"; capital_usdc: number | string; next_capital_usdc: number | string | null; gain_rate: number | string; entry_spacing: number | string; next_gain_rate: number | string | null; next_entry_spacing: number | string | null; slot_count: number; kill_switch: boolean; pause_new_entries: boolean; shadow_test_started_at: string | null; shadow_test_target_end_at: string | null; last_candle_open_at: string | null; last_market_price: number | string | null; last_market_observed_at: string | null; last_engine_at: string | null; last_engine_error: string | null; grid_status: string | null; grid_error: string | null; configured_live_capital_brl: number | string | null; max_order_notional_brl: number | string | null; max_total_exposure_brl: number | string | null };
type Cycle = { id: string; config_id: string; asset: Asset; status: string; anchor_price: number | string; slot_notional_usdc: number | string; capital_usdc: number | string; gain_rate: number | string; entry_spacing: number | string; started_at: string; completed_at: string | null; completion_reason: string | null };
type Slot = { id: string; cycle_id: string; slot_number: number; logical_level: number; operation_sequence: number; entry_state: "NONE" | "ARMED" | "PLANNED"; armed_at: string | null; missed_at: string | null; buy_client_order_id: string; sell_client_order_id: string | null; allocation_usdc: number | string; buy_price: number | string; requested_quantity: number | string; executed_quantity: number | string; average_fill_price: number | string | null; take_profit_price: number | string | null; status: string; buy_triggered_at: string | null; tp_triggered_at: string | null };
type Operation = { id: string; cycle_id: string; slot_id: string; physical_slot_number: number; logical_level: number; operation_sequence: number; allocation_usdc: number | string; entry_price: number | string; executed_quantity: number | string; take_profit_price: number | string; gross_quote_pnl: number | string; estimated_quote_fees: number | string; net_quote_pnl: number | string; opened_at: string | null; closed_at: string };
type SlotAccount = { config_id: string; slot_number: number; initial_balance_usdc: number | string; balance_usdc: number | string; gain_count: number; gross_profit_usdc: number | string; fees_usdc: number | string; net_profit_usdc: number | string; last_operation_id: string | null };
type Event = { cycle_id: string; slot_id: string | null; event_type: string; next_state: Record<string, unknown> | null; observed_at: string };
export type Candle = { symbol: string; candle_open_at: string; open_price: number | string; high_price: number | string; low_price: number | string; close_price: number | string };
type Balance = { asset: string; free: number; locked: number; total: number };
type TestnetRun = { id: string; status: string; symbol: string; last_reconciled_at: string | null; last_error: string | null; created_at: string; slot_notional_usdc?: number | string; gain_rate?: number | string; entry_spacing?: number | string; next_capital_usdc?: number | string | null; next_gain_rate?: number | string | null; next_entry_spacing?: number | string | null; previous_run_id?: string | null; completed_at?: string | null; completion_reason?: string | null; reset_started_at?: string | null; reset_completed_at?: string | null; recovery_source?: string | null } | null;
type TestnetSlot = { run_id?: string; slot_number: number; entry_state: string; target_buy_price?: number | string; balance_usdc: number | string; gain_count: number; net_profit_usdc: number | string; missed_at: string | null; operation_sequence?: number; entry_origin?: string; entry_reference_price?: number | string; last_take_profit_price?: number | string | null; created_at?: string; updated_at?: string };
type TestnetOrderRow = { run_id?: string; slot_number: number; side: string; purpose: string; revision: number; operation_sequence?: number; client_order_id: string; exchange_order_id: string | null; status: string; requested_quantity: number | string | null; price: number | string | null; executed_quantity: number | string; cumulative_quote: number | string; fee_base?: number | string; fee_quote?: number | string; fee_other?: unknown[]; created_at: string; updated_at: string };
type TestnetEvent = { run_id?: string; event_type: string; slot_number: number | null; observed_at: string; details: Record<string, unknown> };
type TestnetDiagnostic = Awaited<ReturnType<typeof diagnoseBinanceSpotTestnet>>;
export type TestnetHistoryBundle = { run: NonNullable<TestnetRun>; slots: TestnetSlot[]; orders: TestnetOrderRow[] };
export type TestnetAssetData = { run: NonNullable<TestnetRun>; slots: TestnetSlot[]; orders: TestnetOrderRow[]; events: TestnetEvent[]; history?: TestnetHistoryBundle[] };
export type Props = { connectionStatus?: string | null; lastSyncedAt?: string | null; balances: Balance[]; reconciliationStatus?: string | null; reconciliationAt?: string | null; mismatches: number; configs: Config[]; cycles: Cycle[]; slots: Slot[]; operations: Operation[]; slotAccounts: SlotAccount[]; events: Event[]; candles: Candle[]; dailyCandles: Candle[]; intentCount: number; solBrlPilot: { observedAt: string; status: string; priceBrl: number; priceTick: number; quantityStep: number; minQuantity: number; minNotional: number; orderTypes: string[]; accepted: boolean; executableNotional: number; minimumPerSlotBrl: number; minimumCapitalFor25SlotsBrl: number }; testnet: ({ ok: true } & TestnetDiagnostic) | { ok: false; error: string } | null; testnetEnabled: boolean; testnetActionError: string | null; testnetRun: TestnetRun; testnetSlots: TestnetSlot[]; testnetOrders: TestnetOrderRow[]; testnetEvents: TestnetEvent[]; testnetHistory?: TestnetHistoryBundle[]; testnetAssetData?: Partial<Record<Asset, TestnetAssetData>>; embedded?: boolean };

const ACTIVE_CYCLES = ["STARTING", "GRID_ACTIVE", "POSITIONS_ACTIVE", "RESETTING"];
const OPEN_SLOTS = ["TP_ACTIVE", "OPEN", "PARTIALLY_FILLED"];
const n = (value: number | string | null | undefined, digits = 2) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value).toLocaleString("pt-BR", { maximumFractionDigits: digits }) : "—";
const d = (value?: string | null) => value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: COINOPS_TIME_ZONE }).format(new Date(value)) : "Ainda não disponível";
const day = (value?: string | null) => value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeZone: "UTC" }).format(new Date(value)) : "—";
const p = (value: number | string | null | undefined) => n(Number(value || 0) * 100, 2);
const signed = (value: number | string | null | undefined) => `${Number(value || 0) >= 0 ? "+" : ""}${n(value, 4)}`;
const shortId = (value?: string | null) => value ? value.slice(0, 8) : "—";

function status(slot: Slot) {
  if (OPEN_SLOTS.includes(slot.status)) return { label: "ABERTO", tone: "open", action: "Monitorando TP" };
  if (slot.status === "PENDING" && slot.entry_state === "ARMED") return { label: "PRÓXIMA COMPRA", tone: "armed", action: "Compra armada" };
  if (slot.status === "PENDING" && slot.missed_at) return { label: "NÍVEL PERDIDO", tone: "missed", action: "Sem fill retroativo" };
  if (slot.status === "PENDING") return { label: "PLANEJADO", tone: "planned", action: "Aguarda sua vez" };
  return { label: slot.status === "CANCELLED" ? "CANCELADO" : "FINALIZADO", tone: "closed", action: "Histórico preservado" };
}
function eventLabel(event: Event, slotNumber?: number) {
  const labels: Record<string, string> = { INITIAL_POSITION_OPENED: "Posição inicial aberta", BUY_TRIGGERED: "Compra Shadow executada", TP_TRIGGERED: "TP Shadow atingido", SLOT_TP_FILLED: "TP preenchido", SLOT_PROFIT_CREDITED: "Lucro creditado no slot", SLOT_BALANCE_UPDATED: "Saldo do slot atualizado", SLOT_RECYCLED: "Slot reciclado", SLOT_REENTRY_PLANNED: "Reentrada preservada", SLOT_REENTRY_ARMED: "Reentrada armada", SHADOW_STATE_REPAIRED: "Estado Shadow reparado", NEXT_BUY_ARMED: "Próxima compra armada", NEXT_BUY_DISARMED: "Próxima compra desarmada", BUY_REPLACED_FOR_REENTRY: "Compra substituída pela reentrada", MISSED_LEVEL_DURING_REARM: "Nível perdido no rearme", CYCLE_STARTED: "Novo ciclo", CYCLE_COMPLETED: "Ciclo concluído", CYCLE_RESTARTED: "Ciclo reiniciado", INTRABAR_AMBIGUOUS: "Vela ambígua", GRID_INVALID: "Grade inválida" };
  const number = event.next_state?.slotNumber;
  const resolvedNumber = typeof number === "number" ? number : slotNumber;
  return `${labels[event.event_type] || event.event_type}${typeof resolvedNumber === "number" ? ` — Slot #${resolvedNumber}` : ""}`;
}
function confirmKill(event: FormEvent<HTMLFormElement>) { if (!window.confirm("Ativar o kill switch pausa novas entradas deste robô Shadow. O ciclo e o histórico serão preservados. Continuar?")) event.preventDefault(); }

export function Sparkline({ candles, asset }: { candles: Candle[]; asset: Asset }) {
  const values = candles.slice(-36).map((row) => Number(row.close_price)).filter(Number.isFinite);
  if (values.length < 2) return <span className="av2-no-trend">Tendência ainda indisponível</span>;
  const min = Math.min(...values), span = Math.max(...values) - min || 1;
  const points = values.map((value, index) => `${index * 180 / (values.length - 1)},${47 - (value - min) / span * 42}`).join(" ");
  return <svg className={`av2-sparkline ${asset.toLowerCase()}`} viewBox="0 0 180 52" preserveAspectRatio="none" role="img" aria-label={`Tendência real das últimas ${values.length} velas de ${asset}/USDC`}><polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function CandleChart({ candles, asset, windowSize }: { candles: Candle[]; asset: Asset; windowSize: number }) {
  const rows = candles.slice(-windowSize);
  if (rows.length < 2) return <p className="av2-empty">Gráfico diário temporariamente indisponível.</p>;
  const low = Math.min(...rows.map((row) => Number(row.low_price)));
  const high = Math.max(...rows.map((row) => Number(row.high_price)));
  const range = high - low || 1;
  const y = (price: number) => 190 - (price - low) / range * 170;
  const step = 680 / rows.length;
  return <div className="av2-chart-wrap"><svg viewBox="0 0 720 220" preserveAspectRatio="none" role="img" aria-label={`Velas diárias de ${asset}/USDC de ${day(rows[0]?.candle_open_at)} até ${day(rows.at(-1)?.candle_open_at)}`}>
    {[30, 80, 130, 180].map((line) => <line key={line} x1="18" x2="700" y1={line} y2={line} className="av2-chart-grid" />)}
    {rows.map((row, index) => { const open = Number(row.open_price), close = Number(row.close_price); const center = 22 + index * step + step / 2; const top = Math.min(y(open), y(close)); return <g key={row.candle_open_at} className={close >= open ? "av2-up" : "av2-down"}><line x1={center} x2={center} y1={y(Number(row.high_price))} y2={y(Number(row.low_price))} /><rect x={center - Math.max(2, step * .28)} y={top} width={Math.max(4, step * .56)} height={Math.max(2, Math.abs(y(open) - y(close)))} rx="1" /></g>; })}
  </svg><div className="av2-chart-axis"><span>{day(rows[0]?.candle_open_at)}</span><span>{n(rows.at(-1)?.close_price, 4)} USDC</span><span>{day(rows.at(-1)?.candle_open_at)}</span></div></div>;
}

export function AutomationMobile(props: Props & { initialAsset?: Asset; detailSection?: string }) {
  const [selectedAsset, setSelectedAsset] = useState<Asset>(props.initialAsset || "SOL");
  const [showAll, setShowAll] = useState(props.detailSection === "slots");
  const [expandedSlot, setExpandedSlot] = useState<string | null>(null);
  const config = props.configs.find((item) => item.asset === selectedAsset);
  const assetCycles = props.cycles.filter((item) => item.asset === selectedAsset);
  const cycle = assetCycles.find((item) => ACTIVE_CYCLES.includes(item.status));
  const slots = cycle ? props.slots.filter((item) => item.cycle_id === cycle.id).sort((a, b) => a.logical_level - b.logical_level) : [];
  const displayedSlots = showAll ? slots : slots.slice(0, 5);
  const accounts = props.slotAccounts.filter((item) => item.config_id === config?.id);
  const testCycles = new Set(assetCycles.filter((item) => !config?.shadow_test_started_at || Date.parse(item.started_at) >= Date.parse(config.shadow_test_started_at)).map((item) => item.id));
  const operations = props.operations.filter((item) => testCycles.has(item.cycle_id));
  const events = props.events.filter((item) => testCycles.has(item.cycle_id));
  const slotNumberById = new Map(props.slots.map((item) => [item.id, item.slot_number]));
  const describeEvent = (event: Event) => eventLabel(event, event.slot_id ? slotNumberById.get(event.slot_id) : undefined);
  const candles = [...props.candles.filter((item) => item.symbol === `${selectedAsset}USDC`)].reverse();
  const dailyCandles = props.dailyCandles.filter((item) => item.symbol === `${selectedAsset}USDC`);
  const open = slots.filter((item) => OPEN_SLOTS.includes(item.status));
  const armed = slots.filter((item) => item.status === "PENDING" && item.entry_state === "ARMED").length;
  const planned = slots.filter((item) => item.status === "PENDING" && item.entry_state !== "ARMED" && !item.missed_at).length;
  const missed = slots.filter((item) => item.missed_at).length;
  const initial = accounts.reduce((sum, item) => sum + Number(item.initial_balance_usdc), 0);
  const capital = accounts.reduce((sum, item) => sum + Number(item.balance_usdc), 0);
  const gains = accounts.reduce((sum, item) => sum + item.gain_count, 0);
  const realized = accounts.reduce((sum, item) => sum + Number(item.net_profit_usdc), 0);
  const market = Number(config?.last_market_price || 0);
  const openPnl = open.reduce((sum, item) => sum + (market - Number(item.average_fill_price || 0)) * Number(item.executed_quantity || 0), 0);
  const committed = open.reduce((sum, item) => sum + Number(item.executed_quantity) * Number(item.average_fill_price || 0), 0);
  const accounting = summarizeV1ShadowOperations(operations.map((item) => ({ grossQuotePnl: item.gross_quote_pnl, estimatedQuoteFees: item.estimated_quote_fees, netQuotePnl: item.net_quote_pnl })));
  const accountValid = reconcileV1PhysicalSlotAccounts(accounts, operations) && Math.abs(initial - Number(config?.capital_usdc || 0)) < 1e-8;
  const healthy = config?.grid_status === "VALID" && !config.last_engine_error && accountValid && armed <= 1;
  const active = Boolean(cycle) && !config?.kill_switch && !config?.pause_new_entries;
  const detail = slots.find((item) => item.id === expandedSlot);
  const detailAccount = accounts.find((item) => item.slot_number === detail?.slot_number);
  const detailHistory = operations.filter((item) => item.physical_slot_number === detail?.slot_number);
  const detailEvents = events.filter((item) => item.slot_id === detail?.id);

  return <div className={`coinops-automation ${props.embedded ? "ac-shadow" : ""}`} data-detail-section={props.detailSection}>
    <header className="av2-mobile-header"><Image src="/icon-96x96.png" alt="" width={36} height={36} priority /><div><strong>COINOPS</strong><small>AUTOMAÇÃO CRIPTO</small></div><a href="/mais" aria-label="Abrir menu">☰</a></header>
    <div className="av2-intro"><div><span className="av2-eyebrow">AUTOMAÇÃO</span><h1>Seu robô CoinOps</h1><p>Disciplina hoje. Resultado amanhã.</p></div><span className="av2-mode"><i /> SHADOW {props.configs.some((item) => !item.kill_switch && !item.pause_new_entries) ? "ATIVO" : "PAUSADO"}<small>Mercado real · dinheiro virtual</small></span></div>
    <div className="av2-asset-grid">{(["BTC", "SOL"] as const).map((asset) => {
      const item = props.configs.find((row) => row.asset === asset);
      const assetCandles = [...props.candles.filter((row) => row.symbol === `${asset}USDC`)].reverse();
      const first = Number(assetCandles[0]?.open_price), last = Number(assetCandles.at(-1)?.close_price);
      const trend = first > 0 && assetCandles.length > 1 ? (last / first - 1) * 100 : null;
      const balance = props.balances.find((row) => row.asset === asset);
      return <button type="button" key={asset} className={`av2-asset-card ${asset.toLowerCase()}`} data-selected={selectedAsset === asset} onClick={() => { setSelectedAsset(asset); setExpandedSlot(null); setShowAll(false); }} aria-pressed={selectedAsset === asset}>
        <span className="av2-asset-heading"><b className="av2-asset-icon">{asset === "BTC" ? "₿" : "≋"}</b><strong>{asset}/USDC</strong><em>{item?.execution_mode || "SEM CONFIG."}</em></span>
        <span className="av2-asset-price">{n(item?.last_market_price, 2)} <small>USDC</small></span>
        <span className={`av2-asset-trend ${trend !== null && trend < 0 ? "av2-negative" : ""}`}>{trend === null ? "Tendência indisponível" : `${trend >= 0 ? "+" : ""}${n(trend, 2)}% · últimas ${assetCandles.length}m`}</span>
        <span className="av2-asset-balance">Saldo Binance <strong>{n(balance?.total, 8)} {asset}</strong></span>
        <Sparkline candles={assetCandles} asset={asset} />
      </button>;
    })}</div>
    <div className="av2-kpi-grid">
      <article><span>Capital operacional · {selectedAsset}</span><strong>{n(capital, 2)} USDC</strong><small>{slots.length || 25} slots · inicial {n(initial, 2)} USDC</small></article>
      <article><span>Lucro líquido do teste</span><strong className="av2-positive">{signed(realized)} USDC</strong><small>Bruto {signed(accounting.grossProfit)} · taxas {n(accounting.estimatedFees, 4)}</small></article>
      <article><span>Gains / operações</span><strong>{gains} gains · {accounting.operations} operações</strong><small>{assetCycles.filter((item) => item.status === "CYCLE_COMPLETE").length} ciclos concluídos</small></article>
      <article><span>Saúde do motor</span><strong className={healthy ? "av2-positive" : "av2-warning"}>{healthy ? "Motor OK" : "Revisar motor"}</strong><small>Última verificação {d(config?.last_engine_at)}</small></article>
    </div>
    <section className="av2-slot-panel" aria-label={`Slots ${selectedAsset}/USDC`}><header><div className="av2-section-title"><b className={`av2-asset-icon ${selectedAsset.toLowerCase()}`}>{selectedAsset === "BTC" ? "₿" : "≋"}</b><div><h2>Slots {selectedAsset}/USDC</h2><small>Gain {p(cycle?.gain_rate || config?.gain_rate)}% · spacing {p(cycle?.entry_spacing || config?.entry_spacing)}%</small></div></div><div className="av2-slot-counts"><span><strong>{open.length}</strong> abertos</span><span><strong>{armed}</strong> próxima BUY</span><span><strong>{planned}</strong> planejados</span><span><strong>{gains}</strong> gains</span></div><button type="button" className="av2-subtle-button" onClick={() => setShowAll(!showAll)}>{showAll ? "Ver menos" : "Ver todos"}</button></header>
      {missed ? <p className="av2-missed-note">{missed} nível(is) atravessado(s) antes do rearme, sem fill retroativo.</p> : null}
      <div className="av2-table-wrap"><table className="av2-slot-table"><thead><tr><th>#</th><th>Status</th><th>Entrada</th><th>Atual</th><th>TP</th><th>Gain</th><th>P&L</th><th>Gains</th><th>Próxima ação</th></tr></thead><tbody>{displayedSlots.map((slot) => { const state = status(slot); const account = accounts.find((item) => item.slot_number === slot.slot_number); const pnl = OPEN_SLOTS.includes(slot.status) ? (market - Number(slot.average_fill_price || 0)) * Number(slot.executed_quantity || 0) : null; return <tr key={slot.id} data-active={expandedSlot === slot.id}><td>{slot.slot_number}</td><td><span className={`av2-status ${state.tone}`}>{state.label}</span></td><td>{n(slot.buy_price, 2)}</td><td>{n(market, 2)}</td><td>{slot.take_profit_price ? n(slot.take_profit_price, 2) : "—"}</td><td>{p(cycle?.gain_rate || config?.gain_rate)}%</td><td className={pnl === null ? "" : pnl >= 0 ? "av2-positive" : "av2-negative"}>{pnl === null ? "—" : signed(pnl)}</td><td>{account?.gain_count ?? 0}</td><td><button type="button" className="av2-row-action" onClick={() => setExpandedSlot(expandedSlot === slot.id ? null : slot.id)} aria-expanded={expandedSlot === slot.id}>{state.action} <span aria-hidden="true">›</span></button></td></tr>; })}</tbody></table></div>
      <div className="av2-mobile-slots">{displayedSlots.map((slot) => { const state = status(slot); const account = accounts.find((item) => item.slot_number === slot.slot_number); const pnl = OPEN_SLOTS.includes(slot.status) ? (market - Number(slot.average_fill_price || 0)) * Number(slot.executed_quantity || 0) : null; return <button key={slot.id} type="button" className="av2-mobile-slot" onClick={() => setExpandedSlot(expandedSlot === slot.id ? null : slot.id)} aria-expanded={expandedSlot === slot.id}><b>{slot.slot_number}</b><span><strong className={`av2-status ${state.tone}`}>{state.label}</strong><small>Entrada {n(slot.buy_price, 2)} · TP {n(slot.take_profit_price, 2)}</small></span><span className="av2-mobile-slot-values"><strong className={pnl === null ? "" : pnl >= 0 ? "av2-positive" : "av2-negative"}>{pnl === null ? "—" : signed(pnl)}</strong><small>{account?.gain_count ?? 0} gains</small></span></button>; })}</div>
      {detail ? <div className="av2-slot-detail"><div className="av2-detail-heading"><h3>Slot físico #{detail.slot_number}</h3><button type="button" onClick={() => setExpandedSlot(null)} aria-label="Fechar detalhes do slot">Fechar ×</button></div><div className="av2-detail-grid">
        <span>Nível lógico <strong>{detail.logical_level}</strong></span><span>Operação <strong>{detail.operation_sequence}</strong></span><span>Ciclo <strong>{shortId(detail.cycle_id)}</strong></span><span>Saldo do slot <strong>{n(detailAccount?.balance_usdc, 8)} USDC</strong></span><span>Capital inicial <strong>{n(detailAccount?.initial_balance_usdc, 2)} USDC</strong></span><span>Lucro acumulado <strong>{signed(detailAccount?.net_profit_usdc)} USDC</strong></span><span>Gains <strong>{detailAccount?.gain_count ?? 0}</strong></span><span>Saldo destinado <strong>{n(detail.allocation_usdc, 8)} USDC</strong></span><span>Entrada <strong>{n(detail.buy_price, 4)} USDC</strong></span><span>Preço atual <strong>{n(market, 4)} USDC</strong></span><span>TP <strong>{n(detail.take_profit_price, 4)} USDC</strong></span><span>Distância <strong>{market > 0 ? detail.take_profit_price ? `${signed((Number(detail.take_profit_price) / market - 1) * 100)}% até TP` : `${signed((Number(detail.buy_price) / market - 1) * 100)}% até entrada` : "—"}</strong></span><span>Quantidade <strong>{n(OPEN_SLOTS.includes(detail.status) ? detail.executed_quantity : detail.requested_quantity, 8)}</strong></span><span>Notional executável <strong>{n(Number(OPEN_SLOTS.includes(detail.status) ? detail.executed_quantity : detail.requested_quantity) * Number(OPEN_SLOTS.includes(detail.status) ? detail.average_fill_price : detail.buy_price), 8)} USDC</strong></span><span>P&L aberto <strong>{OPEN_SLOTS.includes(detail.status) ? `${signed((market - Number(detail.average_fill_price || 0)) * Number(detail.executed_quantity))} USDC` : "—"}</strong></span><span>Armado em <strong>{d(detail.armed_at)}</strong></span><span>Compra em <strong>{d(detail.buy_triggered_at)}</strong></span><span>TP em <strong>{d(detail.tp_triggered_at)}</strong></span><span>BUY clientOrderId <strong>{detail.buy_client_order_id}</strong></span><span>SELL clientOrderId <strong>{detail.sell_client_order_id || "—"}</strong></span>
      </div><details><summary>Histórico deste slot ({detailHistory.length})</summary>{detailHistory.length ? detailHistory.map((item) => <p key={item.id}>Operação {shortId(item.id)} · ciclo {shortId(item.cycle_id)} · nível {item.logical_level} · saldo destinado {n(item.allocation_usdc, 8)} · BUY {n(item.entry_price, 4)} → TP {n(item.take_profit_price, 4)} · líquido {signed(item.net_quote_pnl)} USDC · {d(item.closed_at)}</p>) : <p>Nenhum gain concluído.</p>}</details><details><summary>Eventos deste slot ({detailEvents.length})</summary>{detailEvents.map((item, index) => <p key={`${item.observed_at}:${index}`}>{d(item.observed_at)} · {describeEvent(item)}</p>)}</details></div> : null}
      {!slots.length ? <p className="av2-empty">O ciclo Shadow ainda não criou slots para este ativo.</p> : null}
    </section>
    <div className="av2-bottom-grid"><section className="av2-chart-panel"><header><h2>Gráfico {selectedAsset}/USDC</h2><div className="av2-chart-options"><span>Diário · 30 dias</span></div></header><CandleChart candles={dailyCandles} asset={selectedAsset} windowSize={30} /><small>Velas diárias de mercado da Binance · somente consulta.</small></section>
      <section className="av2-events-panel"><header><h2>Últimos eventos {selectedAsset}</h2><small>{events.length} recentes</small></header>{events.length ? <ol>{events.slice(0, 6).map((event, index) => <li key={`${event.cycle_id}:${event.observed_at}:${index}`}><time>{d(event.observed_at)}</time><span>{describeEvent(event)}</span><strong>{typeof event.next_state?.netProfit === "number" ? `${signed(event.next_state.netProfit)} USDC` : ""}</strong></li>)}</ol> : <p className="av2-empty">Nenhum evento registrado neste teste.</p>}<details><summary>Ver histórico de eventos</summary>{events.slice(6).map((event, index) => <p key={`${event.observed_at}:${index}`}>{d(event.observed_at)} · {describeEvent(event)}</p>)}</details></section></div>
    <section className="av2-gains-panel"><header><h2>Histórico de ganhos</h2><strong>{gains} ganhos · {signed(realized)} USDC</strong></header>{operations.length ? <div className="av2-gain-list">{operations.slice(0, 4).map((item) => <p key={item.id}><span>Slot #{item.physical_slot_number} · {d(item.closed_at)}</span><strong>{signed(item.net_quote_pnl)} USDC</strong></p>)}</div> : <p className="av2-empty">Nenhum gain Shadow concluído neste teste.</p>}<details><summary>Ver todos os ganhos</summary>{operations.map((item) => <p key={item.id}>Operação {shortId(item.id)} · slot #{item.physical_slot_number} · ciclo {shortId(item.cycle_id)} · bruto {signed(item.gross_quote_pnl)} · taxas {n(item.estimated_quote_fees, 4)} · líquido {signed(item.net_quote_pnl)} USDC</p>)}</details></section>
    <section className="av2-connection-panel"><div><strong>{props.connectionStatus === "READ_ONLY" || props.connectionStatus === "CONNECTED" ? "Binance conectada · somente leitura" : "Binance aguardando conexão"}</strong><small>Consulta de saldos e mercado via GET. Production sem ordens, cancelamentos, transferências ou saques.</small></div><div><strong>{props.reconciliationStatus === "COMPLETED" ? "Reconciliação concluída" : "Reconciliação em acompanhamento"}</strong><small>Última sincronização {d(props.reconciliationAt || props.lastSyncedAt)} · {props.mismatches} itens para revisão · {props.intentCount} intenções Shadow</small></div><div><strong>Resultado Shadow total</strong><small>Realizado {signed(realized)} + P&L aberto {signed(openPnl)} = {signed(realized + openPnl)} USDC · capital comprometido {n(committed, 4)} / livre {n(Math.max(0, capital - committed), 4)} USDC</small></div></section>
    <details className="av2-controls"><summary>Configuração e controles <span>Gain {p(cycle?.gain_rate || config?.gain_rate)}% · spacing {p(cycle?.entry_spacing || config?.entry_spacing)}% · {active ? "Shadow ativo" : config?.kill_switch ? "Kill switch ativo" : "Entradas pausadas"}</span></summary>
      <p><strong>PERFIL DE TESTE 0,5% / 1%</strong> · Shadow {selectedAsset}/USDC · 25 slots. A estratégia oficial futura permanece separada e LIVE bloqueado.</p>
      <p>Ciclo atual: capital {n(cycle?.capital_usdc ?? config?.capital_usdc, 2)} USDC · gain {p(cycle?.gain_rate ?? config?.gain_rate)}% · queda entre compras {p(cycle?.entry_spacing ?? config?.entry_spacing)}% · iniciado {d(cycle?.started_at)}.</p>
      <form className="av2-parameters" action={saveRobotV1Parameters} key={config?.id + selectedAsset}>
        <input type="hidden" name="asset" value={selectedAsset} />
        <label>Capital do próximo ciclo (USDC)<input name="capital_usdc" type="number" min="0.01" max="2500" step="0.01" defaultValue={Number(config?.next_capital_usdc ?? config?.capital_usdc ?? 250)} required /></label>
        <label>Gain %<input name="gain_percent" type="number" min="0.1" max="20" step="0.1" defaultValue={p(config?.next_gain_rate ?? config?.gain_rate)} required /></label>
        <label>Queda entre compras %<input name="spacing_percent" type="number" min="0.1" max="20" step="0.1" defaultValue={p(config?.next_entry_spacing ?? config?.entry_spacing)} required /></label>
        <button type="submit">Salvar próximo ciclo</button><button type="submit" name="preset" value="quick" formNoValidate>Usar perfil rápido 0,5% / 1%</button>
      </form>
      <small>Gain: percentual de alta necessário para vender uma posição. Queda entre compras: distância entre entradas. O ciclo e os TPs abertos preservam seus parâmetros; alterações entram no próximo ciclo.</small>
      <div className="av2-control-actions"><form action={controlRobotV1Shadow}><input type="hidden" name="asset" value={selectedAsset} /><input type="hidden" name="command" value="start" /><button type="submit" disabled={Boolean(cycle)}>Iniciar Shadow</button></form><form action={controlRobotV1Shadow}><input type="hidden" name="asset" value={selectedAsset} /><input type="hidden" name="command" value={config?.pause_new_entries ? "resume" : "pause"} /><button type="submit">{config?.pause_new_entries ? "Retomar entradas" : "Pausar entradas"}</button></form><form action={controlRobotV1Shadow} onSubmit={confirmKill}><input type="hidden" name="asset" value={selectedAsset} /><input type="hidden" name="command" value="kill" /><button type="submit" className="av2-danger">Kill switch</button></form><form action={controlRobotV1Shadow} className="av2-restart"><input type="hidden" name="asset" value={selectedAsset} /><input type="hidden" name="command" value="restart" /><label><input type="checkbox" name="restart_confirmed" value="yes" required /> Confirmo o reinício virtual e a preservação do histórico.</label><button type="submit">Reiniciar simulação</button></form></div>
    </details>
    <section className="av2-live-panel"><h2>Piloto LIVE — bloqueado</h2><p>Preparação futura: SOL Spot/BRL, sem ativação de ordens reais. Consulta pública de {d(props.solBrlPilot.observedAt)}; revalidar antes do piloto.</p><ul><li>SOL/BRL {props.solBrlPilot.status} · LIMIT e MARKET disponíveis · tick {n(props.solBrlPilot.priceTick, 4)} BRL · step {n(props.solBrlPilot.quantityStep, 4)} SOL · minQty {n(props.solBrlPilot.minQuantity, 4)} SOL · minNotional {n(props.solBrlPilot.minNotional, 2)} BRL.</li><li>R$ 10 por slot: {props.solBrlPilot.accepted ? "aceito" : "rejeitado"} no preço observado de R$ {n(props.solBrlPilot.priceBrl, 2)} (notional executável R$ {n(props.solBrlPilot.executableNotional, 4)}). Mínimo estimado: R$ {n(props.solBrlPilot.minimumPerSlotBrl, 4)} por slot; R$ {n(props.solBrlPilot.minimumCapitalFor25SlotsBrl, 2)} para 25 slots.</li><li>Spot Testnet: {props.testnetRun ? "execução fictícia em acompanhamento" : props.testnet?.ok ? "conectado; execução fictícia ainda pendente" : props.testnet ? "diagnóstico com erro específico abaixo" : "verificação e execução fictícia pendentes"}.</li><li>Hard caps SOL/BRL: {props.configs.find((item) => item.asset === "SOL")?.configured_live_capital_brl ? "configurados, mas inativos" : "não configurados"}. Kill switch, auditoria e autorização explícita são obrigatórios.</li><li>Saldo BRL separado e par SOL/BRL conferido pelo proprietário antes de qualquer piloto futuro.</li></ul><strong>BTC LIVE OFF · Production GET/read-only</strong></section>
    <section className="av2-testnet-panel"><div><h2>Spot Testnet · {selectedAsset}/USDC</h2><p>Execução fictícia, configuração do próximo ciclo e comparação com Shadow ficam na visão Testnet.</p></div><a href="/automacao?view=testnet">Abrir Testnet BTC/SOL</a></section>
  </div>;
}
