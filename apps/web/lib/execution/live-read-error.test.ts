import test from "node:test";
import assert from "node:assert/strict";
import { ExecutorHttpError, LiveReadUnavailable, retryableObservation, observationFailure, liveFailureEvidence } from "./live-read-error.ts";

test("real 503 query signature is retryable; ownership and financial ambiguity are not reclassified", () => {
  assert.equal(retryableObservation(new ExecutorHttpError("EXECUTOR_ORDER_QUERY_FAILED", 503)), true);
  for (const code of ["EXECUTOR_ORDER_IDENTITY_MISMATCH", "EXECUTOR_TRADES_PAGE_LIMIT", "EXECUTOR_PRODUCTION_PERMISSION_DENIED", "EXECUTOR_SCOPE_DENIED"]) {
    assert.equal(retryableObservation(new ExecutorHttpError(code, 503)), false);
  }
  assert.equal(retryableObservation(new ExecutorHttpError("EXECUTOR_ORDER_QUERY_FAILED", 403)), false);
  assert.equal(retryableObservation(new Error("EXECUTOR_ORDER_QUERY_FAILED")), false);
});

test("timeout/network observations retain finite retry evidence without leaking arbitrary messages", () => {
  for (const error of [new TypeError("private transport detail"), new DOMException("private", "TimeoutError")]) {
    assert.equal(retryableObservation(error), true);
    const safe = observationFailure(error, "/v1/query-order", 4);
    assert.ok(safe instanceof LiveReadUnavailable);
    assert.equal(liveFailureEvidence(safe, "RECONCILE_ORDERS", "LIVE_CRON").read_attempts, 4);
    assert.ok(!JSON.stringify(liveFailureEvidence(safe, "READ_STATE", "LIVE_CRON")).includes("private"));
  }
});

test("typed restriction observation is retryable only with transient HTTP; real denial remains closed", () => {
  const code = "EXECUTOR_PRODUCTION_PERMISSION_READ_UNAVAILABLE";
  for (const status of [502, 503, 504])
    assert.equal(retryableObservation(new ExecutorHttpError(code, status)), true);
  for (const status of [400, 401, 403, 418, 429])
    assert.equal(retryableObservation(new ExecutorHttpError(code, status)), false);
  assert.equal(retryableObservation(new Error(code)), false);
  assert.equal(retryableObservation(new ExecutorHttpError("EXECUTOR_PRODUCTION_PERMISSION_DENIED", 503)), false);
  const exhausted = observationFailure(new ExecutorHttpError(code, 503), "/v1/state", 4);
  assert.deepEqual(liveFailureEvidence(exhausted, "READ_STATE", "LIVE_CRON"), {
    stage: "READ_STATE", source: "ENGINE", root_code: code,
    read_path: "/v1/state", read_attempts: 4, http_status: 503,
  });
});

test("restriction diagnostics preserve sanitized upstream evidence but never messages, URLs or auth payload", () => {
  const code = "EXECUTOR_PRODUCTION_PERMISSION_READ_UNAVAILABLE";
  const value = { path: "/sapi/v1/account/apiRestrictions", http_status: 503, provider_code: -1000,
    message: "private-provider-payload", request_url: "https://private.invalid?signature=secret" };
  const exhausted = observationFailure(new ExecutorHttpError(code, 503, value), "/v1/state", 4);
  const evidence = liveFailureEvidence(exhausted, "READ_STATE", "LIVE_CRON");
  assert.deepEqual(evidence, { stage: "READ_STATE", source: "ENGINE", root_code: code,
    read_path: "/v1/state", read_attempts: 4, http_status: 503,
    provider_read_path: value.path, provider_http_status: 503, provider_code: -1000 });
  assert.ok(!JSON.stringify(evidence).includes("private"));
  for (const invalid of [{ ...value, path: "https://private.invalid" }, { ...value, provider_code: "secret" },
    { ...value, provider_code: Infinity }, { ...value, provider_code: 100001 }, { ...value, http_status: "503" }])
    assert.equal(new ExecutorHttpError(code, 503, invalid).readEvidence, null);
  assert.equal(new ExecutorHttpError("EXECUTOR_PRODUCTION_PERMISSION_DENIED", 503, value).readEvidence, null);
});
