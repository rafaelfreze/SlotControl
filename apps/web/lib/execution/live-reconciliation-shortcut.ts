type LedgerOrder = {
  status: string; side: "BUY" | "SELL"; purpose: string;
  client_order_id: string; exchange_order_id: string | null;
  submission_guarded_at: string | null;
  price: number | string | null;
  executed_quantity: number | string; cumulative_quote: number | string;
};
type ExchangeOrder = {
  status: string; symbol: string; side: "BUY" | "SELL";
  clientOrderId: string; orderId: string; price: number;
  executedQuantity: number; cumulativeQuoteQuantity: number;
};

/** Only an unchanged, completely unfilled resident order can omit the
 * expensive trade-history/fee sync. Every fill, cancellation, uncertain
 * submission or identity/price mismatch still follows full reconciliation. */
export function unchangedUnfilledResidentOrder(ledger: LedgerOrder,
  observed: ExchangeOrder, symbol: string): boolean {
  return ledger.status === "NEW" && observed.status === "NEW"
    && ledger.submission_guarded_at !== null
    && ledger.exchange_order_id !== null
    && observed.orderId === ledger.exchange_order_id
    && observed.clientOrderId === ledger.client_order_id
    && observed.symbol === symbol && observed.side === ledger.side
    && Number(ledger.executed_quantity) === 0 && observed.executedQuantity === 0
    && Number(ledger.cumulative_quote) === 0 && observed.cumulativeQuoteQuantity === 0
    && (ledger.purpose === "INITIAL" || ledger.price !== null
      && Number.isFinite(Number(ledger.price))
      && Math.abs(Number(ledger.price) - observed.price) <= 1e-8);
}
