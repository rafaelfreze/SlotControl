type CapacityAlert = { shard_id: string; severity: string; code: string };

export function acknowledgeableCapacityAlert(alert: CapacityAlert) {
  return (alert.severity === "WARNING"
      && ["BINANCE_WEIGHT_WARNING", "EXECUTOR_CAPACITY_WARNING"].includes(alert.code))
    || (alert.severity === "CRITICAL" && alert.code === "CAPACITY_LIMIT");
}

export function capacityWarningMuted(
  alert: CapacityAlert,
  operatorId: string,
  mutedPairs: ReadonlySet<string>,
) {
  return acknowledgeableCapacityAlert(alert)
    && mutedPairs.has(`${operatorId}:${alert.shard_id}`);
}
