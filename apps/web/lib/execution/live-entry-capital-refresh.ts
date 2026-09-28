/** Pure preflight for a capital-only replacement. It grants no trading authority. */
export type CapitalRefreshOrder = {
  side: string; purpose: string; status: string; requested_quantity: number | string | null;
  executed_quantity: number | string; cumulative_quote: number | string;
};
export function planLiveEntryCapitalRefresh(input: {
  order: CapitalRefreshOrder; slotState: string; positionQuantity: number;
  balance: number; price: number; quantityStep: number; minQuantity: number; maxQuantity: number;
  minNotional: number; spendable: number; freeQuoteAfterCancel: number;
  engineCap: number; accountCap: number; maxOrder: number;
  supportsUnfilledCancel?: boolean;
  executorCaps?: { engine: number; account: number; max_order: number };
}) {
  const o = input.order;
  if (o.side !== "BUY" || o.purpose !== "ENTRY" || o.status !== "NEW"
    || Number(o.executed_quantity) !== 0 || Number(o.cumulative_quote) !== 0
    || input.slotState !== "ARMED" || input.positionQuantity !== 0)
    return { status: "KEEP" as const, reason: "POSITION_OR_ORDER_NOT_UNFILLED" };
  const values = [input.balance, input.price, input.quantityStep, input.minQuantity, input.maxQuantity,
    input.minNotional, input.spendable, input.freeQuoteAfterCancel, Number(o.requested_quantity),
    input.engineCap, input.accountCap, input.maxOrder];
  if (!values.every((v) => Number.isFinite(v) && v > 0))
    return { status: "KEEP" as const, reason: "CAPITAL_REFRESH_EVIDENCE_INCOMPLETE" };
  const quantity = Number((Math.floor((Math.min(input.balance, input.spendable) / input.price + 1e-10)
    / input.quantityStep) * input.quantityStep).toFixed(12));
  const fullQuantity = Number((Math.floor((Math.min(input.balance, input.maxOrder) / input.price + 1e-10)
    / input.quantityStep) * input.quantityStep).toFixed(12));
  // Do not consume the contribution checkpoint with a partially resized BUY.
  // Keep the old order until the ledger/caps can fund the intended slot size.
  if (quantity + input.quantityStep / 2 < fullQuantity)
    return { status: "KEEP" as const, reason: "CAPITAL_REFRESH_HEADROOM_HOLD" };
  if (quantity - Number(o.requested_quantity) < input.quantityStep / 2)
    return { status: "KEEP" as const, reason: "CAPITAL_ALREADY_REFLECTED_IN_BUY" };
  const notional = Number((quantity * input.price).toFixed(12));
  if (quantity < input.minQuantity || quantity > input.maxQuantity || notional < input.minNotional
    || notional > input.freeQuoteAfterCancel + 1e-8)
    return { status: "KEEP" as const, reason: "CAPITAL_REFRESH_FUNDS_OR_FILTER_HOLD" };
  const caps = input.executorCaps;
  if (!input.supportsUnfilledCancel || !caps || ![caps.engine, caps.account, caps.max_order].every(Number.isFinite)
    || caps.engine + 1e-8 < input.engineCap || caps.account + 1e-8 < input.accountCap
    || caps.max_order + 1e-8 < input.maxOrder || caps.max_order + 1e-8 < notional)
    return { status: "KEEP" as const, reason: "CAPITAL_REFRESH_EXECUTOR_SYNC_PENDING" };
  return { status: "REPLACE" as const, quantity, notional };
}

/** A canceled zero-fill order is a durable checkpoint even if the process died
 * before persisting PLANNED. Missing/unknown/filled evidence never authorizes it. */
export function canRestoreUnfilledEntry(slot: { entry_state: string; position_quantity: number | string },
  orders: readonly { side: string; purpose: string; status: string; executed_quantity: number | string;
    cumulative_quote: number | string; trades_reconciled: boolean }[]) {
  return slot.entry_state === "ARMED" && Number(slot.position_quantity) === 0 && orders.length > 0
    && orders.some((o) => o.side === "BUY" && o.purpose === "ENTRY" && o.status === "CANCELED")
    && orders.every((o) => o.side === "BUY" && o.purpose === "ENTRY"
      && ["CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"].includes(o.status)
      && Number(o.executed_quantity) === 0 && Number(o.cumulative_quote) === 0 && o.trades_reconciled);
}
