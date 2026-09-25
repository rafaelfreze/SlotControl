import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getSupabaseDataSchema } from "@/lib/supabase/env";
import { monthlyPeriodKey } from "@/lib/execution/monthly-slot-policy";
import { ViewerSignOut } from "./sign-out";
import { ViewerLiveBalances } from "./live-balances";
import { ViewerGainSimulator } from "./gain-simulator";
import "./viewer.css";
import "./viewer-redesign.css";

export const metadata: Metadata = { title: "Meu CoinOps" };
export const dynamic = "force-dynamic";
const amount = (value: number | null, currency: string) => value === null ? "—"
  : currency === "BRL" ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value)
    : `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(value)} ${currency}`;
const number = (value: number | null, digits = 2) => value === null ? "—"
  : new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits }).format(value);
const asNumber = (value: unknown) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };

async function publicMarket(symbol: string) {
  if (!/^(BTC|SOL)(BRL|USDT|USDC)$/.test(symbol)) return { price: null, change: null, trend: [] as number[] };
  try {
    const [tickerResponse, candleResponse] = await Promise.all([
      fetch(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${symbol}`,
        { next: { revalidate: 60 }, signal: AbortSignal.timeout(4_000) }),
      fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1h&limit=24`,
        { next: { revalidate: 300 }, signal: AbortSignal.timeout(4_000) }),
    ]);
    const ticker = tickerResponse.ok ? await tickerResponse.json() : null;
    const candles = candleResponse.ok ? await candleResponse.json() : null;
    const price = asNumber(ticker?.lastPrice);
    const change = Number(ticker?.priceChangePercent);
    return { price: price > 0 ? price : null, change: Number.isFinite(change) ? change : null,
      trend: Array.isArray(candles) ? candles.map((row) => asNumber(row?.[4])).filter((value) => value > 0) : [] as number[] };
  } catch { return { price: null, change: null, trend: [] as number[] }; }
}

export default async function MeuCoinOps() {
  if (getSupabaseDataSchema() !== "coinops") throw new Error("COINOPS_VIEWER_SCHEMA_DENIED");
  const auth = createClient();
  const user = (await auth.auth.getUser()).data.user;
  if (!user) redirect("/login?redirectTo=/meu-coinops");
  if (user.app_metadata?.coinops_role !== "VIEWER") redirect("/automacao");
  const service = createServiceRoleClient();
  const binding = await service.from("viewer_access")
    .select("operator_id,exchange_account_id,display_name,status")
    .eq("user_id", user.id).maybeSingle();
  if (binding.error || !binding.data || binding.data.status !== "ACTIVE") redirect("/acesso-suspenso");
  const { operator_id: operatorId, exchange_account_id: accountId, display_name: name } = binding.data;
  const [account, engines, credential] = await Promise.all([
    service.from("exchange_accounts").select("display_name,status")
      .eq("id", accountId).eq("operator_id", operatorId).single(),
    service.from("trading_engines").select("id,symbol,base_asset,quote_asset,status,kill_switch,hard_cap_quote")
      .eq("operator_id", operatorId).eq("exchange_account_id", accountId).eq("environment", "REAL").order("symbol"),
    service.from("account_onboarding_checks").select("evidence,checked_at,status")
      .eq("operator_id", operatorId).eq("exchange_account_id", accountId)
      .eq("check_key", "BINANCE_CREDENTIAL").order("checked_at", { ascending: false }).limit(1),
  ]);
  if (account.error || !account.data || engines.error || credential.error) throw new Error("COINOPS_VIEWER_DATA_UNAVAILABLE");
  const month = monthlyPeriodKey(new Date());
  const marketRows = await Promise.all((engines.data ?? []).map(async (engine) => {
    const scoped = <T extends string>(table: string, columns: T) => service.from(table).select(columns)
      .eq("operator_id", operatorId).eq("exchange_account_id", accountId).eq("trading_engine_id", engine.id);
    const [run, accounts, gains, marketData] = await Promise.all([
      scoped("robot_v1_live_runs", "id,status,last_reconciled_at,last_error,gain_rate")
        .in("status", ["PREPARING", "ACTIVE", "PAUSED"]).maybeSingle(),
      scoped("robot_v1_live_slot_accounts", "slot_number,balance_quote,market_pnl_quote,gain_count").order("slot_number"),
      scoped("robot_v1_slot_gain_totals", "slot_number,period_key,monthly_gain_count,lifetime_gain_count")
        .eq("period_key", month),
      publicMarket(engine.symbol),
    ]);
    if (run.error || accounts.error || gains.error) throw new Error("COINOPS_VIEWER_LEDGER_UNAVAILABLE");
    const [slots, orders, alerts, history] = run.data ? await Promise.all([
      scoped("robot_v1_live_slots", "slot_number,operation_sequence,position_quantity,position_committed_quote,target_buy_price")
        .eq("run_id", run.data.id).order("slot_number"),
      scoped("robot_v1_live_orders", "slot_number,operation_sequence,side,purpose,status,price,executed_quantity,cumulative_quote,created_at")
        .eq("run_id", run.data.id),
      scoped("robot_v1_live_alerts", "severity").is("resolved_at", null).limit(1),
      scoped("robot_v1_live_events", "event_type,slot_number,observed_at,details")
        .eq("event_type", "SLOT_PROFIT_CREDITED").order("observed_at", { ascending: false }).limit(100),
    ]) : [null, null, null, null];
    if (slots?.error || orders?.error || alerts?.error || history?.error) throw new Error("COINOPS_VIEWER_LEDGER_UNAVAILABLE");
    const orderRows = orders?.data ?? [];
    const gainMap = new Map((gains.data ?? []).map((row) => [row.slot_number, row]));
    const accountMap = new Map((accounts.data ?? []).map((row) => [row.slot_number, row]));
    const positions = new Map((slots?.data ?? []).map((row) => [row.slot_number, row]));
    const slotRows = [...accountMap.values()].map((slot) => {
      const position = positions.get(slot.slot_number);
      const quantity = asNumber(position?.position_quantity);
      const currentOrders = orderRows.filter((order) => order.slot_number === slot.slot_number
        && order.operation_sequence === position?.operation_sequence);
      const buys = currentOrders.filter((order) => order.side === "BUY" && order.status === "FILLED")
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      const lastBuy = buys.at(-1);
      const entry = lastBuy && asNumber(lastBuy.executed_quantity) > 0
        ? asNumber(lastBuy.cumulative_quote) / asNumber(lastBuy.executed_quantity) : null;
      const tp = currentOrders.find((order) => order.side === "SELL" && order.status === "NEW");
      const next = currentOrders.find((order) => order.side === "BUY" && order.status === "NEW");
      return { slot: slot.slot_number, balance: asNumber(slot.balance_quote),
        committed: asNumber(position?.position_committed_quote), gains: slot.gain_count,
        monthly: gainMap.get(slot.slot_number)?.monthly_gain_count ?? 0,
        open: quantity > 0, quantity, entry, tp: tp ? asNumber(tp.price) : null,
        nextBuy: next ? asNumber(next.price) : null,
        openPnl: quantity > 0 && marketData.price !== null && entry !== null ? (marketData.price - entry) * quantity : null,
        realized: asNumber(slot.market_pnl_quote) };
    });
    const historyRows = [...(history?.data ?? [])].reverse().map((event) => ({ at: event.observed_at,
      slot: event.slot_number, result: asNumber(event.details?.net_pnl_quote ?? event.details?.net_pnl_brl) }));
    return { symbol: engine.symbol, currency: engine.quote_asset, status: engine.status,
      healthy: engine.status === "ACTIVE" && !engine.kill_switch && run.data?.status === "ACTIVE"
        && !run.data.last_error && !(alerts?.data?.length)
        && !!run.data.last_reconciled_at
        && Date.now() - Date.parse(run.data.last_reconciled_at) < 15 * 60_000,
      updatedAt: run.data?.last_reconciled_at ?? null, price: marketData.price, change: marketData.change,
      trend: marketData.trend, gainRate: asNumber(run.data?.gain_rate), cap: asNumber(engine.hard_cap_quote),
      slots: slotRows, openCount: slotRows.filter((slot) => slot.open).length,
      realized: slotRows.reduce((sum, slot) => sum + slot.realized, 0),
      openPnl: slotRows.reduce((sum, slot) => sum + (slot.openPnl ?? 0), 0),
      operationalBalance: slotRows.reduce((sum, slot) => sum + slot.balance, 0), history: historyRows };
  }));
  const currencies = [...new Set(marketRows.map((row) => row.currency))];
  const balanceEvidence = credential.data?.[0];
  const observedBalances: Array<{ asset: string; free: number; locked: number }> = balanceEvidence?.status === "PASS" && Array.isArray(balanceEvidence.evidence?.balances)
    ? balanceEvidence.evidence.balances.filter((item: unknown): item is { asset: string; free: number; locked: number } =>
      !!item && typeof item === "object" && typeof (item as { asset?: unknown }).asset === "string"
        && typeof (item as { free?: unknown }).free === "number" && typeof (item as { locked?: unknown }).locked === "number") : [];
  const allHealthy = marketRows.length > 0 && marketRows.every((row) => row.healthy);
  const latest = marketRows.map((row) => row.updatedAt).filter((value): value is string => !!value).sort().at(0);
  const firstName = String(name || account.data.display_name).trim().split(/\s+/)[0];
  const currencySummaries = currencies.map((currency) => {
    const group = marketRows.filter((row) => row.currency === currency);
    return { currency, capital: group.reduce((sum, row) => sum + row.operationalBalance, 0),
      committed: group.reduce((sum, row) => sum + row.slots.reduce((total, slot) => total + slot.committed, 0), 0),
      realized: group.reduce((sum, row) => sum + row.realized, 0),
      openPnl: group.reduce((sum, row) => sum + row.openPnl, 0) };
  });
  return <main className="viewer-app">
    <div className="viewer-shell"><header className="viewer-header"><div className="viewer-brand"><span className="viewer-mark" aria-hidden="true"><i /></span><span><strong>CoinOps</strong><small>Meu CoinOps · {account.data.display_name}</small></span></div><div className="viewer-account"><span className="viewer-initial" aria-hidden="true">{firstName.charAt(0).toUpperCase()}</span><span>{account.data.display_name}</span><ViewerSignOut /></div></header>
    <section className="viewer-hero"><div><h1>Bom dia, {firstName}!</h1><p>{allHealthy ? "Seu robô está operando normalmente." : "Confira o estado da sua operação abaixo."}</p></div>
      <div className="viewer-health-group"><span className={allHealthy ? "viewer-health is-ok" : "viewer-health"}>{allHealthy ? "● OPERANDO" : "● ATENÇÃO"}</span><small>Atualizado {latest ? new Date(latest).toLocaleString("pt-BR") : "sem reconciliação confirmada"}</small></div></section>
    <ViewerLiveBalances fallback={{ balances: observedBalances.map((row) => ({ ...row, total: row.free + row.locked })),
      observedAt: balanceEvidence?.checked_at ?? null }} summaries={currencySummaries} />
    {!currencies.length ? <section className="viewer-panel viewer-empty"><h2>Conta em preparação</h2><p>Nenhum mercado Real ativado para esta conta.</p></section> : null}
    <section className="viewer-market-grid">{marketRows.map((market) => {
      const trend = market.trend;
      const min = Math.min(...trend), max = Math.max(...trend), spread = max - min || 1;
      const coords = trend.map((value, index) => `${index * 100 / Math.max(1, trend.length - 1)},${44 - (value - min) / spread * 36}`).join(" ");
      const base = market.symbol.replace(market.currency, "");
      return <article className={`viewer-panel viewer-market viewer-market--${base.toLowerCase()}`} key={market.symbol}><div className="viewer-section-title"><div className="viewer-market-name"><span className="viewer-coin" aria-hidden="true">{base === "BTC" ? "₿" : "◎"}</span><h2>{base}/{market.currency}</h2></div><span className={market.healthy ? "viewer-ok" : "viewer-warn"}>{market.healthy ? "OPERANDO" : "ATENÇÃO"}</span></div>
        <div className="viewer-market-price"><strong>{number(market.price)}</strong><span>{market.currency}</span>{market.change !== null ? <small className={market.change >= 0 ? "viewer-up" : "viewer-down"}>{market.change >= 0 ? "▲" : "▼"} {number(Math.abs(market.change))}% (24h)</small> : null}</div>
        {trend.length > 1 ? <svg className="viewer-chart" viewBox="0 0 100 48" preserveAspectRatio="none" role="img" aria-label={`Preço nas últimas 24 horas de ${market.symbol}`}><polyline points={coords} /></svg> : <div className="viewer-chart viewer-chart-empty">Histórico de preços indisponível</div>}
        <div className="viewer-market-summary"><div><small>Posições</small><strong>{market.openCount} / {market.slots.length}</strong></div><div><small>Gains</small><strong>{market.slots.reduce((sum, slot) => sum + slot.gains, 0)}</strong></div><div><small>P&amp;L aberto estimado</small><strong className={market.openPnl >= 0 ? "viewer-up" : "viewer-down"}>{amount(market.price === null ? null : market.openPnl, market.currency)}</strong></div></div>
        <details className="viewer-details"><summary>Ver detalhes →</summary><div className="viewer-slots"><p className="viewer-footnote">{market.slots.length} slots · {market.openCount} posição(ões) aberta(s)</p>{market.slots.map((slot) => <div key={slot.slot} className="viewer-slot">
          <strong>Slot #{slot.slot}<span>{slot.open ? "ABERTO" : slot.nextBuy ? "PRÓXIMA COMPRA" : "EM ESPERA"}</span></strong>
          <small>Saldo {amount(slot.balance, market.currency)} · {slot.gains} gains · {slot.monthly} no mês</small>
          {slot.open ? <small>Quantidade {number(slot.quantity, 8)} · Entrada {amount(slot.entry, market.currency)} · TP {amount(slot.tp, market.currency)}</small> : null}
          {slot.nextBuy ? <small>Próxima compra {amount(slot.nextBuy, market.currency)}</small> : null}
        </div>)}</div></details>
        <details className="viewer-details"><summary>Histórico de ganhos</summary><div className="viewer-slots">{market.history.slice(-20).reverse().map((item, index) => <div className="viewer-slot" key={`${item.at}-${index}`}><strong>Slot #{item.slot} · {amount(item.result, market.currency)}</strong><small>{new Date(item.at).toLocaleString("pt-BR")}</small></div>)}{!market.history.length ? <p>Sem gain realizado neste período.</p> : null}</div></details>
      </article>;
    })}</section>
    <ViewerGainSimulator markets={marketRows.map((row) => ({ symbol: row.symbol, currency: row.currency,
      capital: row.operationalBalance, gainRate: row.gainRate, slotCount: row.slots.length }))} />
    <footer>Dados da sua conta no ledger CoinOps. Preços públicos são referências e podem diferir da execução. Última reconciliação {latest ? new Date(latest).toLocaleString("pt-BR") : "indisponível"}.</footer></div>
  </main>;
}
