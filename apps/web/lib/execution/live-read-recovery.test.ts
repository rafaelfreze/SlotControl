import assert from "node:assert/strict";
import test from "node:test";

import { mayRecoverReadOutage, verifiedReadRecoveryAlert } from "./live-read-recovery.ts";

test("recovers only a successfully reconciled active read outage", () => {
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", "COINOPS_LIVE_RECONCILE_ORDERS_FAILED"), true);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", "COINOPS_LIVE_READ_STATE_FAILED"), true);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", "COINOPS_LIVE_EXECUTOR_READ_STALE"), true);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", "COINOPS_LIVE_MONITOR_EXECUTOR_UNHEALTHY"), true);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", "COINOPS_LIVE_EXCHANGE_ORDER_MISSING"), true);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", "COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN"), true);
  for (const code of ["COINOPS_LIVE_TP_FAILED", "STRATEGY_PRICE_INVARIANT_FAILED", null])
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code), false);
  assert.equal(mayRecoverReadOutage("PAUSED", "OK", "COINOPS_LIVE_READ_STATE_FAILED"), false);
  assert.equal(mayRecoverReadOutage("ACTIVE", "RETRY", "COINOPS_LIVE_READ_STATE_FAILED"), false);
  assert.equal(mayRecoverReadOutage("ACTIVE", "RETRY", "COINOPS_LIVE_EXCHANGE_ORDER_MISSING"), false);
  assert.equal(mayRecoverReadOutage("ACTIVE", "FAILED", "COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN"), false);
});

test("monitor health recovery remains fail-closed before successful reconciliation", () => {
  for (const status of ["PAUSED", "INACTIVE", "BLOCKED"])
    assert.equal(mayRecoverReadOutage(status, "OK", "COINOPS_LIVE_MONITOR_EXECUTOR_UNHEALTHY"), false);
  for (const result of ["RETRY", "FAILED", "BUSY_OR_INACTIVE"])
    assert.equal(mayRecoverReadOutage("ACTIVE", result, "COINOPS_LIVE_MONITOR_EXECUTOR_UNHEALTHY"), false);
});

test("legacy registry outage requires LOAD_LEDGER evidence and completed active reconciliation", () => {
  const code = "COINOPS_OPERATOR_REGISTRY_UNAVAILABLE";
  const alert = { alert_key: "LIVE_RUN:run-a:CRITICAL", code,
    last_seen_at: "2026-10-05T19:43:09.975Z", details: { stage: "LOAD_LEDGER", root_code: code } };
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code), true);
  assert.equal(mayRecoverReadOutage("ACTIVE", "RETRY", code), false);
  assert.equal(mayRecoverReadOutage("PAUSED", "OK", code), false);
  assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [alert]), alert);
  for (const details of [undefined, { stage: "ARM_ENTRY", root_code: code },
    { stage: "LOAD_LEDGER", root_code: "PERMISSION_DENIED" }])
    assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...alert, details }]), /INCIDENT_CHANGED/);
  for (const denied of ["COINOPS_OPERATOR_SCOPE_UNAVAILABLE", "COINOPS_OPERATOR_SCOPE_DENIED", "COINOPS_ENGINE_SCOPE_DENIED"])
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", denied), false);
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

test("ledger recovery requires exact diagnosed read origin, never failed/partial reconciliation", () => {
  const code = "COINOPS_LIVE_LEDGER_INCOMPLETE";
  const alert = { alert_key: "LIVE_RUN:run-a:CRITICAL", code, last_seen_at: "2026-10-07T15:25:09Z",
    details: { stage: "RECONCILE_ORDERS", root_code: code } };
  assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [alert]), alert);
  for (const status of ["RETRY", "FAILED", "BUSY_OR_INACTIVE"])
    assert.equal(mayRecoverReadOutage("ACTIVE", status, code), false);
  for (const details of [undefined, { stage: "ARM_ENTRY", root_code: code },
    { stage: "LOAD_LEDGER", root_code: "42501" }])
    assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...alert, details }]), /INCIDENT_CHANGED/);
  const stale = { ...alert, code: "COINOPS_LIVE_LEDGER_READ_STALE",
    details: { stage: "READ_STATE", root_code: "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE", read_path: "ledger/orders" } };
  assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [stale]), stale);
  assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...stale,
    details: { ...stale.details, read_path: "POST/order" } }]), /INCIDENT_CHANGED/);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", "COINOPS_LIVE_LEDGER_READ_FAILED"), false);
});

test("monthly read recovery requires exact read-stage evidence and rejects ambiguous gains or a changed incident", () => {
  const code = "COINOPS_MONTHLY_GAIN_LEDGER_UNAVAILABLE";
  const alert = { alert_key: "LIVE_RUN:run-a:CRITICAL", code, last_seen_at: "2026-10-07T20:02:13Z",
    details: { stage: "RECYCLE_SLOTS", root_code: code } };
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code), true);
  assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [alert]), alert);
  for (const status of ["RETRY", "FAILED", "BUSY_OR_INACTIVE"])
    assert.equal(mayRecoverReadOutage("ACTIVE", status, code), false);
  for (const details of [undefined, { stage: "PROTECT_TP", root_code: code },
    { stage: "RECYCLE_SLOTS", root_code: "42501" }])
    assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...alert, details }]), /INCIDENT_CHANGED/);
  for (const denied of ["COINOPS_MONTHLY_GAIN_LEDGER_AMBIGUOUS", "COINOPS_MONTHLY_GAIN_LEDGER_MISMATCH",
    "COINOPS_MONTHLY_TARGET_UNAVAILABLE", "COINOPS_LIVE_LEDGER_READ_FAILED"])
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", denied), false);
  for (const path of ["ledger/monthly_target", "ledger/monthly_gains"]) {
    const stale = { ...alert, code: "COINOPS_LIVE_LEDGER_READ_STALE",
      details: { ...alert.details, root_code: "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE", read_path: path } };
    assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [stale]), stale);
  }
  assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a",
    [{ ...alert, last_seen_at: "2026-10-07T20:03:13Z" }], alert), /INCIDENT_CHANGED/);
});

test("bulk checkpoint legacy recovery qualifies only the exact GET stage, never an actual edit failure", () => {
  const code = "COINOPS_BULK_CHECKPOINT_UNAVAILABLE";
  const alert = { alert_key: "LIVE_RUN:run-a:CRITICAL", code, last_seen_at: "2026-10-07T21:02:17Z",
    details: { stage: "CONFIG_UPDATE", root_code: code } };
  assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [alert]), alert);
  for (const details of [undefined, { stage: "ARM_ENTRY", root_code: code },
    { stage: "CONFIG_UPDATE", root_code: "COINOPS_BULK_CLAIM_FAILED" }])
    assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...alert, details }]), /INCIDENT_CHANGED/);
  for (const denied of ["COINOPS_BULK_GATE_UNAVAILABLE", "COINOPS_BULK_CLAIM_FAILED", "COINOPS_BULK_PROFILE_UPDATE_FAILED",
    "COINOPS_BULK_FINISH_FAILED", "COINOPS_BULK_SCOPE_OR_GATE_INVALID", "COINOPS_BULK_VALUE_INVALID"])
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", denied), false);
  for (const path of ["bulk_checkpoint", "config_gate", "quote_cap", "preparation", "operator"]) {
    const stale = { ...alert, code: "COINOPS_LIVE_LEDGER_READ_STALE",
      details: { ...alert.details, root_code: "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE", read_path: `ledger/${path}` } };
    assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [stale]), stale);
  }
  assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a",
    [{ ...alert, last_seen_at: "2026-10-07T21:03:17Z" }], alert), /INCIDENT_CHANGED/);
});
