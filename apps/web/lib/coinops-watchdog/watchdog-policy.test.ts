import test from "node:test";
import assert from "node:assert/strict";
import { evaluateFastRun, type FastRun, type FastSlot, type FastOrder, type FastAlert } from "./watchdog-policy.ts";
import { liveEngineOrderPrefix } from "../execution/robot-v1-live-cycle.ts";

const now = Date.parse("2026-09-26T23:00:00Z");
const run: FastRun = { id: "run-a", trading_engine_id: "engine-a",
  exchange_account_id: "account-a", status: "ACTIVE", symbol: "SOLBRL",
  last_reconciled_at: new Date(now - 60_000).toISOString(), last_error: null, lease_until: null };
const engine = { id: "engine-a", exchange_account_id: "account-a", symbol: "SOLBRL",
  status: "ACTIVE", kill_switch: false, executor_shard_id: "executor-02" };
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

test("same-account SOLBRL on executor03 is unaffected by sibling failure on executor02", () => {
  const runB = { ...run, id: "run-b", trading_engine_id: "engine-b" };
  const engineB = { ...engine, id: "engine-b", executor_shard_id: "executor-03" };
  const ownSlots = slots.map((slot) => ({ ...slot, id: `b-${slot.id}`, run_id: runB.id }));
  const ownOrders = orders.map((order) => ({ ...order, slot_id: `b-${order.slot_id}`, run_id: runB.id }));
  const incidentA: FastAlert = { trading_engine_id: run.trading_engine_id, exchange_account_id: account.id,
    alert_key: `LIVE_RUN:${run.id}:CRITICAL`, severity: "CRITICAL", code: "COINOPS_LIVE_ENGINE_FAILED" };
  assert.equal(check({ engine: { ...engine, kill_switch: true } }).state, "BLOCKED");
  const inputB = { run: runB, engine: engineB, account, shardId: "executor-03", slots: ownSlots,
    orders: ownOrders, alerts: [incidentA], now };
  assert.equal(evaluateFastRun(inputB).state, "HEALTHY");
  assert.equal(evaluateFastRun({ ...inputB, shardId: "executor-02" }).code, "WATCHDOG_OWNERSHIP_MISMATCH");
  assert.equal(evaluateFastRun({ ...inputB, orders }).code, "WATCHDOG_OWNERSHIP_MISMATCH");
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
    { state: "RECONCILING", code: null, recoverable: false });
  assert.deepEqual(check({ run: { ...run, last_reconciled_at: null,
    lease_until: new Date(now + 60_000).toISOString() } }),
  { state: "RECONCILING", code: null, recoverable: false });
});

test("first empty activation waits at most 90s for normal cron, never grants grace to an OPEN position", () => {
  const starting = { ...run, last_reconciled_at: null, created_at: new Date(now-30_000).toISOString() };
  const empty = slots.map(slot=>({...slot,position_quantity:0}));
  assert.equal(check({run:starting,slots:empty,orders:[]}).state,"RECONCILING");
  assert.equal(check({run:{...starting,created_at:new Date(now-86_400_000).toISOString(),
    activated_at:new Date(now-30_000).toISOString()},slots:empty,orders:[]}).state,"RECONCILING");
  assert.equal(check({run:{...starting,created_at:new Date(now-90_000).toISOString()},slots:empty,orders:[]}).code,"WATCHDOG_RECONCILIATION_STALE");
  assert.equal(check({run:starting,orders:[]}).state,"STALE");
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
      exchange_account_id: accountId }, engine: { ...engine, id, exchange_account_id: accountId, executor_shard_id: shardId },
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
  account: { ...account, id: "account-b" },
  slots: slots.map((slot) => ({ ...slot, run_id: "run-b" })),
  orders: orders.map((order) => ({ ...order, run_id: "run-b" })) });
  assert.equal(own.state, "BLOCKED");
  assert.equal(sibling.state, "HEALTHY");
});

function pausedInput(): Parameters<typeof evaluateFastRun>[0] {
  const operatorId = "operator-a";
  const pausedRun = { ...run, operator_id: operatorId, status: "PAUSED" };
  const pausedEngine = { ...engine, operator_id: operatorId, kill_switch: true,
    environment: "REAL", base_asset: "SOL", legacy_compatible: false };
  const owned = { operator_id: operatorId, trading_engine_id: pausedRun.trading_engine_id,
    exchange_account_id: pausedRun.exchange_account_id };
  const prefix = liveEngineOrderPrefix({ ...pausedEngine, trading_engine_id: pausedEngine.id });
  return { run: pausedRun, engine: pausedEngine, account: { ...account, operator_id: operatorId },
    shardId: "executor-02", now,
    preparation: { ...owned, symbol: pausedRun.symbol, live_enabled: true, kill_switch: true },
    slots: slots.map((slot, index) => ({ ...slot, ...owned, slot_number: index + 1 })),
    orders: [{ ...orders[0], ...owned, id: "order-a", client_order_id: `${prefix}1-S-test`,
      executed_quantity: 0, trades_reconciled: true }] };
}

test("intentional pause is healthy protection, counted separately from operating engines", () => {
  assert.deepEqual(evaluateFastRun(pausedInput()), {
    state: "HEALTHY", code: null, recoverable: false, intentionalPause: true });
  assert.equal(check().intentionalPause, undefined);
});

test("active gate failures cannot masquerade as intentional pause", () => {
  const input = pausedInput();
  assert.equal(evaluateFastRun({ ...input, run: { ...input.run, status: "ACTIVE" } }).state, "BLOCKED");
  for (const changed of [
    { ...input, engine: { ...input.engine!, kill_switch: false } },
    { ...input, engine: { ...input.engine!, status: "PAUSED" } },
    { ...input, account: { ...input.account!, kill_switch: true } },
    { ...input, account: { ...input.account!, status: "INACTIVE" } },
    { ...input, preparation: null },
    { ...input, preparation: { ...input.preparation!, live_enabled: false } },
    { ...input, preparation: { ...input.preparation!, kill_switch: false } },
  ]) assert.deepEqual(evaluateFastRun(changed), {
    state: "BLOCKED", code: "WATCHDOG_LOCAL_GATE_CLOSED", recoverable: false });
});

test("intentional pause must retain exact operator/account/engine/shard and REAL ownership", () => {
  const input = pausedInput();
  for (const changed of [
    { ...input, preparation: { ...input.preparation!, trading_engine_id: "engine-b" } },
    { ...input, preparation: { ...input.preparation!, exchange_account_id: "account-b" } },
    { ...input, preparation: { ...input.preparation!, operator_id: "operator-b" } },
    { ...input, preparation: { ...input.preparation!, symbol: "SOLUSDT" } },
    { ...input, engine: { ...input.engine!, operator_id: "operator-b" } },
    { ...input, account: { ...input.account!, operator_id: "operator-b" } },
    { ...input, engine: { ...input.engine!, environment: "TESTNET" } },
    { ...input, shardId: "executor-03" },
    { ...input, slots: input.slots.map((slot, index) => index ? slot : { ...slot, trading_engine_id: "engine-b" }) },
    { ...input, orders: [{ ...input.orders[0], exchange_account_id: "account-b" }] },
    { ...input, orders: [{ ...input.orders[0], client_order_id: "C2-sibling-engine-TP" }] },
  ]) assert.equal(evaluateFastRun(changed).code, "WATCHDOG_OWNERSHIP_MISMATCH");
});

test("intentional pause cannot conceal duplicate, missing, invalid physical slots or order IDs", () => {
  const input = pausedInput();
  for (const changed of [
    { ...input, slots: input.slots.slice(1) },
    { ...input, slots: input.slots.map((slot, index) => index ? slot : { ...slot, slot_number: 2 }) },
    { ...input, slots: input.slots.map((slot, index) => index ? slot : { ...slot, slot_number: 26 }) },
    { ...input, slots: input.slots.map((slot, index) => index ? slot : { ...slot, id: input.slots[1].id }) },
    { ...input, slots: input.slots.map((slot, index) => index ? slot : { ...slot, position_quantity: "NaN" }) },
  ]) assert.equal(evaluateFastRun(changed).code, "WATCHDOG_SLOT_COUNT_INVALID");
  assert.equal(evaluateFastRun({ ...input, orders: [...input.orders, input.orders[0]] }).code,
    "WATCHDOG_OWNERSHIP_MISMATCH");
});

test("PAUSED with a resident, prepared or ambiguous BUY is BLOCKED and never hidden healthy", () => {
  const input = pausedInput();
  for (const status of ["NEW", "PARTIALLY_FILLED", "PREPARED", "UNKNOWN", "SUBMITTING", "PENDING_CANCEL"]) {
    const finding = evaluateFastRun({ ...input, orders: [input.orders[0], { ...input.orders[0],
      id: "buy-a", side: "BUY", status, slot_id: input.slots[1].id }] });
    assert.deepEqual(finding, { state: "BLOCKED", code: "WATCHDOG_PAUSE_BUY_UNRESOLVED", recoverable: false });
  }
});

test("PAUSED permits a proven terminal reconciled BUY but rejects pending fills", () => {
  const input = pausedInput();
  const terminal = { ...input.orders[0], id: "buy-a", side: "BUY", status: "FILLED", executed_quantity: "0.017" };
  assert.equal(evaluateFastRun({ ...input, orders: [...input.orders, terminal] }).intentionalPause, true);
  for (const trades_reconciled of [false, undefined]) {
    assert.deepEqual(evaluateFastRun({ ...input, orders: [...input.orders, { ...terminal, trades_reconciled }] }),
      { state: "BLOCKED", code: "WATCHDOG_FILL_UNRECONCILED", recoverable: false });
  }
  assert.equal(evaluateFastRun({ ...input, orders: [{ ...input.orders[0], status: "UNKNOWN" }] }).code,
    "WATCHDOG_ORDER_OUTCOME_UNKNOWN");
});

test("critical alerts and last_error always override protected pause", () => {
  const input = pausedInput();
  assert.equal(evaluateFastRun({ ...input, alerts: [monitorAlert] }).code, monitorAlert.code);
  assert.equal(evaluateFastRun({ ...input, run: { ...input.run, last_error: "COINOPS_LIVE_ENGINE_FAILED" } }).code,
    "COINOPS_LIVE_ENGINE_FAILED");
  const warning = { ...monitorAlert, severity: "WARNING", code: "COINOPS_LIVE_QUOTE_BALANCE_INSUFFICIENT" };
  assert.equal(evaluateFastRun({ ...input, alerts: [warning] }).intentionalPause, true);
});

test("paused protection still exposes stale reconciliation, missing TP and duplicate TP", () => {
  const input = pausedInput();
  const stale = evaluateFastRun({ ...input, run: { ...input.run,
    last_reconciled_at: new Date(now - 6 * 60_000).toISOString() } });
  assert.deepEqual(stale, { state: "STALE", code: "WATCHDOG_RECONCILIATION_STALE", recoverable: true });
  assert.equal(evaluateFastRun({ ...input, run: { ...input.run,
    last_reconciled_at: new Date(now + 60_000).toISOString() } }).state, "STALE");
  assert.deepEqual(evaluateFastRun({ ...input, orders: [] }), {
    state: "DEGRADED", code: "WATCHDOG_TP_MISSING", recoverable: true });
  assert.deepEqual(evaluateFastRun({ ...input, orders: [...input.orders, { ...input.orders[0],
    id: "order-b", client_order_id: `${input.orders[0].client_order_id}-b`, exchange_order_id: "tp-b" }] }), {
    state: "DEGRADED", code: "WATCHDOG_DUPLICATE_TP", recoverable: false });
});

test("pause reconciliation lease is left to its owner and an empty pause receives no activation grace", () => {
  const input = pausedInput();
  assert.deepEqual(evaluateFastRun({ ...input, run: { ...input.run,
    lease_until: new Date(now + 60_000).toISOString() } }), {
    state: "RECONCILING", code: null, recoverable: false });
  assert.equal(evaluateFastRun({ ...input, run: { ...input.run, last_reconciled_at: null,
    created_at: new Date(now - 30_000).toISOString() },
  slots: input.slots.map((slot) => ({ ...slot, position_quantity: 0 })), orders: [] }).state, "STALE");
});

test("same-account same-symbol active sibling on another shard remains unaffected by pause", () => {
  const a = pausedInput();
  const b = { ...a, run: { ...a.run, id: "run-b", trading_engine_id: "engine-b", status: "ACTIVE" },
    engine: { ...a.engine!, id: "engine-b", executor_shard_id: "executor-03", kill_switch: false },
    shardId: "executor-03", preparation: null,
    slots: a.slots.map((slot) => ({ ...slot, id: `b-${slot.id}`, run_id: "run-b", trading_engine_id: "engine-b" })),
    orders: a.orders.map((order) => ({ ...order, run_id: "run-b", slot_id: `b-${order.slot_id}`, trading_engine_id: "engine-b" })) };
  assert.equal(evaluateFastRun(a).intentionalPause, true);
  assert.deepEqual(evaluateFastRun(b), { state: "HEALTHY", code: null, recoverable: false });
});
