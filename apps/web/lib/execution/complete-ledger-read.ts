/** PostgREST row limits must not turn a financial total into a partial total.
 * Callers supply authoritative scope plus deterministic unique-ID ordering. */
export async function completeLedgerRead<T extends { id: string }>(
  page: (start: number, end: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  errorCode: string, pageSize = 500): Promise<T[]> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error(errorCode);
  const rows: T[] = [], ids = new Set<string>();
  for (let offset = 0; ; offset += pageSize) {
    const result = await page(offset, offset + pageSize - 1);
    if (result.error || !Array.isArray(result.data) || result.data.length > pageSize) throw new Error(errorCode);
    for (const row of result.data) {
      if (!row.id || ids.has(row.id)) throw new Error(errorCode);
      ids.add(row.id); rows.push(row);
    }
    if (result.data.length < pageSize) return rows;
  }
}
