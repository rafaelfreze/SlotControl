/** Only a previously blocked ACTIVE run that has just passed its full
 * reconciliation may use the existing guarded resume path automatically. */
export function mayRecoverReadOutage(status: string, reconciledStatus: string,
  alertCode: string | null): boolean {
  return status === "ACTIVE" && reconciledStatus === "OK"
    && ["COINOPS_LIVE_RECONCILE_ORDERS_FAILED", "COINOPS_LIVE_READ_STATE_FAILED",
      "COINOPS_LIVE_EXECUTOR_READ_STALE"].includes(alertCode ?? "");
}
