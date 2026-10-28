import assert from "node:assert/strict";
import test from "node:test";

import { mayRecoverReadOutage, verifiedReadRecoveryAlert, assertPermissionReadRecoveryOrders,
  isRegistryStateReadRecovery, isExposureStateReadRecovery, isAccountBudgetAlertRecovery,
  isCapitalAuditReadRecovery, operatorRecoveryAlert, isAuditEventRecovery, isResetAuditReplayRecovery,
  isResetMilestoneReadRecovery, isLedgerTlsReadRecovery,
  assertAuditEventRecoveryEvidence, type AuditRecoveryEvent } from "./live-read-recovery.ts";

test("legacy525 eligibility is exact; permission/schema/unknown reads never inherit it and CAS binds evidence", () => {
  const code = "COINOPS_LIVE_LEDGER_READ_FAILED";
  const details = { root_code: code, stage: "RECONCILE_ORDERS", read_path: "ledger/slots", http_status: 525, read_attempts: 1 };
  const alert = { alert_key: "LIVE_RUN:run-a:CRITICAL", code, first_seen_at: "2026-10-28T20:35:15Z", last_seen_at: "2026-10-28T20:35:15Z", details };
  assert.equal(isLedgerTlsReadRecovery(code, details), true);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code, details), true);
  assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [alert]), alert);
  for (const patch of [{ http_status: 403 }, { http_status: 400 }, { http_status: 526 }, { http_status: undefined },
    { provider_code: "42501" }, { provider_code: "PGRST003" }, { provider_code: "" },
    { read_attempts: 0 }, { read_attempts: 3 }, { read_attempts: undefined },
    { read_path: "ledger/orders" }, { read_path: "order/create" }, { stage: "ARM_ENTRY" }, { root_code: "OTHER" }]) {
    const changed = { ...details, ...patch };
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code, changed), false);
    assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...alert, details: changed }]), /INCIDENT_CHANGED/);
  }
  assert.equal(mayRecoverReadOutage("PAUSED", "OK", code, details), false);
  assert.equal(mayRecoverReadOutage("ACTIVE", "RETRY", code, details), false);
  for (const patch of [{ http_status: 526 }, { provider_code: "42501" }, { read_attempts: 2 }])
    assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...alert, details: { ...details, ...patch } }], alert), /INCIDENT_CHANGED/);
});

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
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code, alert.details), true);
  assert.equal(mayRecoverReadOutage("ACTIVE", "RETRY", code), false);
  assert.equal(mayRecoverReadOutage("PAUSED", "OK", code), false);
  assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [alert]), alert);
  for (const details of [undefined, { stage: "READ_STATE", root_code: code },
    { stage: "LOAD_LEDGER", root_code: "PERMISSION_DENIED" }])
    assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...alert, details }]), /INCIDENT_CHANGED/);
  for (const denied of ["COINOPS_OPERATOR_SCOPE_UNAVAILABLE", "COINOPS_OPERATOR_SCOPE_DENIED", "COINOPS_ENGINE_SCOPE_DENIED"])
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", denied), false);
});

test("registry GET recovery accepts only the audited read call sites, never an outer stage alone", () => {
  const code = "COINOPS_OPERATOR_REGISTRY_UNAVAILABLE";
  const stages = ["LOAD_LEDGER", "RECONCILE_ORDERS", "PROTECT_TP", "ASSERT_NEW_POSITION",
    "ARM_ENTRY", "ATH_TRANSITION", "RESTART_CYCLE", "CONFIG_UPDATE"];
  for (const stage of stages) {
    const alert = { alert_key: "LIVE_RUN:run-a:CRITICAL", code,
      first_seen_at: "2026-10-14T13:52:17Z", last_seen_at: "2026-10-14T13:52:17Z",
      details: { stage, root_code: code } };
    assert.equal(isRegistryStateReadRecovery(code, alert.details), true);
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code, alert.details), true);
    assert.equal(mayRecoverReadOutage("ACTIVE", "RETRY", code, alert.details), false);
    assert.equal(mayRecoverReadOutage("PAUSED", "OK", code, alert.details), false);
    assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [alert]), alert);
    for (const details of [undefined, { stage }, { stage, root_code: "PERMISSION_DENIED" },
      { stage, root_code: "COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN" }]) {
      assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code, details), false);
      assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...alert, details }]), /INCIDENT_CHANGED/);
    }
  }
  for (const stage of ["READ_STATE", "CREDIT_SLOTS", "RECYCLE_SLOTS", "ASSERT_PROTECTION",
    "AUDIT_EVENT", "MONITOR", "POST_ORDER", "ASSERT_PAUSED_PROTECTION", "unknown", ""]) {
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code, { stage, root_code: code }), false);
  }
  for (const denied of ["COINOPS_LIVE_MONITOR_RECONCILIATION_STALE", "COINOPS_LIVE_RECOVERY_INCIDENT_CHANGED",
    "COINOPS_LIVE_ARM_ENTRY_FAILED", "COINOPS_OPERATOR_SCOPE_UNAVAILABLE", "COINOPS_OPERATOR_SCOPE_DENIED"])
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", denied, { stage: "ARM_ENTRY", root_code: code }), false);
});

test("registry recovery rejects a changed read stage/root even if the code and timestamp match", () => {
  const code = "COINOPS_OPERATOR_REGISTRY_UNAVAILABLE";
  const alert = { alert_key: "LIVE_RUN:run-a:CRITICAL", code,
    first_seen_at: "2026-10-14T13:52:17Z", last_seen_at: "2026-10-14T13:52:17Z",
    details: { stage: "ARM_ENTRY", root_code: code } };
  for (const details of [{ stage: "LOAD_LEDGER", root_code: code },
    { stage: "ARM_ENTRY", root_code: "COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN" }])
    assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...alert, details }], alert), /INCIDENT_CHANGED/);
});

test("explicit operator recovery binds the sole current engine/run incident without enabling automatic stale recovery", () => {
  const alert = { alert_key: "LIVE_RUN:run-a:CRITICAL", code: "COINOPS_LIVE_MONITOR_RECONCILIATION_STALE",
    first_seen_at: "2026-10-14T13:52:17Z", last_seen_at: "2026-10-14T18:00:06Z",
    details: { stage: "MONITOR", root_code: "COINOPS_LIVE_MONITOR_RECONCILIATION_STALE", read_path: "registry/trading_engines" } };
  for (const status of ["ACTIVE", "PAUSED"]) {
    assert.deepEqual(operatorRecoveryAlert(status, "run-a", [alert]), alert);
    assert.deepEqual(operatorRecoveryAlert(status, "run-a", [alert], alert), alert);
  }
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", alert.code, alert.details), false);
  assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [alert]), /INCIDENT_CHANGED/);
  for (const status of ["PREPARING", "INACTIVE", "COMPLETED", "BLOCKED_SAFE"])
    assert.throws(() => operatorRecoveryAlert(status, "run-a", [alert]), /INCIDENT_CHANGED/);
  for (const alerts of [[alert, alert], [{ ...alert, alert_key: "LIVE_RUN:run-b:CRITICAL" }],
    [{ ...alert, alert_key: "OTHER_CRITICAL" }], [{ ...alert, code: "EXECUTOR_UNKNOWN" }],
    [{ ...alert, code: "COINOPS unsafe message" }], [{ ...alert, first_seen_at: undefined }],
    [{ ...alert, first_seen_at: "invalid" }], [{ ...alert, last_seen_at: "invalid" }]])
    assert.throws(() => operatorRecoveryAlert("ACTIVE", "run-a", alerts), /INCIDENT_CHANGED/);
});

test("intentional pause without critical remains resumable only while the critical inventory stays empty", () => {
  const alert = { alert_key: "LIVE_RUN:run-a:CRITICAL", code: "COINOPS_LIVE_OPEN_WITHOUT_RESIDENT_TP",
    first_seen_at: "2026-10-14T13:52:17Z", last_seen_at: "2026-10-14T13:52:17Z" };
  assert.equal(operatorRecoveryAlert("PAUSED", "run-a", []), null);
  assert.equal(operatorRecoveryAlert("PAUSED", "run-a", [], null), null);
  assert.throws(() => operatorRecoveryAlert("ACTIVE", "run-a", []), /INCIDENT_CHANGED/);
  assert.throws(() => operatorRecoveryAlert("PAUSED", "run-a", [alert], null), /INCIDENT_CHANGED/);
  assert.throws(() => operatorRecoveryAlert("PAUSED", "run-a", [], alert), /INCIDENT_CHANGED/);
});

test("explicit operator recovery rejects same-code/timestamp changes to any bound diagnostic identity", () => {
  const alert = { alert_key: "LIVE_RUN:run-a:CRITICAL", code: "COINOPS_OPERATOR_REGISTRY_UNAVAILABLE",
    first_seen_at: "2026-10-14T13:52:17Z", last_seen_at: "2026-10-14T13:52:17Z",
    details: { stage: "ARM_ENTRY", root_code: "COINOPS_OPERATOR_REGISTRY_UNAVAILABLE", read_path: "registry/trading_engines" } };
  for (const changed of [{ ...alert, code: "COINOPS_LIVE_TP_FAILED" },
    { ...alert, first_seen_at: "2026-10-14T13:52:18Z" }, { ...alert, last_seen_at: "2026-10-14T13:52:18Z" },
    { ...alert, details: { ...alert.details, stage: "LOAD_LEDGER" } },
    { ...alert, details: { ...alert.details, root_code: "COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN" } },
    { ...alert, details: { ...alert.details, read_path: "POST/order" } }])
    assert.throws(() => operatorRecoveryAlert("ACTIVE", "run-a", [changed], alert), /INCIDENT_CHANGED/);
  assert.throws(() => operatorRecoveryAlert("ACTIVE", "run-a", [alert], null), /INCIDENT_CHANGED/);
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

test("legacy permission wrapper needs exact read-stage/root evidence; never generically allow ARM/CREDIT errors", () => {
  for (const [code, stage] of [["COINOPS_LIVE_ARM_ENTRY_FAILED", "ARM_ENTRY"],
    ["COINOPS_LIVE_CREDIT_SLOTS_FAILED", "CREDIT_SLOTS"]]) {
    const details = { stage, root_code: "EXECUTOR_PRODUCTION_PERMISSION_DENIED" };
    const alert = { alert_key: "LIVE_RUN:run-a:CRITICAL", code, details,
      first_seen_at: "2026-10-11T12:00:00Z", last_seen_at: "2026-10-11T12:00:00Z" };
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code, details), true);
    assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [alert]), alert);
    for (const invalid of [undefined, { stage: "PROTECT_TP", root_code: details.root_code },
      { stage, root_code: "EXECUTOR_BINANCE_RESULT_UNKNOWN" }]) {
      assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code, invalid), false);
      assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...alert, details: invalid }]), /INCIDENT_CHANGED/);
    }
    for (const status of ["PAUSED", "PREPARING", "BLOCKED"])
      assert.equal(mayRecoverReadOutage(status, "OK", code, details), false);
    assert.equal(mayRecoverReadOutage("ACTIVE", "RETRY", code, details), false);
  }
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", "EXECUTOR_PRODUCTION_PERMISSION_DENIED"), false);
});

test("permission read recovery accepts only old settled orders and exact unfilled resident NEXT BUY/TP", () => {
  const incident = { alert_key: "LIVE_RUN:run-a:CRITICAL", code: "COINOPS_LIVE_ARM_ENTRY_FAILED",
    details: { stage: "ARM_ENTRY", root_code: "EXECUTOR_PRODUCTION_PERMISSION_DENIED" },
    first_seen_at: "2026-10-11T12:00:00Z", last_seen_at: "2026-10-11T12:00:00Z" };
  const base = { status: "NEW", side: "BUY", client_order_id: "owned:buy", exchange_order_id: "buy-a",
    created_at: "2026-10-09T12:00:00Z", price: 630, requested_quantity: 1,
    executed_quantity: 0, cumulative_quote: 0, trades_reconciled: false };
  const orders = [base, { ...base, side: "SELL", client_order_id: "owned:tp", exchange_order_id: "tp-a", price: 650 }];
  const observed = orders.map(order => ({ id: order.exchange_order_id, clientOrderId: order.client_order_id,
    side: order.side, status: "NEW", price: order.price, executedQuantity: 0, originalQuantity: 1 }));
  assert.equal(assertPermissionReadRecoveryOrders(incident, orders, observed, "owned:"), "2026-10-11T11:58:30.000Z");
  const skewed = { ...incident, first_seen_at: "2026-10-11 15:07:18.029158+00",
    last_seen_at: "2026-10-11 15:07:18.019+00" };
  assert.equal(assertPermissionReadRecoveryOrders(skewed, orders, observed, "owned:"), "2026-10-11T15:05:48.019Z");
  assert.equal(verifiedReadRecoveryAlert("ACTIVE", "run-a", [skewed], skewed).first_seen_at, skewed.first_seen_at);
  assert.equal(assertPermissionReadRecoveryOrders({ ...incident, last_seen_at: "2026-10-11T11:59:59Z" },
    orders, observed, "owned:"), "2026-10-11T11:58:29.000Z");
  for (const last_seen_at of ["2026-10-11T11:59:58.999Z", "invalid"])
    assert.throws(() => assertPermissionReadRecoveryOrders({ ...incident, last_seen_at }, orders, observed, "owned:"), /RECOVERY_UNPROVEN/);
  // A sibling's resident order must not be considered ours.
  assert.equal(assertPermissionReadRecoveryOrders(incident, orders,
    [...observed, { ...observed[0], id: "sibling", clientOrderId: "other:buy" }], "owned:"), "2026-10-11T11:58:30.000Z");
  for (const change of [{ status: "PREPARED" }, { status: "PARTIALLY_FILLED" }, { status: "UNKNOWN" },
    { status: "SUBMITTING" }, { status: "FAILED" }, { exchange_order_id: null },
    { created_at: "2026-10-11T11:59:00Z" }, { created_at: "invalid" }, { executed_quantity: 0.1 },
    { cumulative_quote: 1 }, { client_order_id: "other:buy" }, { requested_quantity: 0 }])
    assert.throws(() => assertPermissionReadRecoveryOrders(incident, [{ ...base, ...change }, orders[1]], observed, "owned:"), /RECOVERY_UNPROVEN/);
  for (const change of [{ status: "PARTIALLY_FILLED" }, { price: 631 }, { originalQuantity: 2 },
    { originalQuantity: undefined }, { executedQuantity: 0.1 }, { id: "wrong" }])
    assert.throws(() => assertPermissionReadRecoveryOrders(incident, orders, [{ ...observed[0], ...change }, observed[1]], "owned:"), /RECOVERY_UNPROVEN/);
  assert.throws(() => assertPermissionReadRecoveryOrders(incident, [orders[1]], [observed[1]], "owned:"), /RECOVERY_UNPROVEN/);
  assert.throws(() => assertPermissionReadRecoveryOrders({ ...incident, first_seen_at: undefined }, orders, observed, "owned:"), /RECOVERY_UNPROVEN/);
  const terminal = { ...base, status: "FILLED", client_order_id: "owned:old", exchange_order_id: "old-a",
    executed_quantity: 1, cumulative_quote: 630 };
  assert.throws(() => assertPermissionReadRecoveryOrders(incident, [...orders, terminal], observed, "owned:"), /RECOVERY_UNPROVEN/);
  assert.equal(assertPermissionReadRecoveryOrders(incident, [...orders, { ...terminal, trades_reconciled: true }], observed, "owned:"),
    "2026-10-11T11:58:30.000Z");
});

test("exposure outage qualifies only the exact legacy pre-entry read, not a cap or dispatch failure", () => {
  const code = "COINOPS_LIVE_EXPOSURE_UNAVAILABLE";
  const alert = { alert_key: "LIVE_RUN:run-a:CRITICAL", code,
    first_seen_at: "2026-10-14T21:38:35.363658Z", last_seen_at: "2026-10-14T21:38:35.340Z",
    details: { stage: "ARM_ENTRY", root_code: code } };
  assert.equal(isExposureStateReadRecovery(code, alert.details), true);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code, alert.details), true);
  assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [alert], alert), alert);
  for (const details of [undefined, { stage: "ARM_ENTRY" }, { stage: "POST_ORDER", root_code: code },
    { stage: "ARM_ENTRY", root_code: "COINOPS_LIVE_HARD_CAP_EXCEEDED" },
    { stage: "ARM_ENTRY", root_code: "COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN" }]) {
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code, details), false);
    assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...alert, details }]), /INCIDENT_CHANGED/);
  }
  assert.equal(mayRecoverReadOutage("PAUSED", "OK", code, alert.details), false);
  assert.equal(mayRecoverReadOutage("ACTIVE", "RETRY", code, alert.details), false);
  for (const details of [{ ...alert.details, stage: "LOAD_LEDGER" },
    { ...alert.details, read_path: "ledger/exposure_orders" }])
    assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...alert, details }], alert), /INCIDENT_CHANGED/);
});

test("typed exposure and routing outages bind read origin and immutable incident, never permission or POST", () => {
  const base = { alert_key: "LIVE_RUN:run-a:CRITICAL",
    first_seen_at: "2026-10-14T21:38:35Z", last_seen_at: "2026-10-14T21:38:35Z" };
  const cases = [
    ...["runs", "engines", "slots", "orders"].map(part => ({
      code: "COINOPS_LIVE_LEDGER_READ_STALE", root: "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE", path: `ledger/exposure_${part}` })),
    ...["operator", "account", "engine", "shard"].map(part => ({
      code: "COINOPS_LIVE_EXECUTOR_READ_STALE", root: "COINOPS_EXECUTOR_BINDING_READ_UNAVAILABLE", path: `executor_binding/${part}` })),
  ];
  for (const { code, root, path } of cases) {
    const alert = { ...base, code, details: { stage: "RECONCILE_ORDERS", root_code: root, read_path: path } };
    assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [alert], alert), alert);
    for (const read_path of ["POST/order", "executor_binding/unknown", "ledger/exposure_unknown"])
      assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...alert,
        details: { ...alert.details, read_path } }]), /INCIDENT_CHANGED/);
    for (const details of [{ ...alert.details, stage: "PROTECT_TP" },
      { ...alert.details, root_code: "COINOPS_EXECUTOR_BINDING_READ_FAILED" }])
      assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...alert, details }], alert), /INCIDENT_CHANGED/);
  }
  for (const denied of ["COINOPS_EXECUTOR_BINDING_READ_FAILED", "EXECUTOR_ENGINE_SHARD_DENIED",
    "COINOPS_LIVE_EXPOSURE_INCOMPLETE", "COINOPS_ENGINE_HARD_CAP_EXCEEDED", "COINOPS_ACCOUNT_HARD_CAP_EXCEEDED"])
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", denied), false);
});

test("a hard routing/exposure/provider denial cannot recover through a legacy reconciliation wrapper", () => {
  for (const root_code of ["EXECUTOR_ENGINE_SHARD_DENIED", "COINOPS_EXECUTOR_BINDING_READ_FAILED",
    "COINOPS_LIVE_LEDGER_READ_FAILED", "COINOPS_LIVE_EXPOSURE_INCOMPLETE",
    "COINOPS_LIVE_EXPOSURE_INVALID", "COINOPS_LIVE_HARD_CAP_BREACHED"]) {
    const alert = { alert_key: "LIVE_RUN:run-a:CRITICAL", code: "COINOPS_LIVE_RECONCILE_ORDERS_FAILED",
      first_seen_at: "2026-10-14T21:41:04Z", last_seen_at: "2026-10-14T21:41:04Z",
      details: { stage: "RECONCILE_ORDERS", root_code } };
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", alert.code, alert.details), false);
    assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [alert]), /INCIDENT_CHANGED/);
  }
});

test("legacy account-budget metadata failure qualifies only exact code/root and proven old cleanup stage", () => {
  const code = "COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_RESOLVE_FAILED";
  for (const stage of ["ARM_ENTRY", "ASSERT_NEW_POSITION"]) {
    const alert = { alert_key: "LIVE_RUN:run-a:CRITICAL", code,
      first_seen_at: "2026-10-15T08:11:21.129136Z", last_seen_at: "2026-10-15T08:11:21.119Z",
      details: { stage, root_code: code } };
    assert.equal(isAccountBudgetAlertRecovery(code, alert.details), true);
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code, alert.details), true);
    assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [alert], alert), alert);
    for (const state of ["PAUSED", "PREPARING", "BLOCKED"])
      assert.equal(mayRecoverReadOutage(state, "OK", code, alert.details), false);
    assert.equal(mayRecoverReadOutage("ACTIVE", "RETRY", code, alert.details), false);
    for (const details of [undefined, { stage }, { stage: "POST_ORDER", root_code: code },
      { stage, root_code: "COINOPS_ACCOUNT_ORDER_RESERVE_FAILED" },
      { stage, root_code: "COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN" }]) {
      assert.equal(isAccountBudgetAlertRecovery(code, details), false);
      assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...alert, details }]), /INCIDENT_CHANGED/);
    }
  }
});

test("new budget-metadata exhaustion binds exact write/read site without treating a financial POST as retryable", () => {
  const code = "COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_RESOLVE_RETRY";
  const alert = { alert_key: "LIVE_RUN:run-a:CRITICAL", code,
    first_seen_at: "2026-10-15T08:11:21Z", last_seen_at: "2026-10-15T08:11:21Z",
    details: { stage: "RESOLVE_ACCOUNT_BUDGET_ALERT", root_code: code, metadata_path: "alert/account_budget/resolve" } };
  assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [alert], alert), alert);
  for (const details of [{ ...alert.details, metadata_path: "POST/order" },
    { ...alert.details, metadata_path: undefined }, { ...alert.details, stage: "ARM_ENTRY" },
    { ...alert.details, root_code: "COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_WRITE_FAILED" }])
    assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...alert, details }]), /INCIDENT_CHANGED/);
  const changed = { ...alert, details: { ...alert.details, metadata_path: undefined } };
  assert.throws(() => operatorRecoveryAlert("ACTIVE", "run-a", [changed], alert), /INCIDENT_CHANGED/);
  for (const part of ["alert", "decision", "reservation"]) {
    const stale = { ...alert, code: "COINOPS_LIVE_LEDGER_READ_STALE", details: {
      stage: "RESOLVE_ACCOUNT_BUDGET_ALERT", root_code: "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE",
      read_path: `ledger/account_budget_${part}` } };
    assert.equal(isAccountBudgetAlertRecovery(stale.code, stale.details), true);
    assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [stale], stale), stale);
    assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...stale,
      details: { ...stale.details, stage: "POST_ORDER" } }]), /INCIDENT_CHANGED/);
  }
  for (const root_code of ["COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_WRITE_FAILED", "COINOPS_LIVE_LEDGER_READ_FAILED"])
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", "COINOPS_LIVE_RECONCILE_ORDERS_FAILED",
      { stage: "RESOLVE_ACCOUNT_BUDGET_ALERT", root_code }), false);
});

test("capital audit legacy eligibility binds the exact old GET code/root and inherited entry stages", () => {
  const code = "COINOPS_LIVE_CAPITAL_AUDIT_UNAVAILABLE";
  for (const stage of ["ARM_ENTRY", "ASSERT_NEW_POSITION"]) {
    const alert = { alert_key: "LIVE_RUN:run-a:CRITICAL", code,
      first_seen_at: "2026-10-15T14:22:00Z", last_seen_at: "2026-10-15T14:22:00Z",
      details: { stage, root_code: code } };
    assert.equal(isCapitalAuditReadRecovery(code, alert.details), true);
    assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [alert], alert), alert);
    for (const status of ["PAUSED", "PREPARING", "BLOCKED"])
      assert.equal(mayRecoverReadOutage(status, "OK", code, alert.details), false);
    assert.equal(mayRecoverReadOutage("ACTIVE", "RETRY", code, alert.details), false);
    for (const details of [undefined, { stage }, { stage: "POST_ORDER", root_code: code },
      { stage: "CONFIRM_CAPITAL_REFRESH", root_code: code },
      { stage, root_code: "COINOPS_LIVE_EVENT_PERSIST_FAILED" },
      { stage, root_code: "COINOPS_LIVE_LEDGER_READ_FAILED" }]) {
      assert.equal(isCapitalAuditReadRecovery(code, details), false);
      assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...alert, details }]), /INCIDENT_CHANGED/);
    }
  }
});

test("new capital audit exhaustion requires its exact GET path and stage; hard reads remain blocked", () => {
  const alert = { alert_key: "LIVE_RUN:run-a:CRITICAL", code: "COINOPS_LIVE_LEDGER_READ_STALE",
    first_seen_at: "2026-10-15T14:22:00Z", last_seen_at: "2026-10-15T14:22:00Z",
    details: { stage: "CONFIRM_CAPITAL_REFRESH", root_code: "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE",
      read_path: "ledger/capital_refresh_events" } };
  assert.equal(isCapitalAuditReadRecovery(alert.code, alert.details), true);
  assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [alert], alert), alert);
  for (const details of [{ ...alert.details, stage: "ARM_ENTRY" },
    { ...alert.details, stage: "POST_ORDER" }, { ...alert.details, read_path: "POST/order" },
    { ...alert.details, root_code: "COINOPS_LIVE_LEDGER_READ_FAILED" }])
    assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...alert, details }]), /INCIDENT_CHANGED/);
  assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [{ ...alert,
    details: { ...alert.details, read_path: "ledger/orders" } }], alert), /INCIDENT_CHANGED/);
  for (const code of ["COINOPS_LIVE_LEDGER_READ_FAILED", "COINOPS_LIVE_CAPITAL_AUDIT_INCOMPLETE",
    "COINOPS_LIVE_EVENT_PERSIST_FAILED"])
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code, { ...alert.details, root_code: code }), false);
});

const auditCode = "COINOPS_LIVE_EVENT_PERSIST_FAILED";
const auditDetails = { stage: "AUDIT_EVENT", root_code: auditCode };
const typedAuditDetails = { ...auditDetails, audit_phase: "WRITE", audit_reason: "TRANSIENT_EXHAUSTED",
  audit_event_type: "RECONCILED", audit_event_key: "RECONCILED:2026-10-21T13:28",
  audit_attempts: 2, audit_http_status: 503, audit_provider_code: null };

test("reset replay mismatch eligibility is limited to its exact typed historical milestone site", () => {
  const details = { ...auditDetails, audit_phase: "READBACK", audit_reason: "READBACK_MISMATCH",
    audit_event_type: "RESET_RECOVERED", audit_event_key: "RESET_RECOVERED:64b267d0-3897-4783-a07e-69c427472f81",
    audit_attempts: 1, audit_http_status: null, audit_provider_code: null };
  for (const audit_attempts of [1, 2]) {
    assert.equal(isResetAuditReplayRecovery(auditCode, { ...details, audit_attempts }), true);
    assert.equal(isAuditEventRecovery(auditCode, { ...details, audit_attempts }), true);
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", auditCode, { ...details, audit_attempts }), true);
  }
  for (const change of [{ stage: "ARM_ENTRY" }, { root_code: "OTHER" }, { audit_phase: "WRITE" },
    { audit_reason: "HARD_PROVIDER" }, { audit_reason: "UNKNOWN" }, { audit_event_type: "RECONCILED" },
    { audit_event_type: "GAIN_CREDITED" }, { audit_event_key: "RESET_RECOVERED:invalid" },
    { audit_event_key: "RECONCILED:2026-10-22T10:00" }, { audit_attempts: 0 }, { audit_attempts: 3 },
    { audit_attempts: "1" }, { audit_http_status: 200 }, { audit_http_status: 503 },
    { audit_http_status: undefined }, { audit_provider_code: "42501" }, { audit_provider_code: "PGRST003" },
    { audit_provider_code: undefined }]) {
    assert.equal(isResetAuditReplayRecovery(auditCode, { ...details, ...change }), false, JSON.stringify(change));
    assert.equal(isAuditEventRecovery(auditCode, { ...details, ...change }), false, JSON.stringify(change));
  }
  assert.equal(isResetAuditReplayRecovery("COINOPS_LIVE_RECONCILE_ORDERS_FAILED", details), false);
  assert.equal(mayRecoverReadOutage("PAUSED", "OK", auditCode, details), false);
  assert.equal(mayRecoverReadOutage("ACTIVE", "RETRY", auditCode, details), false);
});

test("a milestone GET outage cannot inherit generic stale recovery at another stage or root", () => {
  const code = "COINOPS_LIVE_LEDGER_READ_STALE";
  const details = { stage: "AUDIT_EVENT", root_code: "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE",
    read_path: "ledger/reset_recovery_milestone" };
  assert.equal(isResetMilestoneReadRecovery(code, details), true);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code, details), true);
  for (const change of [{ stage: "ARM_ENTRY" }, { stage: "POST_ORDER" },
    { root_code: "COINOPS_LIVE_LEDGER_READ_FAILED" }, { root_code: "UNKNOWN" }])
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code, { ...details, ...change }), false);
  assert.equal(isResetMilestoneReadRecovery("COINOPS_LIVE_RECONCILE_ORDERS_FAILED", details), false);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", "COINOPS_LIVE_RECONCILE_ORDERS_FAILED", details), false);
});

test("audit eligibility is the exact final metadata site, never a gain, order or unidentified provider retry", () => {
  for (const details of [auditDetails, typedAuditDetails, { ...typedAuditDetails,
    audit_phase: "READBACK", audit_reason: "READBACK_UNAVAILABLE", audit_http_status: null }]) {
    assert.equal(isAuditEventRecovery(auditCode, details), true);
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", auditCode, details), true);
    assert.equal(mayRecoverReadOutage("ACTIVE", "RETRY", auditCode, details), false);
    assert.equal(mayRecoverReadOutage("PAUSED", "OK", auditCode, details), false);
  }
  for (const details of [undefined, {}, { ...auditDetails, stage: "ARM_ENTRY" },
    { ...auditDetails, stage: "CREDIT_SLOTS" }, { ...auditDetails, stage: "POST_ORDER" },
    { ...auditDetails, root_code: "COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN" },
    { ...auditDetails, http_status: 403 }, { ...auditDetails, provider_code: "42501" },
    { ...typedAuditDetails, audit_reason: "HARD_PROVIDER" },
    { ...typedAuditDetails, audit_reason: "READBACK_MISMATCH" },
    { ...typedAuditDetails, audit_reason: "PAYLOAD_INVALID" },
    { ...typedAuditDetails, audit_reason: "UNKNOWN" }, { ...typedAuditDetails, audit_phase: "POST_ORDER" },
    { ...typedAuditDetails, audit_phase: "WRITE", audit_reason: "READBACK_UNAVAILABLE" },
    { ...typedAuditDetails, audit_event_type: "GAIN_CREDITED" },
    { ...typedAuditDetails, audit_event_type: "BUY_SUBMITTED" },
    { ...typedAuditDetails, audit_event_key: undefined }, { ...typedAuditDetails, audit_event_key: "POST/order" },
    { ...typedAuditDetails, audit_attempts: 0 }, { ...typedAuditDetails, audit_attempts: 3 },
    { ...typedAuditDetails, audit_http_status: 403 }, { ...typedAuditDetails, audit_http_status: "503" },
    { ...typedAuditDetails, audit_provider_code: "42501" },
    { ...typedAuditDetails, audit_provider_code: "42P01" },
    { ...typedAuditDetails, audit_provider_code: "PGRST204" },
    { ...typedAuditDetails, audit_provider_code: "UNKNOWN" }]) {
    assert.equal(isAuditEventRecovery(auditCode, details), false, JSON.stringify(details));
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", auditCode, details), false);
  }
  for (const code of ["COINOPS_LIVE_RECONCILE_ORDERS_FAILED", "COINOPS_LIVE_READ_STATE_FAILED",
    "COINOPS_LIVE_EXECUTOR_READ_STALE", "COINOPS_LIVE_MONITOR_EXECUTOR_UNHEALTHY"])
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code, typedAuditDetails), false,
      "an outer read wrapper must not broaden audit eligibility");
});

test("audit recovery binds every typed metadata field to the same sole incident CAS", () => {
  const alert = { alert_key: "LIVE_RUN:run-a:CRITICAL", code: auditCode,
    first_seen_at: "2026-10-21T13:28:00Z", last_seen_at: "2026-10-21T13:28:00Z", details: typedAuditDetails };
  assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "run-a", [alert], alert), alert);
  for (const [key, value] of Object.entries({ audit_phase: "READBACK", audit_reason: "READBACK_UNAVAILABLE",
    audit_event_type: "RESET_RECOVERED", audit_attempts: 1, audit_http_status: null, audit_provider_code: "PGRST002",
    audit_event_key: "RECONCILED:2026-10-21T13:29" })) {
    const changed = { ...alert, details: { ...alert.details, [key]: value } };
    assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [changed], alert), /INCIDENT_CHANGED/);
    assert.throws(() => operatorRecoveryAlert("ACTIVE", "run-a", [changed], alert), /INCIDENT_CHANGED/);
  }
  assert.throws(() => verifiedReadRecoveryAlert("ACTIVE", "run-a", [alert, alert]), /INCIDENT_CHANGED/);
});

test("audit recovery requires fresh later exact-engine RECONCILED proof, never historical repair or another engine", () => {
  const now = Date.parse("2026-10-21T13:40:30Z");
  const incident = { alert_key: "LIVE_RUN:run-a:CRITICAL", code: auditCode,
    first_seen_at: "2026-10-21T13:28:00Z", last_seen_at: "2026-10-21T13:28:00Z", details: auditDetails };
  const run = { id: "run-a", product_id: "product", tenant_id: "tenant", user_id: "user", operator_id: "operator",
    exchange_account_id: "account-a", trading_engine_id: "engine-a", quote_asset: "USDT",
    last_reconciled_at: "2026-10-21T13:40:21Z", strategy_version: "fixture-v1" };
  const event: AuditRecoveryEvent = { ...run, run_id: run.id, event_key: "RECONCILED:2026-10-21T13:40",
    event_type: "RECONCILED", slot_number: null, observed_at: "2026-10-21T13:40:20Z",
    details: { next: "KILL_SWITCH", strategy_version: "fixture-v1" } };
  assert.deepEqual(assertAuditEventRecoveryEvidence(incident, run, event, now), event);
  for (const change of [{ run_id: "run-b" }, { product_id: "other" }, { tenant_id: "other" },
    { user_id: "other" }, { operator_id: "other" }, { exchange_account_id: "account-b" },
    { trading_engine_id: "engine-b" }, { quote_asset: "BRL" }, { event_type: "GAIN_CREDITED" },
    { slot_number: 1 }, { observed_at: incident.last_seen_at },
    { observed_at: "2026-10-21T13:28:01Z" }, { observed_at: "2026-10-21T13:40:22Z" },
    { observed_at: "2026-10-21T13:41:00Z" }, { observed_at: "invalid" },
    { event_key: "RECONCILED:2026-10-21T13:28" }, { event_key: "RECONCILED:2026-10-21T13:41" },
    { details: { next: "NEXT_BUY_ARMED", strategy_version: "fixture-v1" } },
    { details: { next: "KILL_SWITCH", strategy_version: "foreign-version" } }])
    assert.throws(() => assertAuditEventRecoveryEvidence(incident, run, { ...event, ...change }, now), /AUDIT_RECOVERY_UNPROVEN/);
  assert.throws(() => assertAuditEventRecoveryEvidence(incident, run, null, now), /AUDIT_RECOVERY_UNPROVEN/);
  for (const last_reconciled_at of [null, "invalid", "2026-10-21T13:40:19Z", "2026-10-21T13:40:31Z"])
    assert.throws(() => assertAuditEventRecoveryEvidence(incident, { ...run, last_reconciled_at }, event, now), /AUDIT_RECOVERY_UNPROVEN/);
  assert.throws(() => assertAuditEventRecoveryEvidence(incident, run, event, now + 151_000), /AUDIT_RECOVERY_UNPROVEN/);
  for (const first_seen_at of [undefined, "invalid", "2026-10-21T13:28:02Z"])
    assert.throws(() => assertAuditEventRecoveryEvidence({ ...incident, first_seen_at }, run, event, now), /AUDIT_RECOVERY_UNPROVEN/);
});
