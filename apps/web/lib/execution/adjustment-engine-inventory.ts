/** A staged engine reserves its allocation but must not prevent an existing
 * ACTIVE engine from receiving an explicit adjustment. Capital synchronization
 * still carries the entire account inventory, including inactive engines. */
export function adjustmentEngineInventory<T extends { id: string; status: string; executor_shard_id: string }>(engines: readonly T[]) {
  if (!engines.length || new Set(engines.map(engine => engine.id)).size !== engines.length
    || engines.some(engine => !/^executor-[0-9]{2,4}$/.test(engine.executor_shard_id)))
    throw new Error("COINOPS_ADJUSTMENT_ACCOUNT_UNAVAILABLE");
  const active = engines.filter(engine => engine.status === "ACTIVE");
  if (!active.length) throw new Error("COINOPS_ADJUSTMENT_ACCOUNT_UNAVAILABLE");
  return { active, all: [...engines] };
}
