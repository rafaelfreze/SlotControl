/** Only observation endpoints/registry reads may construct this error. A failed write remains
 * ambiguous even when its HTTP status or message looks like a read failure. */
export class LiveReadUnavailable extends Error {
  readonly code: string; readonly path: string; readonly attempts: number; readonly httpStatus: number | null;
  readonly providerCode: string | null;
  constructor(code: string, path: string, attempts: number, httpStatus: number | null = null,
    providerCode: string | null = null) {
    super(code);
    this.code = code; this.path = path; this.attempts = attempts; this.httpStatus = httpStatus;
    this.providerCode = safeProviderCode(providerCode);
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
  constructor(code: string, status: number) { super(code); this.status = status; }
}

const OBSERVATION_FAILURES = new Set([
  "EXECUTOR_HTTP_502", "EXECUTOR_HTTP_503", "EXECUTOR_HTTP_504", "EXECUTOR_UNAVAILABLE",
  "EXECUTOR_BINANCE_READ_UNAVAILABLE", "EXECUTOR_ORDER_QUERY_FAILED", "EXECUTOR_TRADES_QUERY_FAILED",
  "EXECUTOR_BINANCE_RESULT_UNKNOWN",
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
    error instanceof ExecutorHttpError ? error.status : null);
}

/** Allowlisted diagnostic metadata only; never serialize error messages/payloads. */
export function liveFailureEvidence(error: unknown, stage: string, source: string) {
  return { stage, source: source.startsWith("WATCHDOG") ? "WATCHDOG" : "ENGINE",
    root_code: error instanceof Error && /^(EXECUTOR|COINOPS)_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "UNCLASSIFIED_FAILURE",
    ...(error instanceof LiveReadUnavailable || error instanceof LiveLedgerReadFailed
      ? { read_path: error.path, read_attempts: error.attempts, http_status: error.httpStatus,
        ...(error.providerCode ? { provider_code: error.providerCode } : {}) } : {}) };
}
