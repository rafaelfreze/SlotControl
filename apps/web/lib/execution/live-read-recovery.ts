export type ReadRecoveryDetails = { stage?: unknown; root_code?: unknown; read_path?: unknown; metadata_path?: unknown;
  audit_phase?: unknown; audit_reason?: unknown; audit_event_type?: unknown; audit_attempts?: unknown;
  audit_http_status?: unknown; audit_provider_code?: unknown; audit_event_key?: unknown;
  http_status?: unknown; provider_code?: unknown };

// Every captured audit diagnostic is bound into the final incident CAS too.
// A changed provider/phase must not inherit a legacy or transient approval.
export const READ_RECOVERY_DIAGNOSTIC_KEYS = ["stage", "root_code", "read_path", "metadata_path",
  "audit_phase", "audit_reason", "audit_event_type", "audit_attempts", "audit_http_status",
  "audit_provider_code", "audit_event_key"] as const;
const AUDIT_DETAIL_KEYS = READ_RECOVERY_DIAGNOSTIC_KEYS.slice(4);
const AUDIT_CONNECTION_CODES = new Set(["PGRST000", "PGRST001", "PGRST002", "PGRST003",
  "08000", "08003", "08006", "53300", "57014"]);

/** The former audit wrapper discarded its provider error. That legacy site
 * identifies a metadata append, not a transient failure or a safe financial
 * write. Resume additionally requires a later fresh RECONCILED checkpoint,
 * complete exchange/ledger protection and twice-settled dispatches under lease. */
export function isAuditEventRecovery(code: string | null, details?: ReadRecoveryDetails | null) {
  if (code !== "COINOPS_LIVE_EVENT_PERSIST_FAILED" || details?.root_code !== code
    || details.stage !== "AUDIT_EVENT") return false;
  if (AUDIT_DETAIL_KEYS.every(key => details[key] === undefined))
    return details.http_status === undefined && details.provider_code === undefined;
  if (!["RECONCILED", "RESET_RECOVERED"].includes(String(details.audit_event_type))
    || !["WRITE", "READBACK"].includes(String(details.audit_phase))
    || !["TRANSIENT_EXHAUSTED", "READBACK_UNAVAILABLE"].includes(String(details.audit_reason))
    || details.audit_reason === "READBACK_UNAVAILABLE" && details.audit_phase !== "READBACK"
    || !Number.isInteger(details.audit_attempts) || Number(details.audit_attempts) < 1
    || Number(details.audit_attempts) > 2) return false;
  if (typeof details.audit_event_key !== "string" || (details.audit_event_type === "RECONCILED"
    ? !/^RECONCILED:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(details.audit_event_key)
    : !/^RESET_RECOVERED:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(details.audit_event_key))) return false;
  const status = details.audit_http_status, provider = details.audit_provider_code;
  if (status !== null && (!Number.isInteger(status) || Number(status) < 0 || Number(status) > 599)) return false;
  if (provider !== null && (typeof provider !== "string" || !AUDIT_CONNECTION_CODES.has(provider))) return false;
  return provider === null && (status === null || [0, 502, 503, 504].includes(Number(status)))
    || provider !== null && ([503, 504].includes(Number(status)) || provider === "57014" && status === 500);
}

type AuditRecoveryScope = { id: string; product_id: string; tenant_id: string; user_id: string;
  operator_id: string; exchange_account_id: string; trading_engine_id: string; quote_asset: string;
  last_reconciled_at: string | null; strategy_version: string };
export type AuditRecoveryEvent = Omit<AuditRecoveryScope, "id" | "last_reconciled_at" | "strategy_version"> & {
  run_id: string; event_key: string; event_type: string; slot_number: number | null;
  observed_at: string; details: Record<string, unknown> };

/** A new checkpoint proves the current audit path works; it never fills in
 * the missing historical minute. All mutable financial facts still require
 * independent current proof by the authoritative reconciler/resume flow. */
export function assertAuditEventRecoveryEvidence(incident: ReadRecoveryAlert, run: AuditRecoveryScope,
  event: AuditRecoveryEvent | null, now = Date.now()) {
  const fail = (): never => { throw new Error("COINOPS_LIVE_AUDIT_RECOVERY_UNPROVEN"); };
  const first = Date.parse(incident.first_seen_at ?? ""), last = Date.parse(incident.last_seen_at);
  const reconciled = Date.parse(run.last_reconciled_at ?? ""), observed = Date.parse(event?.observed_at ?? "");
  if (!isAuditEventRecovery(incident.code, incident.details)
    || incident.alert_key !== `LIVE_RUN:${run.id}:CRITICAL` || !event
    || ![now, first, last, reconciled, observed].every(Number.isFinite)
    || first - last > 1_000 || Math.max(first, last) >= observed
    || observed > reconciled || reconciled > now || now - observed > 150_000
    || reconciled - observed > 120_000 || event.run_id !== run.id
    || event.event_type !== "RECONCILED" || event.slot_number !== null
    || event.details.strategy_version !== run.strategy_version || event.details.next !== "KILL_SWITCH") return fail();
  for (const key of ["product_id", "tenant_id", "user_id", "operator_id", "exchange_account_id",
    "trading_engine_id", "quote_asset"] as const) if (!run[key] || event[key] !== run[key]) return fail();
  if (!/^RECONCILED:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(event.event_key)) return fail();
  const minute = Date.parse(`${event.event_key.slice("RECONCILED:".length)}:00.000Z`);
  // Only bounded DB/caller skew around the actual minute is allowed. An
  // append made today with yesterday's missing key is not recovery evidence.
  if (!Number.isFinite(minute) || minute > observed + 1_000 || observed - minute > 65_000) return fail();
  return event;
}

const EXPOSURE_READ_PATHS = ["ledger/exposure_runs", "ledger/exposure_engines",
  "ledger/exposure_slots", "ledger/exposure_orders"];
const BINDING_READ_PATHS = ["executor_binding/operator", "executor_binding/account",
  "executor_binding/engine", "executor_binding/shard"];
const BUDGET_ALERT_READ_PATHS = ["ledger/account_budget_alert", "ledger/account_budget_decision",
  "ledger/account_budget_reservation"];
const CAPITAL_AUDIT_READ_PATH = "ledger/capital_refresh_events";
const NON_RECOVERABLE_READ_ROOTS = new Set(["EXECUTOR_ENGINE_SHARD_DENIED",
  "COINOPS_EXECUTOR_BINDING_READ_FAILED", "COINOPS_LIVE_LEDGER_READ_FAILED",
  "COINOPS_LIVE_EXPOSURE_INCOMPLETE", "COINOPS_LIVE_EXPOSURE_INVALID",
  "COINOPS_LIVE_HARD_CAP_BREACHED", "COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_WRITE_FAILED"]);

/** Alert housekeeping is not an exchange dispatch. Legacy eligibility is
 * limited to the exact metadata site; resume must additionally prove all
 * financial decisions/dispatches settled and resolve the exact old checkpoint. */
export function isAccountBudgetAlertRecovery(code: string | null, details?: ReadRecoveryDetails | null) {
  if (code === "COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_RESOLVE_FAILED")
    return details?.root_code === code && ["ARM_ENTRY", "ASSERT_NEW_POSITION"].includes(String(details.stage));
  if (details?.stage !== "RESOLVE_ACCOUNT_BUDGET_ALERT") return false;
  return code === "COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_RESOLVE_RETRY" && details.root_code === code
      && details.metadata_path === "alert/account_budget/resolve"
    || code === "COINOPS_LIVE_LEDGER_READ_STALE" && details.root_code === "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE"
      && BUDGET_ALERT_READ_PATHS.includes(String(details.read_path));
}

/** The old audit wrapper discarded the provider response after the entry step.
 * Eligibility identifies only that GET, not a transient error or an approved
 * capital/order change. Resume must reread the complete audit and prove all
 * financial decisions and dispatches settled under the same run lease. */
export function isCapitalAuditReadRecovery(code: string | null, details?: ReadRecoveryDetails | null) {
  if (code === "COINOPS_LIVE_CAPITAL_AUDIT_UNAVAILABLE")
    return details?.root_code === code && ["ARM_ENTRY", "ASSERT_NEW_POSITION"].includes(String(details.stage));
  return code === "COINOPS_LIVE_LEDGER_READ_STALE"
    && details?.root_code === "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE"
    && details.stage === "CONFIRM_CAPITAL_REFRESH" && details.read_path === CAPITAL_AUDIT_READ_PATH;
}

/** Historical exposure wrapper discarded the provider error. Only this exact
 * pre-entry GET site qualifies; current complete account projection and every
 * existing financial/ownership proof are still mandatory under the lease. */
export function isExposureStateReadRecovery(code: string | null, details?: ReadRecoveryDetails | null) {
  return code === "COINOPS_LIVE_EXPOSURE_UNAVAILABLE"
    && details?.root_code === code && details.stage === "ARM_ENTRY";
}

// validateRunEngine/scopedPreparation perform the same owner-scoped registry
// GET in these exact advanceLiveRun stages. A failed observation at ARM_ENTRY
// is not an order dispatch failure merely because of the outer stage name.
// CONFIG_UPDATE eligibility never approves a bulk edit: guarded resume still
// rejects every pending/applying/blocked edit and config gate under its lease.
const REGISTRY_READ_RECOVERY_STAGES = new Set([
  "LOAD_LEDGER", "RECONCILE_ORDERS", "PROTECT_TP", "ASSERT_NEW_POSITION",
  "ARM_ENTRY", "ATH_TRANSITION", "RESTART_CYCLE", "CONFIG_UPDATE",
]);

/** Eligibility for a known registry GET only, never proof that the provider
 * error was transient. Resume must reload real scope/permissions, all physical
 * slots, Binance/ledger ownership, TP, fills, monthly facts and caps. */
export function isRegistryStateReadRecovery(code: string | null, details?: ReadRecoveryDetails | null) {
  return code === "COINOPS_OPERATOR_REGISTRY_UNAVAILABLE"
    && details?.root_code === code && typeof details.stage === "string"
    && REGISTRY_READ_RECOVERY_STAGES.has(details.stage);
}

/** Eligibility only: an old wrapper can represent a GET before any write.
 * Fresh permission/financial proof under lease is still mandatory; the legacy
 * root code itself never becomes retryable or proves a transient provider. */
export function isPermissionStateReadRecovery(code: string | null, details?: ReadRecoveryDetails | null) {
  return details?.root_code === "EXECUTOR_PRODUCTION_PERMISSION_DENIED"
    && (code === "COINOPS_LIVE_ARM_ENTRY_FAILED" && details.stage === "ARM_ENTRY"
      || code === "COINOPS_LIVE_CREDIT_SLOTS_FAILED" && details.stage === "CREDIT_SLOTS");
}

/** Only a previously blocked ACTIVE run that has just passed its full
 * reconciliation may use the existing guarded resume path automatically. */
export function mayRecoverReadOutage(status: string, reconciledStatus: string,
  alertCode: string | null, details?: ReadRecoveryDetails | null): boolean {
  return status === "ACTIVE" && reconciledStatus === "OK"
    && !NON_RECOVERABLE_READ_ROOTS.has(String(details?.root_code))
    && (details?.root_code !== "COINOPS_LIVE_EVENT_PERSIST_FAILED" || isAuditEventRecovery(alertCode, details))
    && (isPermissionStateReadRecovery(alertCode, details)
      || isRegistryStateReadRecovery(alertCode, details)
      || isExposureStateReadRecovery(alertCode, details)
      || isAccountBudgetAlertRecovery(alertCode, details)
      || isCapitalAuditReadRecovery(alertCode, details)
      || isAuditEventRecovery(alertCode, details)
      || ["COINOPS_LIVE_RECONCILE_ORDERS_FAILED", "COINOPS_LIVE_READ_STATE_FAILED",
      "COINOPS_LIVE_EXECUTOR_READ_STALE",
      "COINOPS_LIVE_LEDGER_READ_STALE",
      // Only after the guarded reconciler has proved an undispatched TP,
      // created it with the original client ID, and protected every position.
      "COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN",
      // Eligibility only: the guarded resume must still prove fresh executor
      // health, exchange/ledger agreement, protected positions and hard caps.
      "COINOPS_LIVE_MONITOR_EXECUTOR_UNHEALTHY",
      // Legacy reads conflated provider failure and missing rows. Eligibility
      // is not proof: runRows must now validate all physical rows, complete
      // orders and ownership; resume still proves exchange/TP/caps under lease.
      "COINOPS_LIVE_LEDGER_INCOMPLETE",
      // Legacy monthly GET failures discarded their provider error. Recovery
      // still reloads/validates monthly facts plus exchange/TP/caps under lease.
      "COINOPS_MONTHLY_GAIN_LEDGER_UNAVAILABLE",
      // Legacy checkpoint GET discarded the provider response. Only the exact
      // read stage qualifies; resume also proves there is no pending/blocked
      // bulk edit and conditionally opens the config gate under its run lease.
      "COINOPS_BULK_CHECKPOINT_UNAVAILABLE",
      // Eligibility only. resumeLiveRun also requires a trade-backed fill at
      // incident time plus current exchange/ledger/protection agreement.
      "COINOPS_LIVE_EXCHANGE_ORDER_MISSING"].includes(alertCode ?? ""));
}

export type ReadRecoveryAlert = { alert_key: string; code: string; first_seen_at?: string;
  last_seen_at: string; details?: ReadRecoveryDetails | null };

/** Explicit operator control only; this helper never broadens automatic read
 * recovery. The caller must still prove current finance/ownership under lease
 * and use the returned immutable identity in its final compare-and-set.
 * A deliberate PAUSED run may have no CRITICAL; an unexplained ACTIVE gate
 * cannot inherit that exception. */
export function operatorRecoveryAlert(status: string, runId: string, alerts: ReadRecoveryAlert[],
  expected?: ReadRecoveryAlert | null): ReadRecoveryAlert | null {
  const fail = (): never => { throw new Error("COINOPS_LIVE_RECOVERY_INCIDENT_CHANGED"); };
  if (!["ACTIVE", "PAUSED"].includes(status)) return fail();
  if (!alerts.length) {
    if (status !== "PAUSED" || expected !== undefined && expected !== null) return fail();
    return null;
  }
  const alert = alerts.length === 1 ? alerts[0] : null;
  if (!alert || expected === null || alert.alert_key !== `LIVE_RUN:${runId}:CRITICAL`
    || !/^COINOPS_[A-Z0-9_]+$/.test(alert.code)
    || !Number.isFinite(Date.parse(alert.first_seen_at ?? ""))
    || !Number.isFinite(Date.parse(alert.last_seen_at))) return fail();
  if (expected && (alert.alert_key !== expected.alert_key || alert.code !== expected.code
    || alert.first_seen_at !== expected.first_seen_at || alert.last_seen_at !== expected.last_seen_at
    || alert.details?.stage !== expected.details?.stage
    || alert.details?.root_code !== expected.details?.root_code
    || alert.details?.read_path !== expected.details?.read_path
    || READ_RECOVERY_DIAGNOSTIC_KEYS.some(key => alert.details?.[key] !== expected.details?.[key]))) return fail();
  return alert;
}

/** The caller must load all unresolved CRITICAL alerts in the exact engine /
 * account scope while holding the run lease. Never clear a changed cause. */
export function verifiedReadRecoveryAlert(status: string, runId: string,
  alerts: ReadRecoveryAlert[], expected?: ReadRecoveryAlert): ReadRecoveryAlert {
  const alert = alerts.length === 1 ? alerts[0] : null;
  if (!alert || alert.alert_key !== `LIVE_RUN:${runId}:CRITICAL`
    || !mayRecoverReadOutage(status, "OK", alert.code, alert.details)
    || alert.code === "COINOPS_OPERATOR_REGISTRY_UNAVAILABLE"
      && !isRegistryStateReadRecovery(alert.code, alert.details)
    || alert.code === "COINOPS_LIVE_LEDGER_INCOMPLETE"
      && (!["LOAD_LEDGER", "RECONCILE_ORDERS"].includes(String(alert.details?.stage))
        || alert.details?.root_code !== alert.code)
    || alert.code === "COINOPS_LIVE_LEDGER_READ_STALE"
      && (alert.details?.root_code !== "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE"
        || !["ledger/slots", "ledger/orders", "ledger/slot_accounts", "ledger/monthly_target",
          "ledger/monthly_gains", "ledger/bulk_checkpoint", "ledger/config_gate", "ledger/quote_cap",
          "ledger/preparation", "ledger/operator", ...EXPOSURE_READ_PATHS,
          ...BUDGET_ALERT_READ_PATHS, CAPITAL_AUDIT_READ_PATH].includes(String(alert.details?.read_path)))
    || BUDGET_ALERT_READ_PATHS.includes(String(alert.details?.read_path))
      && !isAccountBudgetAlertRecovery(alert.code, alert.details)
    || alert.details?.read_path === CAPITAL_AUDIT_READ_PATH
      && !isCapitalAuditReadRecovery(alert.code, alert.details)
    || alert.details?.root_code === "COINOPS_EXECUTOR_BINDING_READ_UNAVAILABLE"
      && (alert.code !== "COINOPS_LIVE_EXECUTOR_READ_STALE"
        || !BINDING_READ_PATHS.includes(String(alert.details.read_path)))
    || alert.code === "COINOPS_BULK_CHECKPOINT_UNAVAILABLE"
      && (alert.details?.stage !== "CONFIG_UPDATE" || alert.details?.root_code !== alert.code)
    || alert.details?.root_code === "COINOPS_LIVE_BNB_FEE_BALANCE_UNAVAILABLE"
      && (alert.code !== "COINOPS_LIVE_EXECUTOR_READ_STALE"
        || alert.details.stage !== "OBSERVE_BNB_FEE" || alert.details.read_path !== "snapshot/bnb_fee")
    || alert.code === "COINOPS_MONTHLY_GAIN_LEDGER_UNAVAILABLE"
      && (alert.details?.root_code !== alert.code || !["CREDIT_SLOTS", "RECYCLE_SLOTS", "RESTART_CYCLE",
        "ATH_TRANSITION", "ARM_ENTRY"].includes(String(alert.details?.stage)))
    || !Number.isFinite(Date.parse(alert.last_seen_at))
    || expected && (alert.code !== expected.code || alert.last_seen_at !== expected.last_seen_at
      || alert.first_seen_at !== expected.first_seen_at
      || READ_RECOVERY_DIAGNOSTIC_KEYS.some(key => alert.details?.[key] !== expected.details?.[key])))
    throw new Error("COINOPS_LIVE_RECOVERY_INCIDENT_CHANGED");
  return alert;
}

type PermissionRecoveryOrder = { status: string; side: string; client_order_id: string;
  exchange_order_id: string | null; created_at: string; price: number | string | null;
  requested_quantity: number | string | null; executed_quantity: number | string;
  cumulative_quote: number | string; trades_reconciled: boolean };
type PermissionRecoveryResident = { id: string; clientOrderId: string | null; side: string;
  status: string; price: number | null; executedQuantity: number; originalQuantity?: number };

/** Deliberately narrow: keep all resident orders exactly as they existed well
 * before the incident. No prepared intent, partial fill, unknown status, recent
 * dispatch or empty NEXT BUY can inherit this permission-read recovery. */
export function assertPermissionReadRecoveryOrders(incident: ReadRecoveryAlert,
  orders: PermissionRecoveryOrder[], observed: PermissionRecoveryResident[], prefix: string) {
  const first = Date.parse(incident.first_seen_at ?? "");
  const last = Date.parse(incident.last_seen_at);
  // DB default NOW() and the caller's timestamp may invert by milliseconds.
  // Bound the skew, then use the earlier instant for the conservative cutoff.
  const cutoff = Math.min(first, last) - 90_000;
  const fail = () => { throw new Error("COINOPS_LIVE_PERMISSION_RECOVERY_UNPROVEN"); };
  if (!isPermissionStateReadRecovery(incident.code, incident.details) || !Number.isFinite(first)
    || !Number.isFinite(last) || first - last > 1_000 || !prefix || !orders.length) return fail();
  const settled = new Set(["FILLED", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"]);
  const residents = orders.filter(order => order.status === "NEW");
  if (residents.filter(order => order.side === "BUY").length !== 1) return fail();
  for (const order of orders) {
    if (!order.client_order_id.startsWith(prefix) || !order.exchange_order_id
      || !Number.isFinite(Date.parse(order.created_at)) || Date.parse(order.created_at) >= cutoff
      || !["BUY", "SELL"].includes(order.side)
      || !Number.isFinite(Number(order.executed_quantity)) || Number(order.executed_quantity) < 0
      || !Number.isFinite(Number(order.cumulative_quote)) || Number(order.cumulative_quote) < 0
      || order.status !== "NEW" && (!settled.has(order.status) || !order.trades_reconciled)
      || Number(order.executed_quantity) > 0 && !order.trades_reconciled) return fail();
    if (order.status === "NEW" && (Number(order.executed_quantity) !== 0 || Number(order.cumulative_quote) !== 0
      || !(Number(order.price) > 0) || !(Number(order.requested_quantity) > 0))) return fail();
  }
  const owned = observed.filter(order => order.clientOrderId?.startsWith(prefix));
  if (owned.length !== residents.length || new Set(owned.map(order => order.clientOrderId)).size !== owned.length) return fail();
  for (const order of residents) {
    const current = owned.find(item => item.clientOrderId === order.client_order_id);
    if (!current || current.id !== order.exchange_order_id || current.side !== order.side
      || current.status !== "NEW" || current.executedQuantity !== 0
      || current.price !== Number(order.price)
      || current.originalQuantity !== Number(order.requested_quantity)) return fail();
  }
  return new Date(cutoff).toISOString();
}
