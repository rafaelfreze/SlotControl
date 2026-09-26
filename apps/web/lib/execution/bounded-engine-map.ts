/** Keep a shared Binance IP from receiving every engine's snapshots at once.
 * The index is claimed before awaiting, so a slow engine cannot starve peers. */
export async function boundedEngineMap<T, R>(items: readonly T[], concurrency: number,
  worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("COINOPS_LIVE_CRON_CONCURRENCY_INVALID");
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}
