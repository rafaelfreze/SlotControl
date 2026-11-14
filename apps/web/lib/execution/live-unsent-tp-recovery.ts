/** A guarded TP may be retried with its original client ID only when the
 * durable strategy decision proves that no executor dispatch was attempted.
 * A missing Binance order alone is never sufficient evidence. */
export function isProvablyUnsentTakeProfit(order: {
  status: string; side: string; purpose: string; run_id: string; slot_id: string;
  operation_sequence: number; strategy_decision_id: string | null;
  submission_guarded_at: string | null;
}, decision: {
  decision_id: string; cycle_id: string; slot_id: string | null;
  operation_sequence: number | null; action_type: string; result: string;
  dispatched_at: string | null; exchange_ack_at: string | null;
  completed_at: string | null;
} | null, now: number, minimumAgeMs = 180_000): boolean {
  const guardedAt = Date.parse(order.submission_guarded_at ?? "");
  return order.status === "PREPARED" && order.side === "SELL" && order.purpose === "TP"
    && Boolean(order.strategy_decision_id) && Number.isFinite(guardedAt)
    && now - guardedAt >= minimumAgeMs
    && decision?.decision_id === order.strategy_decision_id
    && decision.cycle_id === order.run_id && decision.slot_id === order.slot_id
    && decision.operation_sequence === order.operation_sequence
    && decision.action_type === "CREATE_TP" && decision.result === "PENDING"
    && decision.dispatched_at === null && decision.exchange_ack_at === null
    && decision.completed_at === null;
}

/** Eligibility to request durable fenced proof, never permission to resend.
 * The executor must attest no POST, not merely an absent exchange order. */
export function mayAttestUnsentTakeProfit(order: Parameters<typeof isProvablyUnsentTakeProfit>[0] & {
  exchange_order_id: string | null; executed_quantity: number | string; cumulative_quote: number | string },
  decision: Parameters<typeof isProvablyUnsentTakeProfit>[1], now = Date.now()) {
  return order.status === "PREPARED" && order.side === "SELL" && order.purpose === "TP"
    && order.exchange_order_id === null && Number(order.executed_quantity) === 0 && Number(order.cumulative_quote) === 0
    && Boolean(order.strategy_decision_id) && decision?.decision_id === order.strategy_decision_id
    && decision.cycle_id === order.run_id && decision.slot_id === order.slot_id
    && decision.operation_sequence === order.operation_sequence && decision.action_type === "CREATE_TP"
    && decision.result === "DISPATCHED" && decision.exchange_ack_at === null && decision.completed_at === null
    && decision.dispatched_at !== null && Number.isFinite(Date.parse(decision.dispatched_at))
    && now - Date.parse(decision.dispatched_at) >= 90_000;
}
