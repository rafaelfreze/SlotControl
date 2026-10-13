import { liveEngineOrderPrefix, LIVE_TERMINAL_ORDER_STATUSES } from "../execution/robot-v1-live-cycle.ts";

export type FastRun = {
  id: string; trading_engine_id: string; exchange_account_id: string;
  status: string; symbol: string; last_reconciled_at: string | null;
  last_error: string | null; lease_until: string | null;
  created_at?: string;
  activated_at?: string;
  operator_id?: string;
};

export type FastEngine = { id: string; exchange_account_id: string; symbol: string;
  status: string; kill_switch: boolean; strategy_config_pending?: boolean; executor_shard_id?: string;
  operator_id?: string; environment?: string; base_asset?: string; legacy_compatible?: boolean };
export type FastAccount = { id: string; executor_shard_id: string; status: string;
  kill_switch: boolean; operator_id?: string };
export type FastSlot = { run_id: string; id: string; entry_state: string;
  position_quantity: number | string; updated_at: string; slot_number?: number;
  operator_id?: string; trading_engine_id?: string; exchange_account_id?: string };
export type FastOrder = { run_id: string; slot_id: string; side: string; status: string;
  exchange_order_id: string | null; id?: string; client_order_id?: string;
  executed_quantity?: number | string; trades_reconciled?: boolean;
  operator_id?: string; trading_engine_id?: string; exchange_account_id?: string };
export type FastPreparation = { trading_engine_id: string; exchange_account_id: string;
  operator_id: string; symbol: string; live_enabled: boolean; kill_switch: boolean };
export type FastAlert = { trading_engine_id: string; exchange_account_id: string;
  alert_key: string; severity: string; code: string; details?: unknown };

export type FastFinding = { state: "HEALTHY" | "RECONCILING" | "RECOVERING" | "BLOCKED" | "STALE" | "DEGRADED";
  code: string | null; recoverable: boolean; intentionalPause?: true };
export type FastConfigUpdate = { status: string; updated_at: string };

const ACTIVE_ORDERS = new Set(["PREPARED", "NEW", "PARTIALLY_FILLED"]);

/** Ignore another account/engine/cycle and the watchdog's own derived alerts.
 * An engine-wide critical without a run reference is conservatively applicable. */
export function criticalAlertsForRun(run: FastRun, alerts: FastAlert[]): FastAlert[] {
  return alerts.filter((alert) => {
    if (alert.trading_engine_id !== run.trading_engine_id
      || alert.exchange_account_id !== run.exchange_account_id || alert.severity !== "CRITICAL"
      || alert.alert_key.startsWith("WATCHDOG:")) return false;
    if (alert.alert_key.startsWith("LIVE_RUN:") && !alert.alert_key.startsWith(`LIVE_RUN:${run.id}:`))
      return false;
    const detailRun = alert.details && typeof alert.details === "object"
      ? (alert.details as { run_id?: unknown }).run_id : undefined;
    return detailRun === undefined || detailRun === run.id;
  });
}

/** Internal-ledger screening only. Exchange truth belongs to advanceLiveRun's
 * guarded reconciliation; this result must never authorize a direct order. */
export function evaluateFastRun(input: { run: FastRun; engine: FastEngine | null;
  account: FastAccount | null; shardId: string; slots: FastSlot[];
  orders: FastOrder[]; alerts?: FastAlert[]; configUpdate?: FastConfigUpdate | null;
  preparation?: FastPreparation | null; now: number }): FastFinding {
  const { run, engine, account, shardId, slots, orders, now } = input;
  if (!engine || !account || engine.id !== run.trading_engine_id
    || engine.exchange_account_id !== run.exchange_account_id
    || engine.symbol !== run.symbol || account.id !== run.exchange_account_id
    || engine.executor_shard_id !== shardId
    || slots.some((slot) => slot.run_id !== run.id) || orders.some((order) => order.run_id !== run.id))
    return { state: "BLOCKED", code: "WATCHDOG_OWNERSHIP_MISMATCH", recoverable: false };
  if (run.last_error)
    return { state: "BLOCKED", code: /^COINOPS_[A-Z0-9_]+$/.test(run.last_error)
      ? run.last_error : "WATCHDOG_RECONCILIATION_FAILED", recoverable: false };
  const critical = criticalAlertsForRun(run, input.alerts ?? [])[0];
  if (critical)
    return { state: "BLOCKED", code: /^COINOPS_[A-Z0-9_]+$/.test(critical.code)
      ? critical.code : "WATCHDOG_CRITICAL_ALERT_OPEN", recoverable: false };
  const paused = run.status === "PAUSED";
  // A pause is certified from the persisted BUY gate, never inferred from a
  // kill switch or a missing order. Critical errors above always take priority.
  const prep = input.preparation;
  if ((!paused && (run.status !== "ACTIVE" || engine.kill_switch))
    || engine.status !== "ACTIVE" || account.status !== "ACTIVE" || account.kill_switch
    || (paused && (!engine.kill_switch || !prep?.live_enabled || !prep.kill_switch)))
    return { state: "BLOCKED", code: "WATCHDOG_LOCAL_GATE_CLOSED", recoverable: false };
  if (paused) {
    const owned = (row: { operator_id?: string; trading_engine_id?: string; exchange_account_id?: string }) =>
      Boolean(run.operator_id) && row.operator_id === run.operator_id
      && row.trading_engine_id === run.trading_engine_id && row.exchange_account_id === run.exchange_account_id;
    if (!owned(prep!) || prep!.symbol !== run.symbol || engine.operator_id !== run.operator_id
      || account.operator_id !== run.operator_id || engine.environment !== "REAL"
      || !engine.base_asset || typeof engine.legacy_compatible !== "boolean"
      || slots.some((slot) => !owned(slot)) || orders.some((order) => !owned(order)))
      return { state: "BLOCKED", code: "WATCHDOG_OWNERSHIP_MISMATCH", recoverable: false };
    const numbers = new Set(slots.map((slot) => slot.slot_number));
    if (slots.length !== 25 || new Set(slots.map((slot) => slot.id)).size !== 25
      || numbers.size !== 25 || slots.some((slot) => !Number.isInteger(slot.slot_number)
        || slot.slot_number! < 1 || slot.slot_number! > 25
        || !Number.isFinite(Number(slot.position_quantity)) || Number(slot.position_quantity) < 0))
      return { state: "BLOCKED", code: "WATCHDOG_SLOT_COUNT_INVALID", recoverable: false };
    const prefix = liveEngineOrderPrefix({ exchange_account_id: engine.exchange_account_id,
      trading_engine_id: engine.id, base_asset: engine.base_asset, legacy_compatible: engine.legacy_compatible });
    const slotIds = new Set(slots.map((slot) => slot.id));
    if (orders.some((order) => !order.id || !order.client_order_id?.startsWith(prefix)
      || !slotIds.has(order.slot_id)) || new Set(orders.map((order) => order.id)).size !== orders.length)
      return { state: "BLOCKED", code: "WATCHDOG_OWNERSHIP_MISMATCH", recoverable: false };
    if (orders.some((order) => order.side === "BUY" && !LIVE_TERMINAL_ORDER_STATUSES.has(order.status)))
      return { state: "BLOCKED", code: "WATCHDOG_PAUSE_BUY_UNRESOLVED", recoverable: false };
    if (orders.some((order) => ["UNKNOWN", "SUBMITTING", "PENDING_CANCEL"].includes(order.status)))
      return { state: "BLOCKED", code: "WATCHDOG_ORDER_OUTCOME_UNKNOWN", recoverable: false };
    if (orders.some((order) => !Number.isFinite(Number(order.executed_quantity))
      || Number(order.executed_quantity) < 0
      || (Number(order.executed_quantity) > 0 && order.trades_reconciled !== true)))
      return { state: "BLOCKED", code: "WATCHDOG_FILL_UNRECONCILED", recoverable: false };
  }
  if (run.lease_until && Date.parse(run.lease_until) > now)
    return { state: "RECONCILING", code: null, recoverable: false };
  // A newly activated empty run has not missed a cron yet. Give the normal
  // worker one bounded scheduling window, never a grace period for an OPEN TP.
  const startedAt = run.activated_at ?? run.created_at;
  const age = startedAt ? now - Date.parse(startedAt) : NaN;
  if (!paused && !run.last_reconciled_at && age >= 0 && age < 90_000 && slots.length === 25
    && slots.every(slot => Number(slot.position_quantity) === 0) && orders.length === 0)
    return { state: "RECONCILING", code: null, recoverable: false };
  const last = run.last_reconciled_at ? Date.parse(run.last_reconciled_at) : NaN;
  if (!Number.isFinite(last) || (paused && last - now > 30_000) || now - last > 5 * 60_000)
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
  if (engine.strategy_config_pending) {
    const update = input.configUpdate;
    if (!update || update.status === "BLOCKED_SAFE")
      return { state: "BLOCKED", code: "WATCHDOG_CONFIG_UPDATE_BLOCKED", recoverable: false };
    if (!Number.isFinite(Date.parse(update.updated_at)) || now - Date.parse(update.updated_at) > 10 * 60_000)
      return { state: "STALE", code: "WATCHDOG_CONFIG_UPDATE_STALE", recoverable: true };
    return { state: "RECOVERING", code: null, recoverable: false };
  }
  // Whether a new BUY is required depends on monthly/strategy eligibility.
  // The existing reconciler decides this from the full ledger, never this screen.
  return { state: "HEALTHY", code: null, recoverable: false, ...(paused ? { intentionalPause: true } : {}) };
}
