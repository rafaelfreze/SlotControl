export type ExecutorObservation = {
  id: string; egressIp: string; state: string; executorVersion: string | null;
  observedAt: string | null; heartbeatAt: string | null;
};

export type ExecutorSnapshot = {
  ip: string | null; version: string | null; gate: string | null;
};

const MAX_OBSERVATION_AGE_MS = 120_000;
const knownStates = new Set(["HEALTHY", "OBSERVE", "WARNING", "CAPACITY_LIMIT", "OFFLINE"]);
const ipKey = (ip: string | null) => typeof ip === "string" ? ip.replace(/\/32$/, "") : "";
const fresh = (value: string | null, now: number) => {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= MAX_OBSERVATION_AGE_MS;
};

/** Persisted capacity is only a refresh hint, NEVER evidence to promote engine health.
 * Weight/warning changes and heartbeat timestamps are deliberately not fingerprints. */
export function observeExecutorSnapshots(seen: Map<string, string>, observations: ExecutorObservation[],
  snapshots: ExecutorSnapshot[], now: number): boolean {
  let refresh = false;
  for (const observation of observations) {
    if (!observation || typeof observation !== "object") continue;
    const matching = snapshots.filter((snapshot) => ipKey(snapshot.ip) === ipKey(observation.egressIp));
    if (!observation.id || !ipKey(observation.egressIp) || !matching.length
      || !knownStates.has(observation.state)
      || !fresh(observation.observedAt, now) || !fresh(observation.heartbeatAt, now)
      || typeof observation.executorVersion !== "string" || !observation.executorVersion.trim()) continue;
    const offline = observation.state === "OFFLINE";
    const signature = JSON.stringify([observation.executorVersion, offline]);
    const key = `${observation.id}:${ipKey(observation.egressIp)}`;
    const previous = seen.get(key);
    seen.set(key, signature);
    if (previous !== undefined ? previous !== signature : matching.some((snapshot) =>
      snapshot.version !== observation.executorVersion
      || (offline ? snapshot.gate === "LIVE_EXECUTOR_ACTIVE" : snapshot.gate === "ATTENTION"))) refresh = true;
  }
  return refresh;
}
