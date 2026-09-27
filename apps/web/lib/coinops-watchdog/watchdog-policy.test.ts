import test from "node:test";
import assert from "node:assert/strict";
import { evaluateFastRun, type FastRun, type FastSlot, type FastOrder, type FastAlert } from "./watchdog-policy.ts";

const now = Date.parse("2026-09-26T23:00:00Z");
const run: FastRun = { id: "run-a", trading_engine_id: "engine-a",
  exchange_account_id: "account-a", status: "ACTIVE", symbol: "SOLBRL",
  last_reconciled_at: new Date(now - 60_000).toISOString(), last_error: null, lease_until: null };
const engine = { id: "engine-a", exchange_account_id: "account-a", symbol: "SOLBRL",
  status: "ACTIVE", kill_switch: false };
const account = { id: "account-a", executor_shard_id: "executor-02",
  status: "ACTIVE", kill_switch: false };
const slots: FastSlot[] = Array.from({ length: 25 }, (_, index) => ({
  id: `slot-${index}`, run_id: run.id, entry_state: index === 0 ? "OPEN" : "PLANNED",
  position_quantity: index === 0 ? 0.017 : 0,
  updated_at: new Date(now - 60_000).toISOString(),
}));
const orders: FastOrder[] = [
  { run_id: run.id, slot_id: "slot-0", side: "SELL", status: "NEW", exchange_order_id: "tp-a" },
  { run_id: run.id, slot_id: "slot-1", side: "BUY", status: "NEW", exchange_order_id: "buy-a" },
];
function check(overrides: Partial<Parameters<typeof evaluateFastRun>[0]> = {}) {
  return evaluateFastRun({ run, engine, account, shardId: "executor-02", slots, orders, now,
    ...overrides });
}

test("healthy engine is screened without exchange writes", () => {
  assert.deepEqual(check(), { state: "HEALTHY", code: null, recoverable: false });
});
test("missing resident TP becomes an engine-local recovery candidate", () => {
  assert.equal(check({ orders: orders.slice(1) }).code, "WATCHDOG_TP_MISSING");
  assert.equal(check({ orders: orders.slice(1) }).recoverable, true);
});
test("duplicate BUY and TP never authorize blind recovery", () => {
  const duplicateBuy = { ...orders[1], slot_id: "slot-2", exchange_order_id: "buy-b" };
  assert.deepEqual(check({ orders: [...orders, duplicateBuy] }), {
    state: "BLOCKED", code: "WATCHDOG_DUPLICATE_BUY", recoverable: false });
  const duplicateTp = { ...orders[0], exchange_order_id: "tp-b" };
  assert.equal(check({ orders: [...orders, duplicateTp] }).recoverable, false);
});
test("stale reconciliation is recoverable; unknown errors and gates are not", () => {
  assert.equal(check({ run: { ...run, last_reconciled_at: new Date(now - 6 * 60_000).toISOString() } }).code,
    "WATCHDOG_RECONCILIATION_STALE");
  assert.equal(check({ run: { ...run, last_error: "EXECUTOR_WRITE_OUTCOME_UNKNOWN" } }).recoverable, false);
  assert.equal(check({ engine: { ...engine, kill_switch: true } }).recoverable, false);
});
test("account or shard mismatch cannot target another engine's credential", () => {
  assert.deepEqual(check({ shardId: "executor-01" }), {
    state: "BLOCKED", code: "WATCHDOG_OWNERSHIP_MISMATCH", recoverable: false });
  assert.equal(check({ account: { ...account, id: "account-b" } }).recoverable, false);
});
test("active lease is left to its current owner", () => {
  assert.deepEqual(check({ run: { ...run, lease_until: new Date(now + 60_000).toISOString() } }),
    { state: "RECOVERING", code: null, recoverable: false });
});

const monitorAlert: FastAlert = { trading_engine_id: run.trading_engine_id,
  exchange_account_id: run.exchange_account_id, alert_key: `LIVE_RUN:${run.id}:CRITICAL`,
  severity: "CRITICAL", code: "COINOPS_LIVE_MONITOR_EXECUTOR_UNHEALTHY", details: { run_id: run.id } };

test("monitor incident retains its real cause instead of generic local gate", () => {
  assert.deepEqual(check({ engine: { ...engine, kill_switch: true }, alerts: [monitorAlert] }), {
    state: "BLOCKED", code: monitorAlert.code, recoverable: false });
});

test("fresh reconciliation cannot mark an unresolved critical incident healthy", () => {
  assert.deepEqual(check({ alerts: [monitorAlert] }), {
    state: "BLOCKED", code: monitorAlert.code, recoverable: false });
  assert.equal(check({ alerts: [{ ...monitorAlert, code: "unsafe private error text" }] }).code,
    "WATCHDOG_CRITICAL_ALERT_OPEN");
  assert.equal(check({ alerts: [] }).state, "HEALTHY");
});

test("critical causes remain account, engine and cycle scoped; watchdog does not self-latch", () => {
  for (const unrelated of [
    { ...monitorAlert, exchange_account_id: "account-b" },
    { ...monitorAlert, trading_engine_id: "engine-b" },
    { ...monitorAlert, alert_key: "LIVE_RUN:run-b:CRITICAL" },
    { ...monitorAlert, details: { run_id: "run-b" } },
    { ...monitorAlert, alert_key: `WATCHDOG:${run.id}` },
    { ...monitorAlert, severity: "WARNING" },
  ]) assert.equal(check({ alerts: [unrelated] }).state, "HEALTHY");
  assert.equal(check({ alerts: [{ ...monitorAlert, alert_key: "ENGINE_CRITICAL", details: {} }] }).state,
    "BLOCKED");
});
test("one and five failed engines have exactly local blast radius in synthetic multi-shard inventory", () => {
  const inventory = Array.from({ length: 10 }, (_, index) => {
    const id = `engine-${index}`;
    const accountId = `account-${Math.floor(index / 2)}`;
    const shardId = index < 6 ? "executor-01" : "executor-02";
    return { run: { ...run, id: `run-${index}`, trading_engine_id: id,
      exchange_account_id: accountId }, engine: { ...engine, id, exchange_account_id: accountId },
      account: { ...account, id: accountId, executor_shard_id: shardId }, shardId,
      slots: slots.map((slot) => ({ ...slot, run_id: `run-${index}` })),
      orders: orders.map((order) => ({ ...order, run_id: `run-${index}` })), now };
  });
  for (const failedCount of [1, 5]) {
    const findings = inventory.map((item, index) => evaluateFastRun({ ...item,
      engine: { ...item.engine, kill_switch: index < failedCount } }));
    assert.equal(findings.filter((item) => item.state === "BLOCKED").length, failedCount);
    assert.equal(findings.filter((item) => item.state === "HEALTHY").length, 10 - failedCount);
    assert.equal(findings.filter((item, index) => index >= 6 && item.state !== "HEALTHY").length, 0);
  }
});
test("a failed credential/account blocks only engines owned by that account", () => {
  const own = check({ account: { ...account, kill_switch: true } });
  const sibling = check({ run: { ...run, id: "run-b", trading_engine_id: "engine-b",
    exchange_account_id: "account-b" },
  engine: { ...engine, id: "engine-b", exchange_account_id: "account-b" },
  account: { ...account, id: "account-b" } });
  assert.equal(own.state, "BLOCKED");
  assert.equal(sibling.state, "HEALTHY");
});
