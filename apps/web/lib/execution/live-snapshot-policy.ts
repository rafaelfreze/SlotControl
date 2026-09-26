type ResidentOrder = {
  status: string;
  side: "BUY" | "SELL";
  submission_guarded_at: string | null;
  executed_quantity: number | string;
};

const MAX_REUSE_MS = 5_000;

/** Reconciliation can dispatch only an unguarded PREPARED order. */
export function needsResidentPreflight(orders: readonly ResidentOrder[]): boolean {
  return orders.some((order) => order.status === "PREPARED"
    && order.submission_guarded_at === null);
}

/** A partial BUY can be canceled while covering it with a TP. */
export function mayCancelPartialBuy(orders: readonly ResidentOrder[]): boolean {
  return orders.some((order) => order.side === "BUY"
    && order.status === "PARTIALLY_FILLED" && Number(order.executed_quantity) > 0);
}

/** Never reuse an exchange snapshot after a write, transition or stale gap. */
export function canReuseLiveState(observedAtMs: number, nowMs: number,
  exchangeMutated: boolean): boolean {
  return !exchangeMutated && Number.isFinite(observedAtMs) && Number.isFinite(nowMs)
    && nowMs >= observedAtMs && nowMs - observedAtMs <= MAX_REUSE_MS;
}
