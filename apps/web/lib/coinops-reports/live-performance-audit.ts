import type { AuditRow } from "./trigger-audit.ts";

const text = (value: unknown) => String(value ?? "");
const numeric = (value: unknown) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const object = (value: unknown): AuditRow => value && typeof value === "object" && !Array.isArray(value) ? value as AuditRow : {};
const iso = (value: unknown) => Number.isFinite(Date.parse(text(value))) ? new Date(text(value)).toISOString() : null;
const round = (value: number) => Number(value.toFixed(12));

/** Read model only: a credited, identified TP is closure evidence. Mutable
 * lifetime balances and raw SELL fills alone are never period performance. */
export function buildLivePerformanceEvidence(sources: Record<string, AuditRow[]>) {
  const runs = new Map((sources.robot_v1_live_runs ?? []).map((row) => [text(row.id), row]));
  const orders = sources.robot_v1_live_orders ?? [], fills = sources.robot_v1_live_fills ?? [];
  const events: AuditRow[] = [], operations: AuditRow[] = [], capital: AuditRow[] = [], alerts: AuditRow[] = [];
  const incomplete: string[] = [], credited = new Set<string>();
  for (const row of sources.robot_v1_live_events ?? []) {
    const run = runs.get(text(row.run_id));
    if (!run) continue;
    const context = { environment: "REAL", asset: run.asset, symbol: run.symbol, quote_asset: run.quote_asset,
      cycle_id: run.id, slot: row.slot_number, source: "robot_v1_live_events" };
    events.push({ ...context, event_id: row.id, event_type: row.event_type, timestamp: iso(row.observed_at),
      idempotency_key: row.event_key,
      severity: /(?:^|_)(ERROR|FAILED|FAILURE|CRITICAL)(?:_|$)/.test(text(row.event_type)) ? "ERROR" : "INFO" });
    if (row.event_type !== "SLOT_PROFIT_CREDITED") continue;
    const details = object(row.details);
    const tp = orders.find((order) => order.run_id === row.run_id && order.slot_number === row.slot_number
      && order.side === "SELL" && order.purpose === "TP" && order.client_order_id === details.tp_client_order_id);
    const identity = tp ? `${run.id}:${tp.slot_id}:${tp.operation_sequence}` : null;
    // Database uniqueness is authoritative; a repeated export page must still
    // not count the same physical operation twice.
    if (identity && credited.has(identity)) continue;
    const tpFills = tp ? fills.filter((fill) => fill.order_id === tp.id && iso(fill.filled_at)) : [];
    const closedAt = tpFills.map((fill) => iso(fill.filled_at)!).sort().at(-1) ?? null;
    const net = numeric(details.net_pnl_quote ?? details.net_pnl_brl);
    if (!tp || !identity || !tp.slot_id || !numeric(tp.operation_sequence) || !closedAt || net === null) {
      incomplete.push(`live_performance:unproven_credit:${text(row.id)}`);
      continue;
    }
    credited.add(identity);
    const buys = orders.filter((order) => order.run_id === run.id && order.slot_id === tp.slot_id
      && order.operation_sequence === tp.operation_sequence && order.side === "BUY");
    const buyFills = fills.filter((fill) => buys.some((buy) => buy.id === fill.order_id));
    const openedAt = buyFills.map((fill) => iso(fill.filled_at)).filter((value): value is string => value !== null).sort()[0] ?? null;
    const quantity = buys.length && buys.every((buy) => numeric(buy.executed_quantity) !== null)
      ? round(buys.reduce((total, buy) => total + Number(buy.executed_quantity), 0)) : null;
    const buyQuote = numeric(details.buy_quote ?? details.buy_quote_brl), sellQuote = numeric(details.sell_quote ?? details.sell_quote_brl);
    const gross = numeric(details.gross_pnl_quote ?? details.gross_pnl_brl), fees = numeric(details.fees_quote ?? details.fees_brl);
    const dust = numeric(details.dust_basis_quote ?? details.dust_basis_brl);
    const after = numeric(details.balance_after_quote ?? details.balance_after_brl);
    const cashDelta = buyQuote === null || sellQuote === null || fees === null ? null : round(sellQuote - buyQuote - fees);
    const operationId = `live:${identity}`;
    operations.push({ ...context, operation_id: operationId, slot_id: tp.slot_id, physical_slot_number: row.slot_number,
      operation_sequence: tp.operation_sequence, sequence: tp.operation_sequence, side: "BUY→TP",
      entry_price: quantity && buyQuote !== null ? buyQuote / quantity : null, quantity, allocation: buyQuote,
      take_profit_price: numeric(tp.price), gain_target_percent: numeric(run.gain_rate) === null ? null : Number(run.gain_rate) * 100,
      opened_at: openedAt, closed_at: closedAt, exchange_closed_at: closedAt, credited_at: iso(row.observed_at),
      gross_profit: gross, fees, net_profit: net, dust_cost_quote: dust, cash_delta_quote: cashDelta,
      result: net > 0 ? "GAIN" : net < 0 ? "LOSS" : "FLAT", buy_client_order_id: buys.map((buy) => buy.client_order_id),
      sell_client_order_id: tp.client_order_id, trigger_source: "PERSISTED_BINANCE_SPOT_TP_FILL",
      closed_at_basis: "EXCHANGE_TP_FILL; CREDIT_OBSERVATION_SEPARATE", source: "robot_v1_live_events+robot_v1_live_orders+robot_v1_live_fills" });
    capital.push({ ...context, timestamp: closedAt, credited_at: iso(row.observed_at), event: "SLOT_PROFIT_CREDITED",
      source_operation: operationId, balance_before: after === null || cashDelta === null ? null : round(after - cashDelta),
      balance_after: after, realized_profit: net, gross_profit: gross, fees, net_profit: net,
      cash_delta_quote: cashDelta, dust_cost_quote: dust, manual_gain: 0, contribution: 0, withdrawal: 0,
      evidence_basis: "IMMUTABLE_CREDIT; CASH_DELTA_EXCLUDES_RETAINED_DUST_COST" });
  }
  for (const order of orders.filter((row) => row.side === "SELL" && row.purpose === "TP" && row.status === "FILLED")) {
    if (!credited.has(`${order.run_id}:${order.slot_id}:${order.operation_sequence}`))
      incomplete.push(`live_performance:filled_tp_without_credit:${text(order.id)}`);
  }
  for (const row of sources.robot_v1_live_alerts ?? []) alerts.push({ environment: "REAL", asset: row.asset,
    timestamp: iso(row.last_seen_at ?? row.first_seen_at), first_seen_at: iso(row.first_seen_at),
    severity: ["CRITICAL", "ERROR"].includes(text(row.severity)) ? "ERROR" : row.severity,
    recorded_severity: row.severity, code: row.code, message: row.code, alert_id: row.id,
    is_active_issue: !row.resolved_at, resolved: Boolean(row.resolved_at), resolved_at: iso(row.resolved_at),
    source: "robot_v1_live_alerts" });
  return { events, operations, capital, alerts, incomplete };
}
