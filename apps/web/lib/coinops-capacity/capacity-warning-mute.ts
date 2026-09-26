export function capacityWarningMuted(
  alert: { shard_id: string; severity: string; code: string },
  operatorId: string,
  mutedPairs: ReadonlySet<string>,
) {
  return alert.severity === "WARNING"
    && ["BINANCE_WEIGHT_WARNING", "EXECUTOR_CAPACITY_WARNING"].includes(alert.code)
    && mutedPairs.has(`${operatorId}:${alert.shard_id}`);
}
