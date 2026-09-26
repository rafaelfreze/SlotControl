import { boundedEngineMap, fairPoolOffset } from "./bounded-engine-map.ts";

/** Independent fixed-IP pools. An offline shard cannot occupy another shard's
 * workers. Output remains aligned with input; fairness is local to each pool. */
export async function shardedEngineMap<T, R>(items: readonly T[], shardOf: (item: T) => string,
  concurrencyPerShard: number, worker: (item: T, index: number) => Promise<R>, minute: number): Promise<R[]> {
  const pools = new Map<string, Array<{ item: T; index: number }>>();
  items.forEach((item, index) => {
    const shardId = shardOf(item);
    if (!shardId) throw new Error("COINOPS_EXECUTOR_SHARD_REQUIRED");
    const pool = pools.get(shardId) ?? [];
    pool.push({ item, index }); pools.set(shardId, pool);
  });
  const results = new Array<R>(items.length);
  await Promise.all([...pools.values()].map((pool) => boundedEngineMap(pool, concurrencyPerShard,
    async ({ item, index }) => { results[index] = await worker(item, index); },
    fairPoolOffset(pool.length, minute))));
  return results;
}
