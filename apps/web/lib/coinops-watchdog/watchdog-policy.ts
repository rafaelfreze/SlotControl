export type FastRun = {
  id: string; trading_engine_id: string; exchange_account_id: string;
  status: string; symbol: string; last_reconciled_at: string | null;
  last_error: string | null; lease_until: string | null;
};

export type FastEngine = { id: string; exchange_account_id: string; symbol: string;
  status: string; kill_switch: boolean };
export type FastAccount = { id: string; executor_shard_id: string; status: string;
  kill_switch: boolean };
export type FastSlot = { run_id: string; id: string; entry_state: string;
  position_quantity: number | string; updated_at: string };
export type FastOrder = { run_id: string; slot_id: string; side: string; status: string;
  exchange_order_id: string | null };

export type FastFinding = { state: "HEALTHY" | "RECOVERING" | "BLOCKED" | "STALE" | "DEGRADED";
  code: string | null; recoverable: boolean };

const ACTIVE_ORDERS = new Set(["PREPARED", "NEW", "PARTIALLY_FILLED"]);

/** Internal-ledger screening only. Exchange truth belongs to advanceLiveRun's
 * guarded reconciliation; this result must never authorize a direct order. */
export function evaluateFastRun(input: { run: FastRun; engine: FastEngine | null;
  account: FastAccount | null; shardId: string; slots: FastSlot[];
  orders: FastOrder[]; now: number }): FastFinding {
  const { run, engine, account, shardId, slots, orders, now } = input;
  if (!engine || !account || engine.id !== run.trading_engine_id
    || engine.exchange_account_id !== run.exchange_account_id
    || engine.symbol !== run.symbol || account.id !== run.exchange_account_id
    || account.executor_shard_id !== shardId)
    return { state: "BLOCKED", code: "WATCHDOG_OWNERSHIP_MISMATCH", recoverable: false };
  if (run.last_error)
    return { state: "BLOCKED", code: /^COINOPS_[A-Z0-9_]+$/.test(run.last_error)
      ? run.last_error : "WATCHDOG_RECONCILIATION_FAILED", recoverable: false };
  if (run.status !== "ACTIVE" || engine.status !== "ACTIVE" || account.status !== "ACTIVE"
    || engine.kill_switch || account.kill_switch)
    return { state: "BLOCKED", code: "WATCHDOG_LOCAL_GATE_CLOSED", recoverable: false };
  if (run.lease_until && Date.parse(run.lease_until) > now)
    return { state: "RECOVERING", code: null, recoverable: false };
  const last = run.last_reconciled_at ? Date.parse(run.last_reconciled_at) : NaN;
  if (!Number.isFinite(last) || now - last > 5 * 60_000)
    return { state: "STALE", code: "WATCHDOG_RECONCILIATION_STALE", recoverable: true };
  if (slots.length !== 25)
    return { state: "BLOCKED", code: "WATCHDOG_SLOT_COUNT_INVALID", recoverable: false };
  const buys = orders.filter((order) => order.side === "BUY" && ACTIVE_ORDERS.has(order.status));
  if (buys.length > 1)
    return { state: "BLOCKED", code: "WATCHDOG_DUPLICATE_BUY", recoverable: false };
  const open = slots.filter((slot) => Number(slot.position_quantity) > 0);
  for (const slot of open) {
    const tps = orders.filter((order) => order.slot_id === slot.id && order.side === "SELL"
      && ["NEW", "PARTIALLY_FILLED"].includes(order.status) && order.exchange_order_id);
    if (tps.length !== 1)
      return { state: "DEGRADED", code: tps.length ? "WATCHDOG_DUPLICATE_TP" : "WATCHDOG_TP_MISSING",
        recoverable: tps.length === 0 };
  }
  // Whether a new BUY is required depends on monthly/strategy eligibility.
  // The existing reconciler decides this from the full ledger, never this screen.
  return { state: "HEALTHY", code: null, recoverable: false };
}
