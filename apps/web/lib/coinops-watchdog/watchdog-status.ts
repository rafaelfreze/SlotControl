export type WatchdogCheck = { shard_id: string; checked_at: string; shard_state: string;
  healthy_engines: number; recovering_engines: number; reconciling_engines?: number; blocked_engines: number; stale_engines: number };

const OPERATIONALLY_HEALTHY_SHARD_STATES = new Set([
  'HEALTHY',
  'CAPACITY_WARNING',
  'CAPACITY_LIMIT',
]);

/** Capacity pressure is an admission concern; it does not make a running executor unhealthy. */
export function isOperationallyHealthyShard(state: string) {
  return OPERATIONALLY_HEALTHY_SHARD_STATES.has(state);
}

/** A prior healthy sample cannot overrule a known, unresolved critical alert. */
export function aggregateWatchdogStatus(enabledIds: string[], checks: WatchdogCheck[],
  criticalAlerts: number, now = Date.now()) {
  const enabled = new Set(enabledIds);
  const rows = checks.filter((row) => enabled.has(row.shard_id));
  const fresh = enabled.size > 0 && rows.length === enabled.size && rows.every((row) => {
    const age = now - Date.parse(row.checked_at);
    return Number.isFinite(age) && age >= -30_000 && age < 3 * 60_000;
  });
  const checkedAt = rows.reduce<string | null>((current, row) =>
    !current || Date.parse(row.checked_at) < Date.parse(current) ? row.checked_at : current, null);
  return { status: !fresh ? 'STALE' : criticalAlerts > 0
    || rows.some((row) => !isOperationallyHealthyShard(row.shard_state)) ? 'ATTENTION' : 'HEALTHY',
  checkedAt, activeCriticalAlerts: criticalAlerts,
  engines: { healthy: rows.reduce((n, row) => n + row.healthy_engines, 0),
    reconciling: rows.reduce((n, row) => n + (row.reconciling_engines ?? 0), 0),
    recovering: rows.reduce((n, row) => n + row.recovering_engines, 0),
    blocked: rows.reduce((n, row) => n + row.blocked_engines, 0),
    stale: rows.reduce((n, row) => n + row.stale_engines, 0) },
  executors: { healthy: rows.filter((row) => isOperationallyHealthyShard(row.shard_state)).length,
    total: enabled.size } };
}
