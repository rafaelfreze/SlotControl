"use client";

import { COINOPS_TIME_ZONE } from "@/lib/slotgain/format";
import { summarizeTestnetResults, testnetDiagnosticIssue, testnetPresentationHealth } from "@/lib/slotgain/testnet-results";
import { CandleChart, Sparkline, type Props } from "./automation-mobile";

const amount = (value: number | string | null | undefined, digits = 2) => value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toLocaleString("pt-BR", { maximumFractionDigits: digits });
const signed = (value: number | null) => value == null ? "—" : `${value >= 0 ? "+" : ""}${amount(value, 4)}`;
const when = (value?: string | null) => value ? new Intl.DateTimeFormat("pt-BR", { timeZone: COINOPS_TIME_ZONE, dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "Ainda não disponível";

export function EnvironmentAssetCards({ data, environment, selectedAsset, onSelect }: { data: Props; environment: "TESTNET" | "REAL"; selectedAsset: "BTC" | "SOL"; onSelect: (asset: "BTC" | "SOL") => void }) {
  return <div className="av2-asset-grid">{(["BTC", "SOL"] as const).map((asset) => {
    const symbol = `${asset}USDC`;
    const config = data.configs.find((item) => item.asset === asset);
    const candles = [...data.candles.filter((item) => item.symbol === symbol)].reverse();
    const probe = data.testnet?.ok ? data.testnet.probes.find((item) => item.symbol === symbol) : null;
    const price = environment === "TESTNET" ? probe?.available ? probe.market.price : null
      : data.livePreparation?.sizing.find((item) => item.asset === asset)?.priceBrl ?? null;
    const balance = environment === "TESTNET" ? data.testnet?.ok ? data.testnet.balances.find((item) => item.asset === asset)?.free : null : data.balances.find((item) => item.asset === asset)?.total;
    const live = data.liveAssetData?.[asset];
    return <button type="button" key={asset} className={`av2-asset-card ${asset.toLowerCase()}`} data-selected={asset === selectedAsset} aria-pressed={asset === selectedAsset} onClick={() => onSelect(asset)} aria-label={`${asset}/${environment === "TESTNET" ? "USDC" : "BRL"} ${environment === "TESTNET" ? "Testnet, fundos fictícios" : live ? `Production ${live.run.status}` : "Production em preparação"}`}>
      <span className="av2-asset-heading"><b className="av2-asset-icon">{asset === "BTC" ? "₿" : "≋"}</b><strong>{asset}/{environment === "TESTNET" ? "USDC" : "BRL"}</strong><em>{environment === "TESTNET" ? "TESTNET" : live?.run.status ?? "PREPARAÇÃO"}</em></span>
      <strong className="av2-asset-price">{amount(price, 2)} <small>{environment === "TESTNET" ? "USDC" : "BRL"}</small></strong>
      <span className="av2-asset-trend">{environment === "TESTNET" ? "Testnet · curva Production" : "Mercado · somente leitura"}</span>
      <span className="av2-asset-balance">{environment === "TESTNET" ? "Saldo fictício disponível" : "Saldo Binance"}<strong>{amount(balance, 8)} {asset}</strong></span>
      {environment === "TESTNET" ? <Sparkline candles={candles} asset={asset} /> : null}
    </button>;
  })}</div>;
}

export function EnvironmentDailyChart({ data, environment, asset }: { data: Props; environment: "TESTNET" | "REAL"; asset: "BTC" | "SOL" }) {
  if (environment === "REAL") {
    const market = data.livePreparation?.sizing.find((item) => item.asset === asset);
    return <section className="av2-chart-panel"><header><h2>{asset}/BRL · cotação atual</h2></header><p>{market ? `R$ ${amount(market.priceBrl, 2)}` : "Cotação indisponível"}</p><small>GET público Binance, sem histórico BRL persistido neste painel. Nenhum gráfico USDC é tratado como preço BRL.</small></section>;
  }
  return <section className="av2-chart-panel"><header><h2>Gráfico {asset}/USDC</h2><div className="av2-chart-options"><span>Diário · 30 dias</span></div></header><CandleChart candles={data.dailyCandles.filter((item) => item.symbol === `${asset}USDC`)} asset={asset} windowSize={30} /><small>{environment === "TESTNET" ? "Mercado Binance Production · referência visual; execução e P&L usam Testnet." : "Mercado Binance Production · somente consulta, sem execução LIVE."}</small></section>;
}

export function RealEvents({ data, asset }: { data: Props; asset: "BTC" | "SOL" }) {
  const live = data.liveAssetData?.[asset];
  if (live) return <section className="av2-events-panel"><header><h2>Últimos eventos {asset} · LIVE</h2><small>{live.events.length} recentes</small></header>
    {live.events.length ? <ol>{live.events.slice(0, 6).map((event, index) =>
      <li key={`${event.observed_at}:${index}`}><time>{when(event.observed_at)}</time>
        <span>{event.event_type}{event.slot_number ? ` · Slot #${event.slot_number}` : ""}</span><strong>Ledger</strong></li>)}</ol>
      : <p className="av2-empty">Nenhum evento de execução registrado.</p>}
    <a className="ac-button" href="/relatorios">Abrir auditoria →</a></section>;
  return <section className="av2-events-panel"><header><h2>Últimos eventos {asset} · Real</h2><small>Production READ-ONLY</small></header>{data.reconciliationAt || data.lastSyncedAt ? <ol><li><time>{when(data.reconciliationAt || data.lastSyncedAt)}</time><span>{data.reconciliationStatus === "COMPLETED" ? "Reconciliação da conta Production concluída" : "Última consulta da conta Production registrada"}</span><strong>GET</strong></li></ol> : <p className="av2-empty">Nenhuma consulta Production registrada disponível.</p>}<details><summary>Ver detalhes da reconciliação</summary><p>Consulta geral da conta: {data.reconciliationStatus || "estado não informado"}. {data.mismatches} item(ns) para revisão. Nenhuma ordem CoinOps real de {asset} é criada pela reconciliação.</p><a className="ac-button" href="/relatorios">Auditar reconciliação →</a></details></section>;
}

export function EnvironmentConnectionStrip({ data, environment, asset }: { data: Props; environment: "TESTNET" | "REAL"; asset: "BTC" | "SOL" }) {
  const probe = data.testnet?.ok ? data.testnet.probes.find((item) => item.symbol === (data.testnetRun?.symbol || `${asset}USDC`)) : null;
  const result = summarizeTestnetResults(data.testnetSlots, data.testnetOrders, probe?.available ? probe.market.price : null, data.testnetRun?.slot_notional_usdc == null ? null : Number(data.testnetRun.slot_notional_usdc), { asset, cycleId: data.testnetRun?.id, events: data.testnetEvents });
  if (environment === "REAL") {
    const live = data.liveAssetData?.[asset];
    if (live) return <section className="av2-connection-panel"><div><strong>Binance Production · Spot restrito</strong><small>Executor {data.livePreparation?.executor.gate ?? "não verificado"} · IP {data.livePreparation?.executor.ip ?? "—"}.</small></div><div><strong>Reconciliação LIVE</strong><small>{when(live.run.last_reconciled_at)} · {live.run.last_error ?? "sem erro registrado"}.</small></div><div><strong>Ledger CoinOps em BRL</strong><small>{live.orders.length} ordens próprias · {live.slots.length}/25 slots · {live.alerts.length} alertas ativos.</small></div></section>;
    return <section className="av2-connection-panel"><div><strong>Binance Production · preparação</strong><small>Executor separado por IPv4 fixo; operações ainda não iniciadas.</small></div><div><strong>Reconciliação da conta</strong><small>{when(data.reconciliationAt || data.lastSyncedAt)} · {data.mismatches} itens para revisão.</small></div><div><strong>LIVE não iniciado</strong><small>Sem ciclo LIVE ativo no ledger.</small></div></section>;
  }
  const hasLedger = Boolean(data.testnetRun && result.rows.length);
  const error = testnetDiagnosticIssue(data.testnet, data.testnetActionError);
  const historyProfit = (data.testnetHistory || []).reduce((total, bundle) => total + summarizeTestnetResults(bundle.slots, bundle.orders, null, Number(bundle.run.slot_notional_usdc || 0)).realizedProfit, 0);
  const health = testnetPresentationHealth(result, data.testnetRun, Date.now(), error);
  return <section className="av2-connection-panel"><div><strong className={health.tone === "ok" ? "av2-positive" : health.tone === "error" ? "av2-negative" : "av2-warning"}>{health.label}</strong><small>{health.reason}</small></div><div><strong>Reconciliação Testnet</strong><small>{when(data.testnetRun?.last_reconciled_at)} · {result.temporalSummary.historicalCount} históricos · {result.temporalSummary.currentVersionCount} missed desde versão atual · {result.temporalSummary.activeIssueCount} ocorrências ativas.</small></div><div><strong>Resultado Testnet total</strong><small>{hasLedger ? `Realizado ${signed(result.realizedProfit + historyProfit)} + P&L aberto ${signed(result.openPnl)} USDC · capital comprometido ${amount(result.committedCapital, 4)} / livre ${amount(result.freeCapital, 4)} USDC` : "Ledger indisponível para totalização."}</small></div></section>;
}
