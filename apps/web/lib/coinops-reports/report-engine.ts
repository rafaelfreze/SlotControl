import { buildAuditChecks } from "./audit-checks.ts";
import { buildStrategyAuditChecks, normalizeStrategyDecisions } from "./strategy-audit.ts";
import { buildTestnetMissedOccurrences, STRATEGY_4_1_EFFECTIVE_AT, summarizeTemporalMissed } from "./missed-level-temporal.ts";
import { testnetClientOrderId } from "../execution/robot-v1-testnet-cycle.ts";
import { auditExecutionGaps, auditTriggerWindows, type AuditRow, type TriggerWindow } from "./trigger-audit.ts";
import { buildMonthlyAuditRows } from "./monthly-audit.ts";
import { buildMonthlyGoalChecks } from "./monthly-audit-checks.ts";
import { monthlyPeriodKey } from "../execution/monthly-slot-policy.ts";

export type ReportEnvironment = "SHADOW" | "TESTNET" | "REAL";
export type ReportAsset = "BTC" | "SOL";
export type AuditFilters = { start: string; end: string; assets: ReportAsset[]; environments: ReportEnvironment[]; temporalWindow?: "SINCE_STRATEGY_4_1" };
export type AuditInput = { sources: Record<string, AuditRow[]>; incompleteSources: string[]; warnings: string[]; generatedAt: string; scope: { tenantId: string; userId: string } };
export const REPORT_DATASET_KEYS = ["summary", "cycles", "slots", "operations", "orders", "events", "gains", "capital", "market", "reconciliation", "alerts", "rules", "checks", "testnet", "real", "decisions", "missed_temporal", "monthly_goals"] as const;
export type AuditDatasets = Record<typeof REPORT_DATASET_KEYS[number], AuditRow[]>;
export type AuditReport = { datasets: AuditDatasets; warnings: string[]; incompleteSources: string[] };
export type ReportRuleDefinition = { parameter: string; field: string; unit: string; version: number; notes?: string };

/** Extension contract: an operational config field must have an export rule entry.
 * Cycle snapshots, rather than today's defaults, are authoritative for old cycles. */
export const REPORT_RULE_CONTRACT: readonly ReportRuleDefinition[] = [
  { parameter: "strategy_version", field: "strategy_version", unit: "version", version: 2, notes: "Versão efetivamente adotada; null preserva ausência de evidência histórica." },
  { parameter: "gain_rate", field: "gain_rate", unit: "ratio", version: 1 },
  { parameter: "entry_spacing", field: "entry_spacing", unit: "ratio", version: 1 },
  { parameter: "slot_count", field: "slot_count", unit: "slots", version: 1 },
  { parameter: "capital", field: "capital_usdc", unit: "USDC", version: 1 },
  { parameter: "mode", field: "execution_mode", unit: "enum", version: 1 },
  { parameter: "kill_switch", field: "kill_switch", unit: "boolean", version: 1 },
  { parameter: "pause_new_entries", field: "pause_new_entries", unit: "boolean", version: 1 },
  { parameter: "next_capital", field: "next_capital_usdc", unit: "USDC", version: 1 },
  { parameter: "next_gain_rate", field: "next_gain_rate", unit: "ratio", version: 1 },
  { parameter: "next_entry_spacing", field: "next_entry_spacing", unit: "ratio", version: 1 },
  { parameter: "configured_live_capital", field: "configured_live_capital_brl", unit: "BRL", version: 1 },
  { parameter: "max_order_notional", field: "max_order_notional_brl", unit: "BRL", version: 1 },
  { parameter: "max_total_exposure", field: "max_total_exposure_brl", unit: "BRL", version: 1 }
];
const str = (value: unknown) => typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
const num = (value: unknown): number | null => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const number = (value: unknown) => num(value) ?? 0;
const timestamp = (value: unknown) => Date.parse(str(value));
const object = (value: unknown): AuditRow => value && typeof value === "object" && !Array.isArray(value) ? value as AuditRow : {};
const sum = (rows: AuditRow[], key: string) => Number(rows.reduce((total, row) => total + number(row[key]), 0).toFixed(12));
const assetOf = (row: AuditRow) => str(row.asset) || (str(row.symbol).startsWith("BTC") ? "BTC" : str(row.symbol).startsWith("SOL") ? "SOL" : "");
const iso = (value: unknown) => Number.isFinite(timestamp(value)) ? new Date(timestamp(value)).toISOString() : null;
const duration = (start: unknown, end: unknown) => Number.isFinite(timestamp(start)) && Number.isFinite(timestamp(end)) ? Math.max(0, timestamp(end) - timestamp(start)) : null;
const inPeriod = (value: unknown, filters: AuditFilters) => timestamp(value) >= timestamp(filters.start) && timestamp(value) < timestamp(filters.end);
const overlap = (start: unknown, end: unknown, filters: AuditFilters) => timestamp(start) < timestamp(filters.end) && (!end || timestamp(end) >= timestamp(filters.start));
const activeOrder = (status: unknown) => ["PREPARED", "NEW", "PARTIALLY_FILLED", "PENDING"].includes(str(status));
const byTime = (a: AuditRow, b: AuditRow) => str(a.timestamp ?? a.started_at ?? a.opened_at ?? a.created_at).localeCompare(str(b.timestamp ?? b.started_at ?? b.opened_at ?? b.created_at)) || JSON.stringify(a).localeCompare(JSON.stringify(b));
const localTime = (value: unknown) => {
  if (!iso(value)) return null;
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Campo_Grande", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(str(value)));
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: "America/Campo_Grande", timeZoneName: "longOffset" }).formatToParts(new Date(str(value))).find((part) => part.type === "timeZoneName")?.value.replace("GMT", "") || "+00:00";
  return `${parts.replace(" ", "T")}${offset}`;
};
const allowedDetails = new Set(["asset", "symbol", "capital", "slots", "slotCount", "slotNumber", "logicalLevel", "operationSequence", "operationId", "cycleId", "anchorPrice", "gainRate", "entrySpacing", "buyPrice", "takeProfitPrice", "triggerPrice", "targetPrice", "target", "fillPrice", "observedPrice", "observedLow", "observedHigh", "observedFloor", "marketPrice", "price", "quantity", "executedQuantity", "cumulativeQuote", "grossProfit", "estimatedFees", "netProfit", "netProfitUsdc", "profitUsdc", "balanceUsdc", "gainCount", "status", "mode", "reason", "action", "errors", "nextCapitalApplied", "invalidatedPendingSlots", "anchorFrom", "requestedStart", "firstAvailable", "clientOrderId", "exchangeOrderId", "canceledClientOrderId", "replacementClientOrderId", "slotNotional", "pauseNewEntries", "killSwitch", "gain_rate", "entry_spacing", "capital_usdc", "next_capital_usdc", "next_gain_rate", "next_entry_spacing"]);
for (const field of ["tradeId", "side", "quoteQuantity", "commission", "commissionAsset", "filledAt", "collectedAt", "timestampBasis"]) allowedDetails.add(field);
for (const field of ["reset_after_last_tp", "old_next_buy_canceled", "new_cycle_started", "initial_reentry_filled", "new_tp_created", "next_buy_armed", "reset_latency_ms", "recovery_source", "previous_entry_price", "reentry_price", "balance_before", "balance_after", "gain_count_before", "gain_count_after", "other_open_positions", "local_recycle_vs_global_reset", "ownership_verified", "replacementSlotNumber"]) allowedDetails.add(field);
for (const field of ["previousEntryPrice", "reentryPrice", "balanceBefore", "balanceAfter", "gainCountBefore", "gainCountAfter", "otherOpenPositions", "localRecycleVsGlobalReset", "physicalSlotNumber", "repairReason"]) allowedDetails.add(field);
for (const field of ["strategy_version", "decision_id", "root_cause", "first_cross_at", "decision_created_at", "decision_dispatched_at", "exchange_ack_at", "order_resident_at", "latency_ms", "resolved_by_version", "expected_behavior", "observed_behavior", "operation_sequence", "target_price", "market_price", "filled_at", "collected_at", "source", "reconciliation_gap_ms"]) allowedDetails.add(field);
for (const field of ["expected_interval_seconds", "fallback_interval_seconds", "age_before_ms", "started_at", "finished_at", "duration_ms", "outcome", "last_reconciled_at", "error", "app_commit_sha", "remedy"]) allowedDetails.add(field);
for (const field of ["occurred_at", "occurred_at_basis", "occurred_by_at", "detected_at", "created_at", "strategy_effective_at", "temporal_classification", "is_active_issue", "resolved_at", "evidence_source", "fact_strategy_version", "source_event_at", "causal_evidence"]) allowedDetails.add(field);
for (const field of ["operation_id", "original_event_id", "original_created_at", "strategy_version_at_occurrence", "detected_by_strategy_version", "external_evidence"]) allowedDetails.add(field);
function safeDetails(value: unknown): AuditRow {
  return Object.fromEntries(Object.entries(object(value)).filter(([key]) => allowedDetails.has(key)).map(([key, field]) => [key,
    typeof field === "string" && /bearer\s|(?:secret|password|api[_ -]?key|authorization)\s*[:=]|eyJ[A-Za-z0-9_-]+\./i.test(field) ? "[REDACTED]" : field
  ]));
}
function selected(row: AuditRow, filters: AuditFilters) {
  return filters.environments.includes(str(row.environment) as ReportEnvironment) && (!assetOf(row) || filters.assets.includes(assetOf(row) as ReportAsset));
}

export function buildAuditReport(input: AuditInput, filters: AuditFilters, extensions: readonly ReportRuleDefinition[] = []): AuditReport {
  if (!Number.isFinite(timestamp(filters.start)) || !Number.isFinite(timestamp(filters.end)) || timestamp(filters.start) >= timestamp(filters.end)) throw new Error("COINOPS_REPORT_PERIOD_INVALID");
  const warnings = [...input.warnings], incompleteSources = [...input.incompleteSources];
  // Defense in depth: the authenticated loader already scopes every query. Never
  // silently export a cross-tenant row passed to this pure layer by a future caller.
  for (const rows of Object.values(input.sources)) for (const row of rows) {
    if ((row.tenant_id !== undefined && row.tenant_id !== input.scope.tenantId) || (row.user_id !== undefined && row.user_id !== input.scope.userId)) throw new Error("COINOPS_REPORT_SCOPE_MISMATCH");
  }
  const source = (key: string) => input.sources[key] ?? [];
  const missing = (key: string) => incompleteSources.some((item) => item === key || item.startsWith(`${key}:`));
  const configs = source("robot_v1_configs"), cycles = source("robot_v1_cycles"), slots = source("robot_v1_slots");
  const accounts = source("robot_v1_slot_accounts"), credits = source("robot_v1_slot_profit_credits");
  const rawOperations = source("robot_v1_slot_operations"), testnetRuns = source("robot_v1_testnet_runs"), testnetSlots = source("robot_v1_testnet_slots"), testnetOrders = source("robot_v1_testnet_orders");
  const temporalOccurrences = testnetRuns.flatMap((run) => buildTestnetMissedOccurrences(
    source("robot_v1_testnet_events").filter((event) => event.run_id === run.id).map((event) => ({ ...event, event_type: str(event.event_type) })),
    { asset: assetOf(run), cycleId: str(run.id), fallbackSlots: testnetSlots.filter((slot) => slot.run_id === run.id).map((slot) => ({
      slot_number: number(slot.slot_number), missed_at: iso(slot.missed_at), operation_sequence: number(slot.operation_sequence) || undefined, target_buy_price: number(slot.target_buy_price),
    })) }
  ));
  const configById = new Map(configs.map((row) => [str(row.id), row]));
  const cycleById = new Map(cycles.map((row) => [str(row.id), row]));
  const slotById = new Map(slots.map((row) => [str(row.id), row]));
  const runById = new Map(testnetRuns.map((row) => [str(row.id), row]));
  const operationById = new Map(rawOperations.map((row) => [str(row.id), row]));
  const eventContext = (row: AuditRow) => cycleById.get(str(row.cycle_id)) ?? configById.get(str(row.config_id)) ?? {};
  const allEvents: AuditRow[] = source("robot_v1_audit_events").map((row) => {
    const context = eventContext(row), next = safeDetails(row.next_state), previous = safeDetails(row.previous_state), slot = slotById.get(str(row.slot_id));
    return { event_id: row.id, timestamp: iso(row.observed_at), timestamp_utc: iso(row.observed_at), timestamp_local: localTime(row.observed_at), environment: str(context.execution_mode) || "SHADOW", asset: assetOf(context), symbol: context.symbol ?? null,
      cycle_id: row.cycle_id ?? null, slot_id: row.slot_id ?? null, slot: slot?.slot_number ?? next.slotNumber ?? null, physical_slot_number: slot?.slot_number ?? next.slotNumber ?? null,
      operation_id: next.operationId ?? null, operation_sequence: next.operationSequence ?? previous.operationSequence ?? null,
      event_type: row.event_type, previous_state: previous, next_state: next, market_price: next.marketPrice ?? next.observedPrice ?? next.observedLow ?? next.observedHigh ?? next.observedFloor ?? null,
      trigger_price: next.triggerPrice ?? next.targetPrice ?? next.buyPrice ?? null,
      previous_entry_price: next.previousEntryPrice ?? previous.previousEntryPrice ?? previous.entryPrice ?? null,
      reentry_price: next.reentryPrice ?? next.buyPrice ?? null, balance_before: next.balanceBefore ?? previous.balanceBefore ?? null,
      balance_after: next.balanceAfter ?? next.balanceUsdc ?? null, gain_count_before: next.gainCountBefore ?? previous.gainCountBefore ?? null,
      gain_count_after: next.gainCountAfter ?? null, other_open_positions: next.otherOpenPositions ?? null,
      local_recycle_vs_global_reset: next.localRecycleVsGlobalReset ?? null,
      details: next, idempotency_key: row.idempotency_key,
      source: "robot_v1_audit_events", severity: /ERROR|INVALID/.test(str(row.event_type)) ? "ERROR" : /GAP|MISSED|AMBIGUOUS/.test(str(row.event_type)) ? "WARNING" : "INFO" };
  });
  for (const row of source("robot_v1_testnet_events")) {
    const run = runById.get(str(row.run_id)) ?? {}, details = safeDetails(row.details);
    allEvents.push({ event_id: row.id, timestamp: iso(row.observed_at), timestamp_utc: iso(row.observed_at), timestamp_local: localTime(row.observed_at), environment: "TESTNET", asset: assetOf(run), symbol: run.symbol ?? null,
      cycle_id: row.run_id, slot: row.slot_number ?? null, physical_slot_number: row.slot_number ?? null, operation_sequence: details.operationSequence ?? details.operation_sequence ?? null,
      operation_id: row.slot_number ? `testnet:${row.run_id}:${row.slot_number}:${details.operationSequence ?? details.operation_sequence ?? 1}` : null,
      event_type: row.event_type, previous_state: null, next_state: details, details, market_price: details.marketPrice ?? null, trigger_price: details.price ?? details.targetPrice ?? null,
      occurred_at: row.event_type === "TESTNET_FILL_OBSERVED" ? iso(details.filledAt) : null,
      occurred_at_basis: row.event_type === "TESTNET_FILL_OBSERVED" && details.filledAt ? "EXCHANGE_FILL_TIME" : null,
      context_only: filters.temporalWindow === "SINCE_STRATEGY_4_1" && row.event_type === "TESTNET_FILL_OBSERVED" && Boolean(details.filledAt) && timestamp(details.filledAt) < timestamp(filters.start),
      reset_after_last_tp: details.reset_after_last_tp ?? null, old_next_buy_canceled: details.old_next_buy_canceled ?? null,
      new_cycle_started: details.new_cycle_started ?? null, initial_reentry_filled: details.initial_reentry_filled ?? null,
      new_tp_created: details.new_tp_created ?? null, next_buy_armed: details.next_buy_armed ?? null,
      reset_latency_ms: details.reset_latency_ms ?? null, recovery_source: details.recovery_source ?? run.recovery_source ?? null,
      previous_entry_price: details.previous_entry_price ?? null, reentry_price: details.reentry_price ?? null,
      balance_before: details.balance_before ?? null, balance_after: details.balance_after ?? null,
      gain_count_before: details.gain_count_before ?? null, gain_count_after: details.gain_count_after ?? null,
      other_open_positions: details.other_open_positions ?? null,
      local_recycle_vs_global_reset: details.local_recycle_vs_global_reset ?? null,
      strategy_version: details.strategy_version ?? null, root_cause: details.root_cause ?? null, first_cross_at: details.first_cross_at ?? null,
      decision_created_at: details.decision_created_at ?? null, decision_dispatched_at: details.decision_dispatched_at ?? null,
      exchange_ack_at: details.exchange_ack_at ?? null, order_resident_at: details.order_resident_at ?? null,
      latency_ms: details.latency_ms ?? details.reconciliation_gap_ms ?? null, resolved_by_version: details.resolved_by_version ?? null,
      idempotency_key: row.event_key, source: "robot_v1_testnet_events", severity: /ERROR|FAILED/.test(str(row.event_type)) ? "ERROR" : /MISSED|DISCONNECTED/.test(str(row.event_type)) ? "WARNING" : "INFO" });
  }
  allEvents.sort(byTime);
  for (const event of allEvents.filter((row) => row.environment === "TESTNET" && /MISSED_LEVEL/.test(str(row.event_type)))) {
    const candidates = temporalOccurrences.filter((occurrence) => occurrence.cycle_id === event.cycle_id && occurrence.slot === event.slot);
    const occurrence = event.operation_sequence != null ? candidates.find((row) => row.operation_sequence === event.operation_sequence) ?? (candidates.length === 1 ? candidates[0] : undefined) : candidates.length === 1 ? candidates[0] : undefined;
    if (occurrence) Object.assign(event, {
      occurred_at: occurrence.occurred_at, occurred_at_basis: occurrence.occurred_at_basis, occurred_by_at: occurrence.occurred_by_at,
      detected_at: occurrence.detected_at, created_at: occurrence.created_at, strategy_effective_at: occurrence.strategy_effective_at,
      temporal_classification: occurrence.temporal_classification, is_active_issue: occurrence.is_active_issue, fact_strategy_version: occurrence.strategy_version,
      root_cause: occurrence.root_cause, resolved_at: occurrence.resolved_at, resolved_by_version: occurrence.resolved_by_version, evidence_source: occurrence.evidence_source,
    });
  }
  const observations = source("report_runtime_observations");
  for (const observation of observations) {
    const metrics = object(observation.metrics);
    allEvents.push({ event_id: observation.id, timestamp: iso(observation.observed_at), timestamp_utc: iso(observation.observed_at), timestamp_local: localTime(observation.observed_at), environment: observation.environment,
      asset: observation.asset ?? null, symbol: observation.symbol ?? null, cycle_id: metrics.cycle_id ?? null, event_type: `${observation.source}_${observation.status}`,
      details: { cycles_started: metrics.cycles_started ?? null, slots_updated: metrics.slots_updated ?? null, candles_processed: metrics.candles_processed ?? null, expected_interval_seconds: metrics.expected_interval_seconds ?? null, error_code: observation.error_code ?? null },
      idempotency_key: observation.event_key, source: "report_runtime_observations", severity: observation.status === "FAILED" ? "ERROR" : "INFO", duration_ms: duration(observation.started_at, observation.finished_at) });
  }
  allEvents.sort(byTime);
  const allOperations: AuditRow[] = rawOperations.map((row) => {
    const cycle = cycleById.get(str(row.cycle_id)) ?? {};
    return { environment: str(cycle.execution_mode) || "SHADOW", asset: assetOf(row), symbol: row.symbol, operation_id: row.id, cycle_id: row.cycle_id, config_id: cycle.config_id ?? null,
      slot_id: row.slot_id, slot: row.physical_slot_number ?? slotById.get(str(row.slot_id))?.slot_number ?? null, physical_slot_number: row.physical_slot_number ?? slotById.get(str(row.slot_id))?.slot_number ?? null,
      logical_level: row.logical_level ?? null, operation_sequence: row.operation_sequence, sequence: row.operation_sequence, side: "BUY→TP", entry_price: num(row.entry_price), quantity: num(row.executed_quantity), allocation: num(row.allocation_usdc),
      take_profit_price: num(row.take_profit_price), gain_target_percent: num(cycle.gain_rate) === null ? null : number(cycle.gain_rate) * 100, opened_at: iso(row.opened_at), closed_at: iso(row.closed_at),
      gross_profit: num(row.gross_quote_pnl), fees: num(row.estimated_quote_fees), net_profit: num(row.net_quote_pnl), result: number(row.net_quote_pnl) > 0 ? "GAIN" : number(row.net_quote_pnl) < 0 ? "LOSS" : "FLAT",
      trigger_source: "PERSISTED_SHADOW_CANDLE", buy_client_order_id: row.buy_client_order_id ?? null, sell_client_order_id: row.sell_client_order_id ?? null, source: "robot_v1_slot_operations" };
  });
  const normalizedOrders: AuditRow[] = testnetOrders.map((row) => {
    const run = runById.get(str(row.run_id)) ?? {};
    const asset = assetOf(run);
    const expectedId = asset === "BTC" || asset === "SOL" ? testnetClientOrderId(str(row.run_id), asset, number(row.slot_number), row.side as "BUY" | "SELL", number(row.revision)) : null;
    const relatedEvents = allEvents.filter((event) => event.environment === "TESTNET" && event.cycle_id === row.run_id && object(event.details).clientOrderId === row.client_order_id);
    const fillEvidence = relatedEvents.filter((event) => event.event_type === "TESTNET_FILL_OBSERVED").sort(byTime);
    const firstFill = fillEvidence[0] ?? relatedEvents.find((event) => /_(PARTIALLY_FILLED|FILLED)$/.test(str(event.event_type)));
    const filled = relatedEvents.find((event) => /_FILLED$/.test(str(event.event_type)));
    const canceled = relatedEvents.find((event) => /CANCELED|CANCEL_RESULT/.test(str(event.event_type)) && object(event.details).status !== "FILLED");
    const replaced = allEvents.find((event) => event.cycle_id === row.run_id && object(event.details).canceledClientOrderId === row.client_order_id);
    return { environment: "TESTNET", asset: assetOf(run), symbol: run.symbol ?? null, exchange: "BINANCE_SPOT_TESTNET", order_id: row.exchange_order_id ?? null, local_order_id: row.id,
      client_order_id: row.client_order_id, ownership_verified: row.client_order_id === expectedId && Boolean(testnetSlots.find((slot) => slot.id === row.slot_id && slot.run_id === row.run_id && slot.slot_number === row.slot_number)),
      cycle_id: row.run_id, slot_id: row.slot_id, slot: row.slot_number, operation_sequence: row.operation_sequence ?? 1, operation_id: `testnet:${row.run_id}:${row.slot_number}:${row.operation_sequence ?? 1}`, side: row.side, purpose: row.purpose, revision: row.revision,
      order_type: row.purpose === "INITIAL" ? "MARKET" : "LIMIT", status: row.status, requested_price: num(row.price), average_fill_price: number(row.executed_quantity) > 0 ? number(row.cumulative_quote) / number(row.executed_quantity) : null,
      requested_quantity: num(row.requested_quantity), requested_quote: num(row.requested_quote), executed_quantity: num(row.executed_quantity), remaining_quantity: num(row.requested_quantity) === null ? null : Math.max(0, number(row.requested_quantity) - number(row.executed_quantity)),
      cumulative_quote: num(row.cumulative_quote), fee_base: num(row.fee_base), fee_quote: num(row.fee_quote), fee_other: Array.isArray(row.fee_other) ? row.fee_other.map((fee) => ({ asset: object(fee).asset, amount: object(fee).amount })) : [],
      created_at: iso(row.created_at), first_fill_at: object(firstFill?.details).filledAt ?? firstFill?.timestamp ?? null, filled_at: filled ? object(fillEvidence.at(-1)?.details).filledAt ?? filled.timestamp : null, canceled_at: canceled?.timestamp ?? null,
      replaced_by: object(replaced?.details).replacementClientOrderId ?? null, reason: row.purpose, reconciliation_status: row.trades_reconciled ? "TRADES_RECONCILED" : "PENDING_OR_NO_FILL", snapshot_at: input.generatedAt, updated_at: iso(row.updated_at),
      fill_time_basis: fillEvidence.at(-1) && object(fillEvidence.at(-1)?.details).filledAt ? "EXCHANGE_FILL_TIME" : "LOCAL_STATUS_OBSERVATION",
      timestamp_basis: "filledAt da exchange quando persistido; fallback histórico para observação local identificado por fill_time_basis.", source: "robot_v1_testnet_orders" };
  });
  for (const slot of testnetSlots) {
    const run = runById.get(str(slot.run_id)) ?? {}, slotOrders = normalizedOrders.filter((order) => order.slot_id === slot.id);
    const sequences = [...new Set(slotOrders.map((order) => number(order.operation_sequence) || 1))];
    for (const sequence of sequences) {
      const orders = slotOrders.filter((order) => (number(order.operation_sequence) || 1) === sequence);
      const buys = orders.filter((order) => order.side === "BUY"), sells = orders.filter((order) => order.side === "SELL");
      const closed = allEvents.find((event) => event.environment === "TESTNET" && event.cycle_id === slot.run_id && event.slot === slot.slot_number && event.event_type === "SLOT_CLOSED" && (number(object(event.details).operationSequence) || 1) === sequence);
      if (!buys.some((order) => number(order.executed_quantity) > 0)) continue;
      const quantity = sum(buys, "executed_quantity"), entryCost = sum(buys, "cumulative_quote"), fees = sum(orders, "fee_quote");
      const exchangeClosedAt = closed ? sells.filter((order) => order.status === "FILLED" && order.fill_time_basis === "EXCHANGE_FILL_TIME" && order.filled_at).map((order) => str(order.filled_at)).sort().at(-1) ?? null : null;
      allOperations.push({ environment: "TESTNET", asset: assetOf(run), symbol: run.symbol, operation_id: `testnet:${slot.run_id}:${slot.slot_number}:${sequence}`, cycle_id: slot.run_id, slot_id: slot.id, slot: slot.slot_number, physical_slot_number: slot.slot_number,
        logical_level: slot.slot_number, operation_sequence: sequence, sequence, side: "BUY→TP", entry_price: quantity ? entryCost / quantity : null, quantity, allocation: buys[0]?.requested_quote ?? num(slot.balance_usdc),
        take_profit_price: sells.at(-1)?.requested_price ?? null, gain_target_percent: num(run.gain_rate) === null ? null : number(run.gain_rate) * 100, opened_at: buys.find((order) => order.first_fill_at)?.first_fill_at ?? null,
        closed_at: closed?.timestamp ?? null, exchange_closed_at: exchangeClosedAt, closed_at_basis: "SLOT_CLOSED_LEDGER_OBSERVATION", gross_profit: closed ? sum(sells, "cumulative_quote") - entryCost : null, fees: closed ? fees : null,
        net_profit: closed ? num(object(closed.details).profitUsdc) : null, result: closed ? number(object(closed.details).profitUsdc) > 0 ? "GAIN" : "LOSS_OR_FLAT" : "OPEN",
        trigger_source: "BINANCE_TESTNET_FILLS", buy_client_order_id: buys.map((order) => order.client_order_id), sell_client_order_id: sells.map((order) => order.client_order_id), source: "robot_v1_testnet_orders+SLOT_CLOSED" });
    }
  }
  // The currently open Shadow operation has not reached the immutable archive yet.
  for (const slot of slots.filter((row) => ["OPEN", "TP_ACTIVE", "PARTIALLY_FILLED"].includes(str(row.status)))) {
    if (rawOperations.some((operation) => operation.slot_id === slot.id && operation.operation_sequence === slot.operation_sequence)) continue;
    const cycle = cycleById.get(str(slot.cycle_id)) ?? {};
    allOperations.push({ environment: str(cycle.execution_mode) || "SHADOW", asset: assetOf(cycle), symbol: cycle.symbol, operation_id: `open:${slot.id}:${slot.operation_sequence}`, cycle_id: slot.cycle_id, config_id: cycle.config_id, slot_id: slot.id,
      slot: slot.slot_number, strategy_version: cycle.strategy_version ?? null, physical_slot_number: slot.slot_number, logical_level: slot.logical_level, operation_sequence: slot.operation_sequence, sequence: slot.operation_sequence, side: "BUY→TP", entry_price: num(slot.average_fill_price), quantity: num(slot.executed_quantity), allocation: num(slot.allocation_usdc),
      take_profit_price: num(slot.take_profit_price), gain_target_percent: num(cycle.gain_rate) === null ? null : number(cycle.gain_rate) * 100, opened_at: iso(slot.buy_triggered_at), closed_at: null, gross_profit: null, fees: null, net_profit: null, result: "OPEN",
      context_ended_at: iso(cycle.completed_at), context_end_reason: cycle.completion_reason ?? null,
      trigger_source: "PERSISTED_SHADOW_CANDLE", buy_client_order_id: slot.buy_client_order_id, sell_client_order_id: slot.sell_client_order_id, source: "robot_v1_slots", snapshot_at: input.generatedAt });
  }
  const observationEnd = new Date(Math.min(timestamp(filters.end), timestamp(input.generatedAt))).toISOString();
  const allCapital: AuditRow[] = credits.map((credit) => {
    const operation = operationById.get(str(credit.operation_id)) ?? {}, cycle = cycleById.get(str(operation.cycle_id)) ?? {}, config = configById.get(str(credit.config_id)) ?? {};
    return { timestamp: iso(operation.closed_at), credited_at: iso(credit.credited_at), environment: str(config.execution_mode) || "SHADOW", asset: assetOf(config), symbol: config.symbol ?? null,
      cycle_id: operation.cycle_id ?? null, config_id: credit.config_id, slot: credit.slot_number, event: "SLOT_PROFIT_CREDITED", balance_before: num(credit.previous_balance_usdc), realized_profit: num(credit.net_profit_usdc),
      gross_profit: num(operation.gross_quote_pnl), fees: num(operation.estimated_quote_fees), net_profit: num(credit.net_profit_usdc), contribution: 0, withdrawal: 0, balance_after: num(credit.new_balance_usdc),
      next_allocation: num(credit.new_balance_usdc), source_operation: credit.operation_id, reason: "Lucro líquido reinvestido no mesmo slot físico.", source: "robot_v1_slot_profit_credits", timestamp_basis: "operation.closed_at; credited_at preserva a data de migração/backfill quando distinta.", gain_rate: cycle.gain_rate ?? null };
  });
  for (const event of allEvents.filter((row) => row.environment === "TESTNET" && row.event_type === "SLOT_CLOSED")) {
    const details = object(event.details), profit = num(details.profitUsdc), after = num(details.balanceUsdc);
    const operation = allOperations.find((row) => row.operation_id === event.operation_id);
    allCapital.push({ timestamp: event.timestamp, credited_at: event.timestamp, environment: "TESTNET", asset: event.asset, symbol: event.symbol, cycle_id: event.cycle_id, slot: event.slot, event: "SLOT_CLOSED",
      balance_before: after === null || profit === null ? null : Number((after - profit).toFixed(12)), realized_profit: profit, gross_profit: operation?.gross_profit ?? null, fees: operation?.fees ?? null, net_profit: profit,
      contribution: 0, withdrawal: 0, balance_after: after, next_allocation: after, source_operation: event.operation_id, reason: "Crédito em fundos fictícios no slot Testnet.", source: "robot_v1_testnet_events" });
  }
  const allGains: AuditRow[] = [];
  const cumulativeSlot = new Map<string, number>(), cumulativeAsset = new Map<string, number>();
  for (const operation of [...allOperations].filter((row) => row.closed_at && number(row.net_profit) > 0).sort((a, b) => str(a.closed_at).localeCompare(str(b.closed_at)) || str(a.operation_id).localeCompare(str(b.operation_id)))) {
    const slotKey = `${operation.environment}:${operation.asset}:${operation.physical_slot_number}`, assetKey = `${operation.environment}:${operation.asset}`;
    cumulativeSlot.set(slotKey, (cumulativeSlot.get(slotKey) ?? 0) + 1); cumulativeAsset.set(assetKey, (cumulativeAsset.get(assetKey) ?? 0) + 1);
    const credit = allCapital.find((row) => row.source_operation === operation.operation_id);
    allGains.push({ environment: operation.environment, asset: operation.asset, symbol: operation.symbol, cycle_id: operation.cycle_id, operation_id: operation.operation_id, physical_slot: operation.physical_slot_number,
      operation_sequence: operation.operation_sequence, entry_price: operation.entry_price, tp_price: operation.take_profit_price, target_percent: operation.gain_target_percent, gross_gain: operation.gross_profit, fees: operation.fees, net_gain: operation.net_profit,
      balance_before: credit?.balance_before ?? null, balance_after: credit?.balance_after ?? null, opened_at: operation.opened_at, gain_at: operation.closed_at, exchange_gain_at: operation.exchange_closed_at ?? null, gain_time_basis: operation.environment === "TESTNET" ? "SLOT_CLOSED_LEDGER_OBSERVATION; exchange_gain_at is separate" : "SHADOW_OPERATION_CLOSED_AT", duration_ms: duration(operation.opened_at, operation.closed_at),
      cumulative_slot_gains: cumulativeSlot.get(slotKey), cumulative_asset_gains: cumulativeAsset.get(assetKey), source: operation.source });
  }
  const normalizedCycles: AuditRow[] = cycles.map((row) => {
    const operations = allOperations.filter((operation) => operation.cycle_id === row.id && operation.closed_at && timestamp(operation.closed_at) < timestamp(observationEnd));
    const events = allEvents.filter((event) => event.cycle_id === row.id);
    const restart = allEvents.find((event) => event.event_type === "CYCLE_RESTARTED" && object(event.previous_state).cycleId === row.id);
    const completion = events.find((event) => event.event_type === "CYCLE_COMPLETED");
    return { environment: str(row.execution_mode) || "SHADOW", asset: row.asset, symbol: row.symbol, cycle_id: row.id, config_id: row.config_id, strategy_version: row.strategy_version ?? null, status: row.status, completion_reason: row.completion_reason ?? object(completion?.next_state).reason ?? null,
      anchor_price: num(row.anchor_price), gain_rate: num(row.gain_rate), entry_spacing: num(row.entry_spacing), capital_start: num(row.capital_usdc), capital_end: num(row.capital_usdc) === null ? null : number(row.capital_usdc) + sum(operations, "net_profit"),
      capital_end_basis: row.completed_at ? "CAPITAL_START_PLUS_ARCHIVED_NET_PROFIT" : "AS_OF_REPORT_CUTOFF", slot_count: slots.filter((slot) => slot.cycle_id === row.id).length,
      started_at: iso(row.started_at), completed_at: iso(row.completed_at), duration_ms: duration(row.started_at, row.completed_at ?? observationEnd), operations: operations.length, gains: operations.filter((operation) => number(operation.net_profit) > 0).length,
      realized_pnl: sum(operations, "net_profit"), missed_levels: events.filter((event) => /MISSED_LEVEL/.test(str(event.event_type))).length, errors: events.filter((event) => event.severity === "ERROR").length,
      reset_reason: object(restart?.previous_state).reason ?? row.completion_reason ?? object(completion?.next_state).reason ?? null, next_cycle_id: restart?.cycle_id ?? null, snapshot_at: input.generatedAt };
  });
  for (const run of testnetRuns) {
    const operations = allOperations.filter((row) => row.environment === "TESTNET" && row.cycle_id === run.id && row.closed_at && timestamp(row.closed_at) < timestamp(observationEnd));
    normalizedCycles.push({ environment: "TESTNET", asset: run.asset, symbol: run.symbol, cycle_id: run.id, strategy_version: run.strategy_version ?? null, status: run.status, completion_reason: run.completion_reason ?? null, anchor_price: num(run.anchor_price), gain_rate: num(run.gain_rate), entry_spacing: num(run.entry_spacing),
      capital_start: num(run.slot_notional_usdc) === null ? null : number(run.slot_notional_usdc) * 25, capital_end: num(run.slot_notional_usdc) === null ? null : number(run.slot_notional_usdc) * 25 + sum(operations, "net_profit"),
      capital_end_basis: "FICTITIOUS_SLOT_CAPITAL_PLUS_CLOSED_PROFIT", slot_count: testnetSlots.filter((slot) => slot.run_id === run.id).length, started_at: iso(run.created_at), completed_at: iso(run.completed_at), duration_ms: duration(run.created_at, run.completed_at ?? observationEnd), operations: operations.length,
      gains: operations.filter((row) => number(row.net_profit) > 0).length, realized_pnl: sum(operations, "net_profit"), missed_levels: testnetSlots.filter((slot) => slot.run_id === run.id && slot.missed_at).length, errors: run.last_error ? 1 : 0,
      reset_reason: run.completion_reason ?? null, next_cycle_id: testnetRuns.find((candidate) => candidate.previous_run_id === run.id)?.id ?? null,
      reset_started_at: iso(run.reset_started_at), reset_completed_at: iso(run.reset_completed_at), reset_latency_ms: duration(run.reset_started_at, run.reset_completed_at), recovery_source: run.recovery_source ?? null,
      snapshot_at: input.generatedAt, notes: "BINANCE TESTNET / FUNDOS FICTÍCIOS. Ciclo e reset preservados separadamente." });
  }
  const normalizedSlots: AuditRow[] = slots.map((slot) => {
    const cycle = cycleById.get(str(slot.cycle_id)) ?? {}, config = configById.get(str(cycle.config_id)) ?? {};
    const account = accounts.find((row) => row.config_id === cycle.config_id && row.slot_number === slot.slot_number);
    const history = allOperations.filter((row) => row.environment === (cycle.execution_mode ?? "SHADOW") && row.config_id === cycle.config_id && row.physical_slot_number === slot.slot_number && row.closed_at && timestamp(row.closed_at) < timestamp(observationEnd));
    const ownEvents = allEvents.filter((row) => row.slot_id === slot.id && timestamp(row.timestamp) < timestamp(observationEnd));
    const market = num(config.last_market_price), entry = num(slot.average_fill_price), quantity = num(slot.executed_quantity);
    const contextEnded = Boolean(cycle.completed_at && timestamp(cycle.completed_at) <= timestamp(input.generatedAt));
    const open = !contextEnded && ["OPEN", "TP_ACTIVE", "PARTIALLY_FILLED"].includes(str(slot.status));
    return { environment: str(cycle.execution_mode) || "SHADOW", asset: assetOf(cycle), symbol: cycle.symbol, cycle_id: slot.cycle_id, config_id: cycle.config_id, slot_id: slot.id,
      strategy_version: cycle.strategy_version ?? null, physical_slot_number: slot.slot_number, logical_level: slot.logical_level, operation_sequence: slot.operation_sequence, entry_state: slot.entry_state, status: slot.status,
      gain_count_test: history.length, gain_count_cycle: history.filter((row) => row.cycle_id === slot.cycle_id).length, initial_balance: num(account?.initial_balance_usdc), current_balance: num(account?.balance_usdc),
      accumulated_profit: num(account?.net_profit_usdc), allocation: num(slot.allocation_usdc), buy_price: num(slot.buy_price), current_price_snapshot: market, price_observed_at: iso(config.last_market_observed_at), take_profit_price: num(slot.take_profit_price),
      buy_status: slot.buy_status, tp_status: slot.take_profit_status, quantity, notional: entry === null || quantity === null ? null : entry * quantity, open_pnl: open && market !== null && entry !== null && quantity !== null ? (market - entry) * quantity : open ? null : 0,
      realized_pnl: sum(history.filter((row) => row.cycle_id === slot.cycle_id), "net_profit"), opened_at: iso(slot.buy_triggered_at), closed_at: iso(slot.tp_triggered_at), recycled_at: ownEvents.filter((row) => row.event_type === "SLOT_RECYCLED").at(-1)?.timestamp ?? null,
      armed_at: iso(slot.armed_at), missed_at: iso(slot.missed_at), buy_client_order_id: slot.buy_client_order_id, sell_client_order_id: slot.sell_client_order_id,
      context_ended_at: iso(cycle.completed_at), context_active: !contextEnded,
      snapshot_at: input.generatedAt, state_basis: "LATEST_PERSISTED_PHYSICAL_SLOT; status legado preservado, contexto encerrado não é posição ativa; histórico de operações e eventos preservado separadamente" };
  });
  for (const slot of testnetSlots) {
    const run = runById.get(str(slot.run_id)) ?? {}, orders = normalizedOrders.filter((order) => order.slot_id === slot.id), operation = allOperations.find((row) => row.slot_id === slot.id && row.environment === "TESTNET");
    const buy = orders.filter((row) => row.side === "BUY").at(-1), sell = orders.filter((row) => row.side === "SELL").at(-1);
    const occurrences = temporalOccurrences.filter((row) => row.cycle_id === slot.run_id && row.slot === slot.slot_number);
    const temporal = summarizeTemporalMissed(occurrences);
    const operationalState = slot.entry_state === "OPEN" ? "OPEN" : slot.entry_state === "ARMED" ? "NEXT_BUY"
      : slot.entry_state === "MISSED" && temporal.activeIssueCount > 0 ? "ACTIVE_ERROR"
      : slot.entry_state === "MISSED" || slot.entry_state === "CLOSED" || slot.entry_state === "PLANNED" && slot.entry_origin === "REENTRY" ? "REENTRY_WAITING" : "PLANNED";
    normalizedSlots.push({ environment: "TESTNET", asset: assetOf(run), symbol: run.symbol, cycle_id: slot.run_id, slot_id: slot.id, physical_slot_number: slot.slot_number, logical_level: slot.slot_number,
      persisted_entry_state: slot.entry_state, operational_state: operationalState, historical_missed_count: temporal.historicalCount, missed_since_strategy_count: temporal.currentVersionCount,
      active_missed_count: temporal.activeIssueCount, unresolved_missed_count: temporal.unresolvedCount, history_does_not_override_current_state: true,
      strategy_version: run.strategy_version ?? null, operation_sequence: slot.operation_sequence ?? 1, entry_state: slot.entry_state, entry_origin: slot.entry_origin ?? "GRID", entry_reference_price: num(slot.entry_reference_price), last_take_profit_price: num(slot.last_take_profit_price), status: slot.entry_state, gain_count_test: slot.gain_count, gain_count_cycle: slot.gain_count, initial_balance: num(run.slot_notional_usdc), current_balance: num(slot.balance_usdc),
      accumulated_profit: num(slot.net_profit_usdc), allocation: num(run.slot_notional_usdc), buy_price: num(slot.target_buy_price), current_price_snapshot: null, take_profit_price: sell?.requested_price ?? null, buy_status: buy?.status ?? "PLANNED", tp_status: sell?.status ?? "NONE",
      quantity: operation?.quantity ?? null, notional: operation?.allocation ?? null, open_pnl: null, realized_pnl: num(slot.net_profit_usdc), opened_at: operation?.opened_at ?? null, closed_at: operation?.closed_at ?? null, recycled_at: null,
      armed_at: buy?.created_at ?? null, missed_at: iso(slot.missed_at), buy_client_order_id: buy?.client_order_id ?? null, sell_client_order_id: sell?.client_order_id ?? null, snapshot_at: input.generatedAt,
      state_basis: "LATEST_PERSISTED_TESTNET_SLOT; fundos fictícios" });
  }
  const monthlyGoals = buildMonthlyAuditRows({ filters, observationEnd, generatedAt: input.generatedAt,
    incomplete: missing("robot_v1_monthly_slot_gains") || !Object.hasOwn(input.sources, "robot_v1_monthly_slot_gains"), credits: source("robot_v1_monthly_slot_gains"),
    configs, cycles, shadowSlots: slots, shadowAccounts: accounts, runs: testnetRuns, testnetSlots });
  const currentPeriod = monthlyPeriodKey(input.generatedAt);
  for (const slot of normalizedSlots) {
    const monthly = monthlyGoals.find((row) => row.environment === slot.environment && row.asset === slot.asset
      && row.cycle_id === slot.cycle_id && row.physical_slot_number === slot.physical_slot_number && row.period_key === currentPeriod);
    if (monthly) for (const key of ["physical_slot_id", "operational_rank", "lifetime_gain_count", "monthly_gain_count", "monthly_gain_target",
      "monthly_target_reached", "period_key", "timezone", "eligible_for_new_entry", "blocked_reason", "next_action"])
      slot[key] = monthly[key];
  }
  const rules: AuditRow[] = [];
  const definitions = [...REPORT_RULE_CONTRACT, ...extensions];
  if (new Set(definitions.map((definition) => definition.parameter)).size !== definitions.length) throw new Error("COINOPS_REPORT_RULE_DUPLICATE");
  for (const config of configs) for (const definition of definitions) if (config[definition.field] !== undefined) rules.push({
    effective_from: iso(config.updated_at ?? config.created_at), environment: definition.field.endsWith("_brl") ? "REAL" : str(config.execution_mode) || "SHADOW", asset: config.asset, symbol: definition.field.endsWith("_brl") ? `${config.asset}BRL` : config.symbol, config_id: config.id,
    parameter: definition.parameter, value: config[definition.field] ?? null, unit: definition.unit, source: `robot_v1_configs.${definition.field}`, version: definition.version,
    evidence_scope: "CURRENT_SNAPSHOT", notes: definition.notes ?? "Snapshot atual; não aplicar retroativamente a ciclos anteriores." });
  for (const run of testnetRuns) for (const [parameter, field, unit] of [["next_capital", "next_capital_usdc", "USDC"], ["next_gain_rate", "next_gain_rate", "ratio"], ["next_entry_spacing", "next_entry_spacing", "ratio"]]) if (run[field] != null) rules.push({
    effective_from: iso(run.updated_at ?? run.created_at), environment: "TESTNET", asset: run.asset, symbol: run.symbol, cycle_id: run.id,
    parameter, value: run[field], unit, source: `robot_v1_testnet_runs.${field}`, version: 1,
    evidence_scope: "NEXT_CYCLE_PENDING", notes: "Configuração pendente; o ciclo atual preserva seus parâmetros originais." });
  for (const cycle of normalizedCycles.filter((row) => overlap(row.started_at, row.completed_at, filters))) {
    rules.push({ effective_from: input.generatedAt, environment: cycle.environment, asset: cycle.asset, symbol: cycle.symbol, cycle_id: cycle.cycle_id,
      parameter: "strategy_version", value: cycle.strategy_version ?? null, unit: "version", source: cycle.environment === "TESTNET" ? "robot_v1_testnet_runs" : "robot_v1_cycles", version: 2,
      evidence_scope: "CURRENT_CYCLE_VERSION_SNAPSHOT", notes: "Versão adotada pelo ciclo no snapshot; vigência histórica vem das decisões, não da data de início do ciclo." });
    if (cycle.environment !== "REAL" && cycle.strategy_version === "4.2") rules.push({ effective_from: input.generatedAt,
      environment: cycle.environment, asset: cycle.asset, symbol: cycle.symbol, cycle_id: cycle.cycle_id,
      parameter: "monthly_gain_target_per_physical_slot", value: cycle.asset === "BTC" ? 7 : 2, unit: "gains/month/slot",
      source: "monthly-slot-policy.ts", version: 4, evidence_scope: "CURRENT_4_2_POLICY_SNAPSHOT",
      notes: "Mês America/Campo_Grande; rank por lifetime entre elegíveis, sem alterar prioridade de preço." });
    const snapshot = { capital_usdc: cycle.capital_start, gain_rate: cycle.gain_rate, entry_spacing: cycle.entry_spacing, slot_count: cycle.slot_count };
    rules.push({ effective_from: cycle.started_at, effective_until: cycle.completed_at, environment: cycle.environment, asset: cycle.asset, symbol: cycle.symbol, cycle_id: cycle.cycle_id,
      parameter: "profile", value: Number(cycle.gain_rate) === 0.005 && Number(cycle.entry_spacing) === 0.01 && Number(cycle.slot_count) === 25 ? "TEST_PROFILE" : "CUSTOM_TEST",
      unit: "enum", source: cycle.environment === "TESTNET" ? "robot_v1_testnet_runs" : "robot_v1_cycles", version: 1, evidence_scope: "CYCLE_SNAPSHOT", snapshot });
    for (const [parameter, field, unit] of [["gain_rate", "gain_rate", "ratio"], ["entry_spacing", "entry_spacing", "ratio"], ["capital", "capital_start", "USDC"], ["slot_count", "slot_count", "slots"]]) rules.push({
    effective_from: cycle.started_at, effective_until: cycle.completed_at, environment: cycle.environment, asset: cycle.asset, symbol: cycle.symbol, cycle_id: cycle.cycle_id,
    parameter, value: cycle[field!] ?? null, unit, source: cycle.environment === "TESTNET" ? "robot_v1_testnet_runs" : "robot_v1_cycles", version: 1, evidence_scope: "CYCLE_SNAPSHOT", notes: "Parâmetros congelados do ciclo; identidade preservada." });
  }
  for (const event of allEvents.filter((row) => /CAPITAL|PARAMETERS|PAUSED|RESUMED|KILL_SWITCH/.test(str(row.event_type)))) rules.push({
    effective_from: event.timestamp, environment: event.environment, asset: event.asset, symbol: event.symbol, cycle_id: event.cycle_id,
    parameter: event.event_type, value: event.next_state, unit: "event", source: event.source, version: 1, evidence_scope: "CONFIGURATION_EVENT", notes: "Evento histórico; parâmetros NEXT_CYCLE entram em vigor no ciclo seguinte, não neste instante." });
  for (const environment of filters.environments) for (const [parameter, value, unit] of [["single_active_entry", true, "boolean"], ["compounding", "PER_PHYSICAL_SLOT", "enum"], ["engine_interval", environment === "TESTNET" ? 60 : 300, "seconds"], ["reconciliation_interval", environment === "TESTNET" ? 60 : 300, "seconds"], ["reconciliation_fallback_interval", 300, "seconds"], ["production_write_enabled", false, "boolean"], ["live_enabled", false, "boolean"]] as const) rules.push({
    effective_from: input.generatedAt, environment, asset: null, parameter, value, unit, source: parameter.endsWith("interval") ? "apps/web/vercel.json" : "runtime_contract_phase_4_1", version: 2, evidence_scope: "CURRENT_CODE_CONTRACT", notes: "Contrato da versão exportada; não comprova vigência histórica anterior ao registro." });
  for (const key of ["execution_engine_settings", "execution_asset_settings"]) for (const settings of source(key)) for (const field of ["mode", "execution_mode", "kill_switch", "global_kill_switch", "max_order_notional", "max_order_notional_usdt", "max_daily_notional_usdt", "max_market_age_seconds", "max_total_exposure", "max_daily_loss", "automation_enabled", "enabled", "paused"]) if (settings[field] !== undefined) rules.push({
    effective_from: iso(settings.updated_at ?? settings.created_at), environment: "REAL", asset: settings.asset ?? null, symbol: settings.symbol ?? null, parameter: field, value: settings[field], unit: "configuration",
    source: `${key}.${field}`, version: 1, evidence_scope: "CURRENT_SNAPSHOT", notes: "Configuração persistida; não habilita LIVE." });
  for (const observation of observations.filter((row) => row.source === "SHADOW_ENGINE")) for (const field of ["kill_switch", "pause_new_entries", "gain_rate", "entry_spacing", "capital_usdc", "slot_count", "compounding", "single_active_entry", "expected_interval_seconds"]) {
    const metrics = object(observation.metrics); if (metrics[field] === undefined) continue;
    rules.push({ effective_from: observation.observed_at, environment: observation.environment, asset: observation.asset, symbol: observation.symbol, cycle_id: metrics.cycle_id ?? null, parameter: field,
      value: metrics[field], unit: field.endsWith("_seconds") ? "seconds" : field.endsWith("_usdc") ? "USDC" : "configuration", source: "report_runtime_observations.metrics", version: observation.observation_version, evidence_scope: "ENGINE_EXECUTION_SNAPSHOT", notes: "Regra efetiva observada nesta execução; não retroage ao histórico anterior." });
  }
  const windows: TriggerWindow[] = [];
  for (const event of allEvents.filter((row) => row.environment === "SHADOW" && selected(row, filters))) {
    const isBuy = event.event_type === "NEXT_BUY_ARMED" || event.event_type === "BUY_ARMED";
    const isTp = event.event_type === "INITIAL_POSITION_OPENED" || event.event_type === "BUY_TRIGGERED";
    if (!isBuy && !isTp) continue;
    const details = object(event.next_state), trigger = num(isBuy ? details.buyPrice ?? details.triggerPrice : details.takeProfitPrice);
    if (trigger === null || !event.timestamp) continue;
    const actionTypes = isBuy ? ["BUY_TRIGGERED", "BUY_FILLED"] : ["TP_TRIGGERED", "TP_FILLED"];
    const isAction = (candidate: AuditRow) => actionTypes.includes(str(candidate.event_type));
    const isStop = (candidate: AuditRow) => candidate.environment === "SHADOW" && candidate.cycle_id === event.cycle_id
      && timestamp(candidate.timestamp) >= timestamp(event.timestamp) && candidate !== event
      && (!isAction(candidate) || !(event.operation_sequence != null && candidate.operation_sequence != null && event.operation_sequence !== candidate.operation_sequence)
        && !(event.operation_id && candidate.operation_id && event.operation_id !== candidate.operation_id))
      && ((candidate.slot === event.slot && (isBuy ? [...actionTypes, "NEXT_BUY_DISARMED", "SLOT_RECYCLED"] : [...actionTypes, "SLOT_RECYCLED"]).includes(str(candidate.event_type))) || candidate.event_type === "CYCLE_COMPLETED");
    const firstStop = allEvents.find(isStop);
    // Candle-driven TP, credit and recycle legitimately share one timestamp.
    // UUID/JSON ordering is not causal: prefer the matching action only at the
    // first stop instant, never across an earlier disarm/recycle/cycle boundary.
    const stop = firstStop && (allEvents.find((candidate) => timestamp(candidate.timestamp) === timestamp(firstStop.timestamp)
      && isAction(candidate) && isStop(candidate)) ?? firstStop);
    const observed = stop && isAction(stop) ? stop : null;
    // Historical restarts can close a cycle without a CYCLE_COMPLETED event.
    // A trigger cannot remain armed after its owning cycle has ended.
    const completedAt = timestamp(cycleById.get(str(event.cycle_id))?.completed_at);
    const endTime = Math.min(timestamp(observationEnd), stop ? timestamp(stop.timestamp) + 1 : Infinity, Number.isFinite(completedAt) ? completedAt + 1 : Infinity);
    if (endTime <= timestamp(event.timestamp)) continue;
    const end = new Date(endTime).toISOString();
    if (!overlap(event.timestamp, end, filters)) continue;
    windows.push({ environment: "SHADOW", asset: str(event.asset), symbol: str(event.symbol), cycleId: str(event.cycle_id), slot: num(event.slot), operationId: str(event.operation_id) || null,
      type: isBuy ? "BUY" : "TP", price: trigger, armedAt: str(event.timestamp), endedAt: end, observedAt: observed ? str(observed.timestamp) : null, observedAction: observed ? str(observed.event_type) : null,
      pairedTarget: isBuy ? num(object(observed?.next_state).takeProfitPrice) : null });
  }
  const candles = source("robot_v1_market_candles");
  const triggerResults = auditTriggerWindows(windows, candles, { complete: !missing("robot_v1_market_candles"), eventsComplete: !missing("robot_v1_audit_events"), start: filters.start, end: observationEnd });
  const sampleTimes = [...allEvents.filter((row) => selected(row, filters) && inPeriod(row.timestamp, filters)).map((row) => timestamp(row.timestamp)), ...triggerResults.map((row) => timestamp(row.first_cross_at))].filter(Number.isFinite).sort((a, b) => a - b);
  // A binary search prevents events × candles work when exporting a busy month.
  const nearEvent = (value: number) => { let low = 0, high = sampleTimes.length; while (low < high) { const mid = (low + high) >>> 1; if (sampleTimes[mid]! < value) low = mid + 1; else high = mid; } return [sampleTimes[low], sampleTimes[low - 1]].some((candidate) => candidate !== undefined && Math.abs(candidate - value) <= 120_000); };
  const candleSamples: AuditRow[] = candles.filter((row) => inPeriod(row.candle_open_at, filters) && nearEvent(timestamp(row.candle_open_at))).map((row) => ({
    timestamp: row.candle_open_at, environment: "SHADOW", asset: assetOf(row), symbol: row.symbol, candle_open_at: row.candle_open_at, candle_close_at: row.candle_close_at,
    open: num(row.open_price), high: num(row.high_price), low: num(row.low_price), close: num(row.close_price), active_cycle: row.cycle_id, cycle_id: row.cycle_id,
    trigger_result: "CANDLE_EVIDENCE", source: "robot_v1_market_candles", notes: "Amostra até 2 minutos de eventos/gatilhos. Candles 1m completos têm exportação separada." }));
  const reconciliation: AuditRow[] = source("exchange_reconciliation_runs").map((run) => {
    const summary = object(run.summary), items = source("exchange_reconciliation_items").filter((row) => row.run_id === run.id);
    return { timestamp: iso(run.started_at ?? run.created_at), environment: "REAL", run_id: run.id, symbol: null, local_state: "SHADOW_INTENTS_ONLY", exchange_state: "PRODUCTION_READ_ONLY_OBSERVATION",
      matches: number(summary.MATCH), divergences: ["QUANTITY_MISMATCH", "PRICE_MISMATCH", "STATUS_MISMATCH"].reduce((total, key) => total + number(summary[key]), 0),
      expected_only: num(summary.EXPECTED_ONLY), exchange_only: num(summary.EXCHANGE_ONLY), recovered_actions: null, unresolved: items.filter((item) => ["QUANTITY_MISMATCH", "PRICE_MISMATCH", "STATUS_MISMATCH", "UNKNOWN"].includes(str(item.classification))).length,
      duration_ms: duration(run.started_at, run.completed_at), result: run.status, error: run.error_code ?? null, completed_at: iso(run.completed_at), idempotency_key: run.idempotency_key,
      source: "exchange_reconciliation_runs", notes: "Ordens/trades externos ou manuais não são operações CoinOps. EXPECTED_ONLY é esperado para intents Shadow." };
  });
  for (const event of allEvents.filter((row) => row.environment === "TESTNET" && row.event_type === "RECONCILED")) reconciliation.push({
    timestamp: event.timestamp, environment: "TESTNET", asset: event.asset, symbol: event.symbol, run_id: event.cycle_id, event_id: event.event_id,
    local_state: null, exchange_state: null, matches: null, divergences: null, recovered_actions: null, unresolved: null, duration_ms: null,
    result: "COMPLETED", error: null, source: "robot_v1_testnet_events", notes: "RECONCILED confirma término; contagens/duração/estado detalhado não eram persistidos." });
  for (const item of source("exchange_reconciliation_items")) {
    const details = object(item.details);
    reconciliation.push({ timestamp: iso(item.created_at), environment: "REAL", asset: assetOf(item), symbol: item.symbol ?? null, run_id: item.run_id, item_id: item.id,
      entity_type: item.entity_type, classification: item.classification, exchange_reference: item.exchange_reference, intent_id: item.intent_id,
      local_state: safeDetails(details.expected ?? details.intent), exchange_state: safeDetails(details.actual ?? details.exchange), result: item.classification,
      notes: "Comparação somente leitura; uma referência externa não atribui ownership ao CoinOps.", source: "exchange_reconciliation_items" });
  }
  const alerts: AuditRow[] = allEvents.filter((row) => row.severity !== "INFO").map((event) => ({
    timestamp: event.timestamp, environment: event.environment, severity: event.severity, asset: event.asset, symbol: event.symbol, cycle_id: event.cycle_id, slot: event.slot,
    code: event.event_type, message: object(event.details).reason ?? event.event_type, expected_behavior: null, observed_behavior: event.details,
    occurred_at: event.occurred_at ?? null, detected_at: event.detected_at ?? null, strategy_effective_at: event.strategy_effective_at ?? null,
    temporal_classification: event.temporal_classification ?? null, is_active_issue: event.is_active_issue ?? null,
    root_cause: event.root_cause ?? null, evidence_source: event.evidence_source ?? null, resolved_by_version: event.resolved_by_version ?? null,
    resolved: event.is_active_issue === false && event.resolved_by_version ? true : null, resolved_at: event.resolved_at ?? null, resolution: null, related_event: event.event_id, related_order: object(event.details).clientOrderId ?? null, related_operation: event.operation_id, source: event.source }));
  for (const cycle of cycles.filter((row) => row.status === "FAILED")) alerts.push({ timestamp: iso(cycle.completed_at ?? cycle.started_at), environment: "SHADOW", asset: cycle.asset, symbol: cycle.symbol, cycle_id: cycle.id, severity: "ERROR", code: cycle.completion_reason || "CYCLE_INITIALIZATION_FAILED", message: cycle.completion_reason || "Ciclo histórico falhou; motivo não persistido.", expected_behavior: "Inicializar a grade e preservar o motivo de qualquer falha.", observed_behavior: "FAILED", resolved: null, source: "robot_v1_cycles" });
  for (const row of triggerResults.filter((result) => ["MISSING_ACTION", "AMBIGUOUS"].includes(str(result.result)))) alerts.push({
    timestamp: row.first_cross_at, environment: row.environment, asset: row.asset, symbol: row.symbol, cycle_id: row.cycle_id, slot: row.slot,
    severity: row.result === "AMBIGUOUS" ? "WARNING" : missing("robot_v1_audit_events") ? "WARNING" : "ERROR", code: row.result === "AMBIGUOUS" ? "AMBIGUOUS_CANDLE" : "TRIGGER_ACTION_NOT_FOUND",
    message: row.notes, expected_behavior: row.expected_action, observed_behavior: row.observed_action, resolved: null, related_operation: row.operation_id, source: "trigger_audit" });
  for (const run of testnetRuns.filter((row) => row.last_error)) alerts.push({ timestamp: iso(run.last_reconciled_at ?? run.updated_at), environment: "TESTNET", asset: run.asset, symbol: run.symbol, cycle_id: run.id, severity: "ERROR", code: run.last_error, message: run.last_error, resolved: false, snapshot_at: input.generatedAt, source: "robot_v1_testnet_runs" });
  for (const config of configs.filter((row) => row.last_engine_error || row.grid_error)) alerts.push({ timestamp: iso(config.last_engine_at ?? config.updated_at), environment: str(config.execution_mode) || "SHADOW", asset: config.asset, symbol: config.symbol, severity: "ERROR", code: config.last_engine_error ?? config.grid_error, message: config.last_engine_error ?? config.grid_error, resolved: false, snapshot_at: input.generatedAt, source: "robot_v1_configs" });
  for (const run of source("exchange_reconciliation_runs").filter((row) => row.status === "FAILED")) alerts.push({ timestamp: iso(run.completed_at ?? run.started_at), environment: "REAL", severity: "ERROR", code: run.error_code ?? "RECONCILIATION_FAILED", message: run.error_code ?? "Reconciliação falhou.", resolved: null, source: "exchange_reconciliation_runs" });
  for (const run of testnetRuns) {
    const started = timestamp(run.created_at) > timestamp(filters.start) ? str(run.created_at) : filters.start;
    const runEvents = allEvents.filter((event) => event.environment === "TESTNET" && event.cycle_id === run.id);
    const fastStart = runEvents.find((event) => event.event_type === "RECONCILIATION_STARTED" && number(object(event.details).expected_interval_seconds) === 60)?.timestamp;
    const checkpoints = runEvents.filter((event) => event.event_type === "RECONCILED").map((event) => str(event.timestamp));
    const boundary = fastStart && timestamp(fastStart) < timestamp(observationEnd) ? str(fastStart) : null;
    const gapContext = { source: "robot_v1_testnet_events.RECONCILED", environment: "TESTNET", asset: assetOf(run), includeEdges: run.status === "ACTIVE" };
    if (!boundary || timestamp(boundary) > timestamp(started)) alerts.push(...auditExecutionGaps(checkpoints.filter((at) => !boundary || timestamp(at) < timestamp(boundary)), 300_000, { ...gapContext, start: started, end: boundary ?? observationEnd }));
    if (boundary) alerts.push(...auditExecutionGaps(checkpoints.filter((at) => timestamp(at) >= timestamp(boundary)), 60_000, { ...gapContext, start: timestamp(boundary) > timestamp(started) ? boundary : started, end: observationEnd }));
  }
  for (const config of configs) {
    const ownCandles = candles.filter((candle) => candle.config_id === config.id);
    alerts.push(...auditExecutionGaps(ownCandles.map((candle) => str(candle.candle_open_at)), 60_000, { start: filters.start, end: observationEnd, source: "robot_v1_market_candles", environment: "SHADOW", asset: assetOf(config) }).map((row) => ({ ...row, code: "MISSING_CANDLES", message: "Há intervalo sem candles persistidos. Pausas e início/fim de ciclos devem ser considerados antes de atribuir falha." })));
    if (!config.kill_switch && !config.pause_new_entries && timestamp(observationEnd) - timestamp(config.last_engine_at) > 600_000 && timestamp(config.last_engine_at) >= timestamp(filters.start)) alerts.push({ timestamp: config.last_engine_at, environment: "SHADOW", asset: config.asset, severity: "WARNING", code: "ENGINE_STALE", message: "Última execução conhecida está atrasada em relação ao intervalo de 5 minutos.", resolved: null, source: "robot_v1_configs" });
    const engineRuns = observations.filter((row) => row.source === "SHADOW_ENGINE" && object(row.metrics).config_id === config.id);
    alerts.push(...auditExecutionGaps(engineRuns.map((row) => str(row.observed_at)), 300_000, { start: filters.start, end: observationEnd, source: "report_runtime_observations.SHADOW_ENGINE", environment: "SHADOW", asset: assetOf(config), includeEdges: !config.kill_switch && !config.pause_new_entries }));
  }
  const firstEngineObservation = observations.filter((row) => row.source === "SHADOW_ENGINE").sort((a, b) => timestamp(a.observed_at) - timestamp(b.observed_at))[0];
  if (filters.environments.includes("SHADOW") && (!firstEngineObservation || timestamp(firstEngineObservation.observed_at) > timestamp(filters.start) + 300_000)) {
    incompleteSources.push("shadow_engine_execution_history:before_first_observation");
    warnings.push("Histórico de execuções Shadow é auditável a partir da primeira observação persistida da Fase 3.9; ausência de gaps anterior a ela não pode ser certificada.");
  }
  const diagnostics = observations.filter((row) => row.source === "TESTNET_DIAGNOSTIC");
  if (filters.environments.includes("TESTNET") && testnetRuns.length) {
    incompleteSources.push("testnet_exact_fill_timestamps:not_persisted", "testnet_reconciliation_details:not_persisted", "testnet_continuous_stream_history:not_persisted");
    if (!diagnostics.length) incompleteSources.push("testnet_account_balances:before_first_observation");
    warnings.push("Testnet exporta ordens e capital dos slots fictícios. Snapshots de conta/permissões aparecem quando persistidos; o teste USER_STREAM comprova permissão, não continuidade do stream. Fill a fill e reconciliação detalhada anteriores permanecem sem evidência.");
  }
  warnings.push("Snapshots mutáveis de slots, contas, configuração e ordens são do momento da leitura; não representam automaticamente o estado de um período passado. Operações, créditos e eventos fornecem o histórico.");
  warnings.push("O horário exato de um cruzamento dentro de candle é desconhecido; first_cross_at identifica o início da primeira vela que contém o cruzamento.");
  const relevantCycles = normalizedCycles.filter((row) => selected(row, filters) && overlap(row.started_at, row.completed_at, filters));
  const cycleIds = new Set(relevantCycles.map((row) => row.cycle_id));
  const periodOperations = allOperations.filter((row) => selected(row, filters) && (inPeriod(row.closed_at, filters) || (!row.closed_at && overlap(row.opened_at, null, filters)) || (row.closed_at && overlap(row.opened_at, row.closed_at, filters))));
  const periodGains = allGains.filter((row) => selected(row, filters) && inPeriod(row.gain_at, filters));
  const periodOrders = normalizedOrders.filter((row) => selected(row, filters) && cycleIds.has(row.cycle_id) && timestamp(row.created_at) < timestamp(filters.end));
  for (const order of periodOrders) {
    const history = allEvents.filter((row) => row.environment === "TESTNET" && object(row.details).clientOrderId === order.client_order_id && timestamp(row.timestamp) < timestamp(observationEnd));
    const stateEvent = history.filter((row) => /_(NEW|PARTIALLY_FILLED|FILLED|CANCELED|EXPIRED|REJECTED)$/.test(str(row.event_type)) || row.event_type === "OWNED_BUY_CANCEL_RESULT").at(-1);
    order.status_at_period_end = stateEvent ? object(stateEvent.details).status ?? str(stateEvent.event_type).replace(/^(BUY|SELL)_/, "") : timestamp(order.updated_at) <= timestamp(observationEnd) ? order.status : "UNKNOWN";
    order.context_only = !inPeriod(order.created_at, filters) && !inPeriod(order.filled_at ?? order.canceled_at ?? order.updated_at, filters);
  }
  const realRows: AuditRow[] = [];
  const productionWriteEvidence = source("exchange_order_intents").filter((row) => row.exchange_order_id || ["LIVE", "REAL"].includes(str(row.execution_mode)) && ["SUBMITTED", "NEW", "PARTIALLY_FILLED", "FILLED", "CANCELED"].includes(str(row.status)));
  for (const connection of source("exchange_connections")) realRows.push({ environment: "REAL", row_type: "CONNECTION", exchange: connection.exchange, connection_status: connection.connection_status,
    mode: "PRODUCTION_READ_ONLY", live_status: "BLOCKED", coinops_real_orders: missing("exchange_order_intents") ? null : productionWriteEvidence.length, coinops_real_orders_basis: "PERSISTED_INTENTS_WITH_EXCHANGE_ID_OR_LIVE_SUBMISSION; não é um log HTTP histórico", last_reconciled_at: iso(connection.last_reconciled_at), last_synced_at: iso(connection.last_synced_at),
    last_error: connection.last_error_code ?? null, snapshot_at: input.generatedAt, source: "exchange_connections" });
  for (const intent of productionWriteEvidence) {
    realRows.push({ environment: "REAL", timestamp: intent.updated_at ?? intent.created_at, row_type: "PRODUCTION_WRITE_GUARD_VIOLATION", asset: intent.asset, symbol: intent.symbol, intent_id: intent.id, exchange_order_id: intent.exchange_order_id ?? null,
      observed_execution_mode: intent.execution_mode, observed_status: intent.status, severity: "ERROR", source: "exchange_order_intents", notes: "Referência de envio encontrada em intent CoinOps; investigar violação da guarda READ-ONLY." });
    alerts.push({ timestamp: intent.updated_at ?? intent.created_at, environment: "REAL", asset: intent.asset, symbol: intent.symbol, code: "PRODUCTION_WRITE_GUARD_VIOLATION", severity: "ERROR", message: "Intent CoinOps contém referência de ordem ou submissão LIVE/REAL, incompatível com Production READ-ONLY.", related_order: intent.exchange_order_id ?? null, resolved: null, source: "exchange_order_intents" });
  }
  const latestRealRun = [...source("exchange_reconciliation_runs")].filter((row) => row.status === "COMPLETED" && timestamp(row.completed_at) < timestamp(filters.end)).sort((a, b) => timestamp(b.completed_at) - timestamp(a.completed_at))[0];
  const realSnapshot = object(latestRealRun?.summary);
  for (const balance of Array.isArray(realSnapshot.balances) ? realSnapshot.balances : []) {
    const row = object(balance); if (![...filters.assets, "USDC", "USDT", "BRL"].includes(str(row.asset))) continue;
    realRows.push({ timestamp: latestRealRun?.completed_at, environment: "REAL", row_type: "READ_ONLY_BALANCE", asset: row.asset, free: num(row.free), locked: num(row.locked), total: num(row.total) ?? number(row.free) + number(row.locked),
      source: "exchange_reconciliation_runs.summary.balances", notes: "Saldo consultado na conta; não é capital nem lucro de operação CoinOps." });
  }
  for (const [symbol, raw] of Object.entries(object(realSnapshot.filters))) {
    if (!filters.assets.includes(assetOf({ symbol }) as ReportAsset)) continue;
    const value = object(raw);
    realRows.push({ timestamp: latestRealRun?.completed_at, environment: "REAL", row_type: "SYMBOL_FILTERS", symbol, asset: assetOf({ symbol }),
      min_quantity: value.minQuantity ?? null, max_quantity: value.maxQuantity ?? null, min_notional: value.minNotional ?? null, quantity_step: value.quantityStep ?? null, price_tick: value.priceTick ?? null,
      source: "exchange_reconciliation_runs.summary.filters" });
  }
  if (filters.environments.includes("REAL")) {
    realRows.push({ environment: "REAL", row_type: "LIVE_READINESS", asset: "SOL", symbol: "SOLBRL", mode: "PRODUCTION_READ_ONLY", live_status: "BLOCKED", filters_status: object(realSnapshot.filters).SOLBRL ? "PERSISTED" : "NOT_PERSISTED", source: "runtime_contract_phase_4_1", notes: "Preparação somente. Esta fase não consulta a exchange, não cria ordens e não habilita LIVE." });
    incompleteSources.push("production_http_write_history:not_persisted");
  }
  const testnetRows: AuditRow[] = [
    ...testnetRuns.map((run) => ({ environment: "TESTNET", asset: run.asset, symbol: run.symbol, row_type: "RUN", cycle_id: run.id, status: run.status, previous_run_id: run.previous_run_id ?? null, completion_reason: run.completion_reason ?? null,
      terminal_fill_client_order_id: run.terminal_fill_client_order_id ?? null, reset_started_at: run.reset_started_at ?? null, reset_completed_at: run.reset_completed_at ?? null,
      reset_latency_ms: duration(run.reset_started_at, run.reset_completed_at), recovery_source: run.recovery_source ?? null, last_reconciled_at: run.last_reconciled_at, last_error: run.last_error,
      source: "robot_v1_testnet_runs", label: "BINANCE TESTNET / FUNDOS FICTÍCIOS", account_balance: null, account_balance_status: "NOT_PERSISTED" })),
    ...periodOrders.map((order) => ({ ...order, row_type: "ORDER", label: "BINANCE TESTNET / FUNDOS FICTÍCIOS" })),
    ...normalizedSlots.filter((slot) => slot.environment === "TESTNET").map((slot) => ({ ...slot, row_type: "SLOT", label: "BINANCE TESTNET / FUNDOS FICTÍCIOS" }))
  ];
  for (const diagnostic of diagnostics) {
    const metrics = object(diagnostic.metrics), permissions = object(metrics.permissions), account = object(metrics.account);
    testnetRows.push({ timestamp: diagnostic.observed_at, environment: "TESTNET", row_type: "ACCOUNT_DIAGNOSTIC", label: "BINANCE TESTNET / FUNDOS FICTÍCIOS", status: diagnostic.status,
      can_trade: account.can_trade ?? null, can_withdraw: account.can_withdraw ?? null, can_deposit: account.can_deposit ?? null,
      user_data: permissions.USER_DATA ?? null, trade: permissions.TRADE ?? null, user_stream: permissions.USER_STREAM ?? null,
      stream_observation_kind: metrics.stream_observation_kind ?? null, error: diagnostic.error_code ?? null, source: "report_runtime_observations", observed_at: diagnostic.observed_at });
    for (const rawBalance of Array.isArray(metrics.balances) ? metrics.balances : []) {
      const balance = object(rawBalance); if (![...filters.assets, "USDC", "USDT", "BRL"].includes(str(balance.asset))) continue;
      testnetRows.push({ timestamp: diagnostic.observed_at, environment: "TESTNET", row_type: "FICTITIOUS_ACCOUNT_BALANCE", asset: balance.asset, free: num(balance.free), locked: num(balance.locked), total: num(balance.total),
        label: "BINANCE TESTNET / FUNDOS FICTÍCIOS", source: "report_runtime_observations", observed_at: diagnostic.observed_at });
    }
    for (const rawProbe of Array.isArray(metrics.probes) ? metrics.probes : []) {
      const probe = object(rawProbe), filtersRow = object(probe.filters), market = object(probe.market);
      if (!filters.assets.includes(assetOf(probe) as ReportAsset)) continue;
      testnetRows.push({ timestamp: diagnostic.observed_at, environment: "TESTNET", row_type: "SYMBOL_DIAGNOSTIC", symbol: probe.symbol, asset: assetOf(probe), available: probe.available, error: probe.error,
        min_quantity: filtersRow.minQuantity ?? null, max_quantity: filtersRow.maxQuantity ?? null, min_notional: filtersRow.minNotional ?? null, quantity_step: filtersRow.quantityStep ?? null, price_tick: filtersRow.priceTick ?? null,
        market_price: market.price ?? null, market_observed_at: market.observedAt ?? null, open_order_count: probe.open_order_count ?? null, owned_open_order_count: probe.owned_open_order_count ?? null, label: "BINANCE TESTNET / FUNDOS FICTÍCIOS", source: "report_runtime_observations" });
    }
  }
  const summary: AuditRow[] = [];
  for (const environment of filters.environments) for (const asset of filters.assets) {
    const gains = periodGains.filter((row) => row.environment === environment && row.asset === asset);
    const completed = allOperations.filter((row) => row.environment === environment && row.asset === asset && inPeriod(row.closed_at, filters));
    const openAtEnd = allOperations.filter((row) => row.environment === environment && row.asset === asset && timestamp(row.opened_at) < timestamp(observationEnd) && (!row.closed_at || timestamp(row.closed_at) >= timestamp(observationEnd)) && (!row.context_ended_at || timestamp(row.context_ended_at) >= timestamp(observationEnd)));
    const ownCycles = relevantCycles.filter((row) => row.environment === environment && row.asset === asset), ownOrders = periodOrders.filter((row) => row.environment === environment && row.asset === asset);
    const ownEvents = allEvents.filter((row) => row.environment === environment && row.asset === asset && inPeriod(row.timestamp, filters));
    const exchangeFills = allEvents.filter((row) => row.environment === environment && row.asset === asset && row.event_type === "TESTNET_FILL_OBSERVED");
    const fillsInWindow = exchangeFills.filter((row) => inPeriod(object(row.details).filledAt, filters));
    const sinceStrategy = (value: unknown) => timestamp(value) >= timestamp(STRATEGY_4_1_EFFECTIVE_AT) && timestamp(value) < timestamp(observationEnd);
    const assetGains = allGains.filter((row) => row.environment === environment && row.asset === asset);
    const ownAlerts = alerts.filter((row) => row.environment === environment && (!row.asset || row.asset === asset) && inPeriod(row.timestamp, filters));
    const ownMissed = environment === "TESTNET" ? temporalOccurrences.filter((row) => row.asset === asset && (!row.detected_at || timestamp(row.detected_at) < timestamp(observationEnd))) : [];
    const temporal = summarizeTemporalMissed(ownMissed);
    const activeAlerts = ownAlerts.filter((row) => row.is_active_issue !== false && (row.is_active_issue === true || timestamp(row.timestamp) >= timestamp(STRATEGY_4_1_EFFECTIVE_AT)));
    const config = configs.find((row) => row.asset === asset && (!row.shadow_test_started_at && !row.created_at || timestamp(row.shadow_test_started_at ?? row.created_at) < timestamp(observationEnd)));
    const periodRuns = [...testnetRuns].filter((row) => row.asset === asset && timestamp(row.created_at) < timestamp(observationEnd)).sort((a, b) => timestamp(a.created_at) - timestamp(b.created_at));
    const firstRun = periodRuns[0], run = periodRuns.at(-1);
    const ownAccounts = accounts.filter((row) => row.config_id === config?.id);
    const starting = environment === "SHADOW" && ownAccounts.length ? sum(ownAccounts, "initial_balance_usdc") : environment === "TESTNET" && firstRun ? number(firstRun.slot_notional_usdc) * 25 : null;
    const history = allCapital.filter((row) => row.environment === environment && row.asset === asset);
    const accountingIncomplete = environment === "SHADOW" && (missing("robot_v1_slot_profit_credits") || missing("robot_v1_slot_accounts") || missing("robot_v1_slot_operations")) || environment === "TESTNET" && missing("robot_v1_testnet_events");
    const capitalStart = starting === null || accountingIncomplete ? null : starting + sum(history.filter((row) => timestamp(row.timestamp) < timestamp(filters.start)), "net_profit");
    const capitalEnd = starting === null || accountingIncomplete ? null : starting + sum(history.filter((row) => timestamp(row.timestamp) < timestamp(observationEnd)), "net_profit");
    const lastCandle = [...candles].filter((row) => assetOf(row) === asset && timestamp(row.candle_close_at) < timestamp(observationEnd)).sort((a, b) => timestamp(b.candle_close_at) - timestamp(a.candle_close_at))[0];
    const market = environment === "SHADOW" ? num(lastCandle?.close_price) ?? (timestamp(config?.last_market_observed_at) <= timestamp(observationEnd) ? num(config?.last_market_price) : null) : null;
    const currentEnough = timestamp(observationEnd) >= timestamp(input.generatedAt) - 1000;
    const historicalOrderUnknown = environment === "TESTNET" && ownOrders.some((row) => row.status_at_period_end === "UNKNOWN" || !currentEnough && row.status_at_period_end === "PARTIALLY_FILLED");
    const openCost = openAtEnd.reduce((total, row) => total + number(row.entry_price) * number(row.quantity), 0);
    const buyReservation = environment === "TESTNET" ? ownOrders.filter((row) => row.side === "BUY" && activeOrder(row.status_at_period_end)).reduce((total, row) => total + (num(row.requested_price) === null ? number(row.requested_quote) : number(row.requested_price) * number(row.remaining_quantity)), 0)
      : environment === "SHADOW" && currentEnough ? normalizedSlots.filter((row) => row.asset === asset && row.environment === "SHADOW" && row.entry_state === "ARMED" && relevantCycles.some((cycle) => cycle.cycle_id === row.cycle_id && !cycle.completed_at)).reduce((total, row) => total + number(row.allocation), 0) : 0;
    const committed = environment === "REAL" || historicalOrderUnknown || environment === "SHADOW" && !currentEnough ? null : Number((openCost + buyReservation).toFixed(12));
    const openPnl = environment === "REAL" || market === null && openAtEnd.length ? null : Number(openAtEnd.reduce((total, row) => total + (number(market) - number(row.entry_price)) * number(row.quantity), 0).toFixed(12));
    const ownRecon = reconciliation.filter((row) => row.environment === environment && (!row.asset || row.asset === asset) && timestamp(row.timestamp) < timestamp(observationEnd)).sort(byTime);
    const persistedEngineExecution = observations.filter((row) => row.source === "SHADOW_ENGINE" && row.asset === asset && timestamp(row.observed_at) < timestamp(observationEnd)).sort((a, b) => timestamp(a.observed_at) - timestamp(b.observed_at)).at(-1)?.observed_at;
    const persistedTestnetExecution = allEvents.filter((row) => row.environment === "TESTNET" && row.asset === asset && row.event_type === "RECONCILED" && timestamp(row.timestamp) < timestamp(observationEnd)).at(-1)?.timestamp;
    const checkpoint = environment === "SHADOW" ? config?.last_engine_at : environment === "TESTNET" ? run?.last_reconciled_at : latestRealRun?.completed_at;
    const lastExecution = environment === "SHADOW" ? persistedEngineExecution ?? (timestamp(checkpoint) <= timestamp(observationEnd) ? checkpoint : null) : environment === "TESTNET" ? persistedTestnetExecution ?? (timestamp(checkpoint) <= timestamp(observationEnd) ? checkpoint : null) : checkpoint;
    const errors = ownAlerts.filter((row) => row.severity === "ERROR").length;
    const hasEvidence = environment === "REAL" ? Boolean(latestRealRun || realRows.length) : environment === "TESTNET" ? Boolean(run) : Boolean(config);
    const missedInWindow = ownMissed.filter((row) => filters.temporalWindow === "SINCE_STRATEGY_4_1" ? row.temporal_classification !== "HISTORICAL_PRE_4_1"
      : inPeriod(row.occurred_at ?? row.occurred_by_at ?? row.detected_at, filters));
    const currentTestnetSlots = normalizedSlots.filter((row) => row.environment === "TESTNET" && row.asset === asset && ownCycles.some((cycle) => cycle.cycle_id === row.cycle_id && cycle.status === "ACTIVE"));
    const activeErrors = temporal.activeIssueCount + (environment === "TESTNET" && run?.last_error ? 1 : 0);
    const engineStale = environment === "TESTNET" && run?.status === "ACTIVE" && (!lastExecution || timestamp(observationEnd) - timestamp(lastExecution) > 120_000);
    const currentHealth = !hasEvidence ? "SEM_EVIDENCIA" : temporal.regressionCount || environment === "TESTNET" && run?.last_error ? "DIVERGÊNCIA ATIVA"
      : temporal.unresolvedCount || temporal.externalCount || engineStale || activeAlerts.length || !currentEnough || missing("robot_v1_testnet_events") || missing("robot_v1_testnet_slots") || missing("robot_v1_testnet_orders") ? "ATENÇÃO"
      : temporal.historicalCount ? "Motor OK — ocorrências históricas preservadas" : "Motor OK";
    summary.push({ period_start: filters.start, period_end: filters.end, observed_until: observationEnd, environment, asset, symbol: environment === "REAL" ? asset === "SOL" ? "SOLBRL" : "BTCUSDT" : `${asset}USDC`, quote_asset: environment === "REAL" ? null : "USDC", mode: environment === "REAL" ? "READ_ONLY / LIVE BLOCKED" : environment,
      capital_start: capitalStart, capital_end: capitalEnd, free_capital: capitalEnd === null || committed === null ? null : capitalEnd - committed, committed_capital: committed,
      capital_basis: environment === "REAL" ? "NOT_COINOPS_OPERATING_CAPITAL" : "INITIAL_PHYSICAL_SLOT_CAPITAL_PLUS_IMMUTABLE_CREDITS; committed=executed position cost + reserved NEXT BUY; unknown historical reserve remains null", realized_pnl: sum(completed, "net_profit"), open_pnl: openPnl,
      total_result: openPnl === null ? null : sum(completed, "net_profit") + openPnl, gains: gains.filter((row) => number(row.net_gain) > 0).length, operations: completed.length, open_operations: openAtEnd.length,
      cycles: ownCycles.length, completed_cycles: ownCycles.filter((row) => inPeriod(row.completed_at, filters)).length, slots: ownCycles.length ? Math.max(...ownCycles.map((row) => number(row.slot_count))) : 0,
      buys: environment === "TESTNET" ? ownOrders.filter((row) => row.side === "BUY" && row.status_at_period_end === "FILLED" && inPeriod(row.filled_at, filters)).length : ownEvents.filter((row) => ["BUY_TRIGGERED", "INITIAL_POSITION_OPENED"].includes(str(row.event_type))).length,
      take_profits: environment === "TESTNET" ? ownOrders.filter((row) => row.side === "SELL" && row.status_at_period_end === "FILLED" && inPeriod(row.filled_at, filters)).length : ownEvents.filter((row) => row.event_type === "TP_TRIGGERED").length,
      orders_open: ownOrders.filter((row) => activeOrder(row.status_at_period_end)).length, orders_filled: ownOrders.filter((row) => row.status_at_period_end === "FILLED" && inPeriod(row.filled_at, filters)).length, orders_cancelled: ownOrders.filter((row) => ["CANCELED", "CANCELLED"].includes(str(row.status_at_period_end)) && inPeriod(row.canceled_at, filters)).length,
      fills: filters.temporalWindow === "SINCE_STRATEGY_4_1" && environment === "TESTNET" ? exchangeFills.length ? fillsInWindow.length : null : ownEvents.some((row) => row.event_type === "TESTNET_FILL_OBSERVED") ? ownEvents.filter((row) => row.event_type === "TESTNET_FILL_OBSERVED").length : ownEvents.filter((row) => /_(PARTIALLY_FILLED|FILLED)$/.test(str(row.event_type))).length,
      fill_count_basis: filters.temporalWindow === "SINCE_STRATEGY_4_1" && environment === "TESTNET" ? "EXCHANGE_FILLED_AT; collection timestamp remains separate; missing exact evidence is null" : ownEvents.some((row) => row.event_type === "TESTNET_FILL_OBSERVED") ? "PERSISTED_EXCHANGE_TRADE_OBSERVATIONS" : "OBSERVED_ORDER_STATUS_TRANSITIONS; exact legacy fills unavailable",
      fills_without_exchange_time: exchangeFills.filter((row) => !object(row.details).filledAt && inPeriod(row.timestamp, filters)).length,
      since_strategy_gains_by_fill: environment === "TESTNET" ? assetGains.filter((row) => sinceStrategy(row.exchange_gain_at)).length : environment === "SHADOW" ? assetGains.filter((row) => sinceStrategy(row.gain_at)).length : null,
      since_strategy_gain_fill_unknown: environment === "TESTNET" ? assetGains.filter((row) => !row.exchange_gain_at && sinceStrategy(row.gain_at)).length : 0,
      ledger_credits_observed_since_strategy: history.filter((row) => sinceStrategy(row.credited_at)).length,
      gain_window_basis: "gains=existing ledger recognition; since_strategy_gains_by_fill=proven exchange TP time (Shadow closed_at); late credits do not become new strategy gains",
      missed_levels: environment === "TESTNET" ? missedInWindow.length : ownEvents.filter((row) => /MISSED_LEVEL/.test(str(row.event_type))).length,
      historical_missed: temporal.historicalCount, missed_since_strategy: temporal.currentVersionCount, active_missed: temporal.activeIssueCount, unresolved_missed: temporal.unresolvedCount,
      active_errors: activeErrors, errors, last_price: market, last_event: ownEvents.at(-1)?.timestamp ?? null,
      operational_open: currentTestnetSlots.filter((row) => row.operational_state === "OPEN").length,
      operational_next_buy: currentTestnetSlots.filter((row) => row.operational_state === "NEXT_BUY").length,
      operational_reentry_waiting: currentTestnetSlots.filter((row) => row.operational_state === "REENTRY_WAITING").length,
      operational_planned: currentTestnetSlots.filter((row) => row.operational_state === "PLANNED").length,
      operational_active_error: currentTestnetSlots.filter((row) => row.operational_state === "ACTIVE_ERROR").length,
      strategy_effective_at: STRATEGY_4_1_EFFECTIVE_AT, audit_window: filters.temporalWindow ?? "CUSTOM_PERIOD",
      local_reentries: ownEvents.filter((row) => row.event_type === "SLOT_REENTRY_PLANNED").length,
      global_resets: ownEvents.filter((row) => ["CYCLE_RESTARTED", "NEW_CYCLE_STARTED"].includes(str(row.event_type))).length,
      latency_warnings: activeAlerts.filter((row) => ["EXECUTION_GAP", "ENGINE_STALE", "DATA_GAP"].includes(str(row.code))).length,
      last_reconciliation: ownRecon.at(-1)?.timestamp ?? (environment === "SHADOW" ? null : iso(lastExecution)), last_execution: iso(lastExecution),
      health: environment === "TESTNET" ? currentHealth : !hasEvidence ? "SEM_EVIDENCIA" : errors ? "ERRO_REGISTRADO" : ownAlerts.length ? "REVISAR_ALERTAS" : "SEM_ERRO_REGISTRADO",
      health_basis: "CURRENT_ISSUES_SEPARATE_FROM_HISTORICAL_OCCURRENCES; ver checks e fontes incompletas", snapshot_at: input.generatedAt });
  }
  const datasets: AuditDatasets = {
    summary, cycles: relevantCycles, slots: normalizedSlots.filter((row) => selected(row, filters) && cycleIds.has(row.cycle_id)), operations: periodOperations,
    orders: periodOrders, events: allEvents.filter((row) => selected(row, filters) && inPeriod(row.timestamp, filters)), gains: periodGains,
    capital: allCapital.filter((row) => selected(row, filters) && inPeriod(row.timestamp, filters)), market: [...triggerResults, ...candleSamples].filter((row) => selected(row, filters)),
    reconciliation: reconciliation.filter((row) => selected(row, filters) && inPeriod(row.timestamp, filters)), alerts: alerts.filter((row) => selected(row, filters) && inPeriod(row.timestamp, filters)),
    rules: rules.filter((row) => selected(row, filters)), checks: [], testnet: testnetRows.filter((row) => filters.environments.includes("TESTNET") && (!assetOf(row) || filters.assets.includes(assetOf(row) as ReportAsset) || ["USDC", "USDT", "BRL"].includes(str(row.asset))) && (row.cycle_id ? cycleIds.has(row.cycle_id) : inPeriod(row.timestamp, filters))), real: realRows.filter((row) => filters.environments.includes("REAL") && (!assetOf(row) || filters.assets.includes(assetOf(row) as ReportAsset) || ["USDC", "USDT", "BRL"].includes(str(row.asset))))
    , decisions: normalizeStrategyDecisions(source("robot_v1_strategy_decisions")).filter((row) => selected(row, filters) && overlap(row.created_at, row.completed_at, filters))
    , missed_temporal: temporalOccurrences.map((row) => ({ ...row, environment: "TESTNET", symbol: `${row.asset}USDC`,
      context_only: filters.temporalWindow === "SINCE_STRATEGY_4_1" && row.temporal_classification === "HISTORICAL_PRE_4_1", source: "robot_v1_testnet_events+current_slot_fallback" }))
      .filter((row) => selected(row, filters) && (!row.detected_at || timestamp(row.detected_at) < timestamp(observationEnd))),
    monthly_goals: monthlyGoals
  };
  datasets.checks = buildAuditChecks(datasets, { source: input.sources, incompleteSources, generatedAt: input.generatedAt, filters, allOperations, allCapital });
  datasets.checks.push(...buildStrategyAuditChecks(datasets, { incompleteSources, generatedAt: input.generatedAt, filters, contextOrders: normalizedOrders, contextEvents: allEvents }));
  datasets.checks.push(...buildMonthlyGoalChecks(datasets, input.sources, incompleteSources, input.generatedAt));
  const liveParity = datasets.checks.find((row) => row.code === "LIVE_STRATEGY_PARITY_READY");
  if (liveParity) {
    const monthlyCodes = new Set(["MONTHLY_GAIN_COUNT_RECONCILES", "TARGET_REACHED_SLOT_HAS_NO_NEW_ENTRY",
      "TARGET_REACHED_SLOT_HAS_NO_REENTRY", "NEW_MONTH_REENABLES_SLOT", "LIFETIME_GAIN_NEVER_RESETS",
      "RANK_DESCENDING_BY_LIFETIME_GAINS", "RANK_EXCLUDES_TARGET_REACHED", "PHYSICAL_SLOT_ID_IMMUTABLE",
      "SINGLE_ACTIVE_ENTRY_PRESERVED", "PRICE_PRIORITY_PRESERVED", "SHADOW_TESTNET_MONTHLY_TARGET_PARITY"]);
    const monthlyChecks = datasets.checks.filter((row) => monthlyCodes.has(str(row.code)));
    liveParity.status = monthlyChecks.some((row) => row.status === "FAIL") ? "FAIL"
      : liveParity.status === "PASS" && monthlyChecks.length && monthlyChecks.every((row) => row.status === "PASS") ? "PASS" : "WARNING";
    liveParity.explanation = `${liveParity.explanation} A Fase 4.2 também exige todos os checks mensais/rank PASS; virada de mês não observada permanece WARNING. LIVE continua bloqueado.`;
  }
  const currentInvariantCodes = new Set(["SLOT_COUNT_25", "SINGLE_ACTIVE_ENTRY", "TP_HAS_POSITION", "TP_NOT_DUPLICATED", "OPEN_POSITION_HAS_RESIDENT_TP", "PRIORITY_REENTRY_MUST_BE_ARMED_BEFORE_LOWER_LEVEL", "CURRENT_SLOT_STATE_NOT_OVERRIDDEN_BY_HISTORY",
    "MONTHLY_GAIN_COUNT_RECONCILES", "TARGET_REACHED_SLOT_HAS_NO_NEW_ENTRY", "TARGET_REACHED_SLOT_HAS_NO_REENTRY", "RANK_DESCENDING_BY_LIFETIME_GAINS", "RANK_EXCLUDES_TARGET_REACHED", "PHYSICAL_SLOT_ID_IMMUTABLE"]);
  for (const row of summary) {
    const scopeChecks = datasets.checks.filter((check) => check.environment === row.environment && (!check.asset || check.asset === row.asset));
    const currentFailures = scopeChecks.filter((check) => currentInvariantCodes.has(str(check.code)) && check.status === "FAIL");
    row.invariant_failures = currentFailures.length;
    row.parity_failures = scopeChecks.filter((check) => str(check.code).startsWith("STRATEGY_") && check.status === "FAIL").length;
    row.decisions = datasets.decisions.filter((decision) => decision.environment === row.environment && decision.asset === row.asset).length;
    if (row.environment === "TESTNET" && currentFailures.length) {
      row.health = "DIVERGÊNCIA ATIVA";
      row.active_errors = number(row.active_errors) + currentFailures.length;
    } else if (row.environment === "TESTNET" && str(row.health).startsWith("Motor OK") && scopeChecks.some((check) => currentInvariantCodes.has(str(check.code)) && check.status === "WARNING")) row.health = "ATENÇÃO";
  }
  for (const check of datasets.checks.filter((row) => row.status !== "PASS")) warnings.push(`${check.code}: ${check.explanation}`);
  for (const key of REPORT_DATASET_KEYS) datasets[key].sort(byTime);
  return { datasets, warnings: [...new Set(warnings)].sort(), incompleteSources: [...new Set(incompleteSources)].sort() };
}
