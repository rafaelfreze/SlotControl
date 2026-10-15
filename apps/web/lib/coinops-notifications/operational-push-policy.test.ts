import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateOperationalPush, operationalAlertRunId, primaryOperationalAlerts, samePushInstant,
  OPERATIONAL_PUSH_BLOCKED_MS, OPERATIONAL_PUSH_FRESH_MS, OPERATIONAL_PUSH_TTL_SECONDS,
  OPERATIONAL_PUSH_LEASE_DEFERRAL_MS,
  type OperationalPushContext,
} from "./operational-push-policy.ts";

const NOW = Date.parse("2026-10-15T14:24:00.000Z");
const at = (seconds = 0) => new Date(NOW + seconds * 1_000).toISOString();
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const ENGINE = "00000000-0000-4000-8000-000000000002";
const OTHER_ENGINE = "00000000-0000-4000-8000-000000000003";
const ALERT = "00000000-0000-4000-8000-000000000004";
const RUN = "00000000-0000-4000-8000-000000000005";
const CODE = "COINOPS_LIVE_LEDGER_READ_FAILED";

function context(): OperationalPushContext {
  return {
    now: NOW,
    alert: { id: ALERT, operator_id: "operator", exchange_account_id: ACCOUNT, trading_engine_id: ENGINE,
      severity: "CRITICAL", code: CODE, alert_key: `LIVE_RUN:${RUN}:CRITICAL`, details: { run_id: RUN },
      first_seen_at: at(-180), resolved_at: null },
    engine: { id: ENGINE, operator_id: "operator", exchange_account_id: ACCOUNT, symbol: "SOLBRL",
      environment: "REAL", executor_shard_id: "executor-02", status: "ACTIVE", kill_switch: true },
    account: { id: ACCOUNT, operator_id: "operator", display_name: "Fixture", status: "ACTIVE" },
    run: { id: RUN, operator_id: "operator", exchange_account_id: ACCOUNT, trading_engine_id: ENGINE,
      symbol: "SOLBRL", status: "ACTIVE", lease_until: null, last_error: CODE },
    incident: { incident_id: "incident", shard_id: "executor-02", engine_id: ENGINE, account_id: ACCOUNT,
      market: "SOLBRL", incident_key: `${RUN}:${CODE}`, detected_condition: CODE,
      state_after: "BLOCKED", result: "OPEN", opened_at: at(-180), last_seen_at: at(-20),
      resolved_at: null, last_recovery_attempt_at: null },
    check: { shard_id: "executor-02", checked_at: at(-20), shard_state: "BLOCKED", blocked_engines: 1 },
  };
}

test("external escalation is bounded to an established 120s block and a fresh 150s Watchdog observation", () => {
  assert.equal(OPERATIONAL_PUSH_BLOCKED_MS, 120_000);
  assert.equal(OPERATIONAL_PUSH_FRESH_MS, 150_000);
  assert.equal(OPERATIONAL_PUSH_TTL_SECONDS, 60);
  assert.deepEqual(evaluateOperationalPush(context()), { eligible: true, reason: "UNRESOLVED_WATCHDOG_BLOCK" });
  const boundary = context(); boundary.incident!.opened_at = at(-120); boundary.alert.first_seen_at = at(-120);
  assert.equal(evaluateOperationalPush(boundary).eligible, true);
  boundary.incident!.opened_at = new Date(NOW - 119_999).toISOString();
  assert.equal(evaluateOperationalPush(boundary).eligible, false);
  const recentAlert = context(); recentAlert.alert.first_seen_at = at(-119);
  assert.equal(evaluateOperationalPush(recentAlert).eligible, false);
});

test("open warnings and resolved alerts never escalate as an unresolved operational block", () => {
  for (const severity of ["INFO", "WARNING", "UNKNOWN"]) {
    const input = context(); input.alert.severity = severity;
    assert.equal(evaluateOperationalPush(input).eligible, false);
  }
  const closed = context(); closed.alert.resolved_at = at(-1);
  assert.equal(evaluateOperationalPush(closed).eligible, false);
});

test("healthy normal reconciliation and active Watchdog recovery remain silent", () => {
  for (const state of ["HEALTHY", "RECONCILING", "RECOVERING", "STALE", "DEGRADED", "UNKNOWN"]) {
    const input = context(); input.incident!.state_after = state;
    assert.equal(evaluateOperationalPush(input).eligible, false, state);
  }
  for (const result of ["RECOVERING", "RECOVERED", "SUPERSEDED", "UNKNOWN"]) {
    const input = context(); input.incident!.result = result;
    assert.equal(evaluateOperationalPush(input).eligible, false, result);
  }
  const liveLease = context(); liveLease.run!.lease_until = at(1);
  assert.equal(evaluateOperationalPush(liveLease).eligible, false);
  const completedLease = context(); completedLease.run!.lease_until = at(-1);
  assert.equal(evaluateOperationalPush(completedLease).eligible, true);
});

test("a stable block beyond ten minutes cannot be muted forever by a protection-only reconciliation lease", () => {
  assert.equal(OPERATIONAL_PUSH_LEASE_DEFERRAL_MS, 600_000);
  const input = context();
  input.incident!.opened_at = at(-600); input.alert.first_seen_at = at(-600);
  input.run!.lease_until = at(30);
  assert.equal(evaluateOperationalPush(input).eligible, true);
  input.alert.first_seen_at = new Date(NOW - 599_999).toISOString();
  assert.equal(evaluateOperationalPush(input).eligible, false);
});

test("active Watchdog recovery remains silent after ten minutes even with a fresh blocked shard sample", () => {
  for (const change of ["state", "result"]) {
    const input = context();
    input.incident!.opened_at = at(-601); input.alert.first_seen_at = at(-601);
    input.run!.lease_until = at(30);
    if (change === "state") input.incident!.state_after = "RECOVERING";
    else input.incident!.result = "RECOVERING";
    assert.equal(evaluateOperationalPush(input).eligible, false);
  }
});

test("BLOCKED_SAFE escalates once recovery has failed but a resolved incident never does", () => {
  const failed = context(); failed.incident!.result = "BLOCKED_SAFE";
  assert.equal(evaluateOperationalPush(failed).eligible, true);
  failed.incident!.resolved_at = at(-1);
  assert.equal(evaluateOperationalPush(failed).eligible, false);
});

test("missing and stale evidence is unknown, never certified as resolved or eligible", () => {
  for (const key of ["engine", "account", "run", "incident", "check"] as const) {
    const input = context(); input[key] = null;
    assert.equal(evaluateOperationalPush(input).eligible, false, key);
  }
  for (const seconds of [-151, 6]) {
    const input = context(); input.check!.checked_at = at(seconds);
    assert.equal(evaluateOperationalPush(input).eligible, false);
    assert.equal(input.alert.resolved_at, null);
    assert.equal(input.incident!.resolved_at, null);
  }
  const staleIncident = context(); staleIncident.incident!.last_seen_at = at(-151);
  assert.equal(evaluateOperationalPush(staleIncident).eligible, false);
  for (const state of ["HEALTHY", "RECOVERING", "STALE", "OFFLINE", "CAPACITY_LIMIT"]) {
    const input = context(); input.check!.shard_state = state;
    assert.equal(evaluateOperationalPush(input).eligible, false);
  }
});

test("foreign operator account engine run market and shard cannot authorize notification", () => {
  const variants: Array<(input: OperationalPushContext) => void> = [
    input => { input.engine!.id = OTHER_ENGINE; },
    input => { input.engine!.operator_id = "foreign"; },
    input => { input.account!.operator_id = "foreign"; },
    input => { input.account!.id = "foreign"; },
    input => { input.run!.operator_id = "foreign"; },
    input => { input.run!.exchange_account_id = "foreign"; },
    input => { input.run!.trading_engine_id = OTHER_ENGINE; },
    input => { input.run!.symbol = "BTCBRL"; },
    input => { input.alert.details = { run_id: "00000000-0000-4000-8000-000000000009" }; },
    input => { input.incident!.engine_id = OTHER_ENGINE; },
    input => { input.incident!.account_id = "foreign"; },
    input => { input.incident!.market = "BTCBRL"; },
    input => { input.incident!.shard_id = "executor-03"; },
    input => { input.check!.shard_id = "executor-03"; },
    input => { input.incident!.detected_condition = "ANOTHER_CODE"; },
    input => { input.incident!.incident_key = `another-run:${CODE}`; },
    input => { input.engine!.environment = "TESTNET"; },
    input => { input.engine!.status = "INACTIVE"; },
  ];
  for (const change of variants) {
    const input = context(); change(input);
    assert.equal(evaluateOperationalPush(input).eligible, false);
  }
});

test("intentional PAUSED alone never notifies but a real protection block still does", () => {
  const paused = context(); paused.run!.status = "PAUSED";
  paused.incident!.state_after = "HEALTHY"; paused.incident!.result = "RECOVERED";
  assert.equal(evaluateOperationalPush(paused).eligible, false);
  const unprotected = context(); unprotected.run!.status = "PAUSED";
  unprotected.alert.code = "WATCHDOG_TP_MISSING";
  unprotected.alert.alert_key = `WATCHDOG:${RUN}`;
  unprotected.incident!.detected_condition = unprotected.alert.code;
  unprotected.incident!.incident_key = `${RUN}:${unprotected.alert.code}`;
  assert.equal(evaluateOperationalPush(unprotected).eligible, true);
});

test("invalid backward or future evidence timestamps never bypass confirmation", () => {
  const changes: Array<(input: OperationalPushContext) => void> = [
    input => { input.incident!.opened_at = "invalid"; },
    input => { input.incident!.last_seen_at = "invalid"; },
    input => { input.alert.first_seen_at = "invalid"; },
    input => { input.check!.checked_at = "invalid"; },
    input => { input.incident!.opened_at = at(1); },
    input => { input.incident!.last_seen_at = at(6); },
    input => { input.incident!.last_seen_at = at(-181); },
    input => { input.check!.checked_at = at(-181); },
    input => { input.check!.blocked_engines = 0; },
  ];
  for (const change of changes) {
    const input = context(); change(input);
    assert.equal(evaluateOperationalPush(input).eligible, false);
  }
});

test("canonical root selection coalesces primary and derived Watchdog alerts without merging siblings", () => {
  const root = context().alert;
  const watchdog = { ...root, id: "watchdog", alert_key: `WATCHDOG:${RUN}`, first_seen_at: at(-200) };
  const sibling = { ...root, id: "sibling", trading_engine_id: OTHER_ENGINE };
  const result = primaryOperationalAlerts([watchdog, sibling, root, { ...root, id: "warning", severity: "WARNING" }]);
  assert.equal(result.length, 2);
  assert.equal(result.find(row => row.trading_engine_id === ENGINE)?.id, root.id);
  assert.equal(result.find(row => row.trading_engine_id === OTHER_ENGINE)?.id, sibling.id);
});

test("run references and equivalent provider timestamps are validated without string-format assumptions", () => {
  const input = context();
  assert.equal(operationalAlertRunId(input.alert), RUN);
  for (const details of [null, [], {}, { run_id: "../foreign" }, { run_id: 123 }])
    assert.equal(operationalAlertRunId({ ...input.alert, details }), null);
  assert.equal(samePushInstant("2026-10-15T14:24:00.000Z", "2026-10-15T14:24:00+00:00"), true);
  assert.equal(samePushInstant(at(-1), at()), false);
  assert.equal(samePushInstant("invalid", "invalid"), false);
});
