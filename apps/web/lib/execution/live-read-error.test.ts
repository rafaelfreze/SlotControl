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
