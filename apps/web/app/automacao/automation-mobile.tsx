"use client";

import type { FormEvent } from "react";

import { controlRobotV1Shadow, saveRobotV1Parameters } from "./robot-v1-actions";

type Config = { id: string; asset: "BTC" | "SOL"; symbol: string; execution_mode: "SHADOW" | "TESTNET"; capital_usdc: number | string; next_capital_usdc: number | string | null; gain_rate: number | string; entry_spacing: number | string; next_gain_rate: number | string | null; next_entry_spacing: number | string | null; slot_count: number; kill_switch: boolean; pause_new_entries: boolean; shadow_test_started_at: string | null; shadow_test_target_end_at: string | null };
type Cycle = { id: string; config_id: string; asset: "BTC" | "SOL"; status: string; slot_notional_usdc: number | string; capital_usdc: number | string; gain_rate: number | string; entry_spacing: number | string; started_at: string };
type Slot = { id: string; cycle_id: string; slot_number: number; buy_price: number | string; buy_status: string; executed_quantity: number | string; average_fill_price: number | string | null; take_profit_price: number | string | null; take_profit_status: string; status: string; realized_quote_pnl: number | string | null };
type Balance = { asset: string; free: number; locked: number; total: number };

type Props = {
  connectionStatus?: string | null;
  lastSyncedAt?: string | null;
  balances: Balance[];
  reconciliationStatus?: string | null;
  reconciliationAt?: string | null;
  mismatches: number;
  configs: Config[];
  cycles: Cycle[];
  slots: Slot[];
  intentCount: number;
};

function number(value: number | string | null | undefined, digits = 2) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString("pt-BR", { maximumFractionDigits: digits }) : "—";
}

function date(value?: string | null) {
  return value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "Ainda não disponível";
}

function connectionLabel(value?: string | null) {
  return value === "READ_ONLY" || value === "CONNECTED" ? "Binance conectada" : value === "ERROR" ? "Conexão precisa de atenção" : "Conexão aguardando leitura";
}

function slotPresentation(slot: Slot) {
  if (slot.status === "TP_ACTIVE" || slot.status === "OPEN" || slot.status === "PARTIALLY_FILLED") return { state: "ABERTO", badge: "VENDA ATIVA", priceLabel: "Entrada Shadow", price: slot.average_fill_price, target: slot.take_profit_price };
  if (slot.status === "PENDING") return { state: "AGUARDANDO COMPRA", badge: null, priceLabel: "Compra programada", price: slot.buy_price, target: null };
  if (slot.status === "CLOSED") return { state: "FINALIZADO", badge: null, priceLabel: "Entrada Shadow", price: slot.average_fill_price || slot.buy_price, target: slot.take_profit_price };
  if (slot.status === "CANCELLED") return { state: "FINALIZADO", badge: "ENTRADA INVALIDADA", priceLabel: "Compra programada", price: slot.buy_price, target: null };
  return { state: "ERRO", badge: null, priceLabel: "Preço", price: slot.buy_price, target: null };
}
function percent(value: number | string | null | undefined) { return number(Number(value || 0) * 100, 2); }

function confirmKill(event: FormEvent<HTMLFormElement>) {
  if (!window.confirm("Ativar o kill switch pausa novas entradas deste robô Shadow. O ciclo e o histórico serão preservados. Continuar?")) event.preventDefault();
}

export function AutomationMobile(props: Props) {
  return (
    <div className="automation-mobile-page">
      <header className="automation-mobile-hero">
        <span className="automation-eyebrow">AUTOMAÇÃO</span>
        <h1>Seu robô CoinOps</h1>
        <strong>SIMULAÇÃO ATIVA</strong>
        <p>Acompanha o mercado real sem movimentar dinheiro.</p>
      </header>

      <section className="automation-connection-card" aria-label="Conexão Binance">
        <div><span className="automation-dot" aria-hidden="true" /><p><strong>{connectionLabel(props.connectionStatus)}</strong><small>Somente consultas GET. Ordens, cancelamentos, transferências e saques permanecem bloqueados.</small></p></div>
        <small>Atualizado: {date(props.lastSyncedAt)}</small>
      </section>

      <section className="automation-balance-grid" aria-label="Saldos reconciliados">
        {(["BTC", "SOL", "USDT"] as const).map((asset) => {
          const balance = props.balances.find((item) => item.asset === asset);
          return <article key={asset}><span>{asset}</span><strong>{number(balance?.total, 8)}</strong><small>Saldo lido da Binance</small></article>;
        })}
      </section>

      <section className="automation-reconciliation-card">
        <span>RECONCILIAÇÃO</span>
        <strong>{props.reconciliationStatus === "COMPLETED" ? "Sincronização concluída" : "Sincronização em acompanhamento"}</strong>
        <p>{props.mismatches ? `${props.mismatches} item(ns) para revisar, sem correção automática.` : "CoinOps e Binance foram comparados sem alterar suas operações."} {props.intentCount} intenção(ões) Shadow auditada(s).</p>
        <small>Última verificação: {date(props.reconciliationAt)}</small>
      </section>

      {(["BTC", "SOL"] as const).map((asset) => {
        const config = props.configs.find((item) => item.asset === asset);
        const cycle = config ? props.cycles.find((item) => item.config_id === config.id) : undefined;
        const slots = cycle ? props.slots.filter((item) => item.cycle_id === cycle.id) : [];
        const pending = slots.filter((item) => item.status === "PENDING").length;
        const open = slots.filter((item) => item.status === "TP_ACTIVE" || item.status === "OPEN" || item.status === "PARTIALLY_FILLED").length;
        const closed = slots.filter((item) => item.status === "CLOSED").length;
        const pnl = slots.reduce((total, item) => total + Number(item.realized_quote_pnl || 0), 0);
        const capital = Number(cycle?.capital_usdc || config?.capital_usdc || 250);
        const slotNotional = Number(cycle?.slot_notional_usdc || capital / 25);
        const isActive = Boolean(cycle) && !config?.kill_switch && !config?.pause_new_entries;
        return (
          <section className={`robot-shadow-card ${asset.toLowerCase()}`} key={asset}>
            <header><div><span>{asset}/USDC</span><h2>{config?.kill_switch ? "Kill switch ativo" : config?.pause_new_entries ? "Novas entradas pausadas" : isActive ? "Shadow ativo" : "Pronto para Shadow"}</h2></div><b>{asset === "BTC" ? "₿" : "S"}</b></header>
            <p className="robot-explainer">Simulação com mercado real. Nenhuma ordem é enviada à Binance.</p>
            <div className="robot-stat-grid"><span><small>Capital do ciclo</small><strong>{number(capital)} USDC</strong></span><span><small>Por slot</small><strong>{number(slotNotional)} USDC</strong></span><span><small>Resumo</small><strong>{open} aberto{open === 1 ? "" : "s"} · {pending} aguardando · {closed} finalizado{closed === 1 ? "" : "s"}</strong></span><span><small>Capital comprometido</small><strong>{number(open * slotNotional)} USDC</strong></span><span><small>Capital livre</small><strong>{number(Math.max(0, capital - open * slotNotional))} USDC</strong></span><span><small>Resultado líquido Shadow</small><strong>{number(pnl, 4)} USDC</strong></span><span><small>Parâmetros atuais</small><strong>{percent(cycle?.gain_rate || config?.gain_rate)}% · {percent(cycle?.entry_spacing || config?.entry_spacing)}%</strong></span></div>
            <form className="robot-capital-form robot-parameters-form" action={saveRobotV1Parameters}><input type="hidden" name="asset" value={asset} /><p>Parâmetros de teste do robô — afetam somente a simulação V1; a estratégia principal não é alterada.</p><label>Capital para {cycle ? "o próximo ciclo" : "este ciclo"}<input name="capital_usdc" type="number" min="0.01" step="0.01" defaultValue={config ? Number(config.next_capital_usdc || config.capital_usdc) : 250} required /></label><label>Gain %<input name="gain_percent" type="number" min="0.1" max="20" step="0.1" defaultValue={percent(config?.next_gain_rate || config?.gain_rate)} required /></label><label>Queda entre compras %<input name="spacing_percent" type="number" min="0.1" max="20" step="0.1" defaultValue={percent(config?.next_entry_spacing || config?.entry_spacing)} required /></label><span className="robot-fixed-slots">25 slots fixos</span><button type="submit">Salvar próximo ciclo</button></form>
            {cycle ? <p className="robot-cycle-note">Ciclo iniciado em {date(cycle.started_at)}. Capital, âncora e histórico deste ciclo estão preservados.</p> : null}
            <div className="robot-control-grid">
              <form action={controlRobotV1Shadow}><input type="hidden" name="asset" value={asset} /><input type="hidden" name="command" value="start" /><button type="submit" disabled={Boolean(cycle)}>Iniciar Shadow</button></form>
              <form action={controlRobotV1Shadow}><input type="hidden" name="asset" value={asset} /><input type="hidden" name="command" value={config?.pause_new_entries ? "resume" : "pause"} /><button type="submit">{config?.pause_new_entries ? "Retomar entradas" : "Pausar entradas"}</button></form>
              <form action={controlRobotV1Shadow} onSubmit={confirmKill}><input type="hidden" name="asset" value={asset} /><input type="hidden" name="command" value="kill" /><button type="submit" className="danger">Kill switch</button></form>
              <form action={controlRobotV1Shadow} className="robot-restart-form"><input type="hidden" name="asset" value={asset} /><input type="hidden" name="command" value="restart" /><label><input type="checkbox" name="restart_confirmed" value="yes" required /> Confirmo o reinício virtual e a preservação do histórico.</label><button type="submit">Reiniciar simulação</button></form>
            </div>
            <details className="robot-slots-details"><summary>Ver os {slots.length || 25} slots deste ciclo</summary>{slots.length ? <ol>{slots.map((slot) => { const view = slotPresentation(slot); return <li className={`robot-slot-${slot.status.toLowerCase()}`} key={slot.id}><span>#{slot.slot_number}</span><div><strong>{view.state}</strong>{view.badge ? <em>{view.badge}</em> : null}<small>{view.priceLabel}: {number(view.price, 4)}</small>{view.target !== null ? <small>Venda programada: {number(view.target, 4)} (+{percent(cycle?.gain_rate || config?.gain_rate)}%)</small> : null}<small>Valor alocado: {number(slotNotional)} USDC</small>{slot.status === "CLOSED" ? <small>Resultado líquido: {number(slot.realized_quote_pnl, 4)} USDC</small> : null}</div></li>; })}</ol> : <p>Os slots aparecerão quando o ciclo Shadow iniciar.</p>}</details>
          </section>
        );
      })}
    </div>
  );
}
