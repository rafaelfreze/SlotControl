"use client";

import type { LivePresentation } from "./automation-mobile";
import { saveLiveAssetCaps, saveLiveGlobalCap } from "./live-preparation-actions";
import "./live-preparation.css";

const brl = (value: number | null | undefined, digits = 2) => value === null || value === undefined
  ? "—" : `R$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const num = (value: number, digits = 8) => value.toLocaleString("pt-BR", { maximumFractionDigits: digits });
const pct = (value: number | string) => `${num(Number(value) * 100, 3)}%`;
const when = (value: string | null) => value ? new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short", timeStyle: "short", timeZone: "America/Campo_Grande" }).format(new Date(value)) : "não disponível";

export function LivePreparationPanel({ data, asset }: {
  data: LivePresentation; asset: "BTC" | "SOL" }) {
  const config = data.configs.find((item) => item.asset === asset);
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
    ["API Production READ-ONLY", data.permissions === "READ_ONLY"],
    ["Spot Trading CoinOps desabilitado", data.configs.length === 2
      && data.configs.every((item) => item.live_enabled === false)],
    ["LIVE bloqueado", data.configs.length === 2 && data.configs.every((item) => item.live_enabled === false)],
  ] as const;
  return <div className="lp-stack">
    <section className="ac-panel lp-summary" aria-label="Executor LIVE">
      <div className="ac-panel-heading"><h2>Executor LIVE · somente leitura</h2>
        <span className="ac-badge ac-badge--slate">{data.executor.gate.replaceAll("_", " ")}</span></div>
      <div className="lp-metrics">
        <span>IP para whitelist Binance <strong>{data.executor.ip ?? "não configurado"}</strong></span>
        <span>Versão <strong>{data.executor.health?.version ?? "indisponível"}</strong></span>
        <span>Binance Production <strong>{data.executor.health?.binance_connectivity ?? "indisponível"}</strong></span>
        <span>API Spot <strong>{data.executor.health?.account_permission ?? "não verificada"}</strong></span>
        <span>Latência health <strong>{data.executor.health ? `${num(data.executor.health.latency_ms, 0)} ms` : "—"}</strong></span>
      </div>
      <small>IPv4 de saída {data.executor.health?.egress_ipv4_verified ? "confirmado" : "não confirmado"} · trading {data.executor.health ? data.executor.health.trading_enabled ? "INSEGURO" : "desligado" : "não verificado"} · kill switch {data.executor.health?.kill_switch ? "ON" : "não verificado"} · whitelist Binance PENDENTE. Não cadastre o IP nem altere a chave nesta fase.</small>
    </section>
    <section className="lp-summary ac-panel" aria-label="Preparação LIVE em BRL">
      <div className="ac-panel-heading"><h2>Preparação LIVE · BTC/BRL + SOL/BRL</h2>
        <span className="ac-badge ac-badge--slate">{data.gate.replaceAll("_", " ")}</span></div>
      <p>Configuração e simulação apenas. Production somente GET; LIVE, compras, cancelamentos, transferências e saques permanecem bloqueados.</p>
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
        <small>Margem técnica: fee conservadora 0,2% + buffer 2%; inclui LOT_SIZE, MARKET_LOT_SIZE quando aplicável, NOTIONAL, TP e arredondamento. Fee específica da conta ainda não comprovada; nenhum valor é garantia de execução futura.</small>
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
