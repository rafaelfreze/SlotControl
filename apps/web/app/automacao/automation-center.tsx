"use client";

import Image from "next/image";
import { useState } from "react";

import { COINOPS_TIME_ZONE } from "@/lib/slotgain/format";

import { AutomationMobile, CandleChart, type Props } from "./automation-mobile";
import { reconcileCoinOpsTestnet, startCoinOpsTestnet } from "./testnet-actions";

export type AutomationView = "overview" | "shadow" | "testnet" | "live";
type Order = Props["testnetOrders"][number];
type OrderFilter = "open" | "filled" | "canceled" | "all";

const openStatuses = new Set(["PREPARED", "NEW", "PARTIALLY_FILLED"]);
const format = (value: number | string | null | undefined, digits = 2) => value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toLocaleString("pt-BR", { maximumFractionDigits: digits });
const time = (value?: string | null) => value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: COINOPS_TIME_ZONE }).format(new Date(value)) : "Ainda não disponível";
const signed = (value: number) => `${value >= 0 ? "+" : ""}${format(value, 4)}`;
const marketPrice = (data: Props, symbol: string) => Number(data.configs.find((config) => config.symbol === symbol)?.last_market_price || data.dailyCandles.filter((candle) => candle.symbol === symbol).at(-1)?.close_price || 0);
const orderQuantity = (order: Order) => Number(order.executed_quantity) || Number(order.requested_quantity) || 0;
const orderPrice = (order: Order) => Number(order.price) || (Number(order.executed_quantity) > 0 ? Number(order.cumulative_quote) / Number(order.executed_quantity) : 0);

function StatusPill({ tone, title, detail }: { tone: "green" | "purple" | "slate"; title: string; detail: string }) {
  return <span className={`ac-status ac-status--${tone}`}><span className="ac-status-dot" /><span><strong>{title}</strong><small>{detail}</small></span></span>;
}

function MetricCard({ label, value, note, tone = "slate" }: { label: string; value: string; note?: string; tone?: "green" | "purple" | "gold" | "slate" }) {
  return <article className={`ac-metric ac-metric--${tone}`}><span>{label}</span><strong>{value}</strong>{note ? <small>{note}</small> : null}</article>;
}

function EnvironmentTabs({ view }: { view: AutomationView }) {
  const tabs: Array<{ value: AutomationView; label: string; mobile: string }> = [
    { value: "overview", label: "Visão Geral", mobile: "Geral" },
    { value: "shadow", label: "Shadow", mobile: "Shadow" },
    { value: "testnet", label: "Testnet", mobile: "Testnet" },
    { value: "live", label: "Real", mobile: "Real" }
  ];
  return <nav className="ac-tabs" aria-label="Ambientes da Automação">{tabs.map((tab) => <a key={tab.value} href={tab.value === "testnet" ? "/automacao?view=testnet&testnet=check" : `/automacao?view=${tab.value}`} aria-current={view === tab.value ? "page" : undefined} className={view === tab.value ? "is-active" : ""}><span className="ac-tab-desktop">{tab.label}</span><span className="ac-tab-mobile">{tab.mobile}</span></a>)}</nav>;
}

function MarketCard({ data, asset }: { data: Props; asset: "BTC" | "SOL" }) {
  const symbol = `${asset}USDC`;
  const candles = data.dailyCandles.filter((item) => item.symbol === symbol);
  const latest = marketPrice(data, symbol);
  const previous = Number(candles.at(-2)?.close_price || 0);
  const change = latest && previous ? (latest / previous - 1) * 100 : null;
  const observedAt = data.configs.find((config) => config.symbol === symbol)?.last_market_observed_at;
  return <article className="ac-market"><div className="ac-market-title"><span className={`ac-coin ac-coin--${asset.toLowerCase()}`}>{asset === "BTC" ? "₿" : "≋"}</span><span><strong>{asset}/USDC</strong><small>Última cotação {time(observedAt)}</small></span></div><strong className="ac-market-price">{latest ? format(latest, 2) : "Sem cotação"} <small>{latest ? "USDC" : ""}</small></strong><span className={change != null && change < 0 ? "ac-negative" : "ac-positive"}>{change == null ? "Variação indisponível" : `${change >= 0 ? "+" : ""}${format(change, 2)}% · vs fechamento anterior`}</span><div className="ac-market-line"><CandleChart candles={candles} asset={asset} windowSize={14} /></div></article>;
}

function GlobalEvents({ data }: { data: Props }) {
  const testnetEvents = data.testnetEvents.filter((event, index) => event.event_type !== "RECONCILED" || index === data.testnetEvents.findIndex((item) => item.event_type === "RECONCILED"));
  const events = [
    ...data.events.slice(0, 3).map((event) => ({ id: `shadow-${event.cycle_id}-${event.observed_at}-${event.event_type}`, at: event.observed_at, source: "SHADOW", label: shadowEventLabel(event.event_type) })),
    ...testnetEvents.slice(0, 4).map((event) => ({ id: `testnet-${event.observed_at}-${event.event_type}-${event.slot_number}`, at: event.observed_at, source: "TESTNET", label: testnetEventLabel(event.event_type, event.slot_number) }))
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 7);
  return <section className="ac-panel ac-events"><div className="ac-panel-heading"><h2>Atividade recente</h2><span>Shadow e Testnet · trilhas separadas</span></div>{events.length ? <ol className="ac-timeline">{events.map((event) => <li key={event.id}><span className={`ac-source ac-source--${event.source.toLowerCase()}`}>{event.source}</span><strong>{event.label}</strong><time>{time(event.at)}</time></li>)}</ol> : <p className="ac-empty">Nenhum evento recente registrado.</p>}</section>;
}

function shadowEventLabel(type: string) {
  const labels: Record<string, string> = { TP_TRIGGERED: "TP Shadow atingido", BUY_TRIGGERED: "Compra Shadow executada", NEXT_BUY_ARMED: "Próxima compra armada", CYCLE_STARTED: "Ciclo iniciado", CYCLE_RESTARTED: "Ciclo reiniciado", CYCLE_COMPLETED: "Ciclo concluído", SLOT_BALANCE_UPDATED: "Saldo do slot atualizado", MISSED_LEVEL_DURING_REARM: "Nível atravessado no rearme" };
  return labels[type] || type.replaceAll("_", " ");
}

function testnetEventLabel(type: string, slot: number | null) {
  const labels: Record<string, string> = { RECONCILED: "Reconciliação concluída", BUY_NEW: "Próxima BUY armada", BUY_FILLED: "BUY preenchida", SELL_NEW: "Take profit criado", SELL_FILLED: "Take profit preenchido", SLOT_CLOSED: "Slot concluído e ganho creditado", TP_PREPARED: "Take profit preparado", NEXT_BUY_PREPARED: "Próxima BUY preparada", BUY_CANCELED: "BUY própria cancelada", OWNED_BUY_REPLACED_AFTER_RESTART: "BUY substituída após recuperação", MISSED_LEVEL: "Nível atravessado" };
  return `${labels[type] || type.replaceAll("_", " ")}${slot ? ` · Slot #${slot}` : ""}`;
}

function Overview({ data }: { data: Props }) {
  const shadowAccounts = data.slotAccounts.filter((account) => data.configs.some((config) => config.id === account.config_id));
  const capital = shadowAccounts.reduce((sum, account) => sum + Number(account.balance_usdc), 0);
  const gains = shadowAccounts.reduce((sum, account) => sum + account.gain_count, 0);
  const profit = shadowAccounts.reduce((sum, account) => sum + Number(account.net_profit_usdc), 0);
  const testnetOpen = data.testnetOrders.filter((order) => openStatuses.has(order.status)).length;
  const testnetFilled = data.testnetOrders.filter((order) => order.side === "BUY" && order.status === "FILLED").length;
  const missed = data.testnetSlots.filter((slot) => slot.missed_at).length;
  const shadowHealthy = data.configs.length > 0 && data.configs.every((config) => !config.last_engine_error && config.grid_status === "VALID");
  return <div className="ac-stack">
    <div className="ac-section-heading"><div><span className="ac-kicker">VISÃO GERAL</span><h2>O essencial, em um lugar.</h2><p>Estado dos três ambientes com dados operacionais atuais.</p></div></div>
    <div className="ac-environments">
      <article className="ac-environment ac-environment--shadow"><div className="ac-environment-top"><span className="ac-environment-icon">◈</span><span className="ac-badge ac-badge--green">SHADOW {data.configs.some((config) => !config.kill_switch && !config.pause_new_entries) ? "ATIVO" : "PAUSADO"}</span></div><h3>Simulação com mercado real</h3><p>BTC/USDC e SOL/USDC · nenhuma ordem enviada à Binance.</p><div className="ac-environment-stats"><span>Capital virtual <strong>{format(capital, 2)} USDC</strong></span><span>Gains <strong>{gains}</strong></span><span>Resultado líquido <strong className="ac-positive">{signed(profit)} USDC</strong></span><span>Motor <strong>{shadowHealthy ? "OK" : "Revisar"}</strong></span></div><a href="/automacao?view=shadow">Abrir Shadow <span aria-hidden="true">→</span></a></article>
      <article className="ac-environment ac-environment--testnet"><div className="ac-environment-top"><span className="ac-environment-icon">✧</span><span className="ac-badge ac-badge--purple">{data.testnetRun?.last_error ? "ATENÇÃO" : data.testnetRun?.status === "ACTIVE" ? "TESTNET OPERANDO" : "TESTNET EM ESPERA"}</span></div><h3>Binance Spot Testnet</h3><p>SOL/USDC · fundos fictícios e ordens isoladas.</p><div className="ac-environment-stats"><span>Ordens abertas <strong>{testnetOpen}</strong></span><span>BUY preenchidas <strong>{testnetFilled}</strong></span><span>Gains <strong>{data.testnetSlots.reduce((sum, slot) => sum + slot.gain_count, 0)}</strong></span><span>Missed levels <strong>{missed}</strong></span></div><small>Última reconciliação {time(data.testnetRun?.last_reconciled_at)}</small><a href="/automacao?view=testnet&testnet=check">Abrir Testnet <span aria-hidden="true">→</span></a></article>
      <article className="ac-environment ac-environment--live"><div className="ac-environment-top"><span className="ac-environment-icon">▣</span><span className="ac-badge ac-badge--slate">LIVE BLOQUEADO</span></div><h3>Operação real</h3><p>Binance Production permanece somente leitura. Nenhuma ordem real é enviada nesta fase.</p><div className="ac-environment-stats"><span>Par planejado <strong>SOL/BRL</strong></span><span>Production <strong>READ-ONLY</strong></span><span>Ordens CoinOps reais <strong>0</strong></span><span>Preparação <strong>Pendente</strong></span></div><a href="/automacao?view=live">Ver preparação <span aria-hidden="true">→</span></a></article>
    </div>
    <div className="ac-overview-lower"><section className="ac-panel"><div className="ac-panel-heading"><h2>Mercado agora</h2><span>Últimas velas diárias disponíveis</span></div><div className="ac-market-grid"><MarketCard data={data} asset="BTC" /><MarketCard data={data} asset="SOL" /></div></section><section className="ac-panel ac-summary"><div className="ac-panel-heading"><h2>Pulso operacional</h2><span>Leituras mais recentes</span></div><MetricCard label="Saúde Shadow" value={shadowHealthy ? "Motor OK" : "Atenção"} note={data.configs.map((config) => time(config.last_engine_at)).join(" · ")} tone={shadowHealthy ? "green" : "gold"} /><MetricCard label="Reconciliação Testnet" value={data.testnetRun?.last_error ? "Revisar" : data.testnetRun?.last_reconciled_at ? "Sem erro" : "Aguardando"} note={time(data.testnetRun?.last_reconciled_at)} tone="purple" /><MetricCard label="LIVE" value="Bloqueado" note="Production GET / read-only" /></section></div>
    <GlobalEvents data={data} />
  </div>;
}

function TestnetHero({ data }: { data: Props }) {
  const connected = data.testnet?.ok;
  const error = data.testnetActionError || data.testnetRun?.last_error || (data.testnet && !data.testnet.ok ? data.testnet.error : null);
  const operating = data.testnetRun?.status === "ACTIVE" && !error;
  return <section className="ac-panel ac-testnet-hero"><div className="ac-testnet-brand"><span className="ac-binance-mark" aria-hidden="true">✥</span><div><span className="ac-kicker">AMBIENTE FICTÍCIO</span><h2>Binance Spot Testnet <span className="ac-badge ac-badge--purple">{error ? "TESTNET — ERRO" : operating ? "TESTNET OPERANDO" : connected ? "TESTNET CONECTADO" : "AGUARDANDO VERIFICAÇÃO"}</span></h2><p>Ordens na infraestrutura Testnet da Binance, com fundos fictícios. Production permanece somente leitura.</p></div></div><div className="ac-permissions"><span className={connected ? "is-ok" : ""}>USER_DATA {connected ? "✓" : "—"}</span><span className={data.testnet?.ok && data.testnet.tradePermission.ok ? "is-ok" : ""}>TRADE {data.testnet?.ok && data.testnet.tradePermission.ok ? "✓" : "—"}</span><span className={data.testnet?.ok && data.testnet.userStreamPermission.ok ? "is-ok" : ""}>USER_STREAM {data.testnet?.ok && data.testnet.userStreamPermission.ok ? "✓" : "—"}</span></div><div className="ac-hero-action"><small>Última verificação<br /><strong>{data.testnet?.ok ? time(data.testnet.observedAt) : "Ainda não disponível"}</strong></small><a className="ac-button" href="/automacao?view=testnet&testnet=check">↻ &nbsp; Verificar agora</a></div>{error ? <p className="ac-error" role="alert">{error}</p> : null}</section>;
}

function BalanceCards({ data }: { data: Props }) {
  const assets = ["USDC", "SOL", "BTC", "USDT"] as const;
  return <div className="ac-balance-grid">{assets.map((asset) => {
    const balance = data.testnet?.ok ? data.testnet.balances.find((item) => item.asset === asset) : null;
    const px = asset === "BTC" || asset === "SOL" ? marketPrice(data, `${asset}USDC`) : 0;
    const approx = balance && px ? Number(balance.free) * px : null;
    return <article key={asset} className="ac-balance"><span className={`ac-coin ac-coin--${asset.toLowerCase()}`}>{asset === "BTC" ? "₿" : asset === "SOL" ? "≋" : asset === "USDT" ? "₮" : "$"}</span><div><span>Disponível Testnet ({asset})</span><strong>{balance ? format(balance.free, asset === "BTC" || asset === "SOL" ? 6 : 5) : "—"}</strong><small>{approx != null ? `≈ ${format(approx, 2)} USDC · última cotação observada` : balance ? "Saldo fictício informado pela Binance" : "Verificação pendente"}</small></div></article>;
  })}</div>;
}

function ExecutionPanel({ data }: { data: Props }) {
  const orders = data.testnetOrders;
  const firstBuy = orders.filter((order) => order.side === "BUY" && order.status === "FILLED").at(-1);
  const residentTp = orders.filter((order) => order.purpose === "TP" && openStatuses.has(order.status)).at(-1);
  const filledTp = orders.filter((order) => order.purpose === "TP" && order.status === "FILLED").at(-1);
  const shownTp = residentTp || filledTp;
  const armedBuy = orders.find((order) => order.side === "BUY" && order.purpose === "ENTRY" && openStatuses.has(order.status));
  const planned = data.testnetSlots.filter((slot) => slot.entry_state === "PLANNED").length;
  return <section className="ac-panel ac-execution"><div className="ac-panel-heading"><div><span className="ac-kicker">SINGLE ACTIVE ENTRY</span><h2>Execução atual — {data.testnetRun?.symbol || "SOL/USDC"}</h2></div><span className="ac-badge ac-badge--purple">{data.testnetRun?.status === "ACTIVE" ? "CICLO ATIVO" : data.testnetRun?.status || "SEM CICLO"}</span></div><div className="ac-execution-rows">
    <ExecutionStep number="1" label={firstBuy ? `BUY · Slot #${firstBuy.slot_number}` : "BUY inicial"} state={firstBuy ? "Preenchida" : "Aguardando"} detail={firstBuy ? `${format(orderQuantity(firstBuy), 6)} SOL @ ${format(orderPrice(firstBuy), 2)} USDC` : "Nenhum fill registrado"} at={firstBuy?.updated_at} tone="green" />
    <ExecutionStep number="2" label={shownTp ? `TAKE PROFIT · Slot #${shownTp.slot_number}` : "Take profit"} state={residentTp ? "Residente" : filledTp ? "Concluído" : "Aguardando"} detail={shownTp ? `${format(orderQuantity(shownTp), 6)} SOL @ ${format(orderPrice(shownTp), 2)} USDC` : "Sem TP registrado"} at={shownTp?.updated_at} tone={residentTp ? "purple" : filledTp ? "green" : "slate"} />
    <ExecutionStep number="3" label={armedBuy ? `BUY · Slot #${armedBuy.slot_number}` : "Próxima BUY"} state={armedBuy ? "Armada (LIMIT)" : "Aguardando"} detail={armedBuy ? `${format(orderQuantity(armedBuy), 6)} SOL @ ${format(orderPrice(armedBuy), 2)} USDC` : "Nenhuma BUY residente"} at={armedBuy?.created_at} tone="blue" />
    <ExecutionStep number="4" label="Demais níveis" state="Planejados" detail={`${planned} slot(s) sem ordem enviada`} tone="slate" />
  </div><small className="ac-panel-foot">As ordens exibidas são do ledger Testnet do CoinOps. IDs próprios e estado da exchange ficam nos detalhes da tabela.</small></section>;
}

function ExecutionStep({ number, label, state, detail, at, tone }: { number: string; label: string; state: string; detail: string; at?: string; tone: string }) {
  return <div className="ac-execution-step"><span className={`ac-step-index ac-step-index--${tone}`}>{number}</span><strong>{label}</strong><span className={`ac-step-state ac-step-state--${tone}`}>{state}</span><span>{detail}</span><time>{at ? time(at) : "—"}</time></div>;
}

function OrdersTable({ data }: { data: Props }) {
  const [filter, setFilter] = useState<OrderFilter>("open");
  const filtered = [...data.testnetOrders].reverse().filter((order) => filter === "all" || filter === "open" && openStatuses.has(order.status) || filter === "filled" && order.status === "FILLED" || filter === "canceled" && order.status === "CANCELED");
  const filters: Array<{ id: OrderFilter; label: string }> = [{ id: "open", label: "Abertas" }, { id: "filled", label: "Concluídas" }, { id: "canceled", label: "Canceladas" }, { id: "all", label: "Todas" }];
  return <section className="ac-panel ac-orders"><div className="ac-panel-heading"><h2>Ordens Testnet</h2><span>Somente ordens próprias do CoinOps</span></div><div className="ac-order-filters" role="group" aria-label="Filtrar ordens Testnet">{filters.map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}<small>{data.testnetOrders.filter((order) => item.id === "all" || item.id === "open" && openStatuses.has(order.status) || item.id === "filled" && order.status === "FILLED" || item.id === "canceled" && order.status === "CANCELED").length}</small></button>)}</div><div className="ac-table-scroll"><table><thead><tr><th>#</th><th>Tipo</th><th>Lado</th><th>Slot</th><th>Preço (USDC)</th><th>Quantidade (SOL)</th><th>Status</th><th>Criada em</th><th>Detalhes</th></tr></thead><tbody>{filtered.map((order, index) => <tr key={order.client_order_id}><td>{index + 1}</td><td>{order.purpose === "TP" ? "LIMIT · TP" : order.purpose === "INITIAL" ? "MARKET" : "LIMIT"}</td><td className={order.side === "BUY" ? "ac-positive" : "ac-negative"}>{order.side}</td><td>#{order.slot_number}</td><td>{orderPrice(order) ? format(orderPrice(order), 4) : "Mercado"}</td><td>{format(orderQuantity(order), 6)}</td><td><span className={`ac-order-status ac-order-status--${order.status.toLowerCase()}`}>{order.status === "NEW" ? "Aberta" : order.status === "FILLED" ? "Preenchida" : order.status === "CANCELED" ? "Cancelada" : order.status === "PARTIALLY_FILLED" ? "Parcial" : order.status}</span></td><td>{time(order.created_at)}</td><td><details><summary>Ver ID</summary><span>CoinOps · revisão {order.revision}<br />clientOrderId: {order.client_order_id}<br />Binance orderId: {order.exchange_order_id || "Aguardando"}</span></details></td></tr>)}</tbody></table></div><MobileOrderCards orders={filtered} />{!filtered.length ? <p className="ac-empty">Nenhuma ordem nesta categoria.</p> : null}</section>;
}

function MobileOrderCards({ orders }: { orders: Order[] }) {
  return <div className="ac-mobile-orders">{orders.map((order) => <article key={order.client_order_id}>
    <div><strong className={order.side === "BUY" ? "ac-positive" : "ac-negative"}>{order.side} · Slot #{order.slot_number}</strong><span className={`ac-order-status ac-order-status--${order.status.toLowerCase()}`}>{order.status === "NEW" ? "Aberta" : order.status === "FILLED" ? "Preenchida" : order.status === "CANCELED" ? "Cancelada" : order.status === "PARTIALLY_FILLED" ? "Parcial" : order.status}</span></div>
    <p>{order.purpose === "TP" ? "LIMIT · Take profit" : order.purpose === "INITIAL" ? "MARKET · Entrada inicial" : "LIMIT · Próxima compra"}</p>
    <div className="ac-mobile-order-values"><span>Preço<strong>{orderPrice(order) ? `${format(orderPrice(order), 4)} USDC` : "Mercado"}</strong></span><span>Quantidade<strong>{format(orderQuantity(order), 6)} SOL</strong></span></div>
    <small>{time(order.created_at)}</small><details><summary>Identificação e ownership</summary><span>CoinOps · revisão {order.revision}<br />clientOrderId: {order.client_order_id}<br />Binance orderId: {order.exchange_order_id || "Aguardando"}</span></details>
  </article>)}</div>;
}

function TestnetEvents({ data }: { data: Props }) {
  const relevant = data.testnetEvents.filter((event, index) => event.event_type !== "RECONCILED" || index === data.testnetEvents.findIndex((item) => item.event_type === "RECONCILED"));
  return <section className="ac-panel ac-events"><div className="ac-panel-heading"><h2>Últimos eventos (Testnet)</h2><span>{data.testnetEvents.length} registros</span></div>{relevant.length ? <ol className="ac-timeline">{relevant.slice(0, 8).map((event, index) => <li key={`${event.observed_at}-${event.event_type}-${index}`}><span className="ac-event-dot" /><strong>{testnetEventLabel(event.event_type, event.slot_number)}</strong><time>{time(event.observed_at)}</time></li>)}</ol> : <p className="ac-empty">O ledger ainda não tem eventos Testnet.</p>}{data.testnetEvents.length > 8 ? <details className="ac-more-events"><summary>Ver histórico completo ({data.testnetEvents.length})</summary><ol className="ac-timeline">{data.testnetEvents.map((event, index) => <li key={`${event.observed_at}-${event.event_type}-${index}`}><span className="ac-event-dot" /><strong>{testnetEventLabel(event.event_type, event.slot_number)}</strong><time>{time(event.observed_at)}</time></li>)}</ol></details> : null}</section>;
}

function Testnet({ data }: { data: Props }) {
  const open = data.testnetSlots.filter((slot) => slot.entry_state === "OPEN").length;
  const armed = data.testnetSlots.filter((slot) => slot.entry_state === "ARMED").length;
  const planned = data.testnetSlots.filter((slot) => slot.entry_state === "PLANNED").length;
  const gains = data.testnetSlots.reduce((sum, slot) => sum + slot.gain_count, 0);
  const profit = data.testnetSlots.reduce((sum, slot) => sum + Number(slot.net_profit_usdc), 0);
  const missed = data.testnetSlots.filter((slot) => slot.missed_at).length;
  const reconciliationAge = data.testnetRun?.last_reconciled_at ? Date.now() - Date.parse(data.testnetRun.last_reconciled_at) : Infinity;
  const healthy = data.testnet?.ok && !data.testnetRun?.last_error && reconciliationAge < 15 * 60_000 && data.testnet?.tradePermission.ok && data.testnet.userStreamPermission.ok;
  return <div className="ac-stack ac-testnet-view"><TestnetHero data={data} /><BalanceCards data={data} /><div className="ac-testnet-main"><section className="ac-panel ac-testnet-chart"><div className="ac-panel-heading"><div><span className="ac-kicker">MERCADO REAL · TESTNET FICTÍCIO</span><h2>SOL/USDC — diário</h2></div><span>30 dias</span></div><strong className="ac-chart-price">{marketPrice(data, "SOLUSDC") ? `${format(marketPrice(data, "SOLUSDC"), 2)} USDC` : "Cotação indisponível"}</strong><CandleChart candles={data.dailyCandles.filter((item) => item.symbol === "SOLUSDC")} asset="SOL" windowSize={30} /><small>Velas públicas da Binance. Execução e fills vêm exclusivamente do Spot Testnet.</small></section><ExecutionPanel data={data} /></div><div className="ac-testnet-main ac-testnet-main--orders"><OrdersTable data={data} /><TestnetEvents data={data} /></div><section className="ac-panel"><div className="ac-panel-heading"><h2>Resumo do ciclo</h2><span>{data.testnetRun?.symbol || "SOL/USDC"}</span></div><div className="ac-cycle-grid"><MetricCard label="Slots totais" value={String(data.testnetSlots.length || 25)} note={`${open} aberto(s) · ${armed} próxima BUY`} /><MetricCard label="Planejados" value={String(planned)} note="Sem ordem enviada" /><MetricCard label="Gains Testnet" value={String(gains)} note={`${signed(profit)} USDC líquido`} tone="green" /><MetricCard label="Missed levels" value={String(missed)} note={missed ? "Confira os eventos" : "Nenhum registrado"} tone={missed ? "gold" : "slate"} /><MetricCard label="Última reconciliação" value={data.testnetRun?.last_reconciled_at ? time(data.testnetRun.last_reconciled_at) : "Aguardando"} note={data.testnetRun?.last_error || "Sem erro registrado"} tone="purple" /></div></section><div className="ac-testnet-main ac-testnet-main--footer"><section className="ac-panel ac-actions"><div className="ac-panel-heading"><h2>Ações rápidas</h2></div><div className="ac-action-row"><a className="ac-button" href="/automacao?view=testnet&testnet=check">↻ &nbsp; Verificar Testnet</a>{data.testnetEnabled && data.testnetRun?.status === "ACTIVE" ? <form action={reconcileCoinOpsTestnet}><input type="hidden" name="run_id" value={data.testnetRun.id} /><button type="submit" className="ac-button">⟳ &nbsp; Reconciliar</button></form> : null}{data.testnetEnabled && data.testnet?.ok && !data.testnetRun ? <form action={startCoinOpsTestnet}><button type="submit" className="ac-button">Iniciar Testnet fictício</button></form> : null}<button type="button" className="ac-button ac-button--disabled" disabled title="Pausa segura ainda não implementada; ordens residentes permanecem sob reconciliação">Pausar indisponível</button></div><small>Cancel/replace é restrito a ordens próprias e controlado pelo motor. Pausa segura depende de tratamento das ordens residentes.</small></section><section className="ac-panel ac-health"><div className="ac-panel-heading"><h2>Saúde Testnet</h2><span className={`ac-badge ${healthy ? "ac-badge--green" : "ac-badge--slate"}`}>{healthy ? "Tudo OK" : "Atenção"}</span></div><div className="ac-health-grid"><span>Conexão <strong>{data.testnet?.ok ? "Conectada" : "A verificar"}</strong></span><span>Reconciliação <strong>{time(data.testnetRun?.last_reconciled_at)}</strong></span><span>Ownership <strong>IDs CoinOps persistidos</strong></span><span>Missed levels <strong>{missed}</strong></span></div><details><summary>Detalhes técnicos</summary><p>Permissão USER_STREAM: {data.testnet?.ok && data.testnet.userStreamPermission.ok ? "confirmada" : "não confirmada nesta consulta"}. Última mensagem de stream contínuo: não monitorada. O cron de reconciliação está configurado para 5 minutos; a última execução registrada está acima.</p><p>Erros do ciclo: {data.testnetRun?.last_error || "nenhum registrado"}. Idempotência: clientOrderId único e ordens próprias persistidas no ledger Testnet.</p></details></section></div></div>;
}

function Live({ data }: { data: Props }) {
  const pilot = data.solBrlPilot;
  const checks = [
    { label: "SOL/BRL disponível", done: pilot.status === "TRADING" },
    { label: "Filtros públicos validados", done: pilot.priceTick > 0 && pilot.quantityStep > 0 && pilot.minNotional > 0 },
    { label: "Testnet aprovado em ciclo completo", done: false },
    { label: "Auditoria final de execução e segurança", done: false },
    { label: "Saldo BRL separado pelo proprietário", done: false },
    { label: "Par SOL/BRL conferido na Binance", done: false },
    { label: "Hard cap e kill switch LIVE", done: false },
    { label: "Autorização explícita futura", done: false }
  ];
  return <div className="ac-stack"><section className="ac-panel ac-live-hero"><div><span className="ac-kicker">PREPARAÇÃO FUTURA</span><h2>Operação Real <span className="ac-badge ac-badge--slate">LIVE BLOQUEADO</span></h2><p>Nenhuma ordem real pode ser enviada nesta fase. O adaptador Production aceita somente consultas.</p></div><strong>0 operações financeiras reais enviadas pelo CoinOps nesta fase</strong></section><div className="ac-live-grid"><section className="ac-panel"><div className="ac-panel-heading"><h2>Binance Production</h2><span className="ac-badge ac-badge--green">READ-ONLY</span></div><div className="ac-facts"><span>Conexão <strong>{data.connectionStatus === "READ_ONLY" || data.connectionStatus === "CONNECTED" ? "Conectada" : "A verificar"}</strong></span><span>Última sincronização <strong>{time(data.reconciliationAt || data.lastSyncedAt)}</strong></span><span>Reconciliação <strong>{data.reconciliationStatus === "COMPLETED" ? "Concluída" : "Em acompanhamento"}</strong></span><span>Ordens/trades reais CoinOps <strong>0 enviados nesta fase</strong></span></div><small>Permissões da chave Production não são alteradas por esta central. createOrder e cancelOrder seguem bloqueados no adaptador.</small></section><section className="ac-panel"><div className="ac-panel-heading"><h2>Piloto planejado · SOL/BRL</h2><span>Dados públicos observados {time(pilot.observedAt)}</span></div><div className="ac-facts"><span>Mercado <strong>{pilot.status}</strong></span><span>tickSize <strong>{format(pilot.priceTick, 4)} BRL</strong></span><span>stepSize <strong>{format(pilot.quantityStep, 4)} SOL</strong></span><span>minQty <strong>{format(pilot.minQuantity, 4)} SOL</strong></span><span>minNotional <strong>{format(pilot.minNotional, 2)} BRL</strong></span><span>Capital mínimo estimado · 25 slots <strong>R$ {format(pilot.minimumCapitalFor25SlotsBrl, 2)}</strong></span><span>Capital desejado <strong>{data.configs.find((config) => config.asset === "SOL")?.configured_live_capital_brl ? `R$ ${format(data.configs.find((config) => config.asset === "SOL")?.configured_live_capital_brl, 2)}` : "Não configurado"}</strong></span></div><small>Snapshot público, sujeito a mudança; filtros, preço e mínimo devem ser revalidados antes de qualquer piloto futuro.</small></section></div><section className="ac-panel ac-checklist"><div className="ac-panel-heading"><h2>Checklist antes de um futuro LIVE</h2><span>Sem botão de ativação</span></div><div className="ac-check-grid">{checks.map((item) => <div key={item.label}><span className={item.done ? "is-done" : ""}>{item.done ? "✓" : "○"}</span><strong>{item.label}</strong><small>{item.done ? "Verificado no snapshot" : "Pendente"}</small></div>)}</div><p>Quando os gates forem aprovados futuramente, a UX poderá orientar a separação de BRL na Binance e a conferência do par SOL/BRL. Nenhuma ação financeira é solicitada agora.</p></section></div>;
}

export function AutomationCenter({ view, data }: { view: AutomationView; data: Props }) {
  const shadowActive = data.configs.some((config) => !config.kill_switch && !config.pause_new_entries);
  const testnetOperating = data.testnetRun?.status === "ACTIVE" && !data.testnetRun.last_error;
  return <div className="coinops-automation ac-center"><header className="ac-mobile-header"><Image src="/icon-96x96.png" alt="" width={34} height={34} priority /><span><strong>COINOPS</strong><small>AUTOMAÇÃO CRIPTO</small></span><a href="/mais" aria-label="Abrir menu">☰</a></header><div className="ac-intro"><div><h1>Automação — Seu robô CoinOps</h1><p>Mercado real e simulado, com execução segura em etapas.</p></div><div className="ac-global-status"><StatusPill tone="green" title={`SHADOW ${shadowActive ? "ATIVO" : "PAUSADO"}`} detail="Mercado real · sem ordens" /><StatusPill tone="purple" title={testnetOperating ? "TESTNET OPERANDO" : "TESTNET EM ESPERA"} detail="Binance Spot Testnet" /><StatusPill tone="slate" title="LIVE BLOQUEADO" detail="Preparação futura" /></div></div><EnvironmentTabs view={view} />{view === "overview" ? <Overview data={data} /> : view === "shadow" ? <AutomationMobile {...data} embedded /> : view === "testnet" ? <Testnet data={data} /> : <Live data={data} />}</div>;
}
