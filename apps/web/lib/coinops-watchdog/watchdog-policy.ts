import { liveClientOrderId, liveEngineOrderPrefix, LIVE_TERMINAL_ORDER_STATUSES } from "../execution/robot-v1-live-cycle.ts";
import { configuredEngineSlotCount, hasCompletePhysicalSlotSet } from "../execution/engine-slot-topology.ts";

export type FastRun = {
  id: string; trading_engine_id: string; exchange_account_id: string;
  status: string; symbol: string; last_reconciled_at: string | null;
  last_error: string | null; lease_until: string | null;
  created_at?: string;
  activated_at?: string;
  operator_id?: string; slot_count?: number;
  quote_asset?: string; reconciliation_checkpoint?: unknown;
};

export type FastEngine = { id: string; exchange_account_id: string; symbol: string;
  status: string; kill_switch: boolean; strategy_config_pending?: boolean; executor_shard_id?: string;
  operator_id?: string; environment?: string; base_asset?: string; legacy_compatible?: boolean; slot_count?: number; config?: unknown };
export type FastAccount = { id: string; executor_shard_id: string; status: string;
  kill_switch: boolean; operator_id?: string };
export type FastSlot = { run_id: string; id: string; entry_state: string;
  position_quantity: number | string; updated_at: string; slot_number?: number;
  operation_sequence?: number;
  operator_id?: string; trading_engine_id?: string; exchange_account_id?: string };
export type FastOrder = { run_id: string; slot_id: string; side: string; status: string;
  exchange_order_id: string | null; id?: string; client_order_id?: string;
  executed_quantity?: number | string; trades_reconciled?: boolean;
  operation_sequence?: number; revision?: number; purpose?: string;
  requested_quantity?: number | string | null; price?: number | string | null;
  cumulative_quote?: number | string; fee_base?: number | string; fee_quote?: number | string; fee_other?: unknown;
  operator_id?: string; trading_engine_id?: string; exchange_account_id?: string };
export type FastPreparation = { trading_engine_id: string; exchange_account_id: string;
  operator_id: string; symbol: string; live_enabled: boolean; kill_switch: boolean; slot_count?: number };
export type FastAlert = { trading_engine_id: string; exchange_account_id: string;
  alert_key: string; severity: string; code: string; details?: unknown };

export type FastFinding = { state: "HEALTHY" | "RECONCILING" | "RECOVERING" | "BLOCKED" | "STALE" | "DEGRADED";
  code: string | null; recoverable: boolean; intentionalPause?: true };
export type FastConfigUpdate = { status: string; updated_at: string };

const ACTIVE_ORDERS = new Set(["PREPARED", "NEW", "PARTIALLY_FILLED"]);

/** The service-only SQL proof is tied to this exact checkpoint and current
 * order/slot facts. A nonterminal partial is not falsely marked reconciled. */
function accountedPartialTp(run: FastRun, cp: Record<string, unknown>, order: FastOrder,
  slots: FastSlot[], raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || order.side !== "SELL"
    || order.purpose !== "TP" || order.status !== "PARTIALLY_FILLED") return false;
  const proof = raw as Record<string, unknown>;
  const checkpoint = proof.checkpoint;
  if (proof.contract !== "PARTIAL_TP_FILLS_PROOF_V1" || proof.run_id !== run.id
    || !checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return false;
  const expected = checkpoint as Record<string, unknown>;
  if (Object.keys(expected).length !== Object.keys(cp).length || Object.keys(cp).some(key => cp[key] !== expected[key])
    || !Array.isArray(proof.orders) || !proof.orders.length || proof.orders.length > Number(cp.slot_count)) return false;
  const records = proof.orders as Array<Record<string, unknown>>;
  if (records.some(row => !row || typeof row !== "object" || Array.isArray(row))
    || new Set(records.map(row => row.id)).size !== records.length) return false;
  const row = records.find(item => item.id === order.id), slot = slots.find(item => item.id === order.slot_id);
  if (!row || !slot || ["slot_id", "client_order_id", "exchange_order_id", "status", "side", "purpose", "operation_sequence"]
    .some(key => row[key] !== order[key as keyof FastOrder])) return false;
  for (const [a, b, tolerance] of [[row.executed_quantity, order.executed_quantity, 1e-12],
    [row.cumulative_quote, order.cumulative_quote, 1e-8], [row.fee_base, order.fee_base, 1e-12],
    [row.fee_quote, order.fee_quote, 1e-8], [row.slot_position_quantity, slot.position_quantity, 1e-12]]) {
    if (a === null || a === undefined || b === null || b === undefined || !Number.isFinite(Number(a))
      || !Number.isFinite(Number(b)) || Math.abs(Number(a) - Number(b)) > Number(tolerance)) return false;
  }
  return JSON.stringify(row.fee_other) === JSON.stringify(order.fee_other);
}

/** A fenced database checkpoint means unfinished normal work, never HEALTHY
 * or permission to trade. Current ownership/positions remain independently
 * checked; a checkpoint cannot conceal a new financial error. */
function largeProgressFinding(run: FastRun, engine: FastEngine, account: FastAccount,
  shardId: string, slots: FastSlot[], orders: FastOrder[], now: number, partialTpProof?: unknown): FastFinding | null {
  const raw = run.reconciliation_checkpoint;
  if (raw === null || raw === undefined || run.status !== "ACTIVE") return null;
  const cp = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const observed = typeof cp.observed_at === "string" ? Date.parse(cp.observed_at) : NaN;
  // A completed full reconciliation supersedes its historical checkpoint.
  if (Number.isFinite(observed) && Date.parse(run.last_reconciled_at ?? "") > observed) return null;
  const count = configuredEngineSlotCount(engine), started = typeof cp.started_at === "string" ? Date.parse(cp.started_at) : NaN;
  const invalid = () => ({ state: "BLOCKED" as const, code: "WATCHDOG_RECONCILIATION_CHECKPOINT_INVALID", recoverable: false });
  if (count <= 25 || cp.contract !== "LARGE_ENGINE_PROGRESS_V1" || cp.run_id !== run.id
    || !run.operator_id || cp.operator_id !== run.operator_id || engine.operator_id !== run.operator_id
    || account.operator_id !== run.operator_id || cp.exchange_account_id !== run.exchange_account_id
    || cp.trading_engine_id !== run.trading_engine_id || cp.executor_shard_id !== shardId
    || cp.symbol !== run.symbol || !run.quote_asset || cp.quote_asset !== run.quote_asset || cp.slot_count !== count
    || !["CREDIT_SLOTS", "RECYCLE_SLOTS"].includes(String(cp.phase))
    || !Number.isFinite(observed) || !Number.isFinite(started) || observed < started
    || observed > now + 10_000 || started > now + 10_000
    || typeof cp.quantity_step !== "number" || !Number.isFinite(cp.quantity_step) || cp.quantity_step <= 0 || cp.quantity_step > 1
    || [cp.settled_orders, cp.credited_gains, cp.operation_total].some(value =>
      !Number.isSafeInteger(value) || Number(value) < 0)) return invalid();
  if (!hasCompletePhysicalSlotSet(slots.map(slot => slot.slot_number!), count)
    || new Set(slots.map(slot => slot.id)).size !== count) return invalid();
  const owns = (row: { operator_id?: string; trading_engine_id?: string; exchange_account_id?: string }) =>
    row.operator_id === run.operator_id && row.trading_engine_id === run.trading_engine_id
      && row.exchange_account_id === run.exchange_account_id;
  if (!engine.base_asset || typeof engine.legacy_compatible !== "boolean") return invalid();
  const prefix = liveEngineOrderPrefix({ exchange_account_id: engine.exchange_account_id,
    trading_engine_id: engine.id, base_asset: engine.base_asset, legacy_compatible: engine.legacy_compatible });
  const slotIds = new Set(slots.map(slot => slot.id));
  if (slots.some(slot => !owns(slot)
    || !Number.isInteger(slot.operation_sequence) || slot.operation_sequence! < 1
    || !Number.isFinite(Number(slot.position_quantity)) || Number(slot.position_quantity) < 0)
    || orders.some(order => !owns(order) || !order.id || !slotIds.has(order.slot_id)
      || !order.client_order_id?.startsWith(prefix)) || new Set(orders.map(order => order.id)).size !== orders.length)
    return { state: "BLOCKED", code: "WATCHDOG_OWNERSHIP_MISMATCH", recoverable: false };
  if (orders.some(order => ["UNKNOWN", "SUBMITTING", "PENDING_CANCEL"].includes(order.status)))
    return { state: "BLOCKED", code: "WATCHDOG_ORDER_OUTCOME_UNKNOWN", recoverable: false };
  if (orders.some(order => !Number.isFinite(Number(order.executed_quantity)) || Number(order.executed_quantity) < 0))
    return { state: "BLOCKED", code: "WATCHDOG_FILL_UNRECONCILED", recoverable: false };
  const unaccounted = orders.filter(order => Number(order.executed_quantity) > 0 && order.trades_reconciled !== true);
  if (unaccounted.length && unaccounted.every(order => order.side === "SELL" && order.purpose === "TP" && order.status === "PARTIALLY_FILLED")
    && partialTpProof && typeof partialTpProof === "object"
    && (partialTpProof as Record<string, unknown>).contract === "PARTIAL_TP_PROOF_UNAVAILABLE")
    return { state: "BLOCKED", code: "WATCHDOG_PARTIAL_TP_PROOF_UNAVAILABLE", recoverable: false };
  if (unaccounted.some(order => !accountedPartialTp(run, cp, order, slots, partialTpProof)))
    return { state: "BLOCKED", code: "WATCHDOG_FILL_UNRECONCILED", recoverable: false };
  if (orders.filter(order => order.side === "BUY" && ACTIVE_ORDERS.has(order.status)).length > 1)
    return { state: "BLOCKED", code: "WATCHDOG_DUPLICATE_BUY", recoverable: false };
  for (const order of orders) {
    const slot = slots.find(item => item.id === order.slot_id)!;
    try {
      if (!["BUY", "SELL"].includes(order.side) || !Number.isInteger(order.operation_sequence)
        || order.operation_sequence! < 1 || order.operation_sequence! > slot.operation_sequence!
        || order.client_order_id !== liveClientOrderId(run.id, engine.base_asset as "BTC" | "SOL", slot.slot_number!,
          order.operation_sequence!, order.side as "BUY" | "SELL", order.revision!, {
            exchange_account_id: engine.exchange_account_id, trading_engine_id: engine.id,
            base_asset: engine.base_asset, legacy_compatible: engine.legacy_compatible, slot_count: count,
          }))
        return invalid();
    } catch { return invalid(); }
    if (ACTIVE_ORDERS.has(order.status) && order.operation_sequence !== slot.operation_sequence) return invalid();
    if (order.side === "SELL" && ACTIVE_ORDERS.has(order.status)) {
      const quantity = Number(order.requested_quantity), executed = Number(order.executed_quantity), price = Number(order.price);
      const expected = Math.floor((Number(slot.position_quantity) + 1e-12) / cp.quantity_step) * cp.quantity_step;
      if (order.purpose !== "TP" || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0
        || quantity < executed || Math.abs(quantity - executed - expected) > 1e-10)
        return { state: "DEGRADED", code: "WATCHDOG_TP_QUANTITY_MISMATCH", recoverable: false };
    }
  }
  const step = cp.quantity_step as number;
  for (const slot of slots.filter(item => Number(item.position_quantity) >= step)) {
    const tps = orders.filter(order => order.slot_id === slot.id && order.side === "SELL"
      && ["NEW", "PARTIALLY_FILLED"].includes(order.status) && order.exchange_order_id);
    if (tps.length !== 1) return { state: "DEGRADED", code: tps.length ? "WATCHDOG_DUPLICATE_TP" : "WATCHDOG_TP_MISSING",
      recoverable: tps.length === 0 };
  }
  if (engine.strategy_config_pending)
    return { state: "BLOCKED", code: "WATCHDOG_CONFIG_UPDATE_BLOCKED", recoverable: false };
  if (now - observed > 150_000 || now - started > 15 * 60_000)
    return { state: "STALE", code: "WATCHDOG_RECONCILIATION_PROGRESS_STALE", recoverable: true };
  return { state: "RECONCILING", code: null, recoverable: false };
}

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
  preparation?: FastPreparation | null; partialTpProof?: unknown; now: number }): FastFinding {
  const { run, engine, account, shardId, slots, orders, now } = input;
  let slotCount: number;
  try {
    slotCount = configuredEngineSlotCount(engine ?? {});
    if (configuredEngineSlotCount(run) !== slotCount
      || input.preparation && configuredEngineSlotCount(input.preparation) !== slotCount)
      return { state: "BLOCKED", code: "WATCHDOG_SLOT_COUNT_INVALID", recoverable: false };
  } catch { return { state: "BLOCKED", code: "WATCHDOG_SLOT_COUNT_INVALID", recoverable: false }; }
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
    if (!hasCompletePhysicalSlotSet(slots.map(slot => slot.slot_number!), slotCount)
      || new Set(slots.map((slot) => slot.id)).size !== slotCount
      || slots.some((slot) => !Number.isInteger(slot.slot_number)
        || slot.slot_number! < 1 || slot.slot_number! > slotCount
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
  const progress = largeProgressFinding(run, engine, account, shardId, slots, orders, now, input.partialTpProof);
  if (progress) return progress;
  if (run.lease_until && Date.parse(run.lease_until) > now)
    return { state: "RECONCILING", code: null, recoverable: false };
  // A newly activated empty run has not missed a cron yet. Give the normal
  // worker one bounded scheduling window, never a grace period for an OPEN TP.
  const startedAt = run.activated_at ?? run.created_at;
  const age = startedAt ? now - Date.parse(startedAt) : NaN;
  if (!paused && !run.last_reconciled_at && age >= 0 && age < 90_000 && slots.length === slotCount
    && slots.every(slot => Number(slot.position_quantity) === 0) && orders.length === 0)
    return { state: "RECONCILING", code: null, recoverable: false };
  const last = run.last_reconciled_at ? Date.parse(run.last_reconciled_at) : NaN;
  if (!Number.isFinite(last) || (paused && last - now > 30_000) || now - last > 5 * 60_000)
    return { state: "STALE", code: "WATCHDOG_RECONCILIATION_STALE", recoverable: true };
  if (slots.length !== slotCount || (slotCount !== 25 || slots.some(slot => slot.slot_number !== undefined))
    && !hasCompletePhysicalSlotSet(slots.map(slot => slot.slot_number!), slotCount)
    || new Set(slots.map(slot => slot.id)).size !== slotCount)
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
