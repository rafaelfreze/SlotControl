"use client";

import { COINOPS_TIME_ZONE } from "@/lib/slotgain/format";
import { summarizeTestnetResults } from "@/lib/slotgain/testnet-results";
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
    const price = environment === "TESTNET" ? probe?.available ? probe.market.price : null : config?.last_market_price;
    const balance = environment === "TESTNET" ? data.testnet?.ok ? data.testnet.balances.find((item) => item.asset === asset)?.free : null : data.balances.find((item) => item.asset === asset)?.total;
    return <button type="button" key={asset} className={`av2-asset-card ${asset.toLowerCase()}`} data-selected={asset === selectedAsset} aria-pressed={asset === selectedAsset} onClick={() => onSelect(asset)} aria-label={`${asset}/USDC ${environment === "TESTNET" ? "Testnet, fundos fictícios" : "Production somente leitura"}`}>
      <span className="av2-asset-heading"><b className="av2-asset-icon">{asset === "BTC" ? "₿" : "≋"}</b><strong>{asset}/USDC</strong><em>{environment === "TESTNET" ? "TESTNET" : "READ-ONLY"}</em></span>
      <strong className="av2-asset-price">{amount(price, 2)} <small>USDC</small></strong>
      <span className="av2-asset-trend">{environment === "TESTNET" ? "Testnet · curva Production" : "Mercado · somente leitura"}</span>
      <span className="av2-asset-balance">{environment === "TESTNET" ? "Saldo fictício disponível" : "Saldo Binance"}<strong>{amount(balance, 8)} {asset}</strong></span>
      <Sparkline candles={candles} asset={asset} />
    </button>;
  })}</div>;
}

export function EnvironmentDailyChart({ data, environment, asset }: { data: Props; environment: "TESTNET" | "REAL"; asset: "BTC" | "SOL" }) {
  return <section className="av2-chart-panel"><header><h2>Gráfico {asset}/USDC</h2><div className="av2-chart-options"><span>Diário · 30 dias</span></div></header><CandleChart candles={data.dailyCandles.filter((item) => item.symbol === `${asset}USDC`)} asset={asset} windowSize={30} /><small>{environment === "TESTNET" ? "Mercado Binance Production · referência visual; execução e P&L usam Testnet." : "Mercado Binance Production · somente consulta, sem execução LIVE."}</small></section>;
}

export function RealEvents({ data, asset }: { data: Props; asset: "BTC" | "SOL" }) {
  return <section className="av2-events-panel"><header><h2>Últimos eventos {asset} · Real</h2><small>Production READ-ONLY</small></header>{data.reconciliationAt || data.lastSyncedAt ? <ol><li><time>{when(data.reconciliationAt || data.lastSyncedAt)}</time><span>{data.reconciliationStatus === "COMPLETED" ? "Reconciliação da conta Production concluída" : "Última consulta da conta Production registrada"}</span><strong>GET</strong></li></ol> : <p className="av2-empty">Nenhuma consulta Production registrada disponível.</p>}<details><summary>Ver detalhes da reconciliação</summary><p>Consulta geral da conta: {data.reconciliationStatus || "estado não informado"}. {data.mismatches} item(ns) para revisão. Nenhuma ordem CoinOps real de {asset} é criada pela reconciliação.</p><a className="ac-button" href="/relatorios">Auditar reconciliação →</a></details></section>;
}

export function EnvironmentConnectionStrip({ data, environment, asset }: { data: Props; environment: "TESTNET" | "REAL"; asset: "BTC" | "SOL" }) {
  const probe = data.testnet?.ok ? data.testnet.probes.find((item) => item.symbol === (data.testnetRun?.symbol || `${asset}USDC`)) : null;
  const result = summarizeTestnetResults(data.testnetSlots, data.testnetOrders, probe?.available ? probe.market.price : null, data.testnetRun?.slot_notional_usdc == null ? null : Number(data.testnetRun.slot_notional_usdc));
  if (environment === "REAL") return <section className="av2-connection-panel"><div><strong>Binance Production · READ-ONLY</strong><small>{data.connectionStatus === "READ_ONLY" || data.connectionStatus === "CONNECTED" ? "Conectada" : "Conexão a verificar"} · consultas GET, sem envio ou cancelamento de ordens.</small></div><div><strong>{data.reconciliationStatus === "COMPLETED" ? "Reconciliação concluída" : "Reconciliação em acompanhamento"}</strong><small>{when(data.reconciliationAt || data.lastSyncedAt)} · {data.mismatches} itens para revisão.</small></div><div><strong>LIVE bloqueado · resultado Real 0 BRL</strong><small>0 gains · 0 operações CoinOps reais. Nenhum capital alocado ao robô.</small></div></section>;
  const hasLedger = Boolean(data.testnetRun && result.rows.length);
  const error = data.testnetActionError || data.testnetRun?.last_error || (data.testnet && !data.testnet.ok ? data.testnet.error : null);
  const historyProfit = (data.testnetHistory || []).reduce((total, bundle) => total + summarizeTestnetResults(bundle.slots, bundle.orders, null, Number(bundle.run.slot_notional_usdc || 0)).realizedProfit, 0);
  const activeTp = data.testnetOrders.filter((order) => order.side === "SELL" && ["PREPARED", "NEW", "PARTIALLY_FILLED"].includes(order.status)).length;
  const operating = result.openSlots > 0 && result.armedSlots === 1 && activeTp > 0;
  const restarting = Boolean(data.testnetRun?.previous_run_id && !data.testnetRun.reset_completed_at) || data.testnetRun?.status === "ACTIVE" && result.openSlots === 0;
  const humanState = error ? "TESTNET · atenção" : restarting ? "REINICIANDO CICLO · fundos fictícios" : operating ? "TESTNET OPERANDO · fundos fictícios" : data.testnet?.ok ? "TESTNET CONECTADO · fundos fictícios" : "Testnet · verificação pendente";
  return <section className="av2-connection-panel"><div><strong>{humanState}</strong><small>{error || "Ordens exclusivas da Binance Spot Testnet. Production permanece READ-ONLY."}</small></div><div><strong>Reconciliação Testnet</strong><small>{when(data.testnetRun?.last_reconciled_at)} · {result.missedLevels} missed levels · LIVE bloqueado.</small></div><div><strong>Resultado Testnet total</strong><small>{hasLedger ? `Realizado ${signed(result.realizedProfit + historyProfit)} + P&L aberto ${signed(result.openPnl)} USDC · capital comprometido ${amount(result.committedCapital, 4)} / livre ${amount(result.freeCapital, 4)} USDC` : "Ledger indisponível para totalização."}</small></div></section>;
}
