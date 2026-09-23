"use client";

import { reconcileV1PhysicalSlotAccounts } from "@/lib/execution/robot-v1-audit";
import { COINOPS_TIME_ZONE } from "@/lib/slotgain/format";
import { selectTestnetAssetData } from "@/lib/slotgain/testnet-asset-view";
import { summarizeTestnetResults, testnetDiagnosticIssue, testnetPresentationHealth } from "@/lib/slotgain/testnet-results";
import type { Props, TestnetAssetData } from "./automation-mobile";
import "../automation-overview.css";

type Asset = "BTC" | "SOL";
type Environment = "shadow" | "testnet" | "real";
type Activity = { key: string; at: string; environment: Environment; asset: string; label: string };
const ASSETS = ["BTC", "SOL"] as const;
const ACTIVE_CYCLES = new Set(["STARTING", "GRID_ACTIVE", "POSITIONS_ACTIVE", "RESETTING"]);
const OPEN_SLOTS = new Set(["TP_ACTIVE", "OPEN", "PARTIALLY_FILLED"]);
const OPEN_ORDERS = new Set(["PREPARED", "NEW", "PARTIALLY_FILLED"]);
const number = (value: number | string | null | undefined) => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const amount = (value: number | null | undefined, digits = 2) => value == null ? "—" : value.toLocaleString("pt-BR", { maximumFractionDigits: digits });
const signed = (value: number | null | undefined) => value == null ? "—" : `${value >= 0 ? "+" : ""}${amount(value, 4)}`;
const at = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("pt-BR", { timeZone: COINOPS_TIME_ZONE, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "Sem registro";
const latest = (values: Array<string | null | undefined>) => values.filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!))).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
const sum = (values: Array<number | null>) => values.some((value) => value == null) ? null : values.reduce<number>((total, value) => total + (value || 0), 0);

function testnetAsset(data: Props, asset: Asset): TestnetAssetData | null {
  const selected = selectTestnetAssetData(data, asset);
  return selected.testnetRun ? { run: selected.testnetRun, slots: selected.testnetSlots, orders: selected.testnetOrders, events: selected.testnetEvents, history: selected.testnetHistory } : null;
}

function shadowAsset(data: Props, asset: Asset) {
  const config = data.configs.find((row) => row.asset === asset && row.execution_mode === "SHADOW");
  const cycles = data.cycles.filter((row) => row.config_id === config?.id);
  const cycle = cycles.find((row) => ACTIVE_CYCLES.has(row.status));
  const slots = data.slots.filter((row) => row.cycle_id === cycle?.id);
  const accounts = data.slotAccounts.filter((row) => row.config_id === config?.id);
  const testCycles = new Set(cycles.filter((row) => !config?.shadow_test_started_at || Date.parse(row.started_at) >= Date.parse(config.shadow_test_started_at)).map((row) => row.id));
  const operations = data.operations.filter((row) => testCycles.has(row.cycle_id));
  const armed = slots.filter((row) => row.status === "PENDING" && row.entry_state === "ARMED").length;
  const accountValid = accounts.length > 0 && reconcileV1PhysicalSlotAccounts(accounts, operations);
  const healthy = Boolean(config?.last_engine_at && config.grid_status === "VALID" && !config.last_engine_error && accountValid && armed <= 1 && !slots.some((slot) => slot.missed_at));
  const active = Boolean(cycle && config && !config.kill_switch && !config.pause_new_entries);
  const market = number(config?.last_market_price);
  const openPnl = market === null ? null : slots.filter((row) => OPEN_SLOTS.has(row.status)).reduce((total, row) => total + (market - Number(row.average_fill_price || 0)) * Number(row.executed_quantity || 0), 0);
  return { asset, config, cycle, accounts, active, healthy, armed, operations: operations.length, cycles: cycles.length, openPnl,
    capital: accounts.length ? sum(accounts.map((row) => number(row.balance_usdc))) : null,
    profit: accounts.length ? sum(accounts.map((row) => number(row.net_profit_usdc))) : null,
    gains: accounts.length ? accounts.reduce((total, row) => total + row.gain_count, 0) : null,
    open: slots.filter((row) => OPEN_SLOTS.has(row.status)).length,
    planned: slots.filter((row) => row.status === "PENDING" && row.entry_state !== "ARMED" && !row.missed_at).length,
    missed: slots.filter((row) => row.missed_at).length,
    state: !config ? "Sem configuração" : config.kill_switch ? "Proteção ativa" : config.pause_new_entries ? "Entradas pausadas" : !cycle ? "Sem ciclo ativo" : healthy ? "Última execução OK" : "Revisar motor"
  };
}

function Metric({ label, value, unit, positive }: { label: string; value: string; unit?: string; positive?: boolean }) {
  return <div className="aov-metric"><dt>{label}</dt><dd className={positive === true ? "av2-positive" : positive === false ? "av2-negative" : undefined}>{value}{unit ? <small>{unit}</small> : null}</dd></div>;
}

function AssetHeading({ asset, label, state, warning = false, error = false, healthy = false }: { asset: Asset; label: string; state: string; warning?: boolean; error?: boolean; healthy?: boolean }) {
  return <header className="aov-asset-heading"><span className={`aov-coin ${asset.toLowerCase()}`} aria-hidden="true">{asset === "BTC" ? "₿" : "≋"}</span><strong>{label}</strong><small className={error ? "av2-negative" : warning ? "av2-warning" : healthy ? "av2-positive" : undefined}>{state}</small></header>;
}

const EVENT_LABELS: Record<string, string> = {
  INITIAL_POSITION_OPENED: "Posição inicial aberta", BUY_TRIGGERED: "Compra virtual executada", TP_TRIGGERED: "TP virtual atingido", SLOT_TP_FILLED: "TP preenchido", SLOT_PROFIT_CREDITED: "Lucro creditado no slot", SLOT_BALANCE_UPDATED: "Saldo do slot atualizado", SLOT_RECYCLED: "Slot reciclado", SLOT_REENTRY_PLANNED: "Reentrada preservada no mesmo preço", SLOT_REENTRY_ARMED: "Reentrada armada", SHADOW_STATE_REPAIRED: "Estado Shadow reparado", NEXT_BUY_ARMED: "Próxima compra armada", NEXT_BUY_DISARMED: "Próxima compra desarmada", BUY_REPLACED_FOR_REENTRY: "Compra substituída pela reentrada", MISSED_LEVEL_DURING_REARM: "Nível perdido no rearme", CYCLE_STARTED: "Ciclo iniciado", CYCLE_COMPLETED: "Ciclo concluído", CYCLE_RESTARTED: "Ciclo reiniciado", INTRABAR_AMBIGUOUS: "Vela ambígua", GRID_INVALID: "Grade inválida", RECONCILED: "Reconciliação concluída", BUY_NEW: "Compra Testnet armada", BUY_FILLED: "Compra Testnet preenchida", SELL_NEW: "TP Testnet criado", SELL_FILLED: "TP Testnet preenchido", SLOT_CLOSED: "Slot concluído e ganho creditado", TP_PREPARED: "TP Testnet preparado", NEXT_BUY_PREPARED: "Próxima compra preparada", BUY_CANCELED: "Compra própria cancelada", OLD_NEXT_BUY_CANCELED: "Compra antiga cancelada", RESET_AFTER_LAST_TP: "Reinício após TP terminal", NEW_CYCLE_STARTED: "Novo ciclo iniciado", INITIAL_REENTRY_FILLED: "Nova entrada preenchida", NEW_TP_CREATED: "Novo TP criado", RESET_COMPLETED: "Reinício concluído", OWNED_BUY_REPLACED_AFTER_RESTART: "Compra substituída na recuperação", MISSED_LEVEL: "Nível atravessado"
};

function recentActivity(data: Props, testnet: Array<{ asset: Asset; persisted: TestnetAssetData | null }>) {
  const shadow: Activity[] = data.events.map((event) => ({ key: `shadow:${event.cycle_id}:${event.slot_id}:${event.observed_at}:${event.event_type}`, at: event.observed_at, environment: "shadow", asset: data.cycles.find((cycle) => cycle.id === event.cycle_id)?.asset || "", label: EVENT_LABELS[event.event_type] || event.event_type.replaceAll("_", " ") }));
  const sandbox: Activity[] = testnet.flatMap(({ asset, persisted }) => (persisted?.events || []).map((event) => ({ key: `testnet:${persisted?.run.id}:${event.observed_at}:${event.event_type}:${event.slot_number}`, at: event.observed_at, environment: "testnet" as const, asset, label: `${EVENT_LABELS[event.event_type] || event.event_type.replaceAll("_", " ")}${event.slot_number ? ` · #${event.slot_number}` : ""}` })));
  const newest = (events: Activity[], count: number) => events.filter((event) => Number.isFinite(Date.parse(event.at))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, count);
  const realAt = data.reconciliationAt || data.lastSyncedAt;
  const real: Activity[] = realAt ? [{ key: `real:${realAt}`, at: realAt, environment: "real", asset: "Conta", label: data.reconciliationStatus === "COMPLETED" ? "Reconciliação Production concluída · GET" : data.reconciliationStatus === "FAILED" ? "Falha na reconciliação Production" : "Consulta Production registrada · GET" }] : [];
  return [...newest(shadow, 2), ...newest(sandbox, 2), ...real].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Compact persisted-data overview. Navigation never starts an execution. */
export function AutomationOverview({ data }: { data: Props }) {
  const shadow = ASSETS.map((asset) => shadowAsset(data, asset));
  const shadowConfigured = shadow.filter((row) => row.config);
  const shadowCapital = shadowConfigured.length ? sum(shadowConfigured.map((row) => row.capital)) : null;
  const shadowProfit = shadowConfigured.length ? sum(shadowConfigured.map((row) => row.profit)) : null;
  const shadowGains = shadowConfigured.length ? sum(shadowConfigured.map((row) => row.gains)) : null;
  const testnet = ASSETS.map((asset) => {
    const persisted = testnetAsset(data, asset);
    const market = number(data.configs.find((row) => row.asset === asset)?.last_market_price);
    const result = persisted ? summarizeTestnetResults(persisted.slots, persisted.orders, market, number(persisted.run.slot_notional_usdc), { asset, cycleId: persisted.run.id, events: persisted.events }) : null;
    const health = result && persisted ? testnetPresentationHealth(result, persisted.run, Date.now(), testnetDiagnosticIssue(data.testnet, data.testnetActionError)) : null;
    const history = (persisted?.history || []).map((bundle) => summarizeTestnetResults(bundle.slots, bundle.orders, null, number(bundle.run.slot_notional_usdc)));
    const gainFacts = (data.monthlyGoals || []).filter((row) => row.environment === "TESTNET" && row.asset === asset);
    return { asset, persisted, result, health, lifetimeProfit: (result?.realizedProfit || 0) + history.reduce((total, item) => total + item.realizedProfit, 0), lifetimeGains: gainFacts.length === 25
      ? gainFacts.reduce((total, row) => total + row.lifetimeGainCount, 0)
      : (result?.gains || 0) + history.reduce((total, item) => total + item.gains, 0), lifetimeOperations: (result?.completedOperations || 0) + history.reduce((total, item) => total + item.completedOperations, 0) };
  });
  const testnetKnown = testnet.filter((row) => row.persisted && row.result?.rows.length);
  const testnetCapital = testnetKnown.length ? sum(testnetKnown.map((row) => row.result!.capital)) : null;
  const testnetProfit = testnetKnown.length ? sum(testnetKnown.map((row) => row.lifetimeProfit)) : null;
  const testnetGains = testnetKnown.length ? sum(testnetKnown.map((row) => row.lifetimeGains)) : null;
  const testnetError = Boolean(testnetDiagnosticIssue(data.testnet, data.testnetActionError) || testnet.some((row) => row.health && !row.health.healthy));
  const testnetDivergence = testnet.some((row) => row.health?.tone === "error");
  const testnetActive = testnet.some((row) => row.persisted?.run.status === "ACTIVE");
  const testnetAt = latest(testnet.map((row) => row.persisted?.run.last_reconciled_at));
  const realConnected = data.connectionStatus === "READ_ONLY" || data.connectionStatus === "CONNECTED";
  const activities = recentActivity(data, testnet);

  return <div className="aov-overview">
    <div className="aov-environments">
      <section className="aov-environment aov-shadow" aria-labelledby="aov-shadow-title">
        <header className="aov-heading"><div><h2 id="aov-shadow-title">Shadow</h2><p>Mercado real · capital virtual</p></div><span className={`aov-state ${shadow.some((row) => row.active) ? "is-active" : ""}`}>{shadow.some((row) => row.active) ? "ATIVO" : "EM ESPERA"}</span></header>
        <dl className="aov-metrics"><Metric label="Capital virtual" value={amount(shadowCapital)} unit="USDC" /><Metric label="Lucro realizado" value={signed(shadowProfit)} unit="USDC" positive={shadowProfit == null ? undefined : shadowProfit >= 0} /><Metric label="Gains acumulados" value={amount(shadowGains, 0)} /><Metric label="Operações concluídas" value={shadowConfigured.length ? amount(shadow.reduce((total, row) => total + row.operations, 0), 0) : "—"} /></dl>
        <div className="aov-assets">{shadow.map((row) => <article className="aov-asset" key={row.asset}><AssetHeading asset={row.asset} label={`${row.asset}/USDC`} state={row.state} warning={Boolean(row.config && !row.healthy)} /><dl className="aov-asset-metrics"><Metric label="Capital" value={amount(row.capital)} unit="USDC" /><Metric label="Lucro" value={signed(row.profit)} positive={row.profit == null ? undefined : row.profit >= 0} /><Metric label="Gains" value={amount(row.gains, 0)} /><Metric label="Slots físicos" value={row.accounts.length ? String(row.accounts.length) : "—"} /></dl><p className="aov-slot-state">{row.cycle ? <><strong>{row.open}</strong> abertos <span>·</span> <strong>{row.armed}</strong> próxima compra <span>·</span> <strong>{row.planned}</strong> planejados{row.missed ? <em> · {row.missed} níveis perdidos</em> : null}</> : "Nenhum ciclo ativo registrado"}</p></article>)}</div>
        <footer className="aov-footer"><span>Motor <time>{at(latest(shadow.map((row) => row.config?.last_engine_at)))}</time></span><a href="/automacao?view=shadow">Abrir Shadow <span aria-hidden="true">→</span></a></footer>
      </section>

      <section className="aov-environment aov-testnet" aria-labelledby="aov-testnet-title">
        <header className="aov-heading"><div><h2 id="aov-testnet-title">Testnet</h2><p>Binance · fundos fictícios</p></div><span className={`aov-state ${testnetDivergence ? "is-error" : testnetError ? "is-warning" : ""}`}>{testnetDivergence ? "DIVERGÊNCIA ATIVA" : testnetError ? "ATENÇÃO" : testnetActive ? "MOTOR OK" : "EM ESPERA"}</span></header>
        <dl className="aov-metrics"><Metric label="Capital do robô" value={amount(testnetCapital)} unit="USDC" /><Metric label="Lucro realizado" value={signed(testnetProfit)} unit="USDC" positive={testnetProfit == null ? undefined : testnetProfit >= 0} /><Metric label="Gains acumulados" value={amount(testnetGains, 0)} /><Metric label="Operações concluídas" value={testnetKnown.length ? amount(testnetKnown.reduce((total, row) => total + row.lifetimeOperations, 0), 0) : "—"} /></dl>
        <div className="aov-assets">{testnet.map(({ asset, persisted, result, health, lifetimeProfit, lifetimeGains }) => <article className="aov-asset" key={asset}><AssetHeading asset={asset} label={persisted?.run.symbol.replace(/(USDC|USDT|BRL)$/, "/$1") || `${asset}/USDC`} state={health?.label || "Sem ciclo Testnet"} warning={Boolean(health && !health.healthy)} error={health?.tone === "error"} healthy={health?.healthy} /><dl className="aov-asset-metrics"><Metric label="Capital" value={amount(result?.rows.length ? result.capital : null)} unit="USDC" /><Metric label="Lucro" value={signed(result?.rows.length ? lifetimeProfit : null)} positive={result?.rows.length ? lifetimeProfit >= 0 : undefined} /><Metric label="Gains" value={result?.rows.length ? amount(lifetimeGains, 0) : "—"} /><Metric label="Ordens abertas" value={persisted ? String(persisted.orders.filter((order) => OPEN_ORDERS.has(order.status)).length) : "—"} /></dl><p className="aov-slot-state">{result?.rows.length ? <><strong>{result.openSlots}</strong> abertos <span>·</span> <strong>{result.armedSlots}</strong> próxima compra <span>·</span> <strong>{result.reentryWaitingSlots}</strong> reentradas em espera <span>·</span> <strong>{result.plannedSlots}</strong> planejados <span>·</span> <strong>{result.activeErrorSlots}</strong> erros atuais</> : "Sem saldo operacional persistido para este ativo"}</p>{result ? <p className="aov-history-note">{result.temporalSummary.historicalCount} ocorrências históricas · {result.temporalSummary.currentVersionCount} missed desde versão atual · {result.temporalSummary.activeIssueCount} ocorrências ativas</p> : null}</article>)}</div>
        <footer className="aov-footer"><span>Reconciliação <time>{at(testnetAt)}</time></span><a href="/automacao?view=testnet">Abrir Testnet <span aria-hidden="true">→</span></a></footer>
      </section>

      <section className="aov-environment aov-real" aria-labelledby="aov-real-title">
        <header className="aov-heading"><div><h2 id="aov-real-title">Real</h2><p>Production · somente leitura</p></div><span className="aov-state">LIVE BLOQUEADO</span></header>
        <dl className="aov-metrics"><Metric label="Capital alocado ao robô" value="0" unit="BRL" /><Metric label="Lucro CoinOps real" value="0" unit="BRL" /><Metric label="Gains reais CoinOps" value="0" /><Metric label="Operações reais CoinOps" value="0" /></dl>
        <div className="aov-assets">{ASSETS.map((asset) => { const balance = data.balances.find((row) => row.asset === asset); return <article className="aov-asset" key={asset}><AssetHeading asset={asset} label={asset === "SOL" ? "SOL · piloto SOL/BRL" : "BTC · conta Binance"} state="READ-ONLY" /><dl className="aov-real-balances"><Metric label="Saldo consultado" value={amount(balance?.total, 8)} unit={asset} /><Metric label="Ordens CoinOps reais" value="0" /></dl><p className="aov-slot-state">Saldo da conta · não alocado ao robô</p><p className="aov-real-note">{asset === "SOL" ? data.solBrlPilot.accepted ? "Filtros SOL/BRL consultados · LIVE bloqueado" : "Preparação SOL/BRL · LIVE bloqueado" : "Consulta de saldo · execução real bloqueada"}</p></article>; })}</div>
        <footer className="aov-footer"><span>{realConnected ? "Binance conectada · GET" : "Conexão a verificar"}<time>{at(data.reconciliationAt || data.lastSyncedAt)}{data.mismatches ? ` · ${data.mismatches} itens a revisar` : ""}</time></span><a href="/automacao?view=live">Abrir Real <span aria-hidden="true">→</span></a></footer>
      </section>
    </div>

    <section className="aov-comparison" aria-labelledby="aov-comparison-title"><header><h2 id="aov-comparison-title">Comparação de Teste</h2><span>Shadow × Testnet · perfil de teste 0,5% / 1% · 25 slots</span></header>
      <div className="aov-comparison-scroll"><table><thead><tr><th>Ativo</th><th>Ambiente</th><th>Gains</th><th>Ciclos</th><th>P&amp;L</th><th>OPEN</th><th>NEXT BUY</th><th>Históricos</th><th>Missed atuais</th><th>Erros ativos</th><th>Saúde</th></tr></thead><tbody>{ASSETS.flatMap((asset) => {
        const sh = shadow.find((row) => row.asset === asset)!;
        const tn = testnet.find((row) => row.asset === asset)!;
        return [<tr key={`${asset}-shadow`}><th scope="row">{asset}</th><td>Shadow</td><td>{amount(sh.gains, 0)}</td><td>{sh.cycles}</td><td>{signed(sh.profit === null || sh.openPnl === null ? null : sh.profit + sh.openPnl)}</td><td>{sh.open}</td><td>{sh.armed}</td><td>—</td><td>{sh.missed}</td><td>{sh.config?.last_engine_error ? 1 : 0}</td><td>{sh.healthy ? "OK" : sh.state}</td></tr>,
          <tr key={`${asset}-testnet`}><th scope="row">{asset}</th><td>Testnet</td><td>{tn.persisted ? tn.lifetimeGains : "—"}</td><td>{tn.persisted ? 1 + (tn.persisted.history?.length || 0) : "—"}</td><td>{signed(tn.persisted && tn.result?.openPnl != null ? tn.lifetimeProfit + tn.result.openPnl : null)}</td><td>{tn.result?.openSlots ?? "—"}</td><td>{tn.result?.armedSlots ?? "—"}</td><td>{tn.result?.temporalSummary.historicalCount ?? "—"}</td><td>{tn.result?.temporalSummary.currentVersionCount ?? "—"}</td><td>{tn.result ? tn.result.activeErrorSlots + (tn.persisted?.run.last_error ? 1 : 0) : "—"}</td><td className={tn.health?.tone === "error" ? "av2-negative" : tn.health?.tone === "attention" ? "av2-warning" : "av2-positive"}>{tn.health?.label || "Não iniciado"}</td></tr>];
      })}</tbody></table></div><small>Diferenças são esperadas: Shadow simula candles; Testnet usa fills e taxas da exchange fictícia. P&amp;L aberto requer preço de mercado disponível.</small>
    </section>

    <section className="aov-activity" aria-labelledby="aov-activity-title"><header><h2 id="aov-activity-title">Atividade recente</h2><span>Trilhas separadas por ambiente</span><a href="/relatorios">Relatório completo <span aria-hidden="true">→</span></a></header>{activities.length ? <ol>{activities.map((event) => <li key={event.key}><span className={`aov-event-source ${event.environment}`}>{event.environment === "real" ? "REAL" : event.environment.toUpperCase()}</span><strong>{event.asset}</strong><span className="aov-event-label" title={event.label}>{event.label}</span><time dateTime={event.at}>{at(event.at)}</time></li>)}</ol> : <p className="aov-empty">Nenhum evento persistido disponível.</p>}</section>
  </div>;
}
