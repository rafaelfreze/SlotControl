/** Bounded work pool. Rotation changes who starts first on each cron minute;
 * each item is still attempted exactly once and results retain input order. */
export async function runFairPool<T, R>(items: readonly T[], concurrency: number,
  offset: number, execute: (item: T) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(offset) || offset < 0)
    throw new Error("COINOPS_LIVE_POOL_CONFIG_INVALID");
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  const first = offset % items.length;
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = (first + cursor++) % items.length;
      results[index] = await execute(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
