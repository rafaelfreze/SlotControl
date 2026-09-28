import assert from "node:assert/strict";
import test from "node:test";

import { mayRecoverReadOutage, verifiedReadRecoveryAlert } from "./live-read-recovery.ts";

test("recovers only a successfully reconciled active read outage", () => {
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", "COINOPS_LIVE_RECONCILE_ORDERS_FAILED"), true);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", "COINOPS_LIVE_READ_STATE_FAILED"), true);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", "COINOPS_LIVE_EXECUTOR_READ_STALE"), true);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", "COINOPS_LIVE_MONITOR_EXECUTOR_UNHEALTHY"), true);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", "COINOPS_LIVE_EXCHANGE_ORDER_MISSING"), true);
  for (const code of ["COINOPS_LIVE_TP_FAILED", "STRATEGY_PRICE_INVARIANT_FAILED", null])
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code), false);
  assert.equal(mayRecoverReadOutage("PAUSED", "OK", "COINOPS_LIVE_READ_STATE_FAILED"), false);
  assert.equal(mayRecoverReadOutage("ACTIVE", "RETRY", "COINOPS_LIVE_READ_STATE_FAILED"), false);
  assert.equal(mayRecoverReadOutage("ACTIVE", "RETRY", "COINOPS_LIVE_EXCHANGE_ORDER_MISSING"), false);
});

test("monitor health recovery remains fail-closed before successful reconciliation", () => {
  for (const status of ["PAUSED", "INACTIVE", "BLOCKED"])
    assert.equal(mayRecoverReadOutage(status, "OK", "COINOPS_LIVE_MONITOR_EXECUTOR_UNHEALTHY"), false);
  for (const result of ["RETRY", "FAILED", "BUSY_OR_INACTIVE"])
    assert.equal(mayRecoverReadOutage("ACTIVE", result, "COINOPS_LIVE_MONITOR_EXECUTOR_UNHEALTHY"), false);
});

test("recovery under lease requires the same sole, scoped incident", () => {
  const known = { alert_key: "LIVE_RUN:run-a:CRITICAL", code: "COINOPS_LIVE_MONITOR_EXECUTOR_UNHEALTHY",
    last_seen_at: "2026-09-27T00:00:12.000Z" };
  assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [known]), known);
  assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [known], known), known);
  for (const rows of [[], [{ ...known, code: "COINOPS_LIVE_TP_FAILED" }],
    [{ ...known, alert_key: "LIVE_RUN:run-b:CRITICAL" }],
    [known, { ...known, alert_key: "UNKNOWN_CRITICAL" }],
    [{ ...known, last_seen_at: "invalid" }]])
    assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", rows), /INCIDENT_CHANGED/);
  assert.throws(() => verifiedReadRecoveryAlert("PAUSED", "run-a", [known]), /INCIDENT_CHANGED/);
  assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a",
    [{ ...known, last_seen_at: "2026-09-27T00:01:12.000Z" }], known), /INCIDENT_CHANGED/);
  assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a",
    [{ ...known, code: "COINOPS_LIVE_READ_STATE_FAILED" }], known), /INCIDENT_CHANGED/);
});
