type SelectionEngine = { engineId: string; accountId: string; asset: string;
  executorShardId?: string | null; health: { healthy: boolean }; killSwitch: boolean };
type SelectionAccount = { id: string; shardId?: string | null };

/** Scope selection is derived from the current registry, never a fixed fleet. */
export function selectBulkEngineIds(engines: SelectionEngine[], _accounts: SelectionAccount[],
  filter: { kind: "ALL" | "ASSET" | "SHARD" | "OPERATIONAL" | "ACCOUNT"; value?: string }) {
  return engines.filter((engine) => filter.kind === "ALL"
    || filter.kind === "ASSET" && engine.asset === filter.value
    || filter.kind === "SHARD" && !!engine.executorShardId && engine.executorShardId === filter.value
    || filter.kind === "OPERATIONAL" && engine.health.healthy && !engine.killSwitch
    || filter.kind === "ACCOUNT" && engine.accountId === filter.value)
    .map((engine) => engine.engineId);
}
