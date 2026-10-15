import "server-only";

/** Asset health is explicitly informational: it never blocks an engine or
 * changes an order. Keep collector/events/UI intact, but do not turn market
 * transitions or recoveries into operator-actionable push notifications.
 * Actual engine/infrastructure blocks use the Watchdog-confirmed dispatcher. */
export async function dispatchAssetHealthPush() {
  return { status: "PANEL_ONLY", sent: 0, failed: 0 };
}
