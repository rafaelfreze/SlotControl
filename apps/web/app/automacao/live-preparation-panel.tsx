"use client";

import { useState } from "react";

import type { LiveAssetData, LivePresentation } from "./automation-mobile";
import { saveLiveAssetCaps, saveLiveGlobalCap } from "./live-preparation-actions";
import "./live-preparation.css";

const brl = (value: number | null | undefined, digits = 2) => value === null || value === undefined
  ? "—" : `R$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const num = (value: number, digits = 8) => value.toLocaleString("pt-BR", { maximumFractionDigits: digits });
const pct = (value: number | string) => `${num(Number(value) * 100, 3)}%`;
const when = (value: string | null) => value ? new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short", timeStyle: "short", timeZone: "America/Campo_Grande" }).format(new Date(value)) : "não disponível";

export function LiveOperationalPanel({ asset, data }: { asset: "BTC" | "SOL"; data: LiveAssetData }) {
  const active = new Set(["PREPARED", "NEW", "PARTIALLY_FILLED"]);
  const open = data.slots.filter((slot) => slot.entry_state === "OPEN");
  const next = data.orders.find((order) => order.side === "BUY" && order.purpose === "ENTRY"
    && active.has(order.status));
  const tps = data.orders.filter((order) => order.side === "SELL" && active.has(order.status));
  const planned = data.slots.filter((slot) => slot.entry_state === "PLANNED").length;
  const total = data.accounts.reduce((sum, account) => sum + Number(account.balance_brl), 0);
  const committed = data.slots.reduce((sum, slot) => sum + Number(slot.position_committed_brl), 0);
  const marketPnl = data.accounts.reduce((sum, account) => sum + Number(account.market_pnl_brl), 0);
  const fees = data.accounts.reduce((sum, account) => sum + Number(account.fees_brl), 0);
  const rows = [...data.slots].sort((left, right) => (left.operational_rank ?? 26)
    - (right.operational_rank ?? 26) || left.slot_number - right.slot_number);
  const target = asset === "BTC" ? 7 : 2;
  return <section className="ac-panel lp-asset" aria-label={`Ciclo LIVE ${asset}/BRL`}>
    <div className="ac-panel-heading"><h2>{asset}/BRL · ciclo LIVE</h2>
      <span className="ac-badge ac-badge--slate">{data.run.status} · {data.run.entry_regime}</span></div>
    {data.alerts.map((alert) => <p role="alert" className="lp-warning" key={alert.code}>
      {alert.severity}: {alert.code} · {when(alert.last_seen_at)}</p>)}
    {data.run.last_error ? <p role="alert" className="lp-warning">Reconciliação: {data.run.last_error}</p> : null}
    <div className="lp-metrics">
      <span>Posições OPEN <strong>{open.length}</strong></span>
      <span>TP residente <strong>{tps.length}</strong></span>
      <span>Próxima BUY <strong>{next ? `Slot #${next.slot_number}` : "nenhuma"}</strong></span>
      <span>Níveis PLANNED <strong>{planned}</strong></span>
      <span>Slots físicos <strong>{data.slots.length}/25</strong></span>
      <span>Caixa lógico <strong>{brl(total)}</strong></span>
      <span>Capital em posições <strong>{brl(committed)}</strong></span>
      <span>P&L mercado líquido <strong>{brl(marketPnl - fees)}</strong></span>
    </div>
    <small>Ciclo {data.run.id} · reconciliação {when(data.run.last_reconciled_at)} ·
      gain {pct(data.run.gain_rate)} · spacing {pct(data.run.entry_spacing)} · v{data.run.config_version}.
      Caixa, posições e saldo Binance são conceitos separados.</small>
    <div className="lp-table-wrap"><table><thead><tr><th>Físico</th><th>Estado</th><th>Rank</th>
      <th>Gains mês</th><th>Entrada</th><th>Saldo</th><th>Detalhes</th></tr></thead><tbody>
      {rows.map((slot) => {
        const account = data.accounts.find((item) => item.slot_number === slot.slot_number);
        const gains = data.monthlyGains.find((item) => item.slot_number === slot.slot_number);
        const related = data.orders.filter((item) => item.slot_number === slot.slot_number);
        return <tr key={slot.slot_number}><td>#{slot.slot_number}</td><td>{slot.entry_state}</td>
          <td>{slot.operational_rank ?? "—"}</td>
          <td>{gains?.monthly_gain_count ?? 0}/{target}</td>
          <td>{brl(Number(slot.target_buy_price))}</td>
          <td>{brl(Number(account?.balance_brl ?? 0))}</td>
          <td><details><summary>Ver</summary><small>Grupo {slot.post_ath_group ?? "—"}
            {slot.post_ath_group_rank ? ` #${slot.post_ath_group_rank}` : ""} · operação {slot.operation_sequence}
            · gains totais {gains?.lifetime_gain_count ?? account?.gain_count ?? 0}
            · quantidade {num(Number(slot.position_quantity))} {asset}
            · P&L mercado {brl(Number(account?.market_pnl_brl ?? 0))}
            · taxas {brl(Number(account?.fees_brl ?? 0))}
            · residual {num(Number(account?.dust_quantity ?? 0))} {asset}.</small>
            {related.map((order) => <p key={order.client_order_id}><small>{order.side} {order.purpose}
              · {order.status} · {order.exchange_order_id ?? "sem exchange ID"}
              · preço {order.price ? brl(Number(order.price)) : "MARKET"}
              · quantidade {num(Number(order.executed_quantity))} {asset}</small></p>)}
          </details></td></tr>;
      })}</tbody></table></div>
    <details><summary>Eventos e auditoria</summary>{data.events.map((entry, index) =>
      <p key={`${entry.observed_at}:${index}`}><small>{when(entry.observed_at)} · {entry.event_type}
        {entry.slot_number ? ` · Slot #${entry.slot_number}` : ""}</small></p>)}
      <a href="/relatorios">Abrir relatórios →</a></details>
  </section>;
}

export function LivePreparationPanel({ data, asset }: {
  data: LivePresentation; asset: "BTC" | "SOL" }) {
  const [checking, setChecking] = useState(false);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  async function checkExecutor() {
    setChecking(true);
    setDiagnostic(null);
    try {
      const response = await fetch("/api/coinops-live-executor/diagnostic", {
        method: "POST", cache: "no-store" });
      const result = await response.json() as { gate?: string; error?: string;
        results?: Array<{ asset: string; valid_slots: number; latency_ms: number }> };
      setDiagnostic(response.ok && result.gate === "NO_WRITE"
        ? `Dry-run sem ordens: ${result.results?.map((item) => `${item.asset} ${item.valid_slots}/25 · ${item.latency_ms} ms`).join("; ")}`
        : result.error ?? "EXECUTOR_DIAGNOSTIC_UNAVAILABLE");
    } catch { setDiagnostic("EXECUTOR_DIAGNOSTIC_UNAVAILABLE"); }
    finally { setChecking(false); }
  }
  const config = data.configs.find((item) => item.asset === asset);
  const operating = Boolean(config?.live_enabled);
  const sizing = data.sizing.find((item) => item.asset === asset);
  const required = data.sizing.reduce((sum, item) => sum + item.configuredCapitalBrl, 0);
  const shortage = data.brlFree === null ? null : Math.max(0, required - data.brlFree);
  const checklist = [
    ["BTCBRL TRADING", data.sizing.some((item) => item.asset === "BTC" && item.rules.status === "TRADING")],
    ["SOLBRL TRADING", data.sizing.some((item) => item.asset === "SOL" && item.rules.status === "TRADING")],
    ["Filtros e 25 slots válidos", data.sizing.length === 2 && data.sizing.every((item) => item.validSlots === 25)],
    ["Hard caps BTC/SOL/global", data.sizing.length === 2
      && data.sizing.reduce((sum, item) => sum + item.exposureCapBrl, 0) <= data.globalCapBrl],
    ["Saldo BRL suficiente", data.brlFree !== null && data.brlFree >= required],
    ["Ledger nativo BRL, sem crédito REAL legado", data.nativeLedgerReady],
    ["Sem divergência de ordens próprias CoinOps", data.reconciliationVerified && data.ownedDivergences === 0],
    ["Chave Spot com IP restrito e saques desabilitados", data.permissions === "SPOT_RESTRICTED"],
    ["Executor em estado esperado", operating ? data.executor.gate === "LIVE_EXECUTOR_ACTIVE"
      : data.executor.gate === "LIVE_EXECUTOR_READY" || data.executor.gate === "LIVE_EXECUTOR_PROTECTED"],
    ["LIVE autorizado no ledger", operating],
  ] as const;
  return <div className="lp-stack">
    <section className="ac-panel lp-summary" aria-label="Executor LIVE">
      <div className="ac-panel-heading"><h2>Executor LIVE · IP fixo</h2>
        <span className="ac-badge ac-badge--slate">{data.executor.gate.replaceAll("_", " ")}</span></div>
      <div className="lp-metrics">
        <span>IP para whitelist Binance <strong>{data.executor.ip ?? "não configurado"}</strong></span>
        <span>Versão <strong>{data.executor.health?.version ?? "indisponível"}</strong></span>
        <span>Região <strong>{data.executor.health?.region ?? "indisponível"}</strong></span>
        <span>Binance Production <strong>{data.executor.health?.binance_connectivity ?? "indisponível"}</strong></span>
        <span>API Spot <strong>{data.executor.health?.account_permission ?? "não verificada"}</strong></span>
        <span>Latência health <strong>{data.executor.health ? `${num(data.executor.health.latency_ms, 0)} ms` : "—"}</strong></span>
      </div>
      <small>IPv4 de saída {data.executor.health?.egress_ipv4_verified ? "confirmado" : "não confirmado"}
        · trading {data.executor.health ? data.executor.health.trading_enabled ? "habilitado para Spot restrito" : "desligado" : "não verificado"}
        · kill switch {data.executor.health ? data.executor.health.kill_switch ? "ON" : "OFF" : "não verificado"}
        · whitelist {data.ipRestricted ? "confirmada" : "não verificada"}. Saques e transferências não fazem parte do executor.</small>
      <button type="button" onClick={checkExecutor} disabled={checking}>{checking ? "Validando..." : "Validar dry-run BTC/SOL"}</button>
      {diagnostic ? <p role="status">{diagnostic}</p> : null}
    </section>
    <section className="lp-summary ac-panel" aria-label="Preparação LIVE em BRL">
      <div className="ac-panel-heading"><h2>Limites e preparação · BTC/BRL + SOL/BRL</h2>
        <span className="ac-badge ac-badge--slate">{data.gate.replaceAll("_", " ")}</span></div>
      <p>{operating ? "Ciclo LIVE gerido pelo executor com ledger, reconciliação e hard caps. Saques, transferências, margem e Futures continuam proibidos."
        : "Preparação sem ordens nesta tela. A ativação exige ledger, executor e gates de segurança verificados."}</p>
      {data.error ? <p role="alert">{data.error}</p> : null}
      <div className="lp-metrics">
        <span>Capital CoinOps configurado <strong>{brl(required)}</strong></span>
        <span>Saldo BRL livre Binance <strong>{brl(data.brlFree)}</strong></span>
        <span>Saldo BRL bloqueado <strong>{brl(data.brlLocked)}</strong></span>
        <span>Limite global <strong>{brl(data.globalCapBrl)}</strong></span>
      </div>
      {shortage !== null && shortage > 0 ? <p className="lp-warning">Para iniciar o piloto, deixe pelo menos {brl(required)} livres em BRL na Binance. Faltam {brl(shortage)}. Nenhum depósito ou conversão será feito aqui.</p> : null}
      <small>Preços/filtros observados {when(data.observedAt)} · saldo {when(data.balanceObservedAt)} · fonte: {data.source ?? "consulta indisponível"}. Revalidar antes de qualquer fase futura. Permissão da chave: {data.permissions} · whitelist IP: {data.ipRestricted === null ? "não verificada" : data.ipRestricted ? "ativa" : "inativa"}.</small>
      <details><summary>Checklist e segurança</summary><ul className="lp-checks">{checklist.map(([label, okay]) => <li key={label}><span aria-hidden="true">{okay ? "✓" : "○"}</span> {label}</li>)}</ul>
        <p>Próxima fase exigirá habilitar somente Spot Trading, mantendo saques/transferências desabilitados. Salvar configuração nunca habilita trading.</p></details>
    </section>
    {config ? <section className="ac-panel lp-asset" key={`${asset}:${config.config_version}`}>
      <div className="ac-panel-heading"><h2>{config.symbol} · 25 slots</h2><span>{config.regime} · v{config.config_version}</span></div>
      <p>Gain {pct(config.gain_rate)} · queda normal {pct(config.normal_spacing_rate)} · pós-ATH {pct(config.post_ath_spacing_rate)} · meta {config.monthly_target}/slot/mês. Compounding, Single Active Entry, initial MARKET e reentrada local preparados. Fonte de capital: BRL, separada do saldo físico Binance.</p>
      {sizing ? <>
        <div className="lp-metrics">
          <span>Preço atual <strong>{brl(sizing.priceBrl)}</strong></span>
          <span>Mínimo atual/slot <strong>{brl(sizing.currentMinimumBrl, 4)}</strong></span>
          <span>Mínimo da escada/slot <strong>{brl(sizing.ladderMinimumBrl, 4)}</strong></span>
          <span>Recomendado/slot <strong>{brl(sizing.recommendedSlotBrl)}</strong></span>
          <span>Mínimo 25 slots <strong>{brl(sizing.minimumCapitalBrl)}</strong></span>
          <span>Recomendado 25 slots <strong>{brl(sizing.recommendedCapitalBrl)}</strong></span>
          <span>Slots elegíveis <strong>{sizing.validSlots}/25</strong></span>
        </div>
        <small>Margem técnica: fee conservadora 0,2% + buffer 2%; inclui LOT_SIZE, MARKET_LOT_SIZE quando aplicável, NOTIONAL, TP e arredondamento. O dimensionamento é prévia; fills e taxas efetivas vêm do ledger Binance.</small>
        <details><summary>Filtros oficiais e dry-run sem ordens</summary>
          <div className="lp-metrics"><span>tickSize <strong>{num(sizing.rules.priceTick)}</strong></span>
            <span>stepSize <strong>{num(sizing.rules.quantityStep)}</strong></span>
            <span>minQty / maxQty <strong>{num(sizing.rules.minQuantity)} / {num(sizing.rules.maxQuantity)}</strong></span>
            <span>MARKET step / max <strong>{num(sizing.rules.marketQuantityStep)} / {num(sizing.rules.marketMaxQuantity)}</strong></span>
            <span>minNotional / maxNotional <strong>{brl(sizing.rules.minNotional)} / {brl(sizing.rules.maxNotional)}</strong></span>
            <span>quoteOrderQty MARKET <strong>{sizing.rules.quoteOrderQtyMarketAllowed ? "sim" : "não"}</strong></span></div>
          <p>Strategy Engine {sizing.dryRun.strategyVersion} · {sizing.dryRun.status}: {sizing.dryRun.initial.action_type} hipotética em {brl(sizing.dryRun.initial.target_price)}, TP em {brl(sizing.dryRun.takeProfit.target_price)}, {sizing.dryRun.nextBuy.action_type} em {brl(sizing.dryRun.nextBuy.target_price)}, 23 níveis PLANNED. Nenhuma posição nem ordem criada.</p>
          <p>Ensaios da mesma engine: reentrada local {sizing.dryRun.localReentry.action_type} com +{brl(sizing.dryRun.hypotheticalManualGainBrl)} apenas no próximo saldo; META BATIDA {sizing.dryRun.monthlyHold.reason}; reset global {sizing.dryRun.globalReset.map((decision) => decision.action_type).join(" → ")}. Valores hipotéticos, sem escrita no ledger.</p>
        </details>
        <details><summary>Ver os 25 slots, rank, grupo, preço e quantidade</summary><div className="lp-table-wrap"><table><thead><tr><th>Físico</th><th>Rank</th><th>Grupo</th><th>Capital BRL</th><th>Entrada BRL</th><th>Qtd.</th><th>TP BRL</th><th>Válido</th></tr></thead><tbody>{sizing.slots.map((slot) => <tr key={slot.physicalSlotNumber}><td>#{slot.physicalSlotNumber}</td><td>{slot.operationalRank ?? "—"}</td><td>{slot.postAthGroup ?? "—"}</td><td>{brl(slot.capitalBrl)}</td><td>{brl(slot.entryPriceBrl)}</td><td>{num(slot.estimatedQuantity)}</td><td>{brl(slot.tpPriceBrl)}</td><td>{slot.valid ? "sim" : "não"}</td></tr>)}</tbody></table></div></details>
      </> : <p role="alert">Dimensionamento indisponível: par, filtros, preço ou configuração inválidos.</p>}
      <details><summary>Editar capital e hard caps de {asset}</summary><form action={saveLiveAssetCaps} className="lp-form">
        <input type="hidden" name="asset" value={asset} />
        <label>Capital CoinOps BRL<input name="capital_brl" type="number" min="0.01" step="0.01" defaultValue={Number(config.configured_live_capital_brl)} required /></label>
        <label>Máximo por ordem BRL<input name="order_cap_brl" type="number" min="0.01" step="0.01" defaultValue={Number(config.max_order_notional_brl)} required /></label>
        <label>Exposição máxima {asset} BRL<input name="exposure_cap_brl" type="number" min="0.01" step="0.01" defaultValue={Number(config.max_total_exposure_brl)} required /></label>
        <button type="submit">Salvar limites · não ativa LIVE</button></form></details>
    </section> : <section className="ac-panel" role="alert">Configuração Real {asset} não encontrada. LIVE bloqueado.</section>}
    <section className="ac-panel"><details><summary>Editar limite global BRL</summary><form action={saveLiveGlobalCap} className="lp-form"><label>Exposição máxima total BRL<input name="global_cap_brl" type="number" min="0.01" step="0.01" defaultValue={data.globalCapBrl} required /></label><button type="submit">Salvar limite global · não ativa LIVE</button></form></details></section>
  </div>;
}
