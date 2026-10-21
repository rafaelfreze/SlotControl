import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as slotTopology from "./engine-slot-topology.ts";
import ts from "typescript";
import { completeLedgerRead } from "./complete-ledger-read.ts";
import { readLiveExposure } from "./live-exposure-read.ts";
import { resolveAccountBudgetAlert, AccountBudgetAlertResolutionError } from "./live-account-budget-alert.ts";
import { boundedLedgerRead, observeLedgerRows, observeLedgerRecord, assertPhysicalLedger } from "./live-ledger-read.ts";
import * as readErrors from "./live-read-error.ts";
import { isConfirmedFilledSnapshotRace } from "./live-order-snapshot-race.ts";
import { assertStrategyBuyPrice, assertStrategyTakeProfitPrice } from "./strategy-price-invariant.ts";
import * as liveAudit from "./live-audit-event.ts";

type Row = Record<string, any>;
type Write = { table: string; values: Row; filters: Row; affected: number };
type Options = { busy?: boolean; inactive?: boolean; staleLookup?: boolean; staleRun?: boolean;
  lastError?: string; existingCritical?: boolean; missingTp?: boolean; filledDuringSnapshot?: boolean;
  leaseLost?: boolean; leaseExpired?: boolean; registryTimeout?: boolean; alertReadDenied?: boolean;
  expireDuringAlertRead?: boolean; gatesOpen?: boolean };

/** No environment or remote client is loaded. The real audit orchestrator,
 * ledger checks and fill-race classifier run against an in-memory database
 * and a deterministic GET-only exchange fixture. Every financial RPC fails. */
function fixture(options: Options = {}) {
  const calls: string[] = [], writes: Write[] = [], reads: Array<{ table: string; filters: Row }> = [];
  const scope = { product_id: "product", tenant_id: "tenant", user_id: "user", operator_id: "operator",
    exchange_account_id: "account-a", trading_engine_id: "engine-a", symbol: "SOLUSDT", quote_asset: "USDT" };
  const oldTimestamp = "2026-01-01T00:00:00.000Z";
  const run: Row = { ...scope, id: "run-a", asset: "SOL", status: options.inactive ? "COMPLETED" : "ACTIVE",
    strategy_version: "fixture", last_error: options.lastError ?? null,
    last_reconciled_at: options.staleRun ? oldTimestamp : new Date(Date.now() - 1000).toISOString(),
    lease_owner: null, lease_until: null, gain_rate: .1, entry_spacing: .03, entry_regime: "NORMAL" };
  const engine: Row = { ...scope, id: "engine-a", environment: "REAL", base_asset: "SOL", status: "ACTIVE",
    engine_kill_switch: !options.gatesOpen, kill_switch: !options.gatesOpen,
    global_kill_switch: false, account_kill_switch: false,
    strategy_config_pending: false, hard_cap_quote: 275, executor_shard_id: "executor-03" };
  const preparation: Row = { ...scope, asset: "SOL", id: "prep-a", live_enabled: true,
    kill_switch: !options.gatesOpen, max_total_exposure_brl: 275 };
  const slots: Row[] = Array.from({ length: 25 }, (_, index) => ({ ...scope, run_id: run.id,
    id: `slot-${index + 1}`, slot_number: index + 1, operation_sequence: 1,
    entry_state: index === 0 ? "OPEN" : "PLANNED", entry_origin: "GRID",
    position_quantity: index === 0 ? 1 : 0, position_committed_brl: index === 0 ? 10 : 0,
    target_buy_price: 10, entry_reference_price: 10, missed_at: null }));
  const accounts: Row[] = slots.map(slot => ({ ...scope, asset: "SOL", slot_number: slot.slot_number,
    balance_brl: 11, contribution_brl: 11, market_pnl_brl: 0, manual_gain_brl: 0,
    fees_brl: 0, dust_cost_brl: 0, gain_count: 0 }));
  const orders: Row[] = [{ ...scope, id: "buy-a", run_id: run.id, slot_id: slots[0].id,
    slot_number: 1, operation_sequence: 1, side: "BUY", purpose: "INITIAL", status: "FILLED",
    client_order_id: "owned:buy", exchange_order_id: "exchange-buy", executed_quantity: 1,
    cumulative_quote: 10, requested_quantity: 1, price: 10, reserved_notional_brl: 0,
    trades_reconciled: true, submission_guarded_at: oldTimestamp }];
  if (!options.missingTp) orders.push({ ...orders[0], id: "tp-a", purpose: "TP", side: "SELL", status: "NEW",
    client_order_id: "owned:tp", exchange_order_id: "exchange-tp", executed_quantity: 0,
    cumulative_quote: 0, price: 11, trades_reconciled: false });
  const originalIncident: Row = { ...scope, id: "incident-a", severity: "CRITICAL", resolved_at: null,
    alert_key: `LIVE_RUN:${run.id}:CRITICAL`, code: "COINOPS_OPERATOR_REGISTRY_UNAVAILABLE",
    first_seen_at: "2026-10-14T13:52:17.000Z", last_seen_at: "2026-10-14T13:52:17.000Z",
    details: { run_id: run.id, stage: "LOAD_LEDGER", root_code: "COINOPS_OPERATOR_REGISTRY_UNAVAILABLE" } };
  const alerts: Row[] = options.existingCritical ? [structuredClone(originalIncident)] : [];
  // Same account, same symbol, another executor: mutations must never reach it.
  const siblingEngine: Row = { ...engine, id: "engine-b", trading_engine_id: "engine-b",
    engine_kill_switch: false, kill_switch: false, executor_shard_id: "executor-02" };
  const siblingRun: Row = { ...run, id: "run-b", trading_engine_id: "engine-b", last_error: null };
  const siblingSlots = slots.map(slot => ({ ...slot, id: `sibling-${slot.id}`, run_id: "run-b",
    trading_engine_id: "engine-b", position_committed_brl: 0, position_quantity: 0, entry_state: "PLANNED" }));
  const siblingBefore = JSON.stringify([siblingEngine, siblingRun]);
  const matches = (row: Row, filters: Row) => Object.entries(filters).every(([key, value]) => {
    if (key.startsWith("in:")) return (value as unknown[]).includes(row[key.slice(3)]);
    if (key.startsWith("gt:")) return Date.parse(row[key.slice(3)]) > Date.parse(String(value));
    if (key === "or") return !row.lease_until || Date.parse(row.lease_until) < Date.now();
    return row[key] === value;
  });
  const service = { from(table: string) {
    const filters: Row = {}; let values: Row | null = null, upsert = false, page: [number, number] | null = null;
    let exactCount = false;
    const response = (singular = false) => {
      let rows: Row[];
      if (table === "robot_v1_live_runs") rows = [run, siblingRun];
      else if (table === "trading_engines") rows = [engine, siblingEngine];
      else if (table === "robot_v1_live_preparations") rows = [preparation];
      else if (table === "robot_v1_live_slots") rows = [...slots, ...siblingSlots];
      else if (table === "robot_v1_live_slot_accounts") rows = accounts;
      else if (table === "robot_v1_live_orders") rows = orders;
      else if (table === "robot_v1_live_alerts") rows = alerts;
      else if (table === "robot_v1_live_events") rows = [];
      else if (table === "operators") rows = [{ ...scope, status: "ACTIVE" }];
      else if (table === "account_quote_caps") rows = [{ ...scope, hard_cap_quote: 1000 }];
      else assert.fail(`Unexpected table ${table}`);
      rows = rows!.filter(row => matches(row, filters));
      if (!values) reads.push({ table, filters: structuredClone(filters) });
      if (table === "robot_v1_live_runs" && values?.lease_owner) {
        calls.push("claim");
        if (options.busy) rows = [];
      }
      if (table === "robot_v1_live_alerts" && !values && options.alertReadDenied)
        return { data: null, error: { code: "42501" } };
      if (table === "robot_v1_live_alerts" && !values && options.expireDuringAlertRead)
        run.lease_until = oldTimestamp;
      if (values) {
        writes.push({ table, values: structuredClone(values), filters: structuredClone(filters), affected: rows.length });
        if (upsert) rows = [values];
        else rows.forEach(row => Object.assign(row, values));
      }
      const count = rows.length;
      if (page) rows = rows.slice(page[0], page[1] + 1);
      let data = singular ? rows[0] ? structuredClone(rows[0]) : null : structuredClone(rows);
      if (!values && table === "robot_v1_live_runs" && filters.id === "run-a" && options.staleLookup)
        data = { ...data, last_error: "COINOPS_OLD_SNAPSHOT_ERROR", last_reconciled_at: oldTimestamp };
      return { data, error: null, ...(exactCount ? { count } : {}) };
    };
    const query = { select: (_columns?: string, options?: { count?: string }) => {
      exactCount = options?.count === "exact"; return query;
    }, order: () => query, abortSignal: () => query,
      eq: (key: string, value: unknown) => { filters[key] = value; return query; },
      is: (key: string, value: unknown) => { filters[key] = value; return query; },
      in: (key: string, value: unknown[]) => { filters[`in:${key}`] = value; return query; },
      gt: (key: string, value: unknown) => { filters[`gt:${key}`] = value; return query; },
      or: (value: string) => { filters.or = value; return query; },
      range: (start: number, end: number) => { page = [start, end]; return query; },
      update: (data: Row) => { values = data; return query; },
      upsert: (data: Row) => { values = data; upsert = true; return query; },
      single: async () => response(true), maybeSingle: async () => response(true),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(response()).then(resolve) };
    return query;
  }, rpc: () => assert.fail("A monitor must not call a financial RPC") };
  const observedTp = { symbol: "SOLUSDT", side: "SELL" as const, orderId: "exchange-tp", id: "exchange-tp",
    clientOrderId: "owned:tp", status: "NEW", price: 11, originalQuantity: 1, executedQuantity: 0 };
  const dependencies: Record<string, unknown> = {
    "./live-audit-event": liveAudit,
    "./engine-slot-topology": slotTopology,
    "./live-account-budget-alert": { resolveAccountBudgetAlert, AccountBudgetAlertResolutionError },
    "node:crypto": { randomUUID: () => "audit-lease" },
    "../supabase/env": { getSupabaseDataSchema: () => "coinops", getCoinOpsServiceTenantId: () => "tenant" },
    "../supabase/service-role": { createServiceRoleClient: () => service },
    "./complete-ledger-read": { completeLedgerRead }, "./live-exposure-read": { readLiveExposure },
    "./live-ledger-read": { boundedLedgerRead, observeLedgerRows, observeLedgerRecord, assertPhysicalLedger },
    "./live-read-error": readErrors, "./live-order-snapshot-race": { isConfirmedFilledSnapshotRace },
    "./operator-context-server": { resolveOperatorEngine: async (_db: unknown, _scope: unknown, selected: Row) => {
      calls.push("registry");
      assert.equal(selected.trading_engine_id, "engine-a");
      assert.equal(selected.exchange_account_id, "account-a");
      assert.equal(selected.symbol, "SOLUSDT");
      if (options.registryTimeout)
        throw new readErrors.LiveReadUnavailable("COINOPS_OPERATOR_REGISTRY_READ_TIMEOUT", "registry", 1);
      return engine;
    } },
    "./operator-context": { assertRowEngine: (row: Row) => {
      assert.equal(row.trading_engine_id, "engine-a"); assert.equal(row.exchange_account_id, "account-a");
    } },
    "./strategy-engine": { STRATEGY_VERSION: "fixture" },
    "./strategy-price-invariant": { assertStrategyBuyPrice, assertStrategyTakeProfitPrice },
    "./live-strategy-snapshot": { strategyRatesForOrder: () => ({ gain: .1, spacing: .03 }) },
    "./monthly-slot-server": { loadMonthlySlotStatuses: async () => [] },
    "./robot-v1-live-cycle": { LIVE_ACTIVE_ORDER_STATUSES: new Set(["PREPARED", "NEW", "PARTIALLY_FILLED"]),
      LIVE_TERMINAL_ORDER_STATUSES: new Set(["FILLED", "CANCELED"]), liveEngineOrderPrefix: () => "owned:",
      liveUncoveredQuantity: () => 0 },
    "./live-executor-health": { loadLiveEngineExecutorStatus: async () => {
      calls.push("health"); return { gate: "LIVE_EXECUTOR_PROTECTED", health: { healthy: true } };
    } },
    "./live-executor-transport": {
      readLiveExecutorState: async () => {
        calls.push("exchange-state");
        if (options.leaseLost) run.lease_owner = "another-worker";
        if (options.leaseExpired) run.lease_until = oldTimestamp;
        return { ...scope, filters: { quantityStep: .001, priceTick: .01 },
          price: { price: 10, observedAt: new Date().toISOString() }, observed_at: new Date().toISOString(),
          open_orders: [
            ...(!options.missingTp && !options.filledDuringSnapshot ? [observedTp] : []),
            { ...observedTp, id: "sibling-tp", orderId: "sibling-tp", clientOrderId: "other-engine:tp" },
          ] };
      },
      readLiveExecutorOrder: async () => {
        calls.push("exact-order-read");
        return { order: options.filledDuringSnapshot ? { ...observedTp, status: "FILLED", executedQuantity: 1 } : null };
      },
      readLiveExecutorTrades: async () => {
        calls.push("exact-trades-read");
        return { order: { ...observedTp, status: "FILLED", executedQuantity: 1 },
          trades: [{ quantity: 1, quoteQuantity: 11, isBuyer: false }] };
      },
      createLiveExecutorOrder: () => assert.fail("Monitor cannot create an order"),
      cancelLiveExecutorOrder: () => assert.fail("Monitor cannot cancel an order"),
    },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./robot-v1-live-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Row = {};
  new Function("require", "exports", compiled)((name: string) => dependencies[name] ?? {}, exports);
  return { audit: () => exports.auditLiveRun("run-a"), run, alerts, originalIncident, calls, reads, writes,
    siblingIntact: () => assert.equal(JSON.stringify([siblingEngine, siblingRun]), siblingBefore) };
}

const gatesOrAlerts = (writes: Write[]) => writes.filter(write =>
  ["trading_engines", "robot_v1_live_preparations", "robot_v1_live_alerts"].includes(write.table));
const release = (writes: Write[]) => writes.find(write => write.table === "robot_v1_live_runs"
  && write.values.lease_owner === null);

test("an audit that loses the real lease performs no exchange reads, gate writes or incident rewrite", async () => {
  const f = fixture({ busy: true });
  assert.deepEqual(await f.audit(), { status: "LEASE_BUSY" });
  assert.deepEqual(f.calls, ["claim"]);
  assert.equal(gatesOrAlerts(f.writes).length, 0);
  assert.equal(release(f.writes), undefined);
  f.siblingIntact();
});

test("inactive runs are ignored before attempting a lease or financial observation", async () => {
  const f = fixture({ inactive: true });
  assert.deepEqual(await f.audit(), { status: "INACTIVE" });
  assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
});

test("the lease-returned run supersedes an obsolete pre-claim reconciliation snapshot", async () => {
  const f = fixture({ staleLookup: true });
  const before = f.run.last_reconciled_at;
  assert.equal((await f.audit()).status, "PASS");
  assert.equal(f.run.last_reconciled_at, before); assert.equal(f.run.last_error, null);
  assert.equal(gatesOrAlerts(f.writes).length, 0);
  assert.equal(f.calls[0], "claim");
  f.siblingIntact();
});

test("successful monitoring never manufactures reconciliation freshness or changes the BUY gate", async () => {
  const f = fixture();
  const before = f.run.last_reconciled_at;
  assert.deepEqual(await f.audit(), { status: "PASS", asset: "SOL", openPositions: 1, activeBuyCount: 0 });
  assert.equal(f.run.last_reconciled_at, before);
  assert.equal(Object.hasOwn(release(f.writes)!.values, "last_reconciled_at"), false);
  assert.equal(release(f.writes)!.values.last_error, null);
  assert.equal(gatesOrAlerts(f.writes).length, 0);
  assert.ok(f.writes.some(write => write.table === "robot_v1_live_events"
    && write.values.event_type === "LIVE_MONITOR_PASS"));
});

test("staleness preserves the original critical code, fingerprint and recovery evidence without reporting green", async () => {
  const f = fixture({ lastError: "COINOPS_LIVE_RECOVERY_INCIDENT_CHANGED", existingCritical: true });
  const before = JSON.stringify(f.alerts);
  assert.deepEqual(await f.audit(), { status: "CRITICAL", asset: "SOL",
    code: "COINOPS_OPERATOR_REGISTRY_UNAVAILABLE", secondary_code: "COINOPS_LIVE_MONITOR_RECONCILIATION_STALE" });
  assert.equal(JSON.stringify(f.alerts), before);
  assert.equal(gatesOrAlerts(f.writes).length, 0);
  assert.equal(f.run.last_error, "COINOPS_LIVE_RECOVERY_INCIDENT_CHANGED");
  const query = f.reads.find(read => read.table === "robot_v1_live_alerts")!;
  assert.deepEqual(query.filters, { product_id: "product", tenant_id: "tenant", user_id: "user",
    operator_id: "operator", exchange_account_id: "account-a", trading_engine_id: "engine-a",
    alert_key: "LIVE_RUN:run-a:CRITICAL", severity: "CRITICAL", resolved_at: null });
  f.siblingIntact();
});

test("a resume crash with reopened BUY gates cannot leave a preserved primary critical trading-enabled", async () => {
  const f = fixture({ staleRun: true, existingCritical: true, gatesOpen: true });
  const before = JSON.stringify(f.alerts);
  assert.deepEqual(await f.audit(), { status: "CRITICAL", asset: "SOL",
    code: "COINOPS_OPERATOR_REGISTRY_UNAVAILABLE", secondary_code: "COINOPS_LIVE_MONITOR_RECONCILIATION_STALE" });
  assert.equal(JSON.stringify(f.alerts), before);
  const gates = gatesOrAlerts(f.writes);
  assert.equal(gates.some(write => write.table === "robot_v1_live_alerts"), false);
  assert.equal(gates.length, 2);
  assert.ok(gates.every(write => write.values.kill_switch === true
    && (write.filters.trading_engine_id ?? write.filters.id) === "engine-a"));
  f.siblingIntact();
});

test("a genuinely stale run without a primary incident still closes only its own engine", async () => {
  const f = fixture({ staleRun: true });
  assert.equal((await f.audit()).code, "COINOPS_LIVE_MONITOR_RECONCILIATION_STALE");
  const writes = gatesOrAlerts(f.writes);
  assert.equal(writes.length, 3);
  assert.ok(writes.filter(write => write.table !== "robot_v1_live_alerts").every(write => write.values.kill_switch === true));
  assert.equal(f.run.last_reconciled_at, "2026-01-01T00:00:00.000Z");
  f.siblingIntact();
});

test("financial protection failure is never masked by an older read incident or a fresh reconciliation timestamp", async () => {
  const f = fixture({ missingTp: true, existingCritical: true });
  assert.deepEqual(await f.audit(), { status: "CRITICAL", asset: "SOL", code: "COINOPS_LIVE_OPEN_WITHOUT_RESIDENT_TP" });
  const alert = f.writes.find(write => write.table === "robot_v1_live_alerts")!;
  assert.equal(alert.values.code, "COINOPS_LIVE_OPEN_WITHOUT_RESIDENT_TP");
  assert.equal(alert.values.trading_engine_id, "engine-a");
  assert.equal(alert.values.exchange_account_id, "account-a");
  assert.equal(alert.values.alert_key, "LIVE_RUN:run-a:CRITICAL");
  for (const write of gatesOrAlerts(f.writes).filter(write => write.table !== "robot_v1_live_alerts")) {
    assert.equal(write.values.kill_switch, true);
    assert.equal(write.filters.trading_engine_id ?? write.filters.id, "engine-a");
  }
  f.siblingIntact();
});

test("lease ownership lost during the reads prevents all new gate or incident mutations", async () => {
  const f = fixture({ missingTp: true, leaseLost: true });
  await assert.rejects(f.audit(), /COINOPS_LIVE_LEASE_LOST/);
  assert.equal(gatesOrAlerts(f.writes).length, 0);
  assert.equal(f.run.lease_owner, "another-worker");
  assert.equal(release(f.writes)!.affected, 0);
  assert.equal(release(f.writes)!.filters.lease_owner, "audit-lease");
  f.siblingIntact();
});

test("an expired lease cannot close BUY gates even when the former owner has not changed", async () => {
  const f = fixture({ missingTp: true, leaseExpired: true });
  await assert.rejects(f.audit(), /COINOPS_LIVE_LEASE_LOST/);
  assert.equal(gatesOrAlerts(f.writes).length, 0);
  const renewal = f.writes.find(write => write.table === "robot_v1_live_runs"
    && write.values.lease_until && !Object.hasOwn(write.values, "lease_owner"))!;
  assert.equal(renewal.affected, 0);
  assert.equal(renewal.filters.lease_owner, "audit-lease");
  assert.ok(renewal.filters["gt:lease_until"]);
  f.siblingIntact();
});

test("an incident read that outlives the lease cannot write a stale gate or overwrite another worker", async () => {
  const f = fixture({ staleRun: true, expireDuringAlertRead: true });
  await assert.rejects(f.audit(), /COINOPS_LIVE_LEASE_LOST/);
  assert.equal(gatesOrAlerts(f.writes).length, 0);
  f.siblingIntact();
});

test("a trade-confirmed fill during the snapshot returns RETRY and preserves the execution checkpoint", async () => {
  const f = fixture({ filledDuringSnapshot: true, lastError: "COINOPS_PREVIOUS_ERROR", existingCritical: true });
  const before = JSON.stringify(f.alerts), reconciled = f.run.last_reconciled_at;
  assert.deepEqual(await f.audit(), { status: "RETRY", asset: "SOL", code: "COINOPS_LIVE_FILLED_DURING_SNAPSHOT" });
  assert.ok(f.calls.includes("exact-order-read")); assert.ok(f.calls.includes("exact-trades-read"));
  assert.equal(f.run.last_error, "COINOPS_PREVIOUS_ERROR"); assert.equal(f.run.last_reconciled_at, reconciled);
  assert.equal(JSON.stringify(f.alerts), before); assert.equal(gatesOrAlerts(f.writes).length, 0);
  f.siblingIntact();
});

test("a typed registry read timeout stays retryable without rewriting the primary financial checkpoint", async () => {
  const f = fixture({ registryTimeout: true, lastError: "COINOPS_PREVIOUS_ERROR", existingCritical: true });
  const before = JSON.stringify(f.alerts);
  assert.deepEqual(await f.audit(), { status: "RETRY", asset: "SOL", code: "COINOPS_OPERATOR_REGISTRY_READ_TIMEOUT" });
  assert.equal(f.calls.includes("health"), false); assert.equal(f.calls.includes("exchange-state"), false);
  assert.equal(f.run.last_error, "COINOPS_PREVIOUS_ERROR");
  assert.equal(JSON.stringify(f.alerts), before); assert.equal(gatesOrAlerts(f.writes).length, 0);
});

test("failure to read the primary critical incident never overwrites it with a generic stale label", async () => {
  const f = fixture({ staleRun: true, existingCritical: true, alertReadDenied: true });
  const before = JSON.stringify(f.alerts);
  await assert.rejects(f.audit(), /COINOPS_LIVE_MONITOR_INCIDENT_READ_FAILED/);
  assert.equal(JSON.stringify(f.alerts), before); assert.equal(gatesOrAlerts(f.writes).length, 0);
  assert.equal(f.run.lease_owner, null);
});
