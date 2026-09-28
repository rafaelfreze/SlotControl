import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../../../../supabase/migrations/20260928202508_monthly_goals_are_floor_not_stop.sql", import.meta.url), "utf8");

test("Testnet 25/25 monthly goal cannot veto an otherwise guarded terminal reset", () => {
  assert.match(migration, /create or replace function coinops\.restart_robot_v1_testnet_cycle_v2/);
  assert.doesNotMatch(migration, /COINOPS_TESTNET_ALL_MONTHLY_TARGETS_REACHED/);
  assert.match(migration, /COINOPS_TESTNET_SERVICE_ROLE_REQUIRED/);
  assert.match(migration, /pg_catalog\.pg_advisory_xact_lock/);
  assert.match(migration, /previous_run_id=p_old_run_id and reset_idempotency_key=p_reset_idempotency_key/);
  assert.match(migration, /COINOPS_TESTNET_TERMINAL_FILL_REQUIRED/);
  assert.match(migration, /status in \('PREPARED','NEW','PARTIALLY_FILLED'\)/);
  assert.match(migration, /entry_state in \('OPEN','ARMED'\)/);
  assert.match(migration, /count\(\*\) from coinops\.robot_v1_testnet_slots where run_id=v_old\.id\)<>25/);
  assert.match(migration, /COINOPS_TESTNET_NEXT_PROFILE_INVALID/);
  assert.match(migration, /revoke all on function coinops\.restart_robot_v1_testnet_cycle_v2/);
  assert.match(migration, /to service_role/);
  assert.doesNotMatch(migration, /\b(?:delete|truncate|drop)\b/i);
});
