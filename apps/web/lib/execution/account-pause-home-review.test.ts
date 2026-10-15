import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { accountPauseProtection, type AccountPauseLedger } from "./account-pause-home-policy.ts";
import { assertDomainRegistry, isIdentity, type DomainRegistry } from "./operator-context.ts";
import { completeLedgerRead } from "./complete-ledger-read.ts";
import { liveEngineOrderPrefix } from "./robot-v1-live-cycle.ts";

const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
const scope = { product_id: uuid(1), tenant_id: uuid(2), user_id: uuid(3) };
const operatorId = uuid(4), accountId = uuid(5), engineId = uuid(6), runId = uuid(7);
const source = readFileSync(new URL("./account-pause-home-server.ts", import.meta.url), "utf8");

function fixture(options: { truncatedTable?: string; duplicateSlots?: boolean; partialCriticalAlert?: boolean;
  unknownAlertCount?: boolean; foreignEngine?: boolean; manyOrders?: boolean } = {}) {
  const at = new Date().toISOString();
  const owner = { operator_id: operatorId, exchange_account_id: accountId, trading_engine_id: engineId };
  const registry: DomainRegistry = { operator: { ...scope, id: operatorId, status: "ACTIVE", kill_switch: false },
    accounts: [{ id: accountId, operator_id: operatorId, display_name: "Renato", status: "ACTIVE",
      is_legacy_default: false, kill_switch: false, executor_shard_id: "executor-02" }],
    engines: [{ id: engineId, ...owner, environment: "REAL", symbol: "SOLBRL", base_asset: "SOL",
      quote_asset: "BRL", status: "ACTIVE", hard_cap_quote: 275, kill_switch: true,
      legacy_compatible: false, executor_shard_id: "executor-02" }] };
  const prefix = liveEngineOrderPrefix({ ...owner, base_asset: "SOL", legacy_compatible: false });
  const rows: Record<string, Array<Record<string, unknown>>> = {
    robot_v1_live_runs: [{ ...scope, ...owner, id: runId, status: "PAUSED", last_error: null, last_reconciled_at: at }],
    robot_v1_live_slots: Array.from({ length: 25 }, (_, index) => ({ ...scope, ...owner, id: uuid(100 + index),
      run_id: runId, slot_number: index + 1, entry_state: index ? "PLANNED" : "OPEN",
      position_quantity: index ? 0 : .112, position_committed_quote: index ? 0 : 63.97196396 })),
    robot_v1_live_slot_accounts: Array.from({ length: 25 }, (_, index) => ({ ...scope, ...owner,
      slot_number: index + 1, balance_quote: 11 })),
    robot_v1_live_orders: [{ ...scope, ...owner, id: uuid(200), run_id: runId, slot_id: uuid(100),
      side: "SELL", purpose: "TP", status: "NEW", client_order_id: `${prefix}1-S-test`, exchange_order_id: "tp-real",
      requested_quantity: .112, executed_quantity: 0, trades_reconciled: true }],
    robot_v1_live_preparations: [{ ...scope, ...owner, id: uuid(201), symbol: "SOLBRL", kill_switch: true, live_enabled: true }],
    robot_v1_live_alerts: [{ ...scope, ...owner, id: uuid(202), resolved_at: null,
      code: "COINOPS_LIVE_QUOTE_BALANCE_INSUFFICIENT", severity: "WARNING" }],
    account_home_preferences: [{ operator_id: operatorId, exchange_account_id: accountId, hidden: true, updated_at: at }],
    robot_v1_live_events: [{ ...scope, ...owner, run_id: runId, observed_at: at, event_type: "RECONCILED",
      details: { protection_verified: true, resident_buy_count: 0, quantity_step: .001, open_positions: 1 } }],
  };
  if (options.partialCriticalAlert) rows.robot_v1_live_alerts.push({ ...scope, ...owner, id: uuid(203),
    resolved_at: null, code: "COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN", severity: "CRITICAL" });
  if (options.manyOrders) for (let index = 0; index < 502; index++) rows.robot_v1_live_orders.push({
    ...scope, ...owner, id: uuid(300 + index), run_id: runId, slot_id: uuid(100), side: "BUY", purpose: "ENTRY",
    status: "CANCELED", client_order_id: `${prefix}1-B-${index}`, exchange_order_id: `buy-old-${index}`,
    requested_quantity: .112, executed_quantity: 0, trades_reconciled: true });
  if (options.duplicateSlots) rows.robot_v1_live_slots[24].id = rows.robot_v1_live_slots[0].id;
  const calls: Array<{ table: string; columns: string; filters: Record<string, unknown>; page: number[] }> = [];
  const captured: AccountPauseLedger[] = [];
  const db = { from(table: string) {
    const filters: Record<string, unknown> = {};
    let columns = "", page = [0, 499], countExact = false;
    const response = () => {
      calls.push({ table, columns, filters: { ...filters }, page: [...page] });
      const values = (rows[table] ?? []).filter((row) => Object.entries(filters).every(([key, value]) =>
        Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
      let returned = values.slice(page[0], page[1] + 1);
      if (options.truncatedTable === table || options.partialCriticalAlert && table === "robot_v1_live_alerts")
        returned = returned.slice(0, Math.max(0, returned.length - 1));
      const projected = returned.map((row) => Object.fromEntries(columns.split(",").map((key) => [key, row[key]])));
      if (options.foreignEngine && table === "robot_v1_live_slots" && projected.length)
        projected[0].exchange_account_id = uuid(999);
      return { data: projected, error: null, count: countExact && !(options.unknownAlertCount && table === "robot_v1_live_alerts") ? values.length : null };
    };
    const chain = {
      select(value: string, settings?: { count?: string }) {
        columns = value; countExact = settings?.count === "exact";
        if (table === "robot_v1_live_slot_accounts") assert.ok(!columns.split(",").includes("id"),
          "Production slot_accounts has a composite identity, not an id column");
        if (table === "robot_v1_live_orders") assert.ok(!columns.split(",").includes("symbol"));
        return chain;
      },
      eq(key: string, value: unknown) { filters[key] = value; return chain; },
      in(key: string, value: unknown[]) { filters[key] = value; return chain; },
      is(key: string, value: unknown) { filters[key] = value; return chain; },
      order() { return chain; }, range(start: number, end: number) { page = [start, end]; return chain; },
      limit(limit: number) { page = [0, limit - 1]; return chain; },
      abortSignal(signal: AbortSignal) { assert.ok(signal instanceof AbortSignal); return chain; },
      maybeSingle() { const result = response(); return Promise.resolve({ ...result, data: result.data[0] ?? null }); },
      then(resolve: (value: unknown) => unknown) { return Promise.resolve(response()).then(resolve); },
    };
    return chain;
  } };
  const dependencies: Record<string, unknown> = { "server-only": {},
    "./operator-context": { assertDomainRegistry, isIdentity }, "./complete-ledger-read": { completeLedgerRead },
    "./account-pause-home-policy": { accountPauseProtection: (input: AccountPauseLedger) => {
      captured.push(input); return accountPauseProtection(input);
    } } };
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText;
  const compiledModule = { exports: {} as { loadAccountPauseHome: (db: unknown, registry: DomainRegistry,
    accountId: string) => Promise<{ canHide: boolean; hidden: boolean;
      engines: Array<{ engineId: string; runId: string | null; runStatus: string | null; entryEnabled: boolean }> }> } };
  new Function("require", "module", "exports", compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name];
  }, compiledModule, compiledModule.exports);
  return { db, registry, rows, calls, captured, load: () => compiledModule.exports.loadAccountPauseHome(db, registry, accountId) };
}

test("pause Home reads complete exact owner scope and composite slot identity without remote writes", async () => {
  const f = fixture(); const result = await f.load();
  assert.equal(result.canHide, true); assert.equal(result.hidden, true);
  assert.equal(result.engines[0].entryEnabled, false, "a protected PAUSED run is never entry-enabled");
  for (const call of f.calls) {
    assert.equal(call.filters.operator_id, operatorId); assert.equal(call.filters.exchange_account_id, accountId);
    if (call.table !== "account_home_preferences") for (const [key, value] of Object.entries(scope))
      assert.equal(call.filters[key], value);
  }
  assert.doesNotMatch(source, /\.rpc\(|\.update\(|\.insert\(|\.upsert\(|\.delete\(|readLiveExecutorState|pauseLiveRun|resumeLiveRun/);
});

function enableEntries(f: ReturnType<typeof fixture>) {
  f.registry.engines[0].kill_switch = false;
  f.registry.engines[0].strategy_config_pending = false;
  f.rows.robot_v1_live_runs[0].status = "ACTIVE";
  f.rows.robot_v1_live_preparations[0].kill_switch = false;
}

test("resume readback certifies entryEnabled only from exact ACTIVE fresh run and all real BUY gates open", async () => {
  const f = fixture(); enableEntries(f);
  assert.equal((await f.load()).engines[0].entryEnabled, true);
  assert.equal(f.rows.robot_v1_live_alerts[0].severity, "WARNING", "balance warning is not a manufactured critical block");
  for (const mutate of [
    (input: typeof f) => { input.registry.engines[0].kill_switch = true; },
    (input: typeof f) => { input.registry.engines[0].strategy_config_pending = true; },
    (input: typeof f) => { delete input.registry.engines[0].strategy_config_pending; },
    (input: typeof f) => { input.registry.accounts[0].kill_switch = true; },
    (input: typeof f) => { input.registry.operator.kill_switch = true; },
    (input: typeof f) => { input.rows.robot_v1_live_runs[0].last_error = "COINOPS_LIVE_BLOCKED"; },
    (input: typeof f) => { input.rows.robot_v1_live_runs[0].last_reconciled_at = new Date(Date.now() - 180_001).toISOString(); },
    (input: typeof f) => { input.rows.robot_v1_live_runs[0].last_reconciled_at = new Date(Date.now() + 30_000).toISOString(); },
    (input: typeof f) => { input.rows.robot_v1_live_runs[0].last_reconciled_at = "invalid"; },
    (input: typeof f) => { input.rows.robot_v1_live_runs[0].status = "PAUSED"; },
    (input: typeof f) => { input.rows.robot_v1_live_runs[0].status = "PREPARING"; },
    (input: typeof f) => { input.rows.robot_v1_live_runs = []; },
    (input: typeof f) => { input.rows.robot_v1_live_runs.push({ ...input.rows.robot_v1_live_runs[0], id: uuid(900) }); },
    (input: typeof f) => { input.rows.robot_v1_live_preparations[0].kill_switch = true; },
    (input: typeof f) => { input.rows.robot_v1_live_preparations[0].live_enabled = false; },
    (input: typeof f) => { input.rows.robot_v1_live_preparations[0].symbol = "BTCBRL"; },
    (input: typeof f) => { input.rows.robot_v1_live_preparations = []; },
    (input: typeof f) => { input.rows.robot_v1_live_preparations.push({ ...input.rows.robot_v1_live_preparations[0], id: uuid(901) }); },
    (input: typeof f) => { input.rows.robot_v1_live_alerts[0].severity = "CRITICAL"; },
  ]) {
    const changed = fixture(); enableEntries(changed); mutate(changed);
    assert.equal((await changed.load()).engines[0].entryEnabled, false);
  }
});

test("closed-gate ACTIVE sibling remains false without disabling a healthy same-symbol cross-shard sibling", async () => {
  const f = fixture(); enableEntries(f);
  const siblingId = uuid(901);
  f.registry.engines.push({ ...f.registry.engines[0], id: siblingId, kill_switch: true, executor_shard_id: "executor-03" });
  f.rows.robot_v1_live_runs.push({ ...f.rows.robot_v1_live_runs[0], id: uuid(902), trading_engine_id: siblingId });
  f.rows.robot_v1_live_preparations.push({ ...f.rows.robot_v1_live_preparations[0], id: uuid(903), trading_engine_id: siblingId });
  const result = await f.load();
  assert.deepEqual(result.engines.map((engine) => [engine.engineId, engine.entryEnabled]), [[engineId, true], [siblingId, false]]);
});

test("pause Home complete pagination retains more than 500 orders", async () => {
  const f = fixture({ manyOrders: true }); assert.equal((await f.load()).canHide, true);
  assert.equal(f.captured[0].orders.length, 503);
  assert.deepEqual(f.calls.filter((call) => call.table === "robot_v1_live_orders").map((call) => call.page), [[0, 499], [500, 999]]);
});

test("pause Home cannot certify partial slots/orders or duplicate physical identities", async () => {
  for (const truncatedTable of ["robot_v1_live_slots", "robot_v1_live_orders", "robot_v1_live_slot_accounts"])
    await assert.rejects(fixture({ truncatedTable }).load(), /COINOPS_ACCOUNT_PAUSE_READ_UNAVAILABLE/);
  await assert.rejects(fixture({ duplicateSlots: true }).load(), /COINOPS_ACCOUNT_PAUSE_READ_UNAVAILABLE/);
  assert.equal((await fixture({ foreignEngine: true }).load()).canHide, false);
});

test("pause Home must not ignore a CRITICAL alert beyond a truncated successful response", async () => {
  await assert.rejects(fixture({ partialCriticalAlert: true }).load(), /COINOPS_ACCOUNT_PAUSE_READ_UNAVAILABLE/);
});

test("pause Home unknown alert count cannot establish complete absence of critical faults", async () => {
  await assert.rejects(fixture({ unknownAlertCount: true }).load(), /COINOPS_ACCOUNT_PAUSE_READ_UNAVAILABLE/);
});

test("backend pause policy rejects stale/different-owner/critical/TP-missing data without affecting other engines", async () => {
  const f = fixture(); await f.load(); const base = f.captured[0];
  const now = Date.now(); assert.equal(accountPauseProtection(base, now), true);
  for (const mutate of [
    (input: AccountPauseLedger) => { input.runs[0].last_error = "COINOPS_LIVE_ENGINE_FAILED"; },
    (input: AccountPauseLedger) => { input.runs[0].last_reconciled_at = new Date(now - 190_000).toISOString(); },
    (input: AccountPauseLedger) => { input.preparations[0].live_enabled = false; },
    (input: AccountPauseLedger) => { input.slots[0].operator_id = uuid(999); },
    (input: AccountPauseLedger) => { input.accounts.pop(); },
    (input: AccountPauseLedger) => { input.orders = []; },
    (input: AccountPauseLedger) => { input.orders[0].purpose = "ENTRY"; },
    (input: AccountPauseLedger) => { input.orders.push({ ...input.orders[0], slot_id: input.slots[1].id }); },
    (input: AccountPauseLedger) => { input.alerts[0].severity = "CRITICAL"; },
    (input: AccountPauseLedger) => { input.proofs[0].details = { protection_verified: true, resident_buy_count: 0, open_positions: 1 }; },
  ]) { const input = structuredClone(base); mutate(input); assert.equal(accountPauseProtection(input, now), false); }
});

test("sub-step dust fails closed in account Home while executable protection uses the official quantity step", async () => {
  const f = fixture(); await f.load(); const input = structuredClone(f.captured[0]);
  input.slots[0].position_quantity = .0001;
  input.proofs[0].details = { protection_verified: true, resident_buy_count: 0, quantity_step: .001, open_positions: 0 };
  assert.equal(accountPauseProtection(input), false, "Strict display policy never hides a dust/proof disagreement");
});

test("exactly one uncovered LOT_SIZE quantum is not dust and must prevent hiding", async () => {
  const f = fixture(); await f.load(); const input = structuredClone(f.captured[0]);
  input.orders[0].requested_quantity = .111;
  assert.equal(accountPauseProtection(input), false, "0.112 position minus 0.111 TP leaves executable 0.001 uncovered");
});

test("SQL preference RPC is service-only invoker with administrator scope, inventory, immutable audit and idempotency", () => {
  const sql = readFileSync(new URL("../../../../supabase/migrations/20261013145823_add_account_pause_home_preferences.sql", import.meta.url), "utf8");
  assert.match(sql, /security invoker set search_path=''/i);
  assert.match(sql, /o\.user_id=p_user_id[\s\S]*a\.id=p_account_id/);
  assert.match(sql, /p_expected_engine_ids/); assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /unique\(operator_id,request_id\)/); assert.match(sql, /COINOPS_ACCOUNT_PAUSE_REQUEST_COLLISION/);
  assert.match(sql, /grant select,insert on coinops\.account_home_preference_events to service_role/);
  assert.match(sql, /revoke all on function coinops\.set_account_home_preference[\s\S]*from public,anon,authenticated/);
  assert.doesNotMatch(sql, /(?:update|insert into|delete from)\s+coinops\.(?:robot_v1_live_orders|robot_v1_live_slots|robot_v1_live_runs|trading_engines|robot_v1_live_slot_accounts)/i);
});
