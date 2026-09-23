/** Pure accounting used by reconciliation. A terminal status does not imply
 * zero execution: canceled/expired partials retain their fills and commissions. */
export const TESTNET_TERMINAL_ORDER_STATUSES = new Set(["FILLED", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"]);
const active = new Set(["PREPARED", "NEW", "PARTIALLY_FILLED"]);
type Numeric = number | string | null;
export type AccountingOrder = {
  side: "BUY" | "SELL"; status: string; executed_quantity: Numeric;
  requested_quantity?: Numeric; cumulative_quote: Numeric; fee_base: Numeric; fee_quote: Numeric;
  fee_other?: readonly { asset: string; amount: number }[]; trades_reconciled: boolean;
  client_order_id: string; revision: number;
};
function value(input: Numeric | undefined) {
  const result = Number(input ?? 0);
  if (!Number.isFinite(result) || result < 0) throw new Error("COINOPS_TESTNET_FILL_AMOUNT_INVALID");
  return result;
}

export function needsTestnetOrderSync(order: Pick<AccountingOrder, "status" | "executed_quantity" | "trades_reconciled">) {
  return !TESTNET_TERMINAL_ORDER_STATUSES.has(order.status)
    || (value(order.executed_quantity) > 0 && !order.trades_reconciled);
}

export function needsTestnetInitialEntry(orders: readonly Pick<AccountingOrder, "side" | "status" | "executed_quantity">[]) {
  return !orders.some((order) => order.side === "BUY" && (value(order.executed_quantity) > 0
    || !TESTNET_TERMINAL_ORDER_STATUSES.has(order.status)));
}

export function testnetBoughtQuantity(buys: readonly AccountingOrder[]) {
  return buys.reduce((sum, order) => sum + value(order.executed_quantity) - value(order.fee_base), 0);
}

export function testnetSoldOrCoveredQuantity(sells: readonly AccountingOrder[]) {
  return sells.reduce((sum, order) => sum + value(order.executed_quantity) + value(order.fee_base)
    + (active.has(order.status) ? Math.max(0, value(order.requested_quantity) - value(order.executed_quantity)) : 0), 0);
}

export function planTestnetUncoveredProtection(buys: readonly AccountingOrder[], sells: readonly AccountingOrder[],
  targetPrice: number, filters: { quantityStep: number; minQuantity: number; maxQuantity: number; minNotional: number }) {
  const missing = testnetBoughtQuantity(buys) - testnetSoldOrCoveredQuantity(sells);
  if (missing < -1e-10) throw new Error("COINOPS_TESTNET_TP_OVERCOVERED");
  if (![targetPrice, filters.quantityStep, filters.minQuantity, filters.maxQuantity, filters.minNotional]
    .every((amount) => Number.isFinite(amount) && amount > 0)) throw new Error("COINOPS_TESTNET_TP_FILTER_INVALID");
  const uncovered = Number((Math.floor((Math.max(0, missing) + 1e-10) / filters.quantityStep) * filters.quantityStep).toFixed(8));
  const canSubmit = uncovered >= filters.minQuantity && uncovered <= filters.maxQuantity && uncovered * targetPrice >= filters.minNotional;
  return { uncovered, canSubmit, blockedByFilter: !canSubmit && uncovered >= filters.quantityStep };
}

export function planTestnetClosedAccounting(buys: readonly AccountingOrder[], sells: readonly AccountingOrder[], quantityStep: number) {
  if (!Number.isFinite(quantityStep) || quantityStep <= 0) throw new Error("COINOPS_TESTNET_QUANTITY_STEP_INVALID");
  if (!buys.length || !sells.length || ![...buys, ...sells].every((order) => TESTNET_TERMINAL_ORDER_STATUSES.has(order.status)
    && (value(order.executed_quantity) === 0 || order.trades_reconciled))) return null;
  const bought = testnetBoughtQuantity(buys);
  if (bought <= 0) return null;
  const remaining = bought - testnetSoldOrCoveredQuantity(sells);
  if (remaining < -1e-10) throw new Error("COINOPS_TESTNET_POSITION_OVERSOLD");
  if (remaining + 1e-10 >= quantityStep) return null;
  if ([...buys, ...sells].some((order) => order.fee_other?.some((fee) => fee.amount > 0)))
    throw new Error("COINOPS_TESTNET_UNPRICED_FEE_ASSET");
  const closingSell = [...sells].filter((order) => value(order.executed_quantity) > 0)
    .sort((left, right) => right.revision - left.revision)[0];
  if (!closingSell) return null;
  const cost = buys.reduce((sum, order) => sum + value(order.cumulative_quote) + value(order.fee_quote), 0);
  const proceeds = sells.reduce((sum, order) => sum + value(order.cumulative_quote) - value(order.fee_quote), 0);
  return { profit: Number((proceeds - cost).toFixed(8)), closingSell, remainingDust: Math.max(0, remaining) };
}
