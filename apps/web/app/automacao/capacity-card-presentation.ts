type Observation = {
  state: string; observedAt: string | null; heartbeatAt: string | null;
  alerts: Array<{ code: string }>;
};

/** Presentation only: never changes admission, collection or engine execution. */
export function executorNeedsAttention(shard: Observation, now: number): boolean {
  const fresh = (value: string | null) => {
    const timestamp = Date.parse(value ?? "");
    return Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= 120_000;
  };
  return !["HEALTHY", "OBSERVE"].includes(shard.state)
    || !fresh(shard.observedAt) || !fresh(shard.heartbeatAt) || shard.alerts.length > 0;
}

/** Home selection only. Admission remains the persisted server decision. */
export function selectOverviewExecutors<T extends Observation & { id: string; canAddEngine: boolean }>(
  shards: readonly T[], now: number,
): T[] {
  const available = shards.some((shard) => !executorNeedsAttention(shard, now) && shard.canAddEngine);
  return shards.filter((shard) => executorNeedsAttention(shard, now) || !available || shard.canAddEngine)
    .sort((left, right) => Number(executorNeedsAttention(right, now)) - Number(executorNeedsAttention(left, now))
      || left.id.localeCompare(right.id, undefined, { numeric: true }))
    .slice(0, 5);
}
