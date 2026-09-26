/** Keep a shared Binance IP from receiving every engine's snapshots at once.
 * The index is claimed before awaiting, so a slow engine cannot starve peers. */
export async function boundedEngineMap<T, R>(items: readonly T[], concurrency: number,
  worker: (item: T, index: number) => Promise<R>, offset = 0): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1
    || !Number.isInteger(offset) || offset < 0)
    throw new Error("COINOPS_LIVE_CRON_CONCURRENCY_INVALID");
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = (offset + next++) % items.length;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

/** A stateless cron cannot retain a cursor if its deadline interrupts a run.
 * A coprime stride rotates first access without changing per-engine identity. */
export function fairPoolOffset(length: number, minute: number): number {
  if (!Number.isInteger(length) || length < 0 || !Number.isSafeInteger(minute) || minute < 0)
    throw new Error("COINOPS_LIVE_CRON_CONCURRENCY_INVALID");
  if (length < 2) return 0;
  const gcd = (left: number, right: number): number => right ? gcd(right, left % right) : left;
  let stride = Math.max(1, Math.round(length * 0.382));
  while (gcd(stride, length) !== 1) stride++;
  return Number((BigInt(minute) * BigInt(stride)) % BigInt(length));
}
