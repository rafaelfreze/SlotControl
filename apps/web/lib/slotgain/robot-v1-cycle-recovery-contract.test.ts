import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../execution/robot-v1-testnet-server.ts", import.meta.url), "utf8");
const shadow = readFileSync(new URL("../execution/robot-v1-shadow-server.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../../../supabase/migrations/20260923021500_add_testnet_terminal_cycle_restart.sql", import.meta.url), "utf8");
const repairMigration = readFileSync(new URL("../../../../supabase/migrations/20260923032000_add_shadow_local_reentry_repair_rpc.sql", import.meta.url), "utf8");
const repairStateMigration = readFileSync(new URL("../../../../supabase/migrations/20260923033000_repair_shadow_local_reentry_state.sql", import.meta.url), "utf8");
const serviceRoleFixMigration = readFileSync(new URL("../../../../supabase/migrations/20260923034000_fix_testnet_restart_service_role_claim.sql", import.meta.url), "utf8");

test("Testnet terminal reset is atomic, locked, idempotent and copies compounded physical balances", () => {
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /reset_idempotency_key = p_reset_idempotency_key/);
  assert.match(migration, /side = 'SELL' and purpose = 'TP' and status = 'FILLED'/);
  assert.match(migration, /status in \('PREPARED', 'NEW', 'PARTIALLY_FILLED'\)/);
  assert.match(migration, /s\.balance_usdc, 0, 0/);
  assert.match(migration, /grant execute on function coinops\.restart_robot_v1_testnet_cycle[^;]+to service_role/);
  assert.match(migration, /auth\.jwt\(\) ->> 'role'/);
  assert.match(serviceRoleFixMigration, /auth\.jwt\(\) ->> 'role'/);
  assert.match(serviceRoleFixMigration, /grant execute on function coinops\.restart_robot_v1_testnet_cycle[^;]+to service_role/);
});

test("Testnet local recycle preserves the physical slot, same entry, compounding and one owned BUY", () => {
  assert.match(server, /planV1ClosedSlotTransition/);
  assert.match(server, /entry_origin: "REENTRY"/);
  assert.match(server, /target_buy_price: previousEntryPrice/);
  assert.match(server, /operation_sequence: nextSequence/);
  assert.match(server, /amount\(desired\.balance_usdc\) \/ price/);
  assert.match(server, /adapter\.cancelOwnedOrder\(SYMBOL, activeBuy\.exchange_order_id, activeBuy\.client_order_id\)/);
  assert.doesNotMatch(server, /cancelAllOrders/);
  assert.match(server, /BUY_REPLACED_FOR_REENTRY/);
  assert.match(server, /SLOT_REENTRY_PLANNED/);
  assert.match(server, /SLOT_REENTRY_ARMED/);
});

test("Shadow and Testnet share the local-versus-global transition policy", () => {
  assert.match(shadow, /buildV1LocalReentry/);
  assert.match(shadow, /LOCAL_REENTRY_SAME_PRICE/);
  assert.match(shadow, /Object\.assign\(closedSlot,[\s\S]+entry_state: "PLANNED", status: "PENDING"/);
  assert.match(server, /planV1ClosedSlotTransition/);
  assert.match(server, /restartTerminalCycle/);
  assert.match(server, /restart_robot_v1_testnet_cycle/);
});

test("Production remains structurally outside every write path", () => {
  assert.doesNotMatch(server, /BINANCE_API_KEY|BINANCE_API_SECRET|BinanceSpotAdapter\.fromEnvironment/);
  assert.doesNotMatch(migration, /exchange_connections|exchange_order_intents|BINANCE_SPOT(?!_TESTNET)/);
});

test("Shadow repair is atomic, service-role-only and preserves credited gain ownership", () => {
  assert.match(repairMigration, /pg_advisory_xact_lock/);
  assert.match(repairMigration, /v_account\.last_operation_id is distinct from v_operation\.id/);
  assert.match(repairMigration, /v_account\.balance_usdc <> v_account\.initial_balance_usdc \+ v_account\.net_profit_usdc/);
  assert.match(repairMigration, /logical_level=v_operation\.logical_level/);
  assert.match(repairMigration, /buy_price=v_operation\.entry_price/);
  assert.match(repairMigration, /entry_state='ARMED'/);
  assert.match(repairMigration, /SHADOW_STATE_REPAIRED/);
  assert.match(repairMigration, /grant execute on function coinops\.repair_robot_v1_shadow_local_reentry[^;]+to service_role/);
  assert.doesNotMatch(repairMigration, /insert into coinops\.robot_v1_slot_profit_credits|update coinops\.robot_v1_slot_accounts/);
});

test("observed Shadow repair locates one exact operational signature without generated IDs", () => {
  assert.match(repairStateMigration, /if v_count > 1 then raise exception 'COINOPS_SHADOW_REPAIR_AMBIGUOUS'/);
  assert.match(repairStateMigration, /if v_count = 0 then return/);
  assert.match(repairStateMigration, /o\.entry_price=117\.90 and o\.take_profit_price=118\.48/);
  assert.match(repairStateMigration, /a\.balance_usdc=10\.0986 and a\.gain_count=2/);
  assert.match(repairStateMigration, /repair_robot_v1_shadow_local_reentry/);
  assert.doesNotMatch(repairStateMigration, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});
