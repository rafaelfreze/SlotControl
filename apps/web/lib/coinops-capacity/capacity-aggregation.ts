/** Pure ledger projection. Never merge independent IP budgets or trading scopes. */
export type CapacityLedger = {
  accounts: Array<{ id: string; executor_shard_id: string }>;
  engines: Array<{ id: string; exchange_account_id: string; executor_shard_id?: string }>;
  runs: Array<{ trading_engine_id: string; last_reconciled_at: string | null; created_at: string; status: string }>;
  alerts: Array<{ trading_engine_id: string }>;
};
export function shardLedgerMetrics(shardId: string, ledger: CapacityLedger, now = Date.now()) {
  const accounts = new Set(ledger.accounts.map((row) => row.id));
  const engines = ledger.engines.filter((row) => row.executor_shard_id === shardId && accounts.has(row.exchange_account_id));
  const engineIds = [...new Set(engines.map((row) => row.id))].sort();
  const accountIds = [...new Set(engines.map((row) => row.exchange_account_id))].sort();
  const ids = new Set(engineIds);
  const runs = ledger.runs.filter((row) => ids.has(row.trading_engine_id));
  const ages = runs.filter((row) => row.status === "ACTIVE")
    .map((row) => Math.max(0, now - Date.parse(row.last_reconciled_at ?? row.created_at)))
    .sort((a, b) => a - b);
  // Missing ownership cannot be interpreted as an empty certified shard.
  const validInventory = ledger.engines.every((row) => Boolean(row.executor_shard_id) && accounts.has(row.exchange_account_id));
  const validRuns = validInventory && runs.length === engineIds.length && new Set(runs.map((row) => row.trading_engine_id)).size === engineIds.length
    && ages.every(Number.isFinite);
  return { engineIds, accountIds, assignedAccountCount: accountIds.length, validRuns,
    schedulerBacklog: ages.filter((age) => !Number.isFinite(age) || age >= 120_000).length,
    reconciliationP95Ms: ages.length ? Math.round(ages[Math.ceil(ages.length * .95) - 1]) : 0,
    reconciliationAgeMs: ages.length ? Math.round(ages[ages.length - 1]) : 0,
    errorsLast5m: ledger.alerts.filter((row) => ids.has(row.trading_engine_id)).length };
}

/** An offline/misconfigured shard cannot abort collection for a healthy shard. */
export async function collectIndependentShards<T>(ids: readonly string[], collect: (id: string) => Promise<T>) {
  return Promise.all(ids.map(async (shardId) => {
    try { return { shardId, ok: true as const, result: await collect(shardId) }; }
    catch { return { shardId, ok: false as const, error: "COINOPS_CAPACITY_SHARD_UNAVAILABLE" }; }
  }));
}
