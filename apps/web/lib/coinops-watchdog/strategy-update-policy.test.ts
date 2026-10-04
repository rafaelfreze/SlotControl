import assert from "node:assert/strict";
import test from "node:test";
import { evaluateFastRun } from "./watchdog-policy.ts";

const now = Date.parse("2026-09-29T11:00:00Z");
const input = () => ({
  run: { id: "run-1", trading_engine_id: "engine-1", exchange_account_id: "account-1",
    status: "ACTIVE", symbol: "SOLBRL", last_reconciled_at: new Date(now - 60_000).toISOString(),
    last_error: null, lease_until: null },
  engine: { id: "engine-1", exchange_account_id: "account-1", symbol: "SOLBRL",
    status: "ACTIVE", kill_switch: false, strategy_config_pending: true, executor_shard_id: "shard-2" },
  account: { id: "account-1", executor_shard_id: "shard-2", status: "ACTIVE", kill_switch: false },
  shardId: "shard-2", slots: Array.from({ length: 25 }, (_, index) => ({
    id: `slot-${index}`, run_id: "run-1", entry_state: "PLANNED", position_quantity: 0,
    updated_at: new Date(now).toISOString() })),
  orders: [], now,
});

test("recent engine-local config update is recovering, not a false missing-BUY incident", () => {
  const finding = evaluateFastRun({ ...input(), configUpdate: {
    status: "APPLYING", updated_at: new Date(now - 60_000).toISOString() } });
  assert.deepEqual(finding, { state: "RECOVERING", code: null, recoverable: false });
});

test("stale config update is recoverable only through the same engine reconciler", () => {
  const finding = evaluateFastRun({ ...input(), configUpdate: {
    status: "APPLYING", updated_at: new Date(now - 11 * 60_000).toISOString() } });
  assert.deepEqual(finding, { state: "STALE", code: "WATCHDOG_CONFIG_UPDATE_STALE", recoverable: true });
});

test("pending gate without matching checkpoint is blocked safe", () => {
  assert.deepEqual(evaluateFastRun(input()), {
    state: "BLOCKED", code: "WATCHDOG_CONFIG_UPDATE_BLOCKED", recoverable: false });
});

test("TP protection still takes priority while config is pending", () => {
  const base = input();
  base.slots[0].position_quantity = 0.1;
  const finding = evaluateFastRun({ ...base, configUpdate: {
    status: "PENDING", updated_at: new Date(now).toISOString() } });
  assert.deepEqual(finding, { state: "DEGRADED", code: "WATCHDOG_TP_MISSING", recoverable: true });
});

test("another shard's config checkpoint cannot turn this engine recovering", () => {
  const base = input();
  base.engine.strategy_config_pending = false;
  const finding = evaluateFastRun({ ...base, configUpdate: {
    status: "APPLYING", updated_at: new Date(now).toISOString() } });
  assert.deepEqual(finding, { state: "HEALTHY", code: null, recoverable: false });
});
