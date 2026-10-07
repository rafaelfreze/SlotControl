/** Only a previously blocked ACTIVE run that has just passed its full
 * reconciliation may use the existing guarded resume path automatically. */
export function mayRecoverReadOutage(status: string, reconciledStatus: string,
  alertCode: string | null): boolean {
  return status === "ACTIVE" && reconciledStatus === "OK"
    && ["COINOPS_LIVE_RECONCILE_ORDERS_FAILED", "COINOPS_LIVE_READ_STATE_FAILED",
      "COINOPS_LIVE_EXECUTOR_READ_STALE",
      "COINOPS_LIVE_LEDGER_READ_STALE",
      // Only after the guarded reconciler has proved an undispatched TP,
      // created it with the original client ID, and protected every position.
      "COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN",
      // Eligibility only: the guarded resume must still prove fresh executor
      // health, exchange/ledger agreement, protected positions and hard caps.
      "COINOPS_LIVE_MONITOR_EXECUTOR_UNHEALTHY",
      // Legacy registry read failure: verifiedReadRecoveryAlert additionally
      // requires LOAD_LEDGER evidence; resume reloads/validates the full scope.
      "COINOPS_OPERATOR_REGISTRY_UNAVAILABLE",
      // Legacy reads conflated provider failure and missing rows. Eligibility
      // is not proof: runRows must now validate all physical rows, complete
      // orders and ownership; resume still proves exchange/TP/caps under lease.
      "COINOPS_LIVE_LEDGER_INCOMPLETE",
      // Eligibility only. resumeLiveRun also requires a trade-backed fill at
      // incident time plus current exchange/ledger/protection agreement.
      "COINOPS_LIVE_EXCHANGE_ORDER_MISSING"].includes(alertCode ?? "");
}

export type ReadRecoveryAlert = { alert_key: string; code: string; first_seen_at?: string;
  last_seen_at: string; details?: { stage?: unknown; root_code?: unknown; read_path?: unknown } | null };

/** The caller must load all unresolved CRITICAL alerts in the exact engine /
 * account scope while holding the run lease. Never clear a changed cause. */
export function verifiedReadRecoveryAlert(status: string, runId: string,
  alerts: ReadRecoveryAlert[], expected?: ReadRecoveryAlert): ReadRecoveryAlert {
  const alert = alerts.length === 1 ? alerts[0] : null;
  if (!alert || alert.alert_key !== `LIVE_RUN:${runId}:CRITICAL`
    || !mayRecoverReadOutage(status, "OK", alert.code)
    || alert.code === "COINOPS_OPERATOR_REGISTRY_UNAVAILABLE"
      && (alert.details?.stage !== "LOAD_LEDGER" || alert.details?.root_code !== alert.code)
    || alert.code === "COINOPS_LIVE_LEDGER_INCOMPLETE"
      && (!["LOAD_LEDGER", "RECONCILE_ORDERS"].includes(String(alert.details?.stage))
        || alert.details?.root_code !== alert.code)
    || alert.code === "COINOPS_LIVE_LEDGER_READ_STALE"
      && (alert.details?.root_code !== "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE"
        || !["ledger/slots", "ledger/orders", "ledger/slot_accounts"].includes(String(alert.details?.read_path)))
    || !Number.isFinite(Date.parse(alert.last_seen_at))
    || expected && (alert.code !== expected.code || alert.last_seen_at !== expected.last_seen_at
      || alert.first_seen_at !== expected.first_seen_at))
    throw new Error("COINOPS_LIVE_RECOVERY_INCIDENT_CHANGED");
  return alert;
}
