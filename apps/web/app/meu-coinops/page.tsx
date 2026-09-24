import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getSupabaseDataSchema } from "@/lib/supabase/env";
import { monthlyPeriodKey } from "@/lib/execution/monthly-slot-policy";
import { ViewerSignOut } from "./sign-out";
import { ViewerLiveBalances } from "./live-balances";
import "./viewer.css";

export const metadata: Metadata = { title: "Meu CoinOps" };
export const dynamic = "force-dynamic";
const amount = (value: number | null, currency: string) => value === null ? "—"
  : currency === "BRL" ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value)
    : `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(value)} ${currency}`;
const number = (value: number | null, digits = 2) => value === null ? "—"
  : new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits }).format(value);
const asNumber = (value: unknown) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };

async function publicPrice(symbol: string) {
  if (!/^(BTC|SOL)(BRL|USDT|USDC)$/.test(symbol)) return null;
  try {
    const response = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`,
      { next: { revalidate: 300 }, signal: AbortSignal.timeout(4_000) });
    if (!response.ok) return null;
    const value = asNumber((await response.json()).price);
    return value > 0 ? value : null;
  } catch { return null; }
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
    const [run, accounts, gains, price] = await Promise.all([
      scoped("robot_v1_live_runs", "id,status,last_reconciled_at,last_error")
        .in("status", ["PREPARING", "ACTIVE", "PAUSED"]).maybeSingle(),
      scoped("robot_v1_live_slot_accounts", "slot_number,balance_quote,market_pnl_quote,gain_count").order("slot_number"),
      scoped("robot_v1_slot_gain_totals", "slot_number,period_key,monthly_gain_count,lifetime_gain_count")
        .eq("period_key", month),
      publicPrice(engine.symbol),
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
        openPnl: quantity > 0 && price !== null && entry !== null ? (price - entry) * quantity : null,
        realized: asNumber(slot.market_pnl_quote) };
    });
    const historyRows = [...(history?.data ?? [])].reverse().map((event) => ({ at: event.observed_at,
      slot: event.slot_number, result: asNumber(event.details?.net_pnl_quote ?? event.details?.net_pnl_brl) }));
    return { symbol: engine.symbol, currency: engine.quote_asset, status: engine.status,
      healthy: engine.status === "ACTIVE" && !engine.kill_switch && run.data?.status === "ACTIVE"
        && !run.data.last_error && !(alerts?.data?.length)
        && !!run.data.last_reconciled_at
        && Date.now() - Date.parse(run.data.last_reconciled_at) < 15 * 60_000,
      updatedAt: run.data?.last_reconciled_at ?? null, price, cap: asNumber(engine.hard_cap_quote),
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
  return <main className="viewer-app">
    <header className="viewer-header"><div><span className="viewer-mark">◉</span><span><strong>CoinOps</strong><small>Meu CoinOps · {account.data.display_name}</small></span></div><ViewerSignOut /></header>
    <section className="viewer-hero"><div><small>Bem-vindo(a), {name}</small><h1>Seu resultado, com clareza.</h1><p>Seu robô e seus investimentos em uma única visão, somente leitura.</p></div>
      <span className={allHealthy ? "viewer-health is-ok" : "viewer-health"}>{allHealthy ? "● Operando normalmente" : "● Atenção · confira a atualização"}</span></section>
    <ViewerLiveBalances fallback={{ balances: observedBalances.map((row) => ({ ...row, total: row.free + row.locked })),
      observedAt: balanceEvidence?.checked_at ?? null }} />
    <section className="viewer-grid" aria-label="Resultados por moeda">{currencies.map((currency) => {
      const group = marketRows.filter((row) => row.currency === currency);
      const capital = group.reduce((sum, row) => sum + row.operationalBalance, 0);
      const realized = group.reduce((sum, row) => sum + row.realized, 0);
      const openPnl = group.reduce((sum, row) => sum + row.openPnl, 0);
      return <article className="viewer-panel" key={currency}><div className="viewer-section-title"><h2>{currency} · capital operacional</h2><span>CoinOps</span></div>
        <strong className="viewer-big">{amount(capital, currency)}</strong>
        <div className="viewer-facts"><div><small>Em posições</small><b>{amount(group.reduce((sum, row) => sum + row.slots.reduce((n, slot) => n + slot.committed, 0), 0), currency)}</b></div>
          <div><small>Resultado realizado</small><b>{amount(realized, currency)}</b></div>
          <div><small>Resultado aberto estimado</small><b>{amount(openPnl, currency)}</b></div>
          <div><small>Resultado total estimado</small><b>{amount(realized + openPnl, currency)}</b></div></div>
        <p className="viewer-footnote">Capital operacional do ledger CoinOps. Saldo livre e bloqueado na Binance aparecem na leitura separada acima.</p>
      </article>;
    })}{!currencies.length ? <article className="viewer-panel"><h2>Conta em preparação</h2><p>Nenhum mercado Real ativado para esta conta.</p></article> : null}</section>
    <section className="viewer-market-grid">{marketRows.map((market) => {
      const points = market.history.reduce<Array<{ at: string; total: number }>>((rows, item) => {
        rows.push({ at: item.at, total: (rows.at(-1)?.total ?? 0) + item.result }); return rows;
      }, []);
      const totals = [0, ...points.map((point) => point.total)];
      const min = Math.min(...totals), max = Math.max(...totals), spread = max - min || 1;
      const coords = totals.map((value, index) => `${index * 100 / Math.max(1, totals.length - 1)},${42 - (value - min) / spread * 34}`).join(" ");
      return <article className="viewer-panel" key={market.symbol}><div className="viewer-section-title"><h2>{market.symbol.replace(market.currency, `/${market.currency}`)}</h2><span className={market.healthy ? "viewer-ok" : "viewer-warn"}>{market.healthy ? "OPERANDO" : "ATENÇÃO"}</span></div>
        <div className="viewer-market-summary"><div><small>Preço de referência</small><strong>{amount(market.price, market.currency)}</strong></div><div><small>Slots</small><strong>{market.slots.length}</strong></div><div><small>Posições abertas</small><strong>{market.openCount}</strong></div><div><small>Gains totais</small><strong>{market.slots.reduce((sum, slot) => sum + slot.gains, 0)}</strong></div></div>
        <svg className="viewer-chart" viewBox="0 0 100 48" preserveAspectRatio="none" role="img" aria-label={`Evolução do resultado realizado de ${market.symbol}`}><polyline points={coords} /></svg>
        <small className="viewer-footnote">Evolução do resultado realizado · {points.length} fechamento(s) · atualizado {market.updatedAt ? new Date(market.updatedAt).toLocaleString("pt-BR") : "não informado"}</small>
        <details className="viewer-details"><summary>Ver os {market.slots.length} slots</summary><div className="viewer-slots">{market.slots.map((slot) => <div key={slot.slot} className="viewer-slot">
          <strong>Slot #{slot.slot}<span>{slot.open ? "ABERTO" : slot.nextBuy ? "PRÓXIMA COMPRA" : "EM ESPERA"}</span></strong>
          <small>Saldo {amount(slot.balance, market.currency)} · {slot.gains} gains · {slot.monthly} no mês</small>
          {slot.open ? <small>Quantidade {number(slot.quantity, 8)} · Entrada {amount(slot.entry, market.currency)} · TP {amount(slot.tp, market.currency)}</small> : null}
          {slot.nextBuy ? <small>Próxima compra {amount(slot.nextBuy, market.currency)}</small> : null}
        </div>)}</div></details>
        <details className="viewer-details"><summary>Histórico de ganhos</summary><div className="viewer-slots">{market.history.slice(-20).reverse().map((item, index) => <div className="viewer-slot" key={`${item.at}-${index}`}><strong>Slot #{item.slot} · {amount(item.result, market.currency)}</strong><small>{new Date(item.at).toLocaleString("pt-BR")}</small></div>)}{!market.history.length ? <p>Sem gain realizado neste período.</p> : null}</div></details>
      </article>;
    })}</section>
    <footer>Dados do ledger CoinOps. Preços públicos de referência podem diferir da execução. Última reconciliação {latest ? new Date(latest).toLocaleString("pt-BR") : "indisponível"}.</footer>
  </main>;
}
