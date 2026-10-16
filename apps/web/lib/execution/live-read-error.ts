/** Only observation endpoints/registry reads may construct this error. A failed write remains
 * ambiguous even when its HTTP status or message looks like a read failure. */
export type PermissionReadEvidence = { path: string; http_status: number | null; provider_code: number | null };

const PERMISSION_READ_PATHS = new Set(["/sapi/v1/account/apiRestrictions", "/api/v3/time", "/api/v3/account"]);
const PERMISSION_READ_UNAVAILABLE = "EXECUTOR_PRODUCTION_PERMISSION_READ_UNAVAILABLE";

/** Provider evidence is numeric/path-only, never an arbitrary message or URL. */
function permissionReadEvidence(code: string, value: unknown): PermissionReadEvidence | null {
  if (code !== PERMISSION_READ_UNAVAILABLE || !value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.path !== "string" || !PERMISSION_READ_PATHS.has(item.path)
    || !(item.http_status === null || Number.isInteger(item.http_status)
      && Number(item.http_status) >= 200 && Number(item.http_status) <= 599)
    || !(item.provider_code === null || Number.isSafeInteger(item.provider_code)
      && Math.abs(Number(item.provider_code)) <= 100_000)) return null;
  return { path: item.path, http_status: item.http_status as number | null,
    provider_code: item.provider_code as number | null };
}

export class LiveReadUnavailable extends Error {
  readonly code: string; readonly path: string; readonly attempts: number; readonly httpStatus: number | null;
  readonly providerCode: string | null;
  readonly readEvidence: PermissionReadEvidence | null;
  constructor(code: string, path: string, attempts: number, httpStatus: number | null = null,
    providerCode: string | null = null, readEvidence?: unknown) {
    super(code);
    this.code = code; this.path = path; this.attempts = attempts; this.httpStatus = httpStatus;
    this.providerCode = safeProviderCode(providerCode);
    this.readEvidence = permissionReadEvidence(code, readEvidence);
    this.name = "LiveReadUnavailable";
  }
}

const safeProviderCode = (code: unknown) => typeof code === "string"
  && /^(?:[0-9A-Z]{5}|PGRST[0-9X]{3})$/.test(code) ? code : null;

/** A non-transient database read error is not an incomplete ledger or a retry. */
export class LiveLedgerReadFailed extends Error {
  readonly providerCode: string | null;
  readonly path: string; readonly attempts: number; readonly httpStatus: number | null;
  constructor(path: string, attempts: number, httpStatus: number | null, providerCode: unknown) {
    super("COINOPS_LIVE_LEDGER_READ_FAILED");
    this.path = path; this.attempts = attempts; this.httpStatus = httpStatus;
    this.providerCode = safeProviderCode(providerCode);
  }
}

export class ExecutorHttpError extends Error {
  readonly status: number;
  readonly readEvidence: PermissionReadEvidence | null;
  constructor(code: string, status: number, readEvidence?: unknown) {
    super(code); this.status = status;
    this.readEvidence = permissionReadEvidence(code, readEvidence);
  }
}

const OBSERVATION_FAILURES = new Set([
  "EXECUTOR_HTTP_502", "EXECUTOR_HTTP_503", "EXECUTOR_HTTP_504", "EXECUTOR_UNAVAILABLE",
  "EXECUTOR_BINANCE_READ_UNAVAILABLE", "EXECUTOR_ORDER_QUERY_FAILED", "EXECUTOR_TRADES_QUERY_FAILED",
  "EXECUTOR_BINANCE_RESULT_UNKNOWN",
  "EXECUTOR_ORDER_OBSERVATION_INCOMPLETE",
  // The executor proves a transient GET failure while observing restrictions;
  // it never uses this code for a real permission denial or a dispatched write.
  "EXECUTOR_PRODUCTION_PERMISSION_READ_UNAVAILABLE",
]);

export function retryableObservation(error: unknown) {
  // Never retry scope, ownership, malformed trade, page-limit or permission failures.
  return error instanceof ExecutorHttpError
    ? [502, 503, 504].includes(error.status) && OBSERVATION_FAILURES.has(error.message)
    : error instanceof TypeError || error instanceof DOMException
      && ["AbortError", "TimeoutError"].includes(error.name);
}

export function observationFailure(error: unknown, path: string, attempts: number) {
  const code = error instanceof ExecutorHttpError ? error.message
    : error instanceof DOMException ? "EXECUTOR_READ_TIMEOUT" : "EXECUTOR_READ_NETWORK_FAILED";
  return new LiveReadUnavailable(code, path, attempts,
    error instanceof ExecutorHttpError ? error.status : null, null,
    error instanceof ExecutorHttpError ? error.readEvidence : null);
}

/** Allowlisted diagnostic metadata only; never serialize error messages/payloads. */
export function liveFailureEvidence(error: unknown, stage: string, source: string) {
  return { stage, source: source.startsWith("WATCHDOG") ? "WATCHDOG" : "ENGINE",
    root_code: error instanceof Error && /^(EXECUTOR|COINOPS)_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "UNCLASSIFIED_FAILURE",
    ...(error instanceof LiveReadUnavailable || error instanceof LiveLedgerReadFailed
      ? { read_path: error.path, read_attempts: error.attempts, http_status: error.httpStatus,
        ...(error.providerCode ? { provider_code: error.providerCode } : {}),
        ...(error instanceof LiveReadUnavailable && error.readEvidence ? {
          provider_read_path: error.readEvidence.path, provider_http_status: error.readEvidence.http_status,
          provider_code: error.readEvidence.provider_code,
        } : {}) } : {}) };
}
