import type { AuditDatasets, AuditFilters } from "./report-engine.ts";
import type { AuditRow } from "./trigger-audit.ts";

type CheckContext = { source: Record<string, AuditRow[]>; incompleteSources: string[]; generatedAt: string; filters: AuditFilters; allOperations: AuditRow[]; allCapital: AuditRow[] };
const n = (value: unknown) => Number(value ?? 0);
const s = (value: unknown) => String(value ?? "");
const sum = (rows: AuditRow[], key: string) => rows.reduce((total, row) => total + n(row[key]), 0);
const same = (a: unknown, b: unknown) => Number.isFinite(n(a)) && Number.isFinite(n(b)) && Math.abs(n(a) - n(b)) <= 0.00000001;
const active = (value: unknown) => ["PREPARED", "PENDING", "NEW", "PARTIALLY_FILLED"].includes(s(value));
const reentryPriceBroken = (event: AuditRow) => event.previous_entry_price != null && event.reentry_price != null && !same(event.previous_entry_price, event.reentry_price);
const reentryRecovered = (event: AuditRow) => event.reentry_temporal_classification === "HISTORICAL_REPAIRED"
  && event.reentry_recovery_basis === "SAME_OPERATION_TICK_REPAIR_AND_PRICE_CONFIRMATION" && Boolean(event.reentry_recovery_event_id);
const duplicates = (rows: AuditRow[], key: (row: AuditRow) => string) => { const seen = new Set<string>(); return rows.some((row) => { const value = key(row); if (!value) return false; if (seen.has(value)) return true; seen.add(value); return false; }); };

/** Checks explain their evidence boundary. Missing input is WARNING, never PASS. */
export function buildAuditChecks(datasets: AuditDatasets, context: CheckContext): AuditRow[] {
  const checks: AuditRow[] = [];
  const incomplete = (...keys: string[]) => context.incompleteSources.some((source) => keys.some((key) => source === key || source.startsWith(`${key}:`)));
  const add = (code: string, status: "PASS" | "WARNING" | "FAIL", explanation: string, extra: AuditRow = {}) => checks.push({ code, status, explanation, ...extra });
  for (const summary of datasets.summary.filter((row) => row.environment !== "REAL")) {
    const environment = s(summary.environment), asset = s(summary.asset), extra = { environment, asset };
    const operations = datasets.operations.filter((row) => row.environment === environment && row.asset === asset && row.closed_at && Date.parse(s(row.closed_at)) >= Date.parse(context.filters.start) && Date.parse(s(row.closed_at)) < Date.parse(context.filters.end));
    const gains = datasets.gains.filter((row) => row.environment === environment && row.asset === asset);
    const sourceMissing = incomplete(environment === "SHADOW" ? "robot_v1_slot_operations" : "robot_v1_testnet_events");
    add("REALIZED_PROFIT_RECONCILES", sourceMissing ? "WARNING" : same(sum(operations, "net_profit"), summary.realized_pnl) ? "PASS" : "FAIL", sourceMissing ? "Operações incompletas; lucro do período não pode ser certificado." : "Lucro realizado confrontado com a soma das operações encerradas no período.", extra);
    add("GAINS_BY_PHYSICAL_SLOT", sourceMissing ? "WARNING" : gains.filter((gain) => n(gain.net_gain) > 0).length === n(summary.gains) && gains.every((gain) => n(gain.physical_slot) >= 1 && n(gain.physical_slot) <= 25) ? "PASS" : "FAIL", "Gains positivos conservam a identidade do slot físico e reconciliam com o total do período.", extra);
    const ledger = datasets.capital.filter((row) => row.environment === environment && row.asset === asset);
    const capitalMissing = summary.capital_start === null || summary.capital_end === null || incomplete(environment === "SHADOW" ? "robot_v1_slot_profit_credits" : "robot_v1_testnet_events");
    add("PERIOD_CAPITAL_LEDGER", capitalMissing ? "WARNING" : same(n(summary.capital_start) + sum(ledger, "net_profit") + sum(ledger, "contribution") - sum(ledger, "withdrawal"), summary.capital_end) ? "PASS" : "FAIL", capitalMissing ? "Baseline/ledger indisponível para reconstruir capital inicial e final." : "Capital final confrontado com capital inicial + lucro líquido + aportes − retiradas.", extra);
    const currentSlots = datasets.slots.filter((slot) => slot.environment === environment && slot.asset === asset);
    const activeCycles = datasets.cycles.filter((cycle) => cycle.environment === environment && cycle.asset === asset && !["CYCLE_COMPLETE", "COMPLETED", "FAILED"].includes(s(cycle.status)));
    const armed = currentSlots.filter((slot) => activeCycles.some((cycle) => cycle.cycle_id === slot.cycle_id) && slot.entry_state === "ARMED");
    const activeBuys = datasets.orders.filter((order) => order.environment === environment && order.asset === asset && order.side === "BUY" && active(order.status));
    const slotsMissing = incomplete(environment === "SHADOW" ? "robot_v1_slots" : "robot_v1_testnet_slots", environment === "SHADOW" ? "robot_v1_cycles" : "robot_v1_testnet_orders");
    add("SINGLE_ACTIVE_ENTRY", slotsMissing || !currentSlots.length ? "WARNING" : armed.length <= 1 && activeBuys.length <= 1 ? "PASS" : "FAIL", slotsMissing || !currentSlots.length ? "Não há snapshot completo para verificar a próxima BUY." : `Snapshot observado: ${armed.length} slot(s) armados e ${activeBuys.length} BUY(s) residentes; limite de um por ativo/ambiente.`, { ...extra, evidence_scope: "CURRENT_PERSISTED_SNAPSHOT" });
    const localReentries = datasets.events.filter((event) => event.environment === environment && event.asset === asset && ["SLOT_REENTRY_PLANNED", "SLOT_REENTRY_ARMED", "SHADOW_STATE_REPAIRED"].includes(s(event.event_type)) && n(event.other_open_positions) > 0);
    const incompleteReentry = localReentries.some((event) => event.previous_entry_price == null || event.reentry_price == null);
    const otherReentryBroken = (event: AuditRow) => event.balance_before !== null && event.balance_before !== undefined && n(event.balance_after) < n(event.balance_before)
      || event.gain_count_before !== null && event.gain_count_before !== undefined && n(event.gain_count_after) < n(event.gain_count_before)
      || !n(event.physical_slot_number);
    const missingCurrentSlotFor = (event: AuditRow) => activeCycles.some((cycle) => cycle.cycle_id === event.cycle_id)
      && !currentSlots.some((slot) => slot.cycle_id === event.cycle_id && n(slot.physical_slot_number) === n(event.physical_slot_number));
    const brokenReentry = localReentries.some((event) => reentryPriceBroken(event) || otherReentryBroken(event));
    const missingCurrentSlot = localReentries.some(missingCurrentSlotFor);
    const activeReentryFailures = localReentries.filter((event) => otherReentryBroken(event) || missingCurrentSlotFor(event)
      || reentryPriceBroken(event) && !reentryRecovered(event)).length;
    const recoveredReentries = localReentries.filter((event) => reentryPriceBroken(event) && reentryRecovered(event)).length;
    add("GAIN_WITH_OTHER_OPEN_MUST_PRESERVE_SLOT_REENTRY", brokenReentry || missingCurrentSlot ? "FAIL" : slotsMissing || !localReentries.length || incompleteReentry ? "WARNING" : "PASS",
      !localReentries.length ? "Nenhuma reciclagem local com outro OPEN foi observada no período; a regra não pôde ser exercitada." : brokenReentry || missingCurrentSlot ? `${activeReentryFailures} violação(ões) sem recuperação comprovada; ${recoveredReentries} desvio(s) histórico(s) de preço reparado(s), preservados como FAIL histórico. Recuperação exige evento exato e preço confirmado da mesma operação.` : incompleteReentry ? "Evento histórico sem preço anterior/novo comparável: falta de evidência não prova violação nem conformidade." : `${localReentries.length} evento(s) preservaram slot físico, preço anterior, compounding e ownership no mesmo ciclo.`,
      { ...extra, active_failures: activeReentryFailures, recovered_historical_failures: recoveredReentries,
        recovery_basis: recoveredReentries ? "SAME_OPERATION_TICK_REPAIR_AND_PRICE_CONFIRMATION" : null });
    const cycles = datasets.cycles.filter((cycle) => cycle.environment === environment && cycle.asset === asset).sort((a, b) => s(a.started_at).localeCompare(s(b.started_at)));
    const failedBeforeSlots = (cycle: AuditRow) => cycle.status === "FAILED"
      && !currentSlots.some((slot) => slot.cycle_id === cycle.cycle_id)
      && !context.allOperations.some((operation) => operation.cycle_id === cycle.cycle_id);
    for (const cycle of cycles) {
      const cycleSlots = currentSlots.filter((slot) => slot.cycle_id === cycle.cycle_id), unique = new Set(cycleSlots.map((slot) => n(slot.physical_slot_number)));
      const initializationFailed = failedBeforeSlots(cycle);
      add("PHYSICAL_SLOTS_25", slotsMissing || initializationFailed ? "WARNING" : cycleSlots.length === 25 && unique.size === 25 && [...unique].every((slot) => slot >= 1 && slot <= 25) ? "PASS" : "FAIL", initializationFailed ? `Inicialização histórica FAILED sem slots ou operações persistidos; motivo: ${s(cycle.completion_reason) || "não registrado"}. Não constitui uma grade ativa de 25 slots.` : `${cycleSlots.length} registros e ${unique.size} identidades físicas distintos; esperado 25.`, { ...extra, cycle_id: cycle.cycle_id });
      if (cycle.completed_at || cycle.status === "CYCLE_COMPLETE") add("RESET_HAS_REASON", cycle.completion_reason || cycle.reset_reason ? "PASS" : "WARNING", cycle.completion_reason || cycle.reset_reason ? `Conclusão/reset identificado: ${cycle.completion_reason ?? cycle.reset_reason}.` : "Ciclo concluído sem motivo persistido; não é possível reconstruir o reset integralmente.", { ...extra, cycle_id: cycle.cycle_id });
    }
    const operationalCycles = cycles.filter((cycle) => !failedBeforeSlots(cycle));
    const overlap = operationalCycles.some((cycle, index) => index > 0 && (!operationalCycles[index - 1]!.completed_at || Date.parse(s(operationalCycles[index - 1]!.completed_at)) > Date.parse(s(cycle.started_at))));
    add("CYCLES_DO_NOT_OVERLAP", incomplete(environment === "SHADOW" ? "robot_v1_cycles" : "robot_v1_testnet_runs") || !cycles.length ? "WARNING" : overlap ? environment === "TESTNET" ? "WARNING" : "FAIL" : "PASS", overlap ? "Há ciclos que se sobrepõem ou término não persistido; revisar a sequência e os motivos." : "Não há sobreposição identificada na sequência de ciclos disponível.", extra);
  }
  for (const environment of context.filters.environments.filter((value) => value !== "REAL")) for (const asset of context.filters.assets) {
    const symbol = `${asset}USDC`;
    const cycles = datasets.cycles.filter((row) => row.environment === environment && row.asset === asset);
    const current = cycles.filter((row) => !["CYCLE_COMPLETE", "COMPLETED", "FAILED"].includes(s(row.status)));
    const slots = datasets.slots.filter((row) => row.environment === environment && row.asset === asset && current.some((cycle) => cycle.cycle_id === row.cycle_id));
    const orders = datasets.orders.filter((row) => row.environment === environment && row.asset === asset && current.some((cycle) => cycle.cycle_id === row.cycle_id));
    const missing = incomplete(environment === "SHADOW" ? "robot_v1_cycles" : "robot_v1_testnet_runs", environment === "SHADOW" ? "robot_v1_slots" : "robot_v1_testnet_slots");
    const prefix = `${environment}_${asset}`;
    const profileMatch = current.every((cycle) => same(cycle.gain_rate, 0.005) && same(cycle.entry_spacing, 0.01) && n(cycle.slot_count) === 25 && s(cycle.symbol) === symbol);
    add(`${prefix}_PROFILE_MATCH`, missing || !current.length ? "WARNING" : profileMatch ? "PASS" : "FAIL", !current.length ? "Sem ciclo ativo para certificar o perfil de teste." : "Snapshot do ciclo ativo confrontado com 0,5% / 1% / 25 slots e par do ativo.", { environment, asset });
    const armed = slots.filter((slot) => slot.entry_state === "ARMED").length;
    const resident = orders.filter((order) => order.side === "BUY" && active(order.status)).length;
    add(`SINGLE_ACTIVE_ENTRY_${asset}`, missing || !current.length ? "WARNING" : armed <= 1 && resident <= 1 ? "PASS" : "FAIL", `Snapshot ${environment}/${asset}: ${armed} slot(s) armados e ${resident} BUY(s) residentes.`, { environment, asset });
    add("SLOT_COUNT_25", missing || !current.length ? "WARNING" : slots.length === 25 && new Set(slots.map((slot) => n(slot.physical_slot_number))).size === 25 ? "PASS" : "FAIL", "Ciclo ativo exige 25 identidades físicas distintas.", { environment, asset });
    const summary = datasets.summary.find((row) => row.environment === environment && row.asset === asset);
    const gains = datasets.gains.filter((row) => row.environment === environment && row.asset === asset && n(row.net_gain) > 0);
    add("GAIN_COUNTS_RECONCILE", !summary || incomplete(environment === "SHADOW" ? "robot_v1_slot_operations" : "robot_v1_testnet_orders") ? "WARNING" : gains.length === n(summary.gains) ? "PASS" : "FAIL", "Contagem de gains positivos confrontada com o resumo do período.", { environment, asset });
    const local = datasets.events.filter((row) => row.environment === environment && row.asset === asset && row.event_type === "SLOT_REENTRY_PLANNED");
    const comparableLocal = local.filter((event) => event.previous_entry_price != null && event.reentry_price != null);
    const brokenLocal = comparableLocal.filter(reentryPriceBroken), recoveredLocal = brokenLocal.filter(reentryRecovered);
    add("LOCAL_REENTRY_RULE", brokenLocal.length ? "FAIL"
      : !local.length || comparableLocal.length !== local.length ? "WARNING" : "PASS", !local.length ? "Nenhuma reentrada local observada no período." : brokenLocal.length ? `${brokenLocal.length} violação(ões) histórica(s) de preço; ${recoveredLocal.length} com reparo e preço da mesma operação confirmados. A ocorrência original não é apagada.` : comparableLocal.length !== local.length ? "Parte do histórico não registra ambos os preços; ausência não equivale a zero ou violação." : "Reentrada local conserva o preço anterior do slot físico.",
      { environment, asset, active_failures: brokenLocal.length - recoveredLocal.length, recovered_historical_failures: recoveredLocal.length,
        recovery_basis: recoveredLocal.length ? "SAME_OPERATION_TICK_REPAIR_AND_PRICE_CONFIRMATION" : null });
    const reset = datasets.events.filter((row) => row.environment === environment && row.asset === asset && ["CYCLE_RESTARTED", "NEW_CYCLE_STARTED"].includes(s(row.event_type)));
    add("GLOBAL_RESET_RULE", !reset.length ? "WARNING" : cycles.some((cycle) => cycle.completion_reason || cycle.reset_reason) ? "PASS" : "FAIL", !reset.length ? "Nenhum reset global observado no período." : "Reset e novo ciclo confrontados com motivo persistido.", { environment, asset });
  }
  const testnetActive = datasets.cycles.filter((cycle) => cycle.environment === "TESTNET" && !["CYCLE_COMPLETE", "COMPLETED", "FAILED"].includes(s(cycle.status)));
  const mixed = testnetActive.some((cycle) => s(cycle.symbol) !== `${s(cycle.asset)}USDC`) || duplicates(testnetActive, (cycle) => s(cycle.cycle_id));
  add("BTC_SOL_ISOLATION", !testnetActive.length || incomplete("robot_v1_testnet_runs") ? "WARNING" : mixed ? "FAIL" : "PASS", "Ciclos Testnet ativos mantêm par, ativo e identificador independentes.", { environment: "TESTNET" });
  const ledgerBroken = datasets.capital.filter((row) => row.balance_before === null || row.net_profit === null || row.balance_after === null || !same(n(row.balance_before) + n(row.net_profit) + n(row.contribution) - n(row.withdrawal), row.balance_after));
  add("COMPOUNDING_BALANCE_FORMULA", !datasets.capital.length ? "WARNING" : ledgerBroken.length ? "FAIL" : "PASS", !datasets.capital.length ? "Nenhum crédito no período para avaliar a fórmula de compounding." : `${datasets.capital.length} créditos verificados; ${ledgerBroken.length} divergências na fórmula antes + lucro líquido + aporte − retirada = depois.`);
  add("COMPOUNDING_RECONCILES", !datasets.capital.length ? "WARNING" : ledgerBroken.length ? "FAIL" : "PASS", "Compounding por slot confrontado com o ledger de créditos disponível.");
  for (const account of context.source.robot_v1_slot_accounts ?? []) {
    const config = (context.source.robot_v1_configs ?? []).find((row) => row.id === account.config_id);
    if (!context.filters.environments.includes("SHADOW") || !context.filters.assets.includes(s(config?.asset) as "BTC" | "SOL")) continue;
    const history = context.allOperations.filter((operation) => operation.environment === "SHADOW" && operation.config_id === account.config_id && operation.physical_slot_number === account.slot_number && operation.closed_at);
    const creditOps = new Set(context.allCapital.filter((row) => row.config_id === account.config_id && row.slot === account.slot_number).map((row) => row.source_operation));
    const archived = history.filter((row) => creditOps.has(row.operation_id));
    const historical = Date.parse(s(account.updated_at)) >= Math.min(Date.parse(context.filters.end), Date.parse(context.generatedAt));
    const manual = (context.source.robot_v1_manual_adjustments ?? []).filter((row) => row.environment === "SHADOW"
      && row.physical_slot_id === `SHADOW:${account.config_id}:${account.slot_number}`);
    const bad = !same(n(account.initial_balance_usdc) + n(account.net_profit_usdc) + n(account.manual_gain_usdc) + n(account.contribution_usdc), account.balance_usdc) || !same(sum(archived, "net_profit"), account.net_profit_usdc)
      || archived.filter((row) => n(row.net_profit) > 0).length + sum(manual, "gain_units") !== n(account.gain_count);
    add("PHYSICAL_SLOT_ACCOUNT_RECONCILES", historical || incomplete("robot_v1_slot_operations", "robot_v1_slot_profit_credits", "robot_v1_slot_accounts", "robot_v1_manual_adjustments") ? "WARNING" : bad ? "FAIL" : "PASS", historical ? "Conta atual foi modificada depois do fim do período; comparação histórica com snapshot atual seria inválida." : "Saldo, lucro de mercado e contagem total confrontados com operações e ajustes manuais assinados da mesma identidade física.", { environment: "SHADOW", asset: config?.asset, physical_slot_number: account.slot_number, evidence_scope: "CURRENT_PERSISTED_ACCOUNT" });
  }
  const operationDuplicate = duplicates(datasets.operations, (row) => `${row.environment}:${row.operation_id}`);
  add("OPERATION_IDS_UNIQUE", operationDuplicate ? "FAIL" : "PASS", operationDuplicate ? "Há operação repetida indevidamente no pacote." : "Cada operação tem uma identidade única por ambiente.");
  const eventDuplicate = duplicates(datasets.events, (row) => row.idempotency_key ? `${row.environment}:${row.environment === "TESTNET" ? row.cycle_id : ""}:${row.idempotency_key}` : "");
  add("EVENT_IDEMPOTENCY_UNIQUE", eventDuplicate ? "FAIL" : incomplete("robot_v1_audit_events", "robot_v1_testnet_events") ? "WARNING" : "PASS", eventDuplicate ? "Chave de idempotência duplicada dentro do mesmo escopo." : "Chaves de idempotência dos eventos não se repetem dentro do escopo.");
  const terminalEvents = datasets.events.filter((event) => ["SLOT_CLOSED", "CYCLE_COMPLETED", "SLOT_PROFIT_CREDITED", "BUY_FILLED", "SELL_FILLED"].includes(s(event.event_type)));
  const terminalDuplicate = duplicates(terminalEvents, (row) => {
    const details = row.details as AuditRow | null;
    // A Testnet slot can fill repeatedly in one cycle. Fill events predate
    // operation_sequence in their payload, but retain the unique exchange ID.
    const identity = ["BUY_FILLED", "SELL_FILLED"].includes(s(row.event_type))
      ? details?.clientOrderId ?? row.operation_id
      : row.operation_id ?? details?.clientOrderId ?? (row.event_type === "CYCLE_COMPLETED" ? row.cycle_id : row.event_type === "SLOT_CLOSED" ? `${row.cycle_id}:${row.slot}` : null);
    return identity ? `${row.environment}:${row.event_type}:${identity}` : "";
  });
  add("TERMINAL_EVENTS_UNIQUE", terminalDuplicate ? "FAIL" : incomplete("robot_v1_audit_events", "robot_v1_testnet_events") ? "WARNING" : "PASS", terminalDuplicate ? "Há evento terminal repetido para a mesma operação/ordem/ciclo." : "Nenhuma duplicação terminal encontrada nas identidades persistidas.");
  for (const environment of context.filters.environments.filter((value) => value !== "REAL")) {
    const slots = datasets.slots.filter((slot) => slot.environment === environment);
    const sellOrders = datasets.orders.filter((order) => order.environment === environment && order.side === "SELL");
    const orphanTp = environment === "SHADOW" ? slots.some((slot) => ["PENDING", "PARTIALLY_FILLED"].includes(s(slot.tp_status)) && n(slot.quantity) <= 0) : sellOrders.some((sell) => !datasets.orders.some((buy) => buy.environment === environment && buy.slot_id === sell.slot_id && buy.side === "BUY" && n(buy.executed_quantity) > 0));
    add("TP_HAS_POSITION", !slots.length || incomplete(environment === "SHADOW" ? "robot_v1_slots" : "robot_v1_testnet_orders") ? "WARNING" : orphanTp ? "FAIL" : "PASS", orphanTp ? "Foi encontrado TP sem posição preenchida correspondente." : "TPs têm posição preenchida no mesmo slot e ambiente.", { environment });
    const duplicateTp = environment === "SHADOW" ? duplicates(slots.filter((slot) => slot.sell_client_order_id), (row) => s(row.sell_client_order_id)) : duplicates(sellOrders, (row) => s(row.client_order_id));
    const overCoverage = environment === "TESTNET" && slots.some((slot) => {
      const orders = datasets.orders.filter((order) => order.slot_id === slot.slot_id), buys = orders.filter((order) => order.side === "BUY"), sells = orders.filter((order) => order.side === "SELL");
      return sum(sells, "executed_quantity") + sells.filter((order) => active(order.status)).reduce((total, order) => total + n(order.remaining_quantity), 0) > sum(buys, "executed_quantity") - sum(buys, "fee_base") + 1e-8;
    });
    add("TP_NOT_DUPLICATED", incomplete(environment === "SHADOW" ? "robot_v1_slots" : "robot_v1_testnet_orders") ? "WARNING" : duplicateTp || overCoverage ? "FAIL" : "PASS", duplicateTp || overCoverage ? "TP duplicado ou quantidade coberta maior que a posição." : "Sem IDs de TP duplicados; cobertura parcial não excede a posição persistida.", { environment });
  }
  if (context.filters.environments.includes("TESTNET")) add("TESTNET_OWNERSHIP", !datasets.orders.length || incomplete("robot_v1_testnet_orders", "robot_v1_testnet_slots") ? "WARNING" : datasets.orders.some((order) => order.ownership_verified !== true) ? "FAIL" : "PASS", "clientOrderId recalculado com run, slot, lado e revisão; vínculo ao slot/run verificado. Ordens manuais não são assumidas como CoinOps.", { environment: "TESTNET" });
  if (context.filters.environments.includes("REAL")) {
    const enabled = datasets.rules.some((rule) => ["production_write_enabled", "live_enabled"].includes(s(rule.parameter)) && rule.value === true);
    add("PRODUCTION_LIVE_BLOCKED", enabled ? "FAIL" : "PASS", "A versão exportada mantém LIVE bloqueado e Production somente leitura; exportação não chama a Binance.", { environment: "REAL", evidence_scope: "CURRENT_CODE_CONTRACT" });
    const violations = datasets.real.filter((row) => row.row_type === "PRODUCTION_WRITE_GUARD_VIOLATION");
    add("PRODUCTION_PERSISTED_WRITE_GUARD", incomplete("exchange_order_intents") ? "WARNING" : violations.length ? "FAIL" : "PASS", violations.length ? `${violations.length} intent(s) com referência de submissão Production; investigar imediatamente.` : "Nenhum intent CoinOps com referência de envio LIVE/REAL encontrado no período carregado.", { environment: "REAL", evidence_scope: "PERSISTED_ORDER_INTENTS" });
    add("PRODUCTION_HTTP_WRITE_HISTORY", "WARNING", "Não existe log histórico completo de métodos HTTP neste banco; ausência histórica de write não pode ser certificada apenas com snapshots.", { environment: "REAL" });
    add("PRODUCTION_NO_WRITE", violations.length ? "FAIL" : "WARNING", "Sem intent persistido de write CoinOps no escopo lido; histórico HTTP completo não está disponível.", { environment: "REAL" });
  }
  const triggerIncomplete = incomplete("robot_v1_audit_events", "robot_v1_market_candles") || datasets.market.some((row) => ["INCOMPLETE", "OBSERVED_WITHOUT_CANDLE", "PENDING_ENGINE_WINDOW"].includes(s(row.result)));
  const missing = datasets.market.filter((row) => row.result === "MISSING_ACTION");
  const noTriggerWindows = !datasets.market.some((row) => row.trigger_type);
  add("ARMED_TRIGGER_ACTIONS", missing.length ? "FAIL" : triggerIncomplete || noTriggerWindows ? "WARNING" : "PASS", missing.length ? `${missing.length} cruzamento(s) armado(s) sem ação correspondente; eventuais lacunas em outras janelas não anulam esta evidência.` : noTriggerWindows ? "Não há janelas de gatilhos Shadow avaliáveis neste escopo. Candles Production não comprovam gatilhos Testnet." : triggerIncomplete ? "Candles/eventos incompletos; detector não pode certificar cobertura integral." : "Nenhuma ação ausente encontrada nos gatilhos armados com evidência disponível; níveis planejados não são tratados como ordens.");
  const ambiguous = datasets.market.filter((row) => row.result === "AMBIGUOUS");
  add("INTRABAR_AMBIGUITY", ambiguous.length ? "WARNING" : "PASS", ambiguous.length ? `${ambiguous.length} vela(s) cruzaram BUY e TP; ordem intrabar é indeterminável e não foi convertida em erro.` : "Nenhuma ambiguidade intrabar detectada nas janelas avaliadas.");
  const gaps = datasets.alerts.filter((row) => ["EXECUTION_GAP", "ENGINE_STALE", "MISSING_CANDLES", "DATA_GAP"].includes(s(row.code)));
  const incompleteHealth = context.incompleteSources.some((row) => /engine_execution_history/.test(row));
  add("ENGINE_CRON_HEALTH", gaps.length || incompleteHealth ? "WARNING" : "PASS", gaps.length ? `${gaps.length} gaps/atrasos na evidência; verificar pausas e execuções.` : incompleteHealth ? "Histórico completo de invocações não persistido para parte do período; último heartbeat não prova execução contínua." : "Nenhum intervalo anormal encontrado nas execuções persistidas disponíveis.");
  add("SOURCE_COMPLETENESS", context.incompleteSources.length ? "WARNING" : "PASS", context.incompleteSources.length ? `${context.incompleteSources.length} fontes/campos têm cobertura incompleta; consulte manifest.incomplete_sources.` : "As fontes solicitadas foram lidas sem truncamento ou falha.");
  return checks;
}
