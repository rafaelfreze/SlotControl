"use client";

import { EngineScopeFields } from "./engine-scope-fields";

import { useState } from "react";

import { COINOPS_TIME_ZONE } from "@/lib/slotgain/format";
import { selectTestnetAssetData } from "@/lib/slotgain/testnet-asset-view";
import { summarizeTestnetResults, testnetDiagnosticIssue, testnetPresentationHealth } from "@/lib/slotgain/testnet-results";

import { AutomationMobile, CandleChart, type Props } from "./automation-mobile";
import { RealResults, TestnetResults } from "./automation-results";
import { AutomationOverview } from "./automation-overview";
import { EnvironmentAssetCards, EnvironmentConnectionStrip, EnvironmentDailyChart, RealEvents } from "./automation-environment-panels";
import { controlCoinOpsTestnet, reconcileCoinOpsTestnet, saveCoinOpsTestnetNextCycle, startCoinOpsTestnet } from "./testnet-actions";
import { LiveOperationalPanel, LivePreparationPanel } from "./live-preparation-panel";

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

function MetricCard({ label, value, note, tone = "slate" }: { label: string; value: string; note?: string; tone?: "green" | "purple" | "gold" | "slate" }) {
  return <article className={`ac-metric ac-metric--${tone}`}><span>{label}</span><strong>{value}</strong>{note ? <small>{note}</small> : null}</article>;
}

export function EnvironmentTabs({ view }: { view: AutomationView }) {
  const tabs: Array<{ value: AutomationView; label: string; mobile: string }> = [
    { value: "overview", label: "Visão Geral", mobile: "Geral" },
    { value: "shadow", label: "Shadow", mobile: "Shadow" },
    { value: "testnet", label: "Testnet", mobile: "Testnet" },
    { value: "live", label: "Real", mobile: "Real" }
  ];
  return <nav className="ac-tabs" aria-label="Ambientes da Automação">{tabs.map((tab) => <a key={tab.value} href={tab.value === "testnet" ? "/automacao?view=testnet&testnet=check" : `/automacao?view=${tab.value}`} aria-current={view === tab.value ? "page" : undefined} className={view === tab.value ? "is-active" : ""}><span className="ac-tab-desktop">{tab.label}</span><span className="ac-tab-mobile">{tab.mobile}</span></a>)}</nav>;
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
  const labels: Record<string, string> = { TP_TRIGGERED: "TP Shadow atingido", SLOT_TP_FILLED: "TP preenchido", BUY_TRIGGERED: "Compra Shadow executada", SLOT_REENTRY_PLANNED: "Reentrada preservada", SLOT_REENTRY_ARMED: "Reentrada armada", SHADOW_STATE_REPAIRED: "Estado Shadow reparado", BUY_REPLACED_FOR_REENTRY: "Compra substituída pela reentrada", NEXT_BUY_ARMED: "Próxima compra armada", CYCLE_STARTED: "Ciclo iniciado", CYCLE_RESTARTED: "Ciclo reiniciado", CYCLE_COMPLETED: "Ciclo concluído", SLOT_BALANCE_UPDATED: "Saldo do slot atualizado", MISSED_LEVEL_DURING_REARM: "Nível atravessado no rearme" };
  return labels[type] || type.replaceAll("_", " ");
}

function testnetEventLabel(type: string, slot: number | null) {
  const labels: Record<string, string> = { RECONCILED: "Reconciliação concluída", BUY_NEW: "Próxima BUY armada", BUY_FILLED: "BUY preenchida", SELL_NEW: "Take profit criado", SELL_FILLED: "Take profit preenchido", SLOT_TP_FILLED: "TP preenchido", SLOT_CLOSED: "Ganho creditado", SLOT_REENTRY_PLANNED: "Reentrada preservada", SLOT_REENTRY_ARMED: "Reentrada armada", BUY_REPLACED_FOR_REENTRY: "BUY substituída pela reentrada", TP_PREPARED: "Take profit preparado", NEXT_BUY_PREPARED: "Próxima BUY preparada", BUY_CANCELED: "BUY própria cancelada", OLD_NEXT_BUY_CANCELED: "BUY antiga cancelada", RESET_AFTER_LAST_TP: "Reinício após TP terminal", CYCLE_COMPLETED: "Ciclo concluído", NEW_CYCLE_STARTED: "Novo ciclo iniciado", INITIAL_REENTRY_FILLED: "Nova entrada preenchida", NEW_TP_CREATED: "Novo TP criado", NEXT_BUY_ARMED: "Nova próxima BUY armada", RESET_COMPLETED: "Reinício concluído", OWNED_BUY_REPLACED_AFTER_RESTART: "BUY substituída após recuperação", MISSED_LEVEL: "Nível atravessado" };
  return `${labels[type] || type.replaceAll("_", " ")}${slot ? ` · Slot #${slot}` : ""}`;
}

function testnetHumanState(data: Props) {
  const result = summarizeTestnetResults(data.testnetSlots, data.testnetOrders, null, null,
    { asset: data.testnetRun?.symbol.replace("USDC", ""), cycleId: data.testnetRun?.id, events: data.testnetEvents });
  return testnetPresentationHealth(result, data.testnetRun, Date.now(),
    testnetDiagnosticIssue(data.testnet, data.testnetActionError)).label;
}

export function TestnetHero({ data }: { data: Props }) {
  const connected = data.testnet?.ok;
  const error = data.testnetActionError || data.testnetRun?.last_error || (data.testnet && !data.testnet.ok ? data.testnet.error : null);
  const state = testnetHumanState(data);
  return <section className="ac-panel ac-testnet-hero"><div className="ac-testnet-brand"><span className="ac-binance-mark" aria-hidden="true">✥</span><div><span className="ac-kicker">AMBIENTE FICTÍCIO</span><h2>Binance Spot Testnet <span className="ac-badge ac-badge--purple">TESTNET {state}</span></h2><p>Fundos fictícios · isolado de Shadow e Production.</p></div></div><div className="ac-permissions"><span className={connected ? "is-ok" : ""}>USER_DATA {connected ? "✓" : "—"}</span><span className={data.testnet?.ok && data.testnet.tradePermission.ok ? "is-ok" : ""}>TRADE {data.testnet?.ok && data.testnet.tradePermission.ok ? "✓" : "—"}</span><span className={data.testnet?.ok && data.testnet.userStreamPermission.ok ? "is-ok" : ""}>USER_STREAM {data.testnet?.ok && data.testnet.userStreamPermission.ok ? "✓" : "—"}</span></div><div className="ac-hero-action"><small>Última verificação<br /><strong>{data.testnet?.ok ? time(data.testnet.observedAt) : "Ainda não disponível"}</strong></small><a className="ac-button" href="/automacao?view=testnet&testnet=check">↻ &nbsp; Verificar agora</a></div>{error ? <p className="ac-error" role="alert">{error}</p> : null}</section>;
}

export function BalanceCards({ data, asset }: { data: Props; asset?: "BTC" | "SOL" }) {
  const assets = asset ? ["USDC", asset, "USDT"] as const : ["USDC", "SOL", "BTC", "USDT"] as const;
  return <div className="ac-balance-grid">{assets.map((asset) => {
    const balance = data.testnet?.ok ? data.testnet.balances.find((item) => item.asset === asset) : null;
    const px = asset === "BTC" || asset === "SOL" ? marketPrice(data, `${asset}USDC`) : 0;
    const approx = balance && px ? Number(balance.free) * px : null;
    return <article key={asset} className="ac-balance"><span className={`ac-coin ac-coin--${asset.toLowerCase()}`}>{asset === "BTC" ? "₿" : asset === "SOL" ? "≋" : asset === "USDT" ? "₮" : "$"}</span><div><span>Disponível ({asset})</span><strong>{balance ? format(balance.free, asset === "BTC" || asset === "SOL" ? 6 : 5) : "—"}</strong><small>{approx != null ? `≈ ${format(approx, 2)} USDC estimados` : balance ? "Saldo fictício" : "Verificação pendente"}</small></div></article>;
  })}</div>;
}

export function TestnetConfiguration({ data, asset }: { data: Props; asset: "BTC" | "SOL" }) {
  const run = data.testnetRun;
  const currentCapital = run ? Number(run.slot_notional_usdc || 0) * 25 : 250;
  const gain = Number(run?.gain_rate ?? 0.005) * 100;
  const spacing = Number(run?.entry_spacing ?? 0.01) * 100;
  return <section className="ac-panel ac-testnet-config"><div className="ac-panel-heading"><div><span className="ac-kicker">PERFIL DE TESTE 0,5% / 1%</span><h2>Configuração {asset}/{data.engineContext?.quote_asset ?? "USDC"}</h2></div><span className="ac-badge ac-badge--slate">25 SLOTS</span></div>
    <div className="ac-facts"><span>Ciclo atual <strong>{run?.status === "ACTIVE" ? "Ativo" : "Não iniciado"}</strong></span><span>Capital inicial <strong>{format(currentCapital, 2)} {data.engineContext?.quote_asset ?? "USDC"}</strong></span><span>Gain <strong>{format(gain, 2)}%</strong></span><span>Queda entre compras <strong>{format(spacing, 2)}%</strong></span><span>Iniciado em <strong>{time(run?.created_at)}</strong></span></div>
    {run?.status === "ACTIVE" ? <form className="av2-parameters" action={saveCoinOpsTestnetNextCycle} key={run.id}><EngineScopeFields context={data.engineContext} /><input type="hidden" name="run_id" value={run.id} /><input type="hidden" name="asset" value={asset} /><h3>Próximo ciclo</h3><label>Capital ({data.engineContext?.quote_asset ?? "USDC"})<input type="number" name="capital_usdc" min="0.01" max="2500" step="0.01" defaultValue={Number(run.next_capital_usdc ?? currentCapital)} required /></label><label>Gain %<input type="number" name="gain_percent" min="0.1" max="20" step="0.1" defaultValue={Number(run.next_gain_rate ?? run.gain_rate ?? 0.005) * 100} required /></label><label>Queda entre compras %<input type="number" name="spacing_percent" min="0.1" max="20" step="0.1" defaultValue={Number(run.next_entry_spacing ?? run.entry_spacing ?? 0.01) * 100} required /></label><button type="submit">Salvar próximo ciclo</button><button type="submit" name="preset" value="quick" formNoValidate>Usar perfil rápido 0,5% / 1%</button></form> : null}
    <small>Gain: percentual de alta necessário para vender uma posição. Queda entre compras: distância percentual entre entradas. Alterações valem apenas no próximo ciclo; posições e TPs atuais mantêm o snapshot original. Estes controles não alteram a operação Real.</small>
  </section>;
}

export function ExecutionPanel({ data, asset = "SOL" }: { data: Props; asset?: "BTC" | "SOL" }) {
  const orders = data.testnetOrders;
  const firstBuy = orders.filter((order) => order.side === "BUY" && order.status === "FILLED").at(-1);
  const residentTp = orders.filter((order) => order.purpose === "TP" && openStatuses.has(order.status)).at(-1);
  const filledTp = orders.filter((order) => order.purpose === "TP" && order.status === "FILLED").at(-1);
  const shownTp = residentTp || filledTp;
  const armedBuy = orders.find((order) => order.side === "BUY" && order.purpose === "ENTRY" && openStatuses.has(order.status));
  const summary = summarizeTestnetResults(data.testnetSlots, data.testnetOrders, null, null, { asset, cycleId: data.testnetRun?.id, events: data.testnetEvents });
  return <section className="ac-panel ac-execution"><div className="ac-panel-heading"><div><span className="ac-kicker">SINGLE ACTIVE ENTRY</span><h2>Execução atual — {data.testnetRun?.symbol || `${asset}/{data.engineContext?.quote_asset ?? "USDC"}`}</h2></div><span className="ac-badge ac-badge--purple">{data.testnetRun?.status === "ACTIVE" ? "CICLO ATIVO" : data.testnetRun?.status || "SEM CICLO"}</span></div><div className="ac-execution-rows">
    <ExecutionStep number="1" label={firstBuy ? `BUY · Slot #${firstBuy.slot_number}` : "BUY inicial"} state={firstBuy ? "Preenchida" : "Aguardando"} detail={firstBuy ? `${format(orderQuantity(firstBuy), 6)} ${asset} @ ${format(orderPrice(firstBuy), 2)} ${data.engineContext?.quote_asset ?? "USDC"}` : "Nenhum fill registrado"} at={firstBuy?.updated_at} tone="green" />
    <ExecutionStep number="2" label={shownTp ? `TAKE PROFIT · Slot #${shownTp.slot_number}` : "Take profit"} state={residentTp ? "Residente" : filledTp ? "Concluído" : "Aguardando"} detail={shownTp ? `${format(orderQuantity(shownTp), 6)} ${asset} @ ${format(orderPrice(shownTp), 2)} ${data.engineContext?.quote_asset ?? "USDC"}` : "Sem TP registrado"} at={shownTp?.updated_at} tone={residentTp ? "purple" : filledTp ? "green" : "slate"} />
    <ExecutionStep number="3" label={armedBuy ? `BUY · Slot #${armedBuy.slot_number}` : "Próxima BUY"} state={armedBuy ? "Armada (LIMIT)" : "Aguardando"} detail={armedBuy ? `${format(orderQuantity(armedBuy), 6)} ${asset} @ ${format(orderPrice(armedBuy), 2)} ${data.engineContext?.quote_asset ?? "USDC"}` : "Nenhuma BUY residente"} at={armedBuy?.created_at} tone="blue" />
    <ExecutionStep number="4" label="Demais níveis" state="Planejados" detail={`${summary.plannedSlots} planejados · ${summary.reentryWaitingSlots} reentradas em espera · ${summary.activeErrorSlots} ocorrências ativas`} tone="slate" />
  </div><small className="ac-panel-foot">Ordens próprias CoinOps · IDs e estado da exchange na tabela.</small></section>;
}

function ExecutionStep({ number, label, state, detail, at, tone }: { number: string; label: string; state: string; detail: string; at?: string; tone: string }) {
  return <div className="ac-execution-step"><span className={`ac-step-index ac-step-index--${tone}`}>{number}</span><strong>{label}</strong><span className={`ac-step-state ac-step-state--${tone}`}>{state}</span><span>{detail}</span><time>{at ? time(at) : "—"}</time></div>;
}

export function OrdersTable({ data, asset = "SOL" }: { data: Props; asset?: "BTC" | "SOL" }) {
  const [filter, setFilter] = useState<OrderFilter>("open");
  const filtered = [...data.testnetOrders].reverse().filter((order) => filter === "all" || filter === "open" && openStatuses.has(order.status) || filter === "filled" && order.status === "FILLED" || filter === "canceled" && order.status === "CANCELED");
  const filters: Array<{ id: OrderFilter; label: string }> = [{ id: "open", label: "Abertas" }, { id: "filled", label: "Concluídas" }, { id: "canceled", label: "Canceladas" }, { id: "all", label: "Todas" }];
  return <section className="ac-panel ac-orders"><div className="ac-panel-heading"><h2>Ordens Testnet</h2><span>Somente ordens próprias do CoinOps</span></div><div className="ac-order-filters" role="group" aria-label="Filtrar ordens Testnet">{filters.map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}<small>{data.testnetOrders.filter((order) => item.id === "all" || item.id === "open" && openStatuses.has(order.status) || item.id === "filled" && order.status === "FILLED" || item.id === "canceled" && order.status === "CANCELED").length}</small></button>)}</div><div className="ac-table-scroll"><table><thead><tr><th>#</th><th>Tipo</th><th>Lado</th><th>Slot</th><th>Preço ({data.engineContext?.quote_asset ?? "USDC"})</th><th>Quantidade ({asset})</th><th>Status</th><th>Criada em</th><th>Detalhes</th></tr></thead><tbody>{filtered.map((order, index) => <tr key={order.client_order_id}><td>{index + 1}</td><td>{order.purpose === "TP" ? "LIMIT · TP" : order.purpose === "INITIAL" ? "MARKET" : "LIMIT"}</td><td className={order.side === "BUY" ? "ac-positive" : "ac-negative"}>{order.side}</td><td>#{order.slot_number}</td><td>{orderPrice(order) ? format(orderPrice(order), 4) : "Mercado"}</td><td>{format(orderQuantity(order), 6)}</td><td><span className={`ac-order-status ac-order-status--${order.status.toLowerCase()}`}>{order.status === "NEW" ? "Aberta" : order.status === "FILLED" ? "Preenchida" : order.status === "CANCELED" ? "Cancelada" : order.status === "PARTIALLY_FILLED" ? "Parcial" : order.status}</span></td><td>{time(order.created_at)}</td><td><details><summary>Ver ID</summary><span>CoinOps · revisão {order.revision}<br />clientOrderId: {order.client_order_id}<br />Binance orderId: {order.exchange_order_id || "Aguardando"}</span></details></td></tr>)}</tbody></table></div><MobileOrderCards orders={filtered} asset={asset} quote={data.engineContext?.quote_asset ?? "USDC"} />{!filtered.length ? <p className="ac-empty">Nenhuma ordem nesta categoria.</p> : null}</section>;
}

function MobileOrderCards({ orders, asset, quote }: { orders: Order[]; asset: "BTC" | "SOL"; quote: string }) {
  return <div className="ac-mobile-orders">{orders.map((order) => <article key={order.client_order_id}>
    <div><strong className={order.side === "BUY" ? "ac-positive" : "ac-negative"}>{order.side} · Slot #{order.slot_number}</strong><span className={`ac-order-status ac-order-status--${order.status.toLowerCase()}`}>{order.status === "NEW" ? "Aberta" : order.status === "FILLED" ? "Preenchida" : order.status === "CANCELED" ? "Cancelada" : order.status === "PARTIALLY_FILLED" ? "Parcial" : order.status}</span></div>
    <p>{order.purpose === "TP" ? "LIMIT · Take profit" : order.purpose === "INITIAL" ? "MARKET · Entrada inicial" : "LIMIT · Próxima compra"}</p>
    <div className="ac-mobile-order-values"><span>Preço<strong>{orderPrice(order) ? `${format(orderPrice(order), 4)} ${quote}` : "Mercado"}</strong></span><span>Quantidade<strong>{format(orderQuantity(order), 6)} {asset}</strong></span></div>
    <small>{time(order.created_at)}</small><details><summary>Identificação e ownership</summary><span>CoinOps · revisão {order.revision}<br />clientOrderId: {order.client_order_id}<br />Binance orderId: {order.exchange_order_id || "Aguardando"}</span></details>
  </article>)}</div>;
}

function TestnetEvents({ data, asset = "SOL" }: { data: Props; asset?: "BTC" | "SOL" }) {
  const relevant = data.testnetEvents.filter((event, index) => event.event_type !== "RECONCILED" || index === data.testnetEvents.findIndex((item) => item.event_type === "RECONCILED"));
  return <section className="av2-events-panel"><header><h2>Últimos eventos {asset} · Testnet</h2><small>{data.testnetEvents.length} recentes</small></header>{relevant.length ? <ol>{relevant.slice(0, 6).map((event, index) => <li key={event.observed_at + event.event_type + index}><time>{time(event.observed_at)}</time><span>{testnetEventLabel(event.event_type, event.slot_number)}</span><strong>{typeof event.details.profitUsdc === "number" ? signed(event.details.profitUsdc) + " USDC" : ""}</strong></li>)}</ol> : <p className="av2-empty">Nenhum evento recente no ledger Testnet.</p>}<details><summary>Ver histórico de eventos ({data.testnetEvents.length} recentes)</summary>{data.testnetEvents.map((event, index) => <p key={event.observed_at + event.event_type + index}>{time(event.observed_at)} · {testnetEventLabel(event.event_type, event.slot_number)}</p>)}</details></section>;
}

export function TestnetControls({ data, asset }: { data: Props; asset: "BTC" | "SOL" }) {
  const result = summarizeTestnetResults(data.testnetSlots, data.testnetOrders, null, null, { asset, cycleId: data.testnetRun?.id, events: data.testnetEvents });
  const health = testnetPresentationHealth(result, data.testnetRun, Date.now(), testnetDiagnosticIssue(data.testnet, data.testnetActionError));
  const runState = data.testnetRun?.status === "PAUSED" ? "PAUSADO" : health.label;
  const healthy = data.testnetRun?.status === "PAUSED" || health.healthy;
  return <div className="ac-environment-controls-body"><TestnetConfiguration data={data} asset={asset} /><TestnetHero data={data} /><BalanceCards data={data} asset={asset} /><div className="ac-environment-controls-grid"><OrdersTable key={asset} data={data} asset={asset} /><ExecutionPanel data={data} asset={asset} /></div><div className="ac-testnet-main ac-testnet-main--footer"><section className="ac-panel ac-actions"><div className="ac-panel-heading"><h2>Ações rápidas</h2></div><div className="ac-action-row"><a className="ac-button" href="/automacao?view=testnet&testnet=check">↻ &nbsp; Verificar Testnet</a>{data.testnetEnabled && data.testnetRun?.status === "ACTIVE" ? <form action={reconcileCoinOpsTestnet}><EngineScopeFields context={data.engineContext} /><input type="hidden" name="run_id" value={data.testnetRun.id} /><button type="submit" className="ac-button">⟳ &nbsp; Reconciliar</button></form> : null}{data.testnetEnabled && data.testnet?.ok && (!data.testnetRun || data.testnetRun.status === "COMPLETED") ? <form action={startCoinOpsTestnet}><EngineScopeFields context={data.engineContext} /><input type="hidden" name="asset" value={asset} /><button type="submit" className="ac-button">Iniciar Testnet fictício {asset}/{data.engineContext?.quote_asset ?? "USDC"}</button></form> : null}{data.testnetEnabled && data.testnetRun && ["ACTIVE", "PAUSED"].includes(data.testnetRun.status) ? <form action={controlCoinOpsTestnet}><EngineScopeFields context={data.engineContext} /><input type="hidden" name="run_id" value={data.testnetRun.id} /><input type="hidden" name="asset" value={asset} /><input type="hidden" name="command" value={data.testnetRun.status === "PAUSED" ? "resume" : "pause"} /><button type="submit" className="ac-button">{data.testnetRun.status === "PAUSED" ? "Iniciar Testnet" : "Pausar Testnet"}</button></form> : null}</div><small>A pausa consulta a Binance Testnet e cancela somente ordens próprias antes de preservar o ciclo. Ao iniciar, TPs são restaurados antes de novas entradas.</small></section><section className="ac-panel ac-health"><div className="ac-panel-heading"><h2>Saúde Testnet</h2><span className={`ac-badge ${healthy ? "ac-badge--green" : health.tone === "error" ? "av2-negative" : "av2-warning"}`}>{runState}</span></div><div className="ac-health-grid"><span>Conexão <strong>{data.testnet?.ok ? "Conectada" : "A verificar"}</strong></span><span>Reconciliação <strong>{time(data.testnetRun?.last_reconciled_at)}</strong></span><span>Ownership <strong>IDs CoinOps persistidos</strong></span><span>Históricos <strong>{result.temporalSummary.historicalCount}</strong></span><span>Missed desde versão atual <strong>{result.temporalSummary.currentVersionCount}</strong></span><span>Ocorrências ativas <strong>{result.temporalSummary.activeIssueCount}</strong></span></div><details><summary>Detalhes técnicos</summary><p>Permissão USER_STREAM: {data.testnet?.ok && data.testnet.userStreamPermission.ok ? "confirmada" : "não confirmada nesta consulta"}. O runtime serverless não mantém stream contínuo; o worker rápido reconcilia a cada minuto e o cron de 5 minutos é somente fallback, e reconciliação manual/autenticada também recupera o mesmo estado idempotente.</p><p>Erros do ciclo: {data.testnetRun?.last_error || "nenhum registrado"}. Idempotência: clientOrderId único e reset vinculado ao ciclo anterior + fill terminal.</p></details></section></div></div>;
}

function Testnet({ data: source, initialAsset }: { data: Props; initialAsset: "BTC" | "SOL" }) {
  const [selectedAsset, setSelectedAsset] = useState(initialAsset);
  const data = { ...source, ...selectTestnetAssetData(source, selectedAsset) };
  return <div className="coinops-automation ac-shadow ac-operational-layout" data-environment="TESTNET">
    <EnvironmentAssetCards data={data} environment="TESTNET" selectedAsset={selectedAsset} onSelect={setSelectedAsset} />
    <TestnetResults key={selectedAsset} data={data} asset={selectedAsset}><div className="av2-bottom-grid"><EnvironmentDailyChart data={data} environment="TESTNET" asset={selectedAsset} /><TestnetEvents data={data} asset={selectedAsset} /></div></TestnetResults>
    <EnvironmentConnectionStrip data={data} environment="TESTNET" asset={selectedAsset} />
    <details className="av2-controls ac-environment-controls"><summary>Configuração e controles <span>{selectedAsset} Testnet · ordens, execução e saldos fictícios</span></summary><TestnetControls data={data} asset={selectedAsset} /></details>
  </div>;
}

function LivePreparation({ data, asset }: { data: Props; asset: "BTC" | "SOL" }) {
  if (data.livePreparation) return <LivePreparationPanel data={data.livePreparation} asset={asset} />;
  if (data.liveAssetData?.[asset]) return <section className="ac-panel" role="status"><div className="ac-panel-heading"><h2>Configuração Real · {asset}/BRL</h2><span className="ac-badge ac-badge--slate">{data.liveAssetData[asset]?.run.status}</span></div><p>Existe um ciclo LIVE no ledger. Os detalhes de preparação e limites não foram carregados nesta consulta; essa ausência não confirma uma interrupção do executor.</p></section>;
  if (asset === "BTC") return <section className="ac-panel"><div className="ac-panel-heading"><h2>Preparação BTC · Real</h2><span className="ac-badge ac-badge--slate">LIVE BLOQUEADO</span></div><p>Nenhuma configuração de piloto BTC LIVE foi validada. Par, filtros, capital, proteções e autorização serão definidos antes de uma ativação futura.</p><p>Production permanece READ-ONLY. Não há botão de ativação ou envio de ordens reais.</p></section>;
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
  return <div className="ac-stack ac-live-preparation"><section className="ac-panel ac-live-hero"><div><span className="ac-kicker">PREPARAÇÃO FUTURA</span><h2>Operação Real <span className="ac-badge ac-badge--slate">LIVE BLOQUEADO</span></h2><p>Nenhuma ordem real pode ser enviada nesta fase. O adaptador Production aceita somente consultas.</p></div><strong>0 operações financeiras reais enviadas pelo CoinOps nesta fase</strong></section><div className="ac-live-grid"><section className="ac-panel"><div className="ac-panel-heading"><h2>Binance Production</h2><span className="ac-badge ac-badge--green">READ-ONLY</span></div><div className="ac-facts"><span>Conexão <strong>{data.connectionStatus === "READ_ONLY" || data.connectionStatus === "CONNECTED" ? "Conectada" : "A verificar"}</strong></span><span>Última sincronização <strong>{time(data.reconciliationAt || data.lastSyncedAt)}</strong></span><span>Reconciliação <strong>{data.reconciliationStatus === "COMPLETED" ? "Concluída" : "Em acompanhamento"}</strong></span><span>Ordens/trades reais CoinOps <strong>0 enviados nesta fase</strong></span></div><small>Permissões da chave Production não são alteradas por esta central. createOrder e cancelOrder seguem bloqueados no adaptador.</small></section><section className="ac-panel"><div className="ac-panel-heading"><h2>Piloto planejado · SOL/BRL</h2><span>Dados públicos observados {time(pilot.observedAt)}</span></div><div className="ac-facts"><span>Mercado <strong>{pilot.status}</strong></span><span>tickSize <strong>{format(pilot.priceTick, 4)} BRL</strong></span><span>stepSize <strong>{format(pilot.quantityStep, 4)} SOL</strong></span><span>minQty <strong>{format(pilot.minQuantity, 4)} SOL</strong></span><span>minNotional <strong>{format(pilot.minNotional, 2)} BRL</strong></span><span>Capital mínimo estimado · 25 slots <strong>R$ {format(pilot.minimumCapitalFor25SlotsBrl, 2)}</strong></span><span>Capital desejado <strong>{data.configs.find((config) => config.asset === "SOL")?.configured_live_capital_brl ? `R$ ${format(data.configs.find((config) => config.asset === "SOL")?.configured_live_capital_brl, 2)}` : "Não configurado"}</strong></span></div><small>Snapshot público, sujeito a mudança; filtros, preço e mínimo devem ser revalidados antes de qualquer piloto futuro.</small></section></div><section className="ac-panel ac-checklist"><div className="ac-panel-heading"><h2>Checklist antes de um futuro LIVE</h2><span>Sem botão de ativação</span></div><div className="ac-check-grid">{checks.map((item) => <div key={item.label}><span className={item.done ? "is-done" : ""}>{item.done ? "✓" : "○"}</span><strong>{item.label}</strong><small>{item.done ? "Verificado no snapshot" : "Pendente"}</small></div>)}</div><p>Quando os gates forem aprovados futuramente, a UX poderá orientar a separação de BRL na Binance e a conferência do par SOL/BRL. Nenhuma ação financeira é solicitada agora.</p></section></div>;
}

export function ProductionBalances({ data, asset }: { data: Props; asset: "BTC" | "SOL" }) {
  return <div className="ac-production-balances" aria-label="Saldos Production somente leitura">{["BRL", "USDT", "USDC", asset].map((currency) => {
    const reconciliationBalance = data.balances.find((item) => item.asset === currency);
    const freshBrl = currency === "BRL" && data.livePreparation?.brlFree !== null
      && data.livePreparation?.brlFree !== undefined;
    const balance = freshBrl ? { free: data.livePreparation!.brlFree!, locked: data.livePreparation!.brlLocked ?? 0,
      total: data.livePreparation!.brlFree! + (data.livePreparation!.brlLocked ?? 0) } : reconciliationBalance;
    return <MetricCard key={currency} label={"Saldo " + currency + (freshBrl ? " · GET atual" : "")}
      value={format(balance?.total, currency === "BTC" || currency === "SOL" ? 8 : 2)}
      note={"Disponível " + format(balance?.free, 8) + " · bloqueado " + format(balance?.locked, 8)} />;
  })}</div>;
}

function Live({ data, initialAsset }: { data: Props; initialAsset: "BTC" | "SOL" }) {
  const [selectedAsset, setSelectedAsset] = useState(initialAsset);
  const live = data.liveAssetData?.[selectedAsset];
  return <div className="coinops-automation ac-shadow ac-operational-layout" data-environment="REAL">
    <EnvironmentAssetCards data={data} environment="REAL" selectedAsset={selectedAsset} onSelect={setSelectedAsset} />
    {live ? <><LiveOperationalPanel key={selectedAsset} asset={selectedAsset} data={live} />
      <div className="av2-bottom-grid"><EnvironmentDailyChart data={data} environment="REAL" asset={selectedAsset} /><RealEvents data={data} asset={selectedAsset} /></div></>
      : <RealResults key={selectedAsset} data={data} asset={selectedAsset}><div className="av2-bottom-grid"><EnvironmentDailyChart data={data} environment="REAL" asset={selectedAsset} /><RealEvents data={data} asset={selectedAsset} /></div></RealResults>}
    <EnvironmentConnectionStrip data={data} environment="REAL" asset={selectedAsset} />
    <details className="av2-controls ac-environment-controls"><summary>Configuração e controles <span>{live?.run.status ?? "LIVE não iniciado"}</span></summary><div className="ac-environment-controls-body"><ProductionBalances data={data} asset={selectedAsset} /><LivePreparation data={data} asset={selectedAsset} /></div></details>
  </div>;
}

export type AutomationDetail = "all" | "orders" | "events" | "market" | "balances" | "slots" | "gains" | "controls";

export function AutomationDetails({ view, data, section, asset }: { view: AutomationView; data: Props; section: AutomationDetail; asset: "BTC" | "SOL" }) {
  const scopedData = view === "testnet" ? { ...data, ...selectTestnetAssetData(data, asset) } : data;
  let content;
  if (section === "market") content = <div className="ac-stack"><h2>{asset}/{data.engineContext?.quote_asset ?? "USDC"} · diário · 30 dias</h2><CandleChart candles={data.dailyCandles.filter((item) => item.symbol === `${asset}USDC`)} asset={asset} windowSize={30} /><small>Velas públicas da Binance. Os preços do topo usam os pares USDT da tela inicial.</small></div>;
  else if (view === "shadow") content = <AutomationMobile {...data} embedded initialAsset={asset} detailSection={section} />;
  else if (view === "testnet" && section === "orders") content = <OrdersTable data={scopedData} asset={asset} />;
  else if (view === "testnet" && section === "events") content = <TestnetEvents data={scopedData} asset={asset} />;
  else if (view === "testnet" && section === "balances") content = <BalanceCards data={scopedData} asset={asset} />;
  else if (section === "events") content = <GlobalEvents data={data} />;
  else content = view === "overview" ? <AutomationOverview data={data} /> : view === "testnet" ? <Testnet data={data} initialAsset={asset} /> : <Live data={data} initialAsset={asset} />;
  return <div className="coinops-automation ac-center ac-detail-content">{content}</div>;
}
