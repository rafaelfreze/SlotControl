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
