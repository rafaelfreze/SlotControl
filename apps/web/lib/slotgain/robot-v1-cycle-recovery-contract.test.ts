import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../execution/robot-v1-testnet-server.ts", import.meta.url), "utf8");
const shadow = readFileSync(new URL("../execution/robot-v1-shadow-server.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../../../supabase/migrations/20260923021500_add_testnet_terminal_cycle_restart.sql", import.meta.url), "utf8");

test("Testnet terminal reset is atomic, locked, idempotent and copies compounded physical balances", () => {
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /reset_idempotency_key = p_reset_idempotency_key/);
  assert.match(migration, /side = 'SELL' and purpose = 'TP' and status = 'FILLED'/);
  assert.match(migration, /status in \('PREPARED', 'NEW', 'PARTIALLY_FILLED'\)/);
  assert.match(migration, /s\.balance_usdc, 0, 0/);
  assert.match(migration, /grant execute on function coinops\.restart_robot_v1_testnet_cycle[^;]+to service_role/);
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
