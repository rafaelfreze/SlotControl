import type { AuditDatasets, AuditFilters } from "./report-engine.ts";
import type { AuditRow } from "./trigger-audit.ts";

type CheckContext = { source: Record<string, AuditRow[]>; incompleteSources: string[]; generatedAt: string; filters: AuditFilters; allOperations: AuditRow[]; allCapital: AuditRow[] };
const n = (value: unknown) => Number(value ?? 0);
const s = (value: unknown) => String(value ?? "");
const sum = (rows: AuditRow[], key: string) => rows.reduce((total, row) => total + n(row[key]), 0);
const same = (a: unknown, b: unknown) => Number.isFinite(n(a)) && Number.isFinite(n(b)) && Math.abs(n(a) - n(b)) <= 0.00000001;
const active = (value: unknown) => ["PREPARED", "PENDING", "NEW", "PARTIALLY_FILLED"].includes(s(value));
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
  const ledgerBroken = datasets.capital.filter((row) => row.balance_before === null || row.net_profit === null || row.balance_after === null || !same(n(row.balance_before) + n(row.net_profit) + n(row.contribution) - n(row.withdrawal), row.balance_after));
  add("COMPOUNDING_BALANCE_FORMULA", !datasets.capital.length ? "WARNING" : ledgerBroken.length ? "FAIL" : "PASS", !datasets.capital.length ? "Nenhum crédito no período para avaliar a fórmula de compounding." : `${datasets.capital.length} créditos verificados; ${ledgerBroken.length} divergências na fórmula antes + lucro líquido + aporte − retirada = depois.`);
  for (const account of context.source.robot_v1_slot_accounts ?? []) {
    const config = (context.source.robot_v1_configs ?? []).find((row) => row.id === account.config_id);
    if (!context.filters.environments.includes("SHADOW") || !context.filters.assets.includes(s(config?.asset) as "BTC" | "SOL")) continue;
    const history = context.allOperations.filter((operation) => operation.environment === "SHADOW" && operation.config_id === account.config_id && operation.physical_slot_number === account.slot_number && operation.closed_at);
    const creditOps = new Set(context.allCapital.filter((row) => row.config_id === account.config_id && row.slot === account.slot_number).map((row) => row.source_operation));
    const archived = history.filter((row) => creditOps.has(row.operation_id));
    const historical = Date.parse(s(account.updated_at)) >= Math.min(Date.parse(context.filters.end), Date.parse(context.generatedAt));
    const bad = !same(n(account.initial_balance_usdc) + n(account.net_profit_usdc), account.balance_usdc) || !same(sum(archived, "net_profit"), account.net_profit_usdc) || archived.length !== n(account.gain_count);
    add("PHYSICAL_SLOT_ACCOUNT_RECONCILES", historical || incomplete("robot_v1_slot_operations", "robot_v1_slot_profit_credits", "robot_v1_slot_accounts") ? "WARNING" : bad ? "FAIL" : "PASS", historical ? "Conta atual foi modificada depois do fim do período; comparação histórica com snapshot atual seria inválida." : "Saldo, lucro acumulado e contagem da conta física confrontados com seus créditos e operações imutáveis.", { environment: "SHADOW", asset: config?.asset, physical_slot_number: account.slot_number, evidence_scope: "CURRENT_PERSISTED_ACCOUNT" });
  }
  const operationDuplicate = duplicates(datasets.operations, (row) => `${row.environment}:${row.operation_id}`);
  add("OPERATION_IDS_UNIQUE", operationDuplicate ? "FAIL" : "PASS", operationDuplicate ? "Há operação repetida indevidamente no pacote." : "Cada operação tem uma identidade única por ambiente.");
  const eventDuplicate = duplicates(datasets.events, (row) => row.idempotency_key ? `${row.environment}:${row.environment === "TESTNET" ? row.cycle_id : ""}:${row.idempotency_key}` : "");
  add("EVENT_IDEMPOTENCY_UNIQUE", eventDuplicate ? "FAIL" : incomplete("robot_v1_audit_events", "robot_v1_testnet_events") ? "WARNING" : "PASS", eventDuplicate ? "Chave de idempotência duplicada dentro do mesmo escopo." : "Chaves de idempotência dos eventos não se repetem dentro do escopo.");
  const terminalEvents = datasets.events.filter((event) => ["SLOT_CLOSED", "CYCLE_COMPLETED", "SLOT_PROFIT_CREDITED", "BUY_FILLED", "SELL_FILLED"].includes(s(event.event_type)));
  const terminalDuplicate = duplicates(terminalEvents, (row) => {
    const details = row.details as AuditRow | null;
    const identity = row.operation_id ?? details?.clientOrderId ?? (row.event_type === "CYCLE_COMPLETED" ? row.cycle_id : row.event_type === "SLOT_CLOSED" ? `${row.cycle_id}:${row.slot}` : null);
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
  }
  const triggerIncomplete = incomplete("robot_v1_audit_events", "robot_v1_market_candles") || datasets.market.some((row) => ["INCOMPLETE", "OBSERVED_WITHOUT_CANDLE", "PENDING_ENGINE_WINDOW"].includes(s(row.result)));
  const missing = datasets.market.filter((row) => row.result === "MISSING_ACTION");
  add("ARMED_TRIGGER_ACTIONS", triggerIncomplete || !datasets.market.some((row) => row.trigger_type) ? "WARNING" : missing.length ? "FAIL" : "PASS", triggerIncomplete ? "Candles/eventos incompletos; detector não pode certificar cobertura integral." : missing.length ? `${missing.length} cruzamento(s) armado(s) sem ação correspondente.` : "Nenhuma ação ausente encontrada nos gatilhos armados com evidência disponível; níveis planejados não são tratados como ordens.");
  const ambiguous = datasets.market.filter((row) => row.result === "AMBIGUOUS");
  add("INTRABAR_AMBIGUITY", ambiguous.length ? "WARNING" : "PASS", ambiguous.length ? `${ambiguous.length} vela(s) cruzaram BUY e TP; ordem intrabar é indeterminável e não foi convertida em erro.` : "Nenhuma ambiguidade intrabar detectada nas janelas avaliadas.");
  const gaps = datasets.alerts.filter((row) => ["EXECUTION_GAP", "ENGINE_STALE", "MISSING_CANDLES", "DATA_GAP"].includes(s(row.code)));
  const incompleteHealth = context.incompleteSources.some((row) => /engine_execution_history/.test(row));
  add("ENGINE_CRON_HEALTH", gaps.length || incompleteHealth ? "WARNING" : "PASS", gaps.length ? `${gaps.length} gaps/atrasos na evidência; verificar pausas e execuções.` : incompleteHealth ? "Histórico completo de invocações não persistido para parte do período; último heartbeat não prova execução contínua." : "Nenhum intervalo anormal encontrado nas execuções persistidas disponíveis.");
  add("SOURCE_COMPLETENESS", context.incompleteSources.length ? "WARNING" : "PASS", context.incompleteSources.length ? `${context.incompleteSources.length} fontes/campos têm cobertura incompleta; consulte manifest.incomplete_sources.` : "As fontes solicitadas foram lidas sem truncamento ou falha.");
  return checks;
}
