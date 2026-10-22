import type { createServiceRoleClient } from "../supabase/service-role";

type Service = ReturnType<typeof createServiceRoleClient>;
export type LiveAuditEventRow = {
  run_id: string; product_id: string; tenant_id: string; user_id: string; operator_id: string;
  exchange_account_id: string; trading_engine_id: string; quote_asset: string;
  event_key: string; event_type: string; slot_number: number | null; details: Record<string, unknown>;
};
type Phase = "WRITE" | "READBACK";
type Reason = "HARD_PROVIDER" | "TRANSIENT_EXHAUSTED" | "READBACK_UNAVAILABLE"
  | "READBACK_MISMATCH" | "PAYLOAD_INVALID";
type Result = { data?: unknown; error: unknown; status?: number };
type Evidence = { transient: boolean; httpStatus: number | null; providerCode: string | null };
const SCOPE = ["product_id", "tenant_id", "user_id", "operator_id", "exchange_account_id",
  "trading_engine_id", "quote_asset", "run_id", "event_key"] as const;
const COLUMNS = [...SCOPE, "event_type", "slot_number", "details"].join(",");
const CONNECTION_CODES = new Set(["PGRST000", "PGRST001", "PGRST002", "PGRST003",
  "08000", "08003", "08006", "53300", "57014"]);
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN",
  "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);
const SET_BUDGET_MS = 5_000;
const safeCode = (code: unknown) => typeof code === "string"
  && /^(?:[0-9A-Z]{5}|PGRST[0-9X]{3})$/.test(code) ? code : null;
const safeStatus = (status: unknown) => Number.isInteger(status) && Number(status) >= 0
  && Number(status) <= 599 ? Number(status) : null;

/** Evidence contains a fixed phase/reason, sanitized provider codes and only
 * the two explicitly allowed audit-key shapes. No payload, arbitrary key,
 * path, provider message or response body is retained. */
export class LiveAuditEventPersistError extends Error {
  readonly code = "COINOPS_LIVE_EVENT_PERSIST_FAILED";
  readonly phase: Phase; readonly reason: Reason; readonly attempts: number;
  readonly httpStatus: number | null; readonly providerCode: string | null;
  readonly eventType: string | null; readonly eventKey: string | null;
  constructor(phase: Phase, reason: Reason, attempts: number, eventType: unknown,
    evidence?: Pick<Evidence, "httpStatus" | "providerCode">, eventKey?: unknown) {
    super("COINOPS_LIVE_EVENT_PERSIST_FAILED");
    this.name = "LiveAuditEventPersistError";
    this.phase = phase; this.reason = reason; this.attempts = attempts;
    this.eventType = typeof eventType === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(eventType)
      ? eventType : null;
    this.eventKey = typeof eventKey === "string" && (this.eventType === "RECONCILED"
      && /^RECONCILED:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$/.test(eventKey)
      || this.eventType === "RESET_RECOVERED"
      && /^RESET_RECOVERED:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(eventKey))
      ? eventKey : null;
    this.httpStatus = safeStatus(evidence?.httpStatus);
    this.providerCode = safeCode(evidence?.providerCode);
  }
}

/** Capture JSON once using the existing transport semantics for undefined:
 * object properties are omitted, array entries become null. Never coerce a
 * non-finite financial number, custom object or cyclic graph into evidence. */
function captureJson(value: unknown, ancestors = new Set<object>(), depth = 0): unknown {
  if (depth > 64) throw new Error("INVALID_JSON");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || !value || ancestors.has(value)) throw new Error("INVALID_JSON");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(Array.from(value, item => item === undefined ? null
      : captureJson(item, ancestors, depth + 1)));
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("INVALID_JSON");
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) Object.defineProperty(output, key, { value: captureJson(item, ancestors, depth + 1),
        enumerable: true, configurable: false, writable: false });
    }
    return Object.freeze(output);
  } finally { ancestors.delete(value); }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(
      (value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function captureRow(input: LiveAuditEventRow): LiveAuditEventRow {
  if (!input || typeof input !== "object" || SCOPE.some(key => typeof input[key] !== "string"
    || input[key].length < 1 || input[key].length > 1_024 || /[\r\n]/.test(input[key]))
    || !/^[A-Z][A-Z0-9_]{0,127}$/.test(input.event_type)
    || !/^[A-Z0-9]{1,16}$/.test(input.quote_asset)
    || input.slot_number !== null && (!Number.isInteger(input.slot_number)
      || input.slot_number < 1 || input.slot_number > 100)
    || !input.details || typeof input.details !== "object" || Array.isArray(input.details)) throw new Error("INVALID_ROW");
  return Object.freeze({ ...Object.fromEntries(SCOPE.map(key => [key, input[key]])),
    event_type: input.event_type, slot_number: input.slot_number,
    details: captureJson(input.details) }) as LiveAuditEventRow;
}

function providerEvidence(result: Result): Evidence {
  const provider = result.error && typeof result.error === "object"
    ? result.error as { code?: unknown; message?: unknown } : null;
  const httpStatus = safeStatus(result.status), providerCode = safeCode(provider?.code);
  const hasCode = provider?.code !== undefined && provider.code !== null && provider.code !== "";
  const connection = providerCode !== null && CONNECTION_CODES.has(providerCode)
    && ([503, 504].includes(httpStatus ?? -1) || providerCode === "57014" && httpStatus === 500);
  const network = !hasCode && httpStatus === 0 && typeof provider?.message === "string"
    && /^TypeError:\s*(?:fetch failed|Failed to fetch)(?:\s|$)/.test(provider.message);
  return { httpStatus, providerCode, transient: connection
    || !hasCode && ([502, 503, 504].includes(httpStatus ?? -1) || network) };
}

function thrownEvidence(error: unknown): Evidence {
  const typed = error && typeof error === "object" ? error as { code?: unknown; cause?: { code?: unknown } } : null;
  return { httpStatus: null, providerCode: null, transient: error instanceof DOMException
      && ["AbortError", "TimeoutError"].includes(error.name)
    || error instanceof TypeError && /^(?:fetch failed|Failed to fetch)$/.test(error.message)
    || NETWORK_CODES.has(String(typed?.code)) || NETWORK_CODES.has(String(typed?.cause?.code)) };
}

async function observed(query: PromiseLike<Result>, signal: AbortSignal): Promise<Result> {
  if (signal.aborted) throw new DOMException("Audit request deadline", "TimeoutError");
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([Promise.resolve(query), new Promise<never>((_resolve, reject) => {
      abort = () => reject(new DOMException("Audit request deadline", "TimeoutError"));
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

/** Retry only the captured immutable audit INSERT, never a financial step.
 * Each of at most two attempt sets has five seconds including its readback.
 * Half the set is reserved for observing a possibly committed write. Lease
 * callbacks are deliberately outside provider catches: lease loss is not a
 * retryable database error and must retain its original financial fence code. */
export async function appendLiveAuditEvent(service: Service, input: LiveAuditEventRow,
  options: { renewLease?: () => Promise<void> } = {}): Promise<{
    status: "ACKNOWLEDGED" | "CONFIRMED_AFTER_UNCERTAIN"; writeAttempts: 1 | 2;
  }> {
  let row: LiveAuditEventRow;
  try { row = captureRow(input); }
  catch { throw new LiveAuditEventPersistError("WRITE", "PAYLOAD_INVALID", 0, input?.event_type); }
  const failureFor = (phase: Phase, reason: Reason, attempts: number,
    evidence?: Pick<Evidence, "httpStatus" | "providerCode">) => new LiveAuditEventPersistError(
    phase, reason, attempts, row.event_type, evidence, row.event_key);
  for (const attempt of [1, 2] as const) {
    const started = performance.now();
    await options.renewLease?.();
    const writeRemaining = SET_BUDGET_MS - (performance.now() - started);
    if (writeRemaining <= 0) throw failureFor("WRITE", "TRANSIENT_EXHAUSTED", attempt);
    const writeSignal = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(2_500, writeRemaining))));
    let failure: Evidence;
    try {
      const result = await observed(service.from("robot_v1_live_events").upsert(row,
        { onConflict: "run_id,event_key", ignoreDuplicates: true }).abortSignal(writeSignal), writeSignal);
      if (!result || typeof result !== "object") throw new Error("INVALID_RESPONSE");
      if (result.error === null && (result.status === undefined || result.status >= 200 && result.status < 300))
        return { status: "ACKNOWLEDGED", writeAttempts: attempt };
      failure = providerEvidence(result);
    } catch (error) { failure = thrownEvidence(error); }
    if (!failure.transient) throw failureFor("WRITE", "HARD_PROVIDER", attempt, failure);
    await options.renewLease?.();
    const remaining = SET_BUDGET_MS - (performance.now() - started);
    if (remaining <= 0) throw failureFor("READBACK", "READBACK_UNAVAILABLE", attempt, failure);
    const readSignal = AbortSignal.timeout(Math.max(1, Math.floor(remaining)));
    let result: Result;
    try {
      let query = service.from("robot_v1_live_events").select(COLUMNS);
      for (const key of SCOPE) query = query.eq(key, row[key]);
      result = await observed(query.limit(2).abortSignal(readSignal), readSignal);
    } catch (error) {
      const readFailure = thrownEvidence(error);
      throw failureFor("READBACK", readFailure.transient
        ? "READBACK_UNAVAILABLE" : "HARD_PROVIDER", attempt, readFailure);
    }
    if (!result || typeof result !== "object" || result.error !== null
      || result.status !== undefined && !(result.status >= 200 && result.status < 300)) {
      const readFailure = providerEvidence(result ?? { error: true });
      throw failureFor("READBACK", readFailure.transient
        ? "READBACK_UNAVAILABLE" : "HARD_PROVIDER", attempt, readFailure);
    }
    if (!Array.isArray(result.data)) throw failureFor("READBACK", "READBACK_MISMATCH", attempt);
    if (result.data.length) {
      let matches = false;
      try { matches = result.data.length === 1 && canonical(captureRow(result.data[0])) === canonical(row); }
      catch { /* Missing, foreign or malformed evidence never acknowledges a write. */ }
      if (!matches) throw failureFor("READBACK", "READBACK_MISMATCH", attempt);
      return { status: "CONFIRMED_AFTER_UNCERTAIN", writeAttempts: attempt };
    }
    if (attempt === 2) throw failureFor("WRITE", "TRANSIENT_EXHAUSTED", attempt, failure);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw failureFor("WRITE", "TRANSIENT_EXHAUSTED", 2);
}
