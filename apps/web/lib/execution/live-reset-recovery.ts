import type { createServiceRoleClient } from "../supabase/service-role";
import { validateEngineSlotCount } from "./engine-slot-topology.ts";
import { boundedLedgerRead, observeLedgerRows } from "./live-ledger-read.ts";

type Service = ReturnType<typeof createServiceRoleClient>;
const SCOPE = ["product_id", "tenant_id", "user_id", "operator_id", "exchange_account_id",
  "trading_engine_id", "quote_asset"] as const;
export type ResetRecoveryRun = Record<typeof SCOPE[number], string> & {
  id: string; previous_run_id: string | null; created_at: string;
};
export type ResetRecoveryMilestone = Record<typeof SCOPE[number], string> & {
  run_id: string; event_key: string; event_type: "RESET_RECOVERED"; slot_number: null;
  observed_at: string; details: { previous_run_id: string; open_positions: number; resident_buy_count: 1 };
};
const EVENT_KEYS = [...SCOPE, "run_id", "event_key", "event_type", "slot_number", "observed_at", "details"];
const DETAIL_KEYS = ["previous_run_id", "open_positions", "resident_buy_count"];
const COLUMNS = EVENT_KEYS.join(",");
const INVALID = "COINOPS_LIVE_RESET_RECOVERY_MILESTONE_INVALID";
const READ_FAILED = "COINOPS_LIVE_RESET_RECOVERY_MILESTONE_READ_FAILED";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const text = (value: unknown): value is string => typeof value === "string"
  && value.length > 0 && value.length <= 1_024 && value.trim() === value && !/[\r\n]/.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object"
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validTime = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));

function assertRun(run: ResetRecoveryRun, slotCount: number, now: number) {
  validateEngineSlotCount(slotCount);
  if (!run || !Number.isFinite(now) || !text(run.id) || SCOPE.some(key => !text(run[key]))
    || !/^[A-Z0-9]{1,16}$/.test(run.quote_asset) || typeof run.previous_run_id !== "string"
    || !UUID.test(run.previous_run_id) || run.previous_run_id === run.id
    || !validTime(run.created_at) || Date.parse(run.created_at) > now) throw new Error(INVALID);
}

/** A reset milestone is the immutable snapshot of one completed recovery,
 * not today's OPEN count. Its old timestamp and counts are intentionally kept.
 * This proof never establishes current financial health or authorizes a BUY. */
export function assertResetRecoveryMilestone(run: ResetRecoveryRun, value: unknown,
  slotCount: number, now = Date.now()): ResetRecoveryMilestone {
  assertRun(run, slotCount, now);
  if (!record(value) || !exactKeys(value, EVENT_KEYS) || SCOPE.some(key => value[key] !== run[key])
    || value.run_id !== run.id || value.event_key !== `RESET_RECOVERED:${run.previous_run_id}`
    || value.event_type !== "RESET_RECOVERED" || value.slot_number !== null
    || !validTime(value.observed_at) || Date.parse(value.observed_at) < Date.parse(run.created_at)
    || Date.parse(value.observed_at) > now || !record(value.details) || !exactKeys(value.details, DETAIL_KEYS)
    || value.details.previous_run_id !== run.previous_run_id
    || !Number.isSafeInteger(value.details.open_positions) || Number(value.details.open_positions) < 1
    || Number(value.details.open_positions) > slotCount || value.details.resident_buy_count !== 1)
    throw new Error(INVALID);
  return Object.freeze({ ...Object.fromEntries(SCOPE.map(key => [key, value[key]])),
    run_id: value.run_id, event_key: value.event_key, event_type: "RESET_RECOVERED", slot_number: null,
    observed_at: value.observed_at, details: Object.freeze({ previous_run_id: value.details.previous_run_id,
      open_positions: value.details.open_positions, resident_buy_count: 1 }) }) as ResetRecoveryMilestone;
}

/** Each observation has a real deadline even if a transport ignores abort.
 * The existing GET-only policy owns bounded retry and sanitized provider facts. */
async function observed(query: PromiseLike<{ data?: unknown; error: unknown; status?: number }>, signal: AbortSignal) {
  let abort: (() => void) | undefined;
  try {
    const result = await Promise.race([Promise.resolve(query), new Promise<never>((_resolve, reject) => {
      abort = () => reject(new DOMException("Reset milestone observation deadline", "TimeoutError"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
    if (!result || typeof result !== "object" || result.error === undefined
      || result.error === null && result.status !== undefined && !(result.status >= 200 && result.status < 300))
      throw new Error(READ_FAILED);
    return result as { data: unknown[] | null; error: unknown; status?: number };
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

/** Exact GETs, with the existing two-set 5s/250ms observation policy. Absence
 * is null only after a successful complete response. No INSERT, metadata
 * UPDATE, exchange action or cross-invocation cache exists. */
export async function readResetRecoveryMilestone(service: Service, run: ResetRecoveryRun,
  options: { slotCount: number; renewLease?: () => Promise<void> }, now = Date.now()): Promise<ResetRecoveryMilestone | null> {
  const expected = { ...run };
  assertRun(expected, options.slotCount, now);
  const rows = await boundedLedgerRead(async (deadline, attempt) => {
    // Lease loss is a financial fence, not a provider error to hide or retry.
    await options.renewLease?.();
    let query = service.from("robot_v1_live_events").select(COLUMNS)
      .eq("run_id", expected.id).eq("event_key", `RESET_RECOVERED:${expected.previous_run_id}`);
    for (const key of SCOPE) query = query.eq(key, expected[key]);
    return observeLedgerRows("reset_recovery_milestone", observed(query.limit(2).abortSignal(deadline), deadline), deadline, attempt);
  });
  if (rows.length > 1) throw new Error(INVALID);
  return rows.length ? assertResetRecoveryMilestone(expected, rows[0], options.slotCount, now) : null;
}
