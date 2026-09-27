/** Only a previously blocked ACTIVE run that has just passed its full
 * reconciliation may use the existing guarded resume path automatically. */
export function mayRecoverReadOutage(status: string, reconciledStatus: string,
  alertCode: string | null): boolean {
  return status === "ACTIVE" && reconciledStatus === "OK"
    && ["COINOPS_LIVE_RECONCILE_ORDERS_FAILED", "COINOPS_LIVE_READ_STATE_FAILED",
      "COINOPS_LIVE_EXECUTOR_READ_STALE",
      // Eligibility only: the guarded resume must still prove fresh executor
      // health, exchange/ledger agreement, protected positions and hard caps.
      "COINOPS_LIVE_MONITOR_EXECUTOR_UNHEALTHY"].includes(alertCode ?? "");
}

export type ReadRecoveryAlert = { alert_key: string; code: string; last_seen_at: string };

/** The caller must load all unresolved CRITICAL alerts in the exact engine /
 * account scope while holding the run lease. Never clear a changed cause. */
export function verifiedReadRecoveryAlert(status: string, runId: string,
  alerts: ReadRecoveryAlert[], expected?: ReadRecoveryAlert): ReadRecoveryAlert {
  const alert = alerts.length === 1 ? alerts[0] : null;
  if (!alert || alert.alert_key !== `LIVE_RUN:${runId}:CRITICAL`
    || !mayRecoverReadOutage(status, "OK", alert.code)
    || !Number.isFinite(Date.parse(alert.last_seen_at))
    || expected && (alert.code !== expected.code || alert.last_seen_at !== expected.last_seen_at))
    throw new Error("COINOPS_LIVE_RECOVERY_INCIDENT_CHANGED");
  return alert;
}
