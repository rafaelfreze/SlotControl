/** Eligibility to ASK for durable executor evidence, not permission to trade.
 * Neither an absent order nor an expired permit alone releases ownership. */
export function mayAttestUnsentEntry(order: { status: string; side: string; purpose: string;
  exchange_order_id: string | null; executed_quantity: number | string; cumulative_quote: number | string },
  decision: { result: string; dispatched_at: string | null; exchange_ack_at: string | null; completed_at: string | null } | null,
  now = Date.now()) {
  return order.status === "PREPARED" && order.side === "BUY" && order.purpose === "ENTRY"
    && order.exchange_order_id === null && Number(order.executed_quantity) === 0 && Number(order.cumulative_quote) === 0
    && decision?.result === "DISPATCHED" && decision.exchange_ack_at === null && decision.completed_at === null
    && decision.dispatched_at !== null && Number.isFinite(Date.parse(decision.dispatched_at))
    && now - Date.parse(decision.dispatched_at) >= 90_000;
}
