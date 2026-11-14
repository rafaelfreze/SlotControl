type Scope = { product_id: string; tenant_id: string; user_id: string; operator_id: string;
  exchange_account_id: string; trading_engine_id: string; quote_asset: string };
type Run = Scope & { id: string; symbol: string; created_at: string; last_reconciled_at: string | null };
type Row = Record<string, unknown>;
const OWNER = ["product_id", "tenant_id", "user_id", "operator_id", "exchange_account_id", "trading_engine_id", "quote_asset"] as const;
const SETTLED = new Set(["NEW", "PARTIALLY_FILLED", "FILLED", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"]);
const positive = (n: unknown) => n !== null && n !== undefined && n !== "" && Number.isFinite(Number(n)) && Number(n) > 0;
const zero = (n: unknown) => n !== null && n !== undefined && n !== "" && Number(n) === 0;

/** A PREPARED LIMIT is not an ambiguous POST when ALL dispatch barriers are
 * untouched and an exact current exchange GET also proves absence. Preserve
 * its identity/reservation; this proof never submits, retires or replaces it. */
export function proveUndispatchedRateLimitEntry(run: Run, orders: Row[], slots: Row[],
  decisions: Row[], unacknowledged: Row[], observedOrder: unknown, prefix: string,
  incident: { first_seen_at?: string; last_seen_at: string }, now = Date.now()) {
  const fail = (): never => { throw Error("COINOPS_LIVE_RATE_LIMIT_RECOVERY_UNPROVEN"); };
  const first = Date.parse(incident.first_seen_at ?? ""), last = Date.parse(incident.last_seen_at);
  const reconciled = Date.parse(run.last_reconciled_at ?? ""), created = Date.parse(run.created_at);
  if (![first, last, reconciled, created, now].every(Number.isFinite)
    || reconciled <= Math.max(first, last) || reconciled > now || now - reconciled > 150_000
    || !prefix || !orders.length || !Array.isArray(decisions) || decisions.length !== 1
    || !Array.isArray(unacknowledged) || unacknowledged.length || observedOrder !== null) return fail();
  for (const order of orders) {
    if (OWNER.some(key => !run[key] || order[key] !== run[key]) || order.run_id !== run.id
      || typeof order.client_order_id !== "string" || !order.client_order_id.startsWith(prefix)
      || !["BUY", "SELL"].includes(String(order.side)) || !Number.isFinite(Number(order.executed_quantity))
      || Number(order.executed_quantity) < 0 || !Number.isFinite(Number(order.cumulative_quote))
      || Number(order.cumulative_quote) < 0 || Number(order.executed_quantity) > 0 && !order.trades_reconciled
      || order.status !== "PREPARED" && !SETTLED.has(String(order.status))) return fail();
  }
  if (new Set(orders.map(o => o.id)).size !== orders.length
    || new Set(orders.map(o => o.client_order_id)).size !== orders.length) return fail();
  const prepared = orders.filter(o => o.status === "PREPARED");
  const order = prepared.length === 1 ? prepared[0] : null;
  const slot = order && slots.find(s => s.id === order.slot_id);
  const decision = decisions[0];
  if (!order || !slot || order.side !== "BUY" || order.purpose !== "ENTRY" || order.requested_quote !== null
    || order.exchange_order_id !== null || order.submission_guarded_at !== null
    || order.account_order_unsent_receipt !== null || !zero(order.executed_quantity) || !zero(order.cumulative_quote)
    || !zero(order.fee_base) || !zero(order.fee_quote) || !Array.isArray(order.fee_other) || order.fee_other.length
    || !positive(order.price) || !positive(order.requested_quantity) || !positive(order.reserved_notional_brl)
    || Math.abs(Number(order.requested_quantity) * Number(order.price) - Number(order.reserved_notional_brl)) > 1e-8
    || !Number.isFinite(Date.parse(String(order.created_at))) || Date.parse(String(order.created_at)) < created
    || Date.parse(String(order.created_at)) > Math.min(first, last)
    || slots.filter(s => s.id === order.slot_id).length !== 1 || OWNER.some(key => slot[key] !== run[key])
    || slot.run_id !== run.id || slot.entry_state !== "ARMED" || !zero(slot.position_quantity)
    || slot.operation_sequence !== order.operation_sequence || slot.slot_number !== order.slot_number
    || Number(slot.target_buy_price) !== Number(order.price)
    || orders.some(o => o.side === "BUY" && ["NEW", "PARTIALLY_FILLED"].includes(String(o.status)))
    || OWNER.some(key => decision[key] !== run[key]) || decision.environment !== "REAL"
    || decision.cycle_id !== run.id || decision.decision_id !== order.strategy_decision_id
    || !order.strategy_decision_id || decision.slot_id !== order.slot_id
    || decision.operation_sequence !== order.operation_sequence || decision.action_type !== "ARM_NEXT_BUY"
    || decision.expected_next_state !== "ARMED"
    || decision.result !== "PENDING" || decision.dispatched_at !== null || decision.exchange_ack_at !== null
    || decision.completed_at !== null || Number(decision.target_price) !== Number(order.price)
    || !positive(decision.target_notional) || Number(decision.target_notional) < Number(order.reserved_notional_brl)
    || !Number.isFinite(Date.parse(String(decision.created_at)))
    || Date.parse(String(decision.created_at)) < created
    || Date.parse(String(decision.created_at)) > Date.parse(String(order.created_at))) return fail();
  return JSON.stringify([run.id, ...OWNER.map(k => run[k]),
    orders.map(o => [o.id, o.client_order_id, o.exchange_order_id, o.slot_id, o.operation_sequence, o.status,
      o.submission_guarded_at, o.executed_quantity, o.cumulative_quote, o.trades_reconciled, o.price,
      o.requested_quantity, o.reserved_notional_brl]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    decision.decision_id, decision.created_at, decision.target_price, decision.target_notional,
    slot.id, slot.operation_sequence, slot.target_buy_price]);
}
