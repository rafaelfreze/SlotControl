import type { AuditDatasets, AuditFilters } from "./report-engine.ts";
import type { AuditRow } from "./trigger-audit.ts";
import { sanitizeExportValue } from "./export-format.ts";

const string = (value: unknown) => String(value ?? "");
const time = (value: unknown) => Date.parse(string(value));
const object = (value: unknown): AuditRow => value && typeof value === "object" && !Array.isArray(value) ? value as AuditRow : {};
const active = (value: unknown) => ["NEW", "PREPARED", "PARTIALLY_FILLED", "PENDING"].includes(string(value));
const external = (row: AuditRow) => ["OPEN_INITIAL_MARKET", "CREATE_TP", "ARM_NEXT_BUY", "CANCEL_REPLACE_NEXT_BUY"].includes(string(row.action_type));
const fields = "id environment asset decision_id strategy_version cycle_id slot_id operation_id operation_sequence action_type target_price target_notional priority reason expected_next_state observed_next_state created_at dispatched_at exchange_ack_at completed_at result error latency_ms root_cause resolved_by_version".split(" ");

/** Only persisted decisions are exported. Legacy execution is never backfilled. */
export function normalizeStrategyDecisions(rows: AuditRow[]): AuditRow[] {
  return rows.map((row) => sanitizeExportValue({ ...Object.fromEntries(fields.map((field) => [field, row[field] ?? null])),
    symbol: `${row.asset}USDC`, source: "robot_v1_strategy_decisions", evidence_basis: "PERSISTED_STRATEGY_DECISION",
    decision_created_at: row.created_at ?? null, decision_dispatched_at: row.dispatched_at ?? null,
    first_cross_at: object(row.observed_next_state).first_cross_at ?? null,
    order_resident_at: object(row.observed_next_state).order_resident_at ?? null,
    decision_latency_ms: Number.isFinite(time(row.completed_at)) && Number.isFinite(time(row.created_at)) ? time(row.completed_at) - time(row.created_at) : null,
  }) as AuditRow);
}

type Context = { incompleteSources: string[]; generatedAt: string; filters: AuditFilters };
/** Read-only parity proof: no version-only PASS, no missing-evidence success. */
export function buildStrategyAuditChecks(data: AuditDatasets, context: Context): AuditRow[] {
  const checks: AuditRow[] = [];
  const add = (code: string, status: "PASS" | "WARNING" | "FAIL", explanation: string, extra: AuditRow = {}) => checks.push({ code, status, explanation, ...extra });
  const missing = context.incompleteSources.some((name) => name.startsWith("robot_v1_strategy_decisions"));
  const currentSnapshot = time(context.filters.end) >= time(context.generatedAt);
  for (const environment of context.filters.environments.filter((value) => value !== "REAL")) for (const asset of context.filters.assets) {
    const scope = { environment, asset };
    const decisions = data.decisions.filter((row) => row.environment === environment && row.asset === asset);
    const cycles = data.cycles.filter((row) => row.environment === environment && row.asset === asset);
    const current = cycles.filter((row) => !["COMPLETED", "CYCLE_COMPLETE", "FAILED"].includes(string(row.status)));
    const latestDecisions = current.flatMap((cycle) => {
      const latest = decisions.filter((row) => row.cycle_id === cycle.cycle_id).at(-1);
      return latest ? [latest] : [];
    });
    const versions = new Set([...current, ...latestDecisions].map((row) => string(row.strategy_version)).filter(Boolean));
    add("STRATEGY_VERSION_PARITY", !currentSnapshot || missing || latestDecisions.length !== current.length || !current.length || current.some((row) => !row.strategy_version) ? "WARNING" : versions.size === 1 ? "PASS" : "FAIL",
      "Versão persistida do ciclo e das decisões; histórico sem versão não é certificado retroativamente.", scope);
    const ids = decisions.map((row) => string(row.decision_id));
    add("STRATEGY_DECISION_IDEMPOTENCY", !decisions.length || missing ? "WARNING" : ids.some((id) => !id) || new Set(ids).size !== ids.length ? "FAIL" : "PASS", "Uma identidade por decisão, ambiente, ativo e escopo.", scope);
    const expired = decisions.filter((row) => time(context.generatedAt) - time(row.created_at) > 120_000);
    const undispatched = expired.filter((row) => !row.dispatched_at && row.action_type !== "WAIT");
    const unacknowledged = expired.filter((row) => environment === "TESTNET" && external(row) && row.dispatched_at && !row.exchange_ack_at);
    const failures = decisions.filter((row) => row.result === "FAILED" || row.error);
    const pendingDispatch = decisions.some((row) => !row.dispatched_at && row.action_type !== "WAIT");
    const pendingAck = decisions.some((row) => external(row) && !row.exchange_ack_at);
    add("STRATEGY_DECISION_DISPATCH", undispatched.length || failures.length ? "FAIL" : missing || !decisions.length || pendingDispatch ? "WARNING" : "PASS", `${undispatched.length} decisão(ões) há mais de 120s sem despacho; ${failures.length} falha(s) persistida(s). Pendências dentro da janela ainda não são sucesso.`, scope);
    add("STRATEGY_DECISION_ACK", unacknowledged.length ? "FAIL" : environment === "SHADOW" || missing || !decisions.some(external) || pendingAck ? "WARNING" : "PASS", environment === "SHADOW" ? "Shadow não possui ACK de exchange; conclusão simulada é evidência distinta." : `${unacknowledged.length} decisão(ões) enviada(s) há mais de 120s sem ACK Testnet.`, scope);
    for (const cycle of cycles) {
      const initialOrders = data.orders.filter((row) => row.environment === environment && row.cycle_id === cycle.cycle_id && row.purpose === "INITIAL" && row.side === "BUY");
      const initialEvents = data.events.filter((row) => row.environment === environment && row.cycle_id === cycle.cycle_id && row.event_type === "INITIAL_POSITION_OPENED");
      const initialDecision = decisions.find((row) => row.cycle_id === cycle.cycle_id && row.action_type === "OPEN_INITIAL_MARKET");
      const filled = environment === "TESTNET" ? initialOrders.some((row) => row.status === "FILLED" && Number(row.executed_quantity) > 0) : initialEvents.length > 0;
      const overdue = Boolean((initialDecision || cycle.strategy_version) && time(context.generatedAt) - time(initialDecision?.created_at ?? cycle.started_at) > 120_000);
      add("NEW_CYCLE_MUST_HAVE_INITIAL_MARKET_FILL", filled ? "PASS" : overdue ? "FAIL" : "WARNING", filled ? "Entrada inicial preenchida persistida, distinta de reentrada local." : "Não há fill inicial comprovado neste recorte; nenhum fill foi inventado.", { ...scope, cycle_id: cycle.cycle_id });
    }
    for (const cycle of current) {
      const slots = data.slots.filter((row) => row.environment === environment && row.cycle_id === cycle.cycle_id);
      const armed = slots.filter((row) => row.entry_state === "ARMED");
      const lastQueue = decisions.filter((row) => row.cycle_id === cycle.cycle_id && ["ARM_NEXT_BUY", "CANCEL_REPLACE_NEXT_BUY", "WAIT"].includes(string(row.action_type))).at(-1);
      const observed = object(lastQueue?.observed_next_state);
      const market = Number(observed.market_price ?? observed.marketPrice);
      const priorityEvidence = currentSnapshot && Number.isFinite(market) && market > 0 && armed.length === 1;
      const partialResident = armed.some((slot) => slot.buy_status === "PARTIALLY_FILLED" || data.orders.some((order) => order.environment === environment && order.slot_id === slot.slot_id && order.side === "BUY" && active(order.status) && Number(order.executed_quantity) > 0));
      const higher = priorityEvidence && slots.some((slot) => slot.entry_state === "PLANNED" && !slot.missed_at && Number(slot.buy_price) < market && Number(slot.buy_price) > Number(armed[0]!.buy_price));
      const missed = slots.filter((row) => row.missed_at);
      add("PRIORITY_REENTRY_MUST_BE_ARMED_BEFORE_LOWER_LEVEL", higher && !partialResident ? "FAIL" : missing || !priorityEvidence || partialResident ? "WARNING" : "PASS", partialResident ? "BUY parcialmente preenchida protegida contra cancel/replace; candidato prioritário aguarda tratamento seguro do fill." : higher ? "Há candidato válido acima da BUY residente; prioridade de reentrada violada." : priorityEvidence ? "BUY residente confrontada com candidatos e mercado observado; níveis cruzados não viram MARKET." : "Falta snapshot de mercado/BUY residente para certificar a prioridade.", { ...scope, cycle_id: cycle.cycle_id, expected: "HIGHEST_VALID_TARGET_BELOW_MARKET; PARTIAL_FILL_PROTECTED", observed: armed[0]?.buy_price ?? null });
      add("MISSED_LEVEL_RECOVERY_EVIDENCE", missed.length ? "WARNING" : slots.length ? "PASS" : "WARNING", missed.length ? `${missed.length} nível(is) perdido(s) preservado(s); revisão histórica não é fill nem apaga divergência.` : "Nenhum missed level no snapshot atual.", { ...scope, cycle_id: cycle.cycle_id });
      const open = slots.filter((row) => ["OPEN", "TP_ACTIVE", "PARTIALLY_FILLED"].includes(string(row.status)));
      const unprotected = open.filter((row) => environment === "SHADOW" ? !active(row.tp_status) : !data.orders.some((order) => order.environment === environment && order.slot_id === row.slot_id && order.side === "SELL" && active(order.status)));
      add("OPEN_POSITION_HAS_RESIDENT_TP", !slots.length ? "WARNING" : unprotected.length ? "FAIL" : "PASS", `${unprotected.length} posição(ões) OPEN sem proteção TP persistida.`, { ...scope, cycle_id: cycle.cycle_id });
    }
    const fills = data.events.filter((row) => row.environment === environment && row.asset === asset && row.event_type === "TESTNET_FILL_OBSERVED");
    const orphans = fills.filter((row) => !data.orders.some((order) => order.environment === environment && order.cycle_id === row.cycle_id && order.client_order_id === object(row.details).clientOrderId));
    if (environment === "TESTNET") add("FILL_HAS_COINOPS_ORDER", orphans.length ? "FAIL" : !fills.length || context.incompleteSources.some((name) => name.startsWith("robot_v1_testnet_orders")) ? "WARNING" : "PASS", `${orphans.length} fill(s) sem ordem CoinOps correspondente; ausência histórica de fills não certifica completude.`, scope);
  }
  const activeCycles = data.cycles.filter((row) => row.environment !== "REAL" && !["COMPLETED", "CYCLE_COMPLETE", "FAILED"].includes(string(row.status)));
  const coverage = new Set(activeCycles.map((row) => `${row.environment}:${row.asset}`));
  const versions = new Set(activeCycles.map((row) => string(row.strategy_version)));
  const complete = ["SHADOW:BTC", "SHADOW:SOL", "TESTNET:BTC", "TESTNET:SOL"].every((key) => coverage.has(key)) && versions.size === 1 && !versions.has("");
  const relevant = [...data.checks, ...checks].filter((row) => row.code !== "STRATEGY_DECISION_ACK" || row.environment !== "SHADOW");
  const failed = relevant.some((row) => row.status === "FAIL");
  add("LIVE_STRATEGY_PARITY_READY", failed ? "FAIL" : !complete || context.incompleteSources.length || relevant.some((row) => row.status !== "PASS") ? "WARNING" : "PASS", "Exige os quatro motores, versão única, evidência completa e todos os checks aplicáveis aprovados. Mesmo PASS não habilita LIVE; Production permanece READ-ONLY.", { live_enabled: false, production_write_enabled: false, evidence_scope: "PERSISTED_PARITY_EVIDENCE" });
  return checks;
}
