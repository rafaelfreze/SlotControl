import { LiveLedgerReadFailed, LiveReadUnavailable } from "./live-read-error.ts";

type Resource = "slots" | "orders" | "slot_accounts" | "monthly_target" | "monthly_gains";
type Response<T> = { data: T[] | null; error: unknown; status?: number };
const CONNECTION_CODES = new Set(["PGRST000", "PGRST001", "PGRST002", "PGRST003",
  "08000", "08003", "08006", "53300", "57014"]);

/** Only GET builders belong here. No mutation, dispatch or whole trading step
 * may inherit this retry. Error messages/details never leave this boundary. */
export async function observeLedgerRows<T>(resource: Resource, query: PromiseLike<Response<T>>,
  deadline: AbortSignal, attempt: number): Promise<T[]> {
  const path = `ledger/${resource}`;
  let result: Response<T>;
  try { result = await query; }
  catch (error) {
    if (error instanceof TypeError || error instanceof DOMException
      && ["AbortError", "TimeoutError"].includes(error.name))
      throw new LiveReadUnavailable("COINOPS_LIVE_LEDGER_READ_UNAVAILABLE", path, attempt);
    throw new LiveLedgerReadFailed(path, attempt, null, null);
  }
  if (result.error) {
    const provider = result.error as { code?: unknown; message?: unknown };
    const code = typeof provider.code === "string" ? provider.code.trim() : "";
    const status = Number.isInteger(result.status) && result.status! >= 0 && result.status! <= 599
      ? result.status! : null;
    const network = !code && status === 0 && typeof provider.message === "string"
      && /^TypeError:\s*fetch failed(?:\s|$)/.test(provider.message);
    // A deadline never overrides a real permission/schema/identity error.
    const connection = CONNECTION_CODES.has(code) && ([503, 504].includes(status ?? -1)
      || code === "57014" && status === 500);
    if (connection || !code
      && (deadline.aborted || network || [502, 503, 504].includes(status ?? -1)))
      throw new LiveReadUnavailable("COINOPS_LIVE_LEDGER_READ_UNAVAILABLE", path, attempt, status, code);
    throw new LiveLedgerReadFailed(path, attempt, status, code);
  }
  if (!Array.isArray(result.data)) throw new Error("COINOPS_LIVE_LEDGER_INCOMPLETE");
  return result.data;
}

/** Discard the entire partial read and retry once under a fresh 5s deadline.
 * Exhaustion is checkpointed by the normal reconciler, not by a second trader. */
export async function boundedLedgerRead<T>(read: (deadline: AbortSignal, attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await read(AbortSignal.timeout(5_000), attempt); }
    catch (error) {
      if (!(error instanceof LiveReadUnavailable)
        || error.code !== "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE" || attempt >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

export function assertPhysicalLedger(rows: { slot_number: number }[]) {
  if (rows.length !== 25 || new Set(rows.map(row => row.slot_number)).size !== 25
    || rows.some(row => !Number.isInteger(row.slot_number) || row.slot_number < 1 || row.slot_number > 25))
    throw new Error("COINOPS_LIVE_LEDGER_INCOMPLETE");
}
