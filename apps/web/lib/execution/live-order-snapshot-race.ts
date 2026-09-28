import type { LiveOrder, LiveTrade } from "./live-executor-transport";

/** A resident can disappear from openOrders between a snapshot and ledger sync.
 * Only an exact, trade-backed fill is a retryable race; every other absence
 * remains a fail-closed mismatch. This never mutates an order or ledger row. */
export function isConfirmedFilledSnapshotRace(expected: {
  client_order_id: string; exchange_order_id: string | null; side: "BUY" | "SELL";
}, symbol: string, order: LiveOrder | null, tradesOrder: LiveOrder | null,
trades: LiveTrade[] | null): boolean {
  return !!expected.exchange_order_id && !!order && !!tradesOrder && !!trades?.length
    && order.orderId === expected.exchange_order_id
    && order.clientOrderId === expected.client_order_id
    && order.symbol === symbol && order.side === expected.side
    && order.status === "FILLED" && order.executedQuantity > 0
    && tradesOrder.orderId === order.orderId
    && tradesOrder.clientOrderId === order.clientOrderId
    && tradesOrder.symbol === symbol && tradesOrder.side === expected.side
    && tradesOrder.status === "FILLED"
    && tradesOrder.executedQuantity === order.executedQuantity
    && Math.abs(trades.reduce((sum, trade) => sum + trade.quantity, 0)
      - order.executedQuantity) <= Math.max(1e-12, order.executedQuantity * 1e-8)
    && trades.every((trade) => trade.isBuyer === (expected.side === "BUY")
      && trade.quantity > 0 && trade.quoteQuantity > 0);
}
