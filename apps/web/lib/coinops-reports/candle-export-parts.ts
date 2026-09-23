export const CANDLE_EXPORT_MAX_DAYS = 7;
export type CandleExportPart = { number: number; start: string; end: string; days: number };
const DAY = 86_400_000;

function calendarDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed : null;
}

/** Local inclusive calendar dates; partitioning never changes the chosen period. */
export function partitionCandleExports(start: string, end: string): CandleExportPart[] {
  const first = calendarDay(start); const last = calendarDay(end);
  if (first === null || last === null || last < first || last - first >= 366 * DAY) return [];
  const parts: CandleExportPart[] = [];
  for (let cursor = first; cursor <= last; cursor += CANDLE_EXPORT_MAX_DAYS * DAY) {
    const partEnd = Math.min(last, cursor + (CANDLE_EXPORT_MAX_DAYS - 1) * DAY);
    parts.push({ number: parts.length + 1, start: new Date(cursor).toISOString().slice(0, 10), end: new Date(partEnd).toISOString().slice(0, 10), days: (partEnd - cursor) / DAY + 1 });
  }
  return parts;
}
