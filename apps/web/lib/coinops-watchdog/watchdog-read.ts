type Observation = { data: unknown[] | null; error: unknown; count: number | null };

/** A bounded internal observation, not a retry of trading. A truncated or
 * changing snapshot cannot certify a deliberately paused engine as protected. */
export async function completeWatchdogRows<T>(read: (start: number, end: number,
  signal: AbortSignal) => PromiseLike<Observation>): Promise<T[]> {
  const signal = AbortSignal.timeout(5_000);
  const rows: T[] = [];
  let expected: number | null = null;
  for (let start = 0; ; start += 500) {
    const result = await read(start, start + 499, signal);
    if (signal.aborted || result.error || !Array.isArray(result.data) || result.count === null
      || !Number.isSafeInteger(result.count) || result.count < 0
      || (expected !== null && expected !== result.count))
      throw new Error("COINOPS_WATCHDOG_LEDGER_READ_FAILED");
    expected = result.count;
    rows.push(...result.data as T[]);
    if (rows.length > expected || (result.data.length < 500 && rows.length !== expected))
      throw new Error("COINOPS_WATCHDOG_LEDGER_READ_FAILED");
    if (rows.length === expected) return rows;
  }
}
