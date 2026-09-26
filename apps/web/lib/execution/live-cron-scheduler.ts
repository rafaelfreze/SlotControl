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

/** A stateless cron cannot persist its cursor if the platform stops a run at
 * its deadline. A near-golden-ratio, coprime stride spreads the first jobs
 * across the list instead of starving the same tail on adjacent minutes. */
export function fairPoolOffset(length: number, minute: number): number {
  if (!Number.isInteger(length) || length < 0 || !Number.isSafeInteger(minute) || minute < 0)
    throw new Error("COINOPS_LIVE_POOL_CONFIG_INVALID");
  if (length < 2) return 0;
  const gcd = (left: number, right: number): number => right ? gcd(right, left % right) : left;
  let stride = Math.max(1, Math.round(length * 0.382));
  while (gcd(stride, length) !== 1) stride++;
  return (minute * stride) % length;
}
