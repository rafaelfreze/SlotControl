type SelectionEngine = { engineId: string; accountId: string; asset: string;
  health: { healthy: boolean }; killSwitch: boolean };
type SelectionAccount = { id: string; shardId?: string | null };

/** Scope selection is derived from the current registry, never a fixed fleet. */
export function selectBulkEngineIds(engines: SelectionEngine[], accounts: SelectionAccount[],
  filter: { kind: "ALL" | "ASSET" | "SHARD" | "OPERATIONAL" | "ACCOUNT"; value?: string }) {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  return engines.filter((engine) => filter.kind === "ALL"
    || filter.kind === "ASSET" && engine.asset === filter.value
    || filter.kind === "SHARD" && accountById.get(engine.accountId)?.shardId === filter.value
    || filter.kind === "OPERATIONAL" && engine.health.healthy && !engine.killSwitch
    || filter.kind === "ACCOUNT" && engine.accountId === filter.value)
    .map((engine) => engine.engineId);
}
