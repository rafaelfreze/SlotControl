"use client";

import type { FormEvent } from "react";

import { reconcileV1PhysicalSlotAccounts, summarizeV1ShadowOperations } from "@/lib/execution/robot-v1-audit";

import { controlRobotV1Shadow, saveRobotV1Parameters } from "./robot-v1-actions";

type Config = { id: string; asset: "BTC" | "SOL"; symbol: string; execution_mode: "SHADOW" | "TESTNET"; capital_usdc: number | string; next_capital_usdc: number | string | null; gain_rate: number | string; entry_spacing: number | string; next_gain_rate: number | string | null; next_entry_spacing: number | string | null; slot_count: number; kill_switch: boolean; pause_new_entries: boolean; shadow_test_started_at: string | null; shadow_test_target_end_at: string | null; last_candle_open_at: string | null; last_market_price: number | string | null; last_market_observed_at: string | null; last_engine_at: string | null; last_engine_error: string | null; grid_status: string | null; grid_error: string | null };
type Cycle = { id: string; config_id: string; asset: "BTC" | "SOL"; status: string; anchor_price: number | string; slot_notional_usdc: number | string; capital_usdc: number | string; gain_rate: number | string; entry_spacing: number | string; started_at: string; completed_at: string | null; completion_reason: string | null };
type Slot = { id: string; cycle_id: string; slot_number: number; logical_level: number; operation_sequence: number; buy_price: number | string; requested_quantity: number | string; executed_quantity: number | string; average_fill_price: number | string | null; take_profit_price: number | string | null; status: string; buy_triggered_at: string | null };
type Operation = { id: string; cycle_id: string; slot_id: string; physical_slot_number: number; logical_level: number; operation_sequence: number; entry_price: number | string; take_profit_price: number | string; gross_quote_pnl: number | string; estimated_quote_fees: number | string; net_quote_pnl: number | string; closed_at: string };
type SlotAccount = { config_id: string; slot_number: number; initial_balance_usdc: number | string; balance_usdc: number | string; gain_count: number; gross_profit_usdc: number | string; fees_usdc: number | string; net_profit_usdc: number | string; last_operation_id: string | null };
type Event = { cycle_id: string; slot_id: string | null; event_type: string; next_state: Record<string, unknown> | null; observed_at: string };
type Balance = { asset: string; free: number; locked: number; total: number };
type Props = { connectionStatus?: string | null; lastSyncedAt?: string | null; balances: Balance[]; reconciliationStatus?: string | null; reconciliationAt?: string | null; mismatches: number; configs: Config[]; cycles: Cycle[]; slots: Slot[]; operations: Operation[]; slotAccounts: SlotAccount[]; events: Event[]; intentCount: number };

const ACTIVE_CYCLES = ["STARTING", "GRID_ACTIVE", "POSITIONS_ACTIVE", "RESETTING"];
const OPEN_SLOTS = ["TP_ACTIVE", "OPEN", "PARTIALLY_FILLED"];
const n = (value: number | string | null | undefined, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toLocaleString("pt-BR", { maximumFractionDigits: digits }) : "—";
const d = (value?: string | null) => value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "Ainda não disponível";
const p = (value: number | string | null | undefined) => n(Number(value || 0) * 100, 2);
const signed = (value: number | string | null | undefined) => `${Number(value || 0) >= 0 ? "+" : ""}${n(value, 4)}`;
const shortId = (value?: string | null) => value ? value.slice(0, 8) : "—";
function connectionLabel(value?: string | null) { return value === "READ_ONLY" || value === "CONNECTED" ? "Binance conectada" : value === "ERROR" ? "Conexão precisa de atenção" : "Conexão aguardando leitura"; }
function state(slot: Slot) { if (OPEN_SLOTS.includes(slot.status)) return { label: "ABERTO", badge: "VENDA ATIVA", price: slot.average_fill_price, target: slot.take_profit_price }; if (slot.status === "PENDING") return { label: "AGUARDANDO COMPRA", badge: null, price: slot.buy_price, target: null }; return { label: "FINALIZADO", badge: slot.status === "CANCELLED" ? "ENTRADA INVALIDADA" : null, price: slot.average_fill_price || slot.buy_price, target: slot.take_profit_price }; }
function distance(current: number, target: number, up: boolean) { if (!current || !target) return "Cotação indisponível"; const percent = (up ? target / current - 1 : current / target - 1) * 100; return percent <= 0 ? up ? "TP alcançado; aguardando vela confirmada" : "Compra atingida; aguardando vela confirmada" : `Falta ${up ? "+" : "-"}${n(percent, 2)}%`; }
function eventLabel(event: Event) { const slot = typeof event.next_state?.slotNumber === "number" ? `Slot #${event.next_state.slotNumber} ` : ""; const labels: Record<string, string> = { INITIAL_POSITION_OPENED: "posição inicial aberta", BUY_TRIGGERED: "compra Shadow confirmada", TP_TRIGGERED: "TP atingido", SLOT_PROFIT_CREDITED: "lucro creditado no slot", SLOT_BALANCE_UPDATED: "saldo do slot atualizado", SLOT_RECYCLED: "slot reciclado", CYCLE_STARTED: "novo ciclo", CYCLE_COMPLETED: "ciclo concluído", CYCLE_RESTARTED: "ciclo reiniciado", INTRABAR_AMBIGUOUS: "vela ambígua", GRID_INVALID: "grade inválida" }; return `${slot}${labels[event.event_type] || event.event_type}`; }
function confirmKill(event: FormEvent<HTMLFormElement>) { if (!window.confirm("Ativar o kill switch pausa novas entradas deste robô Shadow. O ciclo e o histórico serão preservados. Continuar?")) event.preventDefault(); }

export function AutomationMobile(props: Props) {
  return <div className="automation-mobile-page">
    <header className="automation-mobile-hero"><span className="automation-eyebrow">AUTOMAÇÃO</span><h1>Seu robô CoinOps</h1><strong>SIMULAÇÃO ATIVA</strong><p>Acompanha o mercado real sem movimentar dinheiro.</p></header>
    <section className="automation-connection-card" aria-label="Conexão Binance"><div><span className="automation-dot" aria-hidden="true" /><p><strong>{connectionLabel(props.connectionStatus)}</strong><small>Somente consultas GET. Ordens, cancelamentos, transferências e saques permanecem bloqueados.</small></p></div><small>Atualizado: {d(props.lastSyncedAt)}</small></section>
    <section className="automation-balance-grid" aria-label="Saldos reconciliados">{(["BTC", "SOL", "USDT"] as const).map((asset) => { const balance = props.balances.find((item) => item.asset === asset); return <article key={asset}><span>{asset}</span><strong>{n(balance?.total, 8)}</strong><small>Saldo lido da Binance</small></article>; })}</section>
    <section className="automation-reconciliation-card"><span>RECONCILIAÇÃO</span><strong>{props.reconciliationStatus === "COMPLETED" ? "Sincronização concluída" : "Sincronização em acompanhamento"}</strong><p>{props.mismatches ? `${props.mismatches} item(ns) para revisar, sem correção automática.` : "CoinOps e Binance foram comparados sem alterar suas operações."} {props.intentCount} intenção(ões) Shadow auditada(s).</p><small>Última verificação: {d(props.reconciliationAt)}</small></section>
    {(["BTC", "SOL"] as const).map((asset) => {
      const config = props.configs.find((item) => item.asset === asset);
      const assetCycles = props.cycles.filter((item) => item.asset === asset);
      const cycle = assetCycles.find((item) => ACTIVE_CYCLES.includes(item.status));
      const slots = cycle ? props.slots.filter((item) => item.cycle_id === cycle.id) : [];
      const ordered = [...slots].sort((a, b) => a.logical_level - b.logical_level || a.slot_number - b.slot_number);
      const testCycles = new Set(assetCycles.filter((item) => !config?.shadow_test_started_at || Date.parse(item.started_at) >= Date.parse(config.shadow_test_started_at)).map((item) => item.id));
      const operations = props.operations.filter((item) => testCycles.has(item.cycle_id));
      const events = props.events.filter((item) => testCycles.has(item.cycle_id)).slice(0, 10);
      const openRows = slots.filter((item) => OPEN_SLOTS.includes(item.status));
      const pending = slots.filter((item) => item.status === "PENDING").length;
      const accounts = props.slotAccounts.filter((item) => item.config_id === config?.id);
      const initialCapital = accounts.reduce((sum, item) => sum + Number(item.initial_balance_usdc), 0);
      const operationalCapital = accounts.reduce((sum, item) => sum + Number(item.balance_usdc), 0);
      const growth = operationalCapital - initialCapital;
      const committed = openRows.reduce((sum, item) => sum + Number(item.executed_quantity) * Number(item.average_fill_price || 0), 0);
      const current = Number(config?.last_market_price || 0);
      const accounting = summarizeV1ShadowOperations(operations.map((item) => ({ grossQuotePnl: item.gross_quote_pnl, estimatedQuoteFees: item.estimated_quote_fees, netQuotePnl: item.net_quote_pnl })));
      const gains = accounts.reduce((sum, item) => sum + item.gain_count, 0);
      const realized = accounts.reduce((sum, item) => sum + Number(item.net_profit_usdc), 0);
      const openPnl = openRows.reduce((sum, item) => sum + (current - Number(item.average_fill_price || 0)) * Number(item.executed_quantity || 0), 0);
      const cyclesDone = assetCycles.filter((item) => item.status === "CYCLE_COMPLETE").length;
      const accountValid = reconcileV1PhysicalSlotAccounts(accounts, operations)
        && Math.abs(initialCapital - Number(config?.capital_usdc || 0)) < 1e-8;
      const health = config?.grid_status === "VALID" && !config.last_engine_error && accountValid ? "Motor OK" : "Atenção";
      const active = Boolean(cycle) && !config?.kill_switch && !config?.pause_new_entries;
      return <section className={`robot-shadow-card ${asset.toLowerCase()}`} key={asset}>
        <header><div><span>{asset}/USDC · SHADOW/VIRTUAL</span><h2>{config?.kill_switch ? "Kill switch ativo" : config?.pause_new_entries ? "Novas entradas pausadas" : active ? "Shadow ativo" : "Pronto para Shadow"}</h2></div><b>{asset === "BTC" ? "₿" : "S"}</b></header><p className="robot-explainer">Simulação com mercado real. Nenhuma ordem é enviada à Binance.</p>
        <div className="robot-stat-grid">
          <span><small>Saúde do motor</small><strong>{health}</strong><small>{!accountValid ? "Contabilidade dos slots requer revisão" : config?.grid_error || `Motor: ${d(config?.last_engine_at)}`}</small></span>
          <span><small>Preço atual Shadow</small><strong>{n(current, 4)} USDC</strong><small>Vela: {d(config?.last_candle_open_at)}</small></span>
          <span><small>Âncora / ciclo</small><strong>{n(cycle?.anchor_price, 4)} · {shortId(cycle?.id)}</strong><small>Início: {d(cycle?.started_at)}</small></span>
          <span><small>Capital inicial → operacional</small><strong>{n(initialCapital, 4)} → {n(operationalCapital, 4)} USDC</strong><small>Crescimento {signed(growth)} USDC · {signed(initialCapital ? growth / initialCapital * 100 : 0)}%</small></span>
          <span><small>Capital comprometido / livre</small><strong>{n(committed, 4)} / {n(Math.max(0, operationalCapital - committed), 4)} USDC</strong><small>Saldo inicial por slot: {n(Number(config?.capital_usdc || 250) / 25)} USDC</small></span>
          <span><small>Estratégia</small><strong>Gain {p(cycle?.gain_rate || config?.gain_rate)}% · spacing {p(cycle?.entry_spacing || config?.entry_spacing)}%</strong><small>{slots.length || 25} slots físicos</small></span>
          <span><small>Operação atual</small><strong>{openRows.length} aberto{openRows.length === 1 ? "" : "s"} · {pending} aguardando</strong><small>{openRows.length + pending === 25 ? "Capacidade operacional: 25/25" : "Capacidade requer atenção"}</small></span>
          <span><small>Gains / operações</small><strong>{gains} gain{gains === 1 ? "" : "s"} · {accounting.operations} operação(ões) · {cyclesDone} ciclo(s)</strong><small>Histórico preservado por slot físico</small></span>
          <span><small>Lucro realizado / P&L aberto</small><strong>{signed(realized)} / {signed(openPnl)} USDC</strong><small>Bruto {signed(accounting.grossProfit)} · taxas {n(accounting.estimatedFees, 4)}</small></span>
          <span><small>Resultado total Shadow</small><strong>{signed(realized + openPnl)} USDC</strong><small>Realizado + P&L aberto</small></span>
        </div>
        <form className="robot-capital-form robot-parameters-form" action={saveRobotV1Parameters}><input type="hidden" name="asset" value={asset} /><p>Parâmetros de teste do robô — afetam somente a simulação V1; a estratégia principal não é alterada.</p><label>Capital inicial deste teste<input name="capital_usdc" type="number" min="0.01" step="0.01" defaultValue={config ? Number(config.capital_usdc) : 250} readOnly={Boolean(config?.shadow_test_started_at)} required /></label><label>Gain %<input name="gain_percent" type="number" min="0.1" max="20" step="0.1" defaultValue={p(config?.next_gain_rate || config?.gain_rate)} required /></label><label>Queda entre compras %<input name="spacing_percent" type="number" min="0.1" max="20" step="0.1" defaultValue={p(config?.next_entry_spacing || config?.entry_spacing)} required /></label><span className="robot-fixed-slots">25 slots fixos</span><button type="submit">Salvar próximo ciclo</button></form>
        <div className="robot-control-grid"><form action={controlRobotV1Shadow}><input type="hidden" name="asset" value={asset} /><input type="hidden" name="command" value="start" /><button type="submit" disabled={Boolean(cycle)}>Iniciar Shadow</button></form><form action={controlRobotV1Shadow}><input type="hidden" name="asset" value={asset} /><input type="hidden" name="command" value={config?.pause_new_entries ? "resume" : "pause"} /><button type="submit">{config?.pause_new_entries ? "Retomar entradas" : "Pausar entradas"}</button></form><form action={controlRobotV1Shadow} onSubmit={confirmKill}><input type="hidden" name="asset" value={asset} /><input type="hidden" name="command" value="kill" /><button type="submit" className="danger">Kill switch</button></form><form action={controlRobotV1Shadow} className="robot-restart-form"><input type="hidden" name="asset" value={asset} /><input type="hidden" name="command" value="restart" /><label><input type="checkbox" name="restart_confirmed" value="yes" required /> Confirmo o reinício virtual e a preservação do histórico.</label><button type="submit">Reiniciar simulação</button></form></div>
        <details className="robot-slots-details"><summary>Ver os {slots.length || 25} slots — ordenados pelo nível lógico</summary>{ordered.length ? <ol>{ordered.map((slot) => {
          const view = state(slot);
          const account = accounts.find((item) => item.slot_number === slot.slot_number);
          const history = operations.filter((item) => item.physical_slot_number === slot.slot_number);
          const fill = Number(slot.average_fill_price || 0);
          const quantity = Number(OPEN_SLOTS.includes(slot.status) ? slot.executed_quantity : slot.requested_quantity);
          const notional = quantity * Number(OPEN_SLOTS.includes(slot.status) ? slot.average_fill_price : slot.buy_price);
          return <li className={`robot-slot-${slot.status.toLowerCase()}`} key={slot.id}><span>#{slot.slot_number}</span><div>
            <strong>{view.label}</strong>{view.badge ? <em>{view.badge}</em> : null}
            <small>Slot físico #{slot.slot_number} · nível lógico {slot.logical_level} · operação {slot.operation_sequence}</small>
            <small>Gains: {account?.gain_count ?? 0} · operações concluídas: {account?.gain_count ?? 0}</small>
            <small>Saldo atual do slot: {n(account?.balance_usdc, 8)} USDC · inicial: {n(account?.initial_balance_usdc, 2)} USDC</small>
            <small>Lucro acumulado: {signed(account?.net_profit_usdc)} USDC · bruto {signed(account?.gross_profit_usdc)} · taxas {n(account?.fees_usdc, 4)}</small>
            <small>{slot.status === "PENDING" ? "Compra programada" : "Entrada Shadow"}: {n(view.price, 4)} USDC</small>
            {view.target !== null ? <small>TP: {n(view.target, 4)} USDC · {distance(current, Number(view.target), true)}</small> : <small>{distance(current, Number(slot.buy_price), false)}</small>}
            <small>Quantidade virtual: {n(quantity, 8)} · notional {slot.status === "PENDING" ? "da próxima compra" : "da posição"}: {n(notional, 8)} USDC</small>
            {OPEN_SLOTS.includes(slot.status) ? <small>P&L aberto: {signed((current - fill) * Number(slot.executed_quantity || 0))} USDC · aberto em {d(slot.buy_triggered_at)}</small> : null}
            {history.length ? <details className="robot-operation-history"><summary>Histórico do slot físico</summary>{history.map((item) => <small key={item.id}>Ciclo {shortId(item.cycle_id)} · nível {item.logical_level} · BUY {n(item.entry_price, 4)} · TP {n(item.take_profit_price, 4)} · líquido {signed(item.net_quote_pnl)} USDC · {d(item.closed_at)}</small>)}</details> : null}
          </div></li>;
        })}</ol> : <p>Os slots aparecerão quando o ciclo Shadow iniciar.</p>}</details>
        <details className="robot-events-details"><summary>Últimos eventos Shadow</summary>{events.length ? <ol>{events.map((event, index) => <li key={`${event.cycle_id}:${event.observed_at}:${index}`}><strong>{d(event.observed_at)}</strong><span>{eventLabel(event)}</span></li>)}</ol> : <p>Ainda não há eventos neste teste.</p>}</details>
        <details className="robot-events-details"><summary>Histórico de ganhos Shadow</summary>{operations.length ? <ol>{operations.map((item) => <li key={item.id}><strong>Slot físico #{item.physical_slot_number} · ciclo {shortId(item.cycle_id)} · nível {item.logical_level} · operação {item.operation_sequence}</strong><span>BUY {n(item.entry_price, 4)} → TP {n(item.take_profit_price, 4)} · bruto {signed(item.gross_quote_pnl)} · taxas {n(item.estimated_quote_fees, 4)} · líquido {signed(item.net_quote_pnl)} USDC · TP em {d(item.closed_at)}</span></li>)}</ol> : <p>Nenhum gain Shadow concluído neste teste.</p>}</details>
      </section>;
    })}
  </div>;
}
