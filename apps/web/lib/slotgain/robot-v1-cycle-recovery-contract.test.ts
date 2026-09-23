import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../execution/robot-v1-testnet-server.ts", import.meta.url), "utf8");
const shadow = readFileSync(new URL("../execution/robot-v1-shadow-server.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../../../supabase/migrations/20260923021500_add_testnet_terminal_cycle_restart.sql", import.meta.url), "utf8");
const repairMigration = readFileSync(new URL("../../../../supabase/migrations/20260923032000_add_shadow_local_reentry_repair_rpc.sql", import.meta.url), "utf8");
const repairStateMigration = readFileSync(new URL("../../../../supabase/migrations/20260923033000_repair_shadow_local_reentry_state.sql", import.meta.url), "utf8");
const serviceRoleFixMigration = readFileSync(new URL("../../../../supabase/migrations/20260923034000_fix_testnet_restart_service_role_claim.sql", import.meta.url), "utf8");
const migrationsDirectory = new URL("../../../../supabase/migrations/", import.meta.url);
function migrationBySuffix(suffix: string) {
  const matches = readdirSync(migrationsDirectory).filter((name) => name.endsWith(suffix));
  assert.equal(matches.length, 1, `one versioned migration expected: ${suffix}`);
  return readFileSync(new URL(matches[0]!, migrationsDirectory), "utf8");
}
const phaseFourMigration = migrationBySuffix("_enable_btc_sol_testnet_profile.sql");
const strategyMigration = migrationBySuffix("_strategy_engine_decision_ledger.sql");

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
  assert.match(server, /planStrategyClosedSlot/);
  assert.match(server, /entry_origin: "REENTRY"/);
  assert.match(server, /target_buy_price: previousEntryPrice/);
  assert.match(server, /operation_sequence: nextSequence/);
  assert.match(server, /amount\(desired\.balance_usdc\) \/ price/);
  assert.match(server, /adapter\.cancelOwnedOrder\(run\.symbol, activeBuy\.exchange_order_id, activeBuy\.client_order_id\)/);
  assert.doesNotMatch(server, /cancelAllOrders/);
  assert.match(server, /BUY_REPLACED_FOR_REENTRY/);
  assert.match(server, /SLOT_REENTRY_PLANNED/);
  assert.match(server, /SLOT_REENTRY_ARMED/);
});

test("Phase 4 Testnet isolates BTC and SOL and freezes the active cycle profile", () => {
  assert.match(phaseFourMigration, /asset in \('BTC', 'SOL'\)/);
  assert.match(phaseFourMigration, /symbol = 'BTCUSDC'/);
  assert.match(phaseFourMigration, /coinops_guard_testnet_cycle_snapshot/);
  assert.match(phaseFourMigration, /restart_robot_v1_testnet_cycle_v2/);
  assert.match(phaseFourMigration, /grant execute on function coinops\.restart_robot_v1_testnet_cycle_v2[^;]+to service_role/);
  assert.match(server, /getSymbolInfo\(run\.symbol\)/);
  assert.match(server, /feeTotals\(trades, run\.asset\)/);
  assert.doesNotMatch(server, /cancelAllOrders/);
});

test("Shadow and Testnet share the local-versus-global transition policy", () => {
  assert.match(shadow, /buildV1LocalReentry/);
  assert.match(shadow, /LOCAL_REENTRY_SAME_PRICE/);
  assert.match(shadow, /buildV1LocalReentry\(closedSlot\.slot_number, Number\(closedSlot\.buy_price\)/);
  for (const runtime of [shadow, server]) {
    assert.match(runtime, /planStrategyClosedSlot/);
    assert.match(runtime, /planStrategyInitialEntry/);
    assert.match(runtime, /planStrategyNextEntry/);
    assert.match(runtime, /planStrategyTakeProfit/);
    assert.match(runtime, /persistStrategyDecision/);
  }
  assert.match(server, /restartTerminalCycle/);
  assert.match(server, /restart_robot_v1_testnet_cycle/);
});

test("Strategy ledger is scoped, versioned, immutable and permits only fictitious environments", () => {
  assert.match(strategyMigration, /environment in \('SHADOW','TESTNET'\)/);
  assert.match(strategyMigration, /unique \(product_id,tenant_id,user_id,environment,decision_id\)/);
  assert.match(strategyMigration, /enable row level security/);
  assert.match(strategyMigration, /force row level security/);
  assert.match(strategyMigration, /private\.coinops_can_access_row\(product_id,tenant_id,user_id\)/);
  assert.match(strategyMigration, /grant insert,update on coinops\.robot_v1_strategy_decisions to service_role/);
  assert.match(strategyMigration, /COINOPS_STRATEGY_DECISION_IMMUTABLE/);
  assert.match(strategyMigration, /r\.product_id=new\.product_id and r\.tenant_id=new\.tenant_id and r\.user_id=new\.user_id and r\.asset=new\.asset/);
  assert.match(strategyMigration, /s\.id=new\.slot_id and s\.run_id=new\.cycle_id/);
  assert.match(strategyMigration, /s\.id=new\.slot_id and s\.cycle_id=new\.cycle_id/);
  assert.match(strategyMigration, /strategy_version text/);
  assert.match(strategyMigration, /STALE_CACHED_RUN_DISCOVERY/);
  assert.match(strategyMigration, /historical_missed_preserved/);
  assert.doesNotMatch(strategyMigration, /\b(?:update|delete\s+from)\s+coinops\.(?:robot_v1_slot_operations|robot_v1_slot_accounts|robot_v1_testnet_fills|robot_v1_testnet_slots|robot_v1_testnet_runs|asset_slots|assets)\b/i);
  assert.doesNotMatch(strategyMigration, /(?:truncate|drop\s+table)\s/i);
});

test("Shadow recovery has a bounded lease and processes resident candle chronology before current-market queue decisions", () => {
  assert.match(shadow, /strategy_lease_owner: leaseOwner, strategy_lease_until: new Date\(started \+ 90_000\)/);
  assert.match(shadow, /strategy_lease_until\.is\.null,strategy_lease_until\.lt/);
  assert.match(shadow, /Date\.now\(\) >= deadline/);
  assert.match(shadow, /strategy_lease_owner: null, strategy_lease_until: null/);
  assert.match(shadow, /wasStrategyOrderResidentAt\(slot\.buy_triggered_at, candle\.openTime\)/);
  const candleLoop = shadow.indexOf("for (const candle of candles)");
  const localClose = shadow.indexOf("settleClosedSlots(supabase, config, cycle, filters, candle.closeTime)", candleLoop);
  const oldQueue = shadow.indexOf("reconcileSingleArmedEntry(supabase, config, cycle, candle.low, candle.closeTime, canArm)", candleLoop);
  const newQueue = shadow.indexOf("reconcileSingleArmedEntry(supabase, config, cycle, candle.close, candle.closeTime, canArm)", localClose);
  const checkpoint = shadow.indexOf("last_candle_open_at: candle.openTime", candleLoop);
  const currentMarketQueue = shadow.indexOf("reconcileSingleArmedEntry(supabase, config, cycle, market.price, market.observedAt, canArm)", candleLoop);
  assert.ok(candleLoop >= 0 && localClose > candleLoop && checkpoint > localClose && currentMarketQueue > checkpoint);
  assert.ok(oldQueue > candleLoop && oldQueue < localClose && newQueue > localClose && newQueue < checkpoint);
  assert.match(shadow, /if \(!terminal && backlogComplete\)/);
  assert.match(shadow, /if \(terminal\) break/);
  assert.match(shadow, /Math\.max\(Date\.parse\(cycle\.started_at\), config\.last_candle_open_at/);
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
