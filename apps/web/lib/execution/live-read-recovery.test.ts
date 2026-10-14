import assert from "node:assert/strict";
import test from "node:test";

import { mayRecoverReadOutage, verifiedReadRecoveryAlert, assertPermissionReadRecoveryOrders,
  isRegistryStateReadRecovery, isExposureStateReadRecovery, operatorRecoveryAlert } from "./live-read-recovery.ts";

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
