import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { verifiedReadRecoveryAlert, isPermissionStateReadRecovery, assertPermissionReadRecoveryOrders,
  operatorRecoveryAlert } from "./live-read-recovery.ts";
import { readLiveExposure } from "./live-exposure-read.ts";
import { completeLedgerRead } from "./complete-ledger-read.ts";
import { boundedLedgerRead, observeLedgerRows, observeLedgerRecord, assertPhysicalLedger } from "./live-ledger-read.ts";
import * as readErrors from "./live-read-error.ts";
import { liveBnbFeeBalanceCheck } from "./live-bnb-fee-balance.ts";

const known = { alert_key: "LIVE_RUN:run-a:CRITICAL", code: "COINOPS_LIVE_MONITOR_EXECUTOR_UNHEALTHY",
  first_seen_at: "2026-09-27T00:00:12.000Z", last_seen_at: "2026-09-27T00:00:12.000Z" };

function fixture(options: { alerts?: Array<typeof known[]>; healthy?: boolean; missingTp?: boolean;
  casLost?: boolean; lateFill?: boolean; registryDenied?: boolean; missingSlot?: boolean; duplicateSlot?: boolean;
  ledgerDenied?: boolean; monthlyFailure?: boolean; configPending?: boolean; bulkStatus?: string;
  lateBulk?: boolean; bulkDenied?: boolean; configCasLost?: boolean;
  permissionRecovery?: boolean; permissionOrderStatus?: string; permissionRecentOrder?: boolean;
  permissionResidentQuantity?: number; permissionResidentPrice?: number;
  permissionRecentDecision?: boolean; permissionUnsettledDecision?: boolean;
  permissionPendingDispatch?: boolean; permissionProofDenied?: boolean;
  permissionSiblingOrder?: boolean; permissionExpectedCutoff?: string;
  bnbFree?: number; staleBnb?: boolean; unknownBnb?: boolean; runStatus?: "ACTIVE" | "PAUSED";
  operatorRecovery?: boolean; operatorPendingDispatch?: boolean; operatorUnsettledDecision?: boolean;
  operatorLatePendingDispatch?: boolean; operatorLateUnsettledDecision?: boolean;
  operatorProofDenied?: boolean; operatorOrderStatus?: string; operatorExecutedQuantity?: number;
  operatorClientOrderId?: string; caixetaLayout?: boolean; exposureCap?: number;
  exposureCountMissing?: boolean; readPathAddedAtCas?: boolean } = {}) {
  const calls: string[] = [];
  const writes: Array<{ table: string; data: Record<string, unknown>; filters: Record<string, unknown> }> = [];
  const scope = { product_id: "product", tenant_id: "tenant", user_id: "user", operator_id: "operator",
    exchange_account_id: "account-a", trading_engine_id: "engine-a", symbol: "SOLBRL", quote_asset: "BRL" };
  const run = { ...scope, id: "run-a", asset: "SOL", status: options.runStatus ?? "ACTIVE", strategy_version: "fixture-v1",
    last_error: null, last_reconciled_at: new Date().toISOString(), lease_owner: "lease" };
  const engine = { ...scope, id: "engine-a", hard_cap_quote: options.exposureCap ?? 275, base_asset: "SOL", status: "ACTIVE",
    environment: "REAL", executor_shard_id: "executor-02", engine_kill_switch: true,
    global_kill_switch: false, account_kill_switch: false, strategy_config_pending: options.configPending ?? false };
  const slots = Array.from({ length: 25 }, (_, index) => ({ ...scope, id: `slot-${index}`, run_id: run.id,
    slot_number: index + 1, position_quantity: index < (options.caixetaLayout ? 7 : 1) ? 1 : 0,
    position_committed_brl: index < (options.caixetaLayout ? 7 : 1) ? 10 : 0 }));
  const accounts = slots.map((slot) => ({ ...slot, balance_brl: 11, gain_count: 0 }));
  if (options.missingSlot) slots.pop();
  if (options.duplicateSlot) slots[24].slot_number = slots[0].slot_number;
  const orders = [{ ...scope, id: "order-tp", run_id: run.id, slot_id: "slot-0", side: "SELL",
    status: options.operatorOrderStatus ?? "NEW",
    client_order_id: options.operatorClientOrderId ?? "owned:tp", exchange_order_id: "tp-a", submission_guarded_at: known.last_seen_at,
    executed_quantity: options.operatorExecutedQuantity ?? 0, cumulative_quote: 0, reserved_notional_brl: 0, trades_reconciled: false,
    price: 650, requested_quantity: 1, created_at: "2026-09-25T00:00:00Z" }];
  if (options.caixetaLayout) {
    for (let index = 1; index < 7; index++) orders.push({ ...orders[0], id: `order-tp-${index + 1}`,
      slot_id: `slot-${index}`, client_order_id: `owned:tp-${index + 1}`, exchange_order_id: `tp-${index + 1}` });
    orders.push({ ...orders[0], id: "order-next-buy", slot_id: "slot-7", side: "BUY", price: 630,
      client_order_id: "owned:next-buy-8", exchange_order_id: "next-buy-8", reserved_notional_brl: 10 });
  }
  if (options.permissionRecovery) orders.push({ ...orders[0], id: "order-buy", side: "BUY", price: 630,
    client_order_id: "owned:buy", exchange_order_id: "buy-a", slot_id: "slot-1",
    status: options.permissionOrderStatus ?? "NEW",
    trading_engine_id: options.permissionSiblingOrder ? "engine-b" : "engine-a",
    created_at: options.permissionRecentOrder ? "2026-09-27T00:00:00Z" : orders[0].created_at });
  let alertReads = 0;
  let bulkReads = 0;
  let operatorIntentReads = 0;
  let operatorDispatchReads = 0;
  const service = { from(table: string) {
    const filters: Record<string, unknown> = {};
    let mutation: Record<string, unknown> | null = null;
    let page: [number, number] | null = null;
    let exactCount = false;
    const response = (singular = false) => {
      if (mutation) writes.push({ table, data: mutation, filters: { ...filters } });
      let data: unknown;
      if (table === "robot_v1_live_alerts" && !mutation) {
        calls.push("alert-read");
        for (const key of ["product_id", "tenant_id", "user_id", "operator_id", "exchange_account_id", "trading_engine_id"])
          assert.equal(filters[key], scope[key as keyof typeof scope]);
        assert.equal(filters.severity, "CRITICAL");
        assert.equal(filters.resolved_at, null);
        const variants = options.alerts ?? [[known]];
        data = variants[Math.min(alertReads++, variants.length - 1)];
      } else if (table === "robot_v1_live_alerts") data = options.casLost || options.readPathAddedAtCas
        && filters["details->>read_path"] === null ? [] : [{ id: "incident" }];
      else if (table === "robot_v1_live_runs") {
        if (mutation?.lease_owner) calls.push("lease-claimed");
        data = singular ? { ...run, ...mutation } : [{ ...run, ...mutation }];
      } else if (table === "operators") data = scope;
      else if (table === "robot_v1_live_preparations") data = { ...scope, id: "prep", live_enabled: true,
        kill_switch: mutation?.kill_switch ?? true, max_total_exposure_brl: 275 };
      else if (table === "trading_engines") data = options.configCasLost && mutation?.kill_switch === false
        ? null : singular ? engine : [engine];
      else if (table === "strategy_bulk_engine_updates") {
        assert.equal(filters.trading_engine_id, "engine-a");
        assert.equal(filters.exchange_account_id, "account-a");
        assert.equal(filters.operator_id, "operator");
        assert.deepEqual(filters.status, ["PENDING", "APPLYING", "BLOCKED_SAFE"]);
        // No run filter: another run's queued edit must still prevent resume.
        assert.equal(filters.run_id, undefined);
        bulkReads++;
        data = options.bulkStatus || options.lateBulk && bulkReads > 1 ? [{ id: "edit" }] : [];
      }
      else if (table === "robot_v1_live_slots") data = slots;
      else if (table === "robot_v1_live_slot_accounts") data = accounts;
      else if (table === "robot_v1_live_fills") data = options.lateFill ? [{ order_id: "filled-order",
        filled_at: "2026-09-27T00:00:11.000Z", collected_at: "2026-09-27T00:00:30.000Z" }] : [];
      else if (table === "robot_v1_live_orders") data = filters.id ? [{ id: "filled-order",
        client_order_id: "owned:filled-tp", status: "FILLED", trades_reconciled: true }] : orders;
      else if (table === "robot_v1_strategy_decisions" || table === "account_order_budget_reservations") {
        calls.push(options.operatorRecovery
          ? table === "robot_v1_strategy_decisions" ? "operator-intent-read" : "operator-dispatch-read"
          : table === "robot_v1_strategy_decisions" ? "permission-intent-read" : "permission-dispatch-read");
        assert.equal(filters.trading_engine_id, "engine-a");
        assert.equal(filters.exchange_account_id, "account-a");
        assert.equal(filters.operator_id, "operator");
        assert.equal(filters.cycle_id, undefined, "another run's unsettled dispatch must not be hidden");
        if (table === "robot_v1_strategy_decisions") {
          assert.equal(filters.environment, "REAL");
          assert.deepEqual(filters.action_type, ["OPEN_INITIAL_MARKET", "CREATE_TP", "ARM_NEXT_BUY", "CANCEL_REPLACE_NEXT_BUY"]);
          if (options.operatorRecovery) {
            operatorIntentReads++;
            assert.equal(filters.or, "result.neq.COMPLETED,result.is.null");
            data = options.operatorUnsettledDecision || options.operatorLateUnsettledDecision && operatorIntentReads > 1
              ? [{ id: "unsettled-decision" }] : [];
          } else {
            const cutoff = options.permissionExpectedCutoff ?? "2026-09-26T23:58:42.000Z";
            assert.equal(filters.or, `created_at.gte.${cutoff},dispatched_at.gte.${cutoff},result.neq.COMPLETED,result.is.null`);
            data = options.permissionRecentDecision || options.permissionUnsettledDecision ? [{ id: "unsettled-decision" }] : [];
          }
        } else {
          assert.equal(filters.acknowledged_at, null);
          if (options.operatorRecovery) {
            operatorDispatchReads++;
            data = options.operatorPendingDispatch || options.operatorLatePendingDispatch && operatorDispatchReads > 1
              ? [{ client_order_id: "uncertain-dispatch" }] : [];
          } else data = options.permissionPendingDispatch ? [{ client_order_id: "uncertain-dispatch" }] : [];
        }
        if (options.permissionProofDenied || options.operatorProofDenied)
          return { data: null, error: { code: "42501" }, status: 403 };
      }
      else if (table === "account_quote_caps") data = { ...scope, hard_cap_quote: 275 };
      else if (table === "robot_v1_live_events") data = {};
      else assert.fail(`Unexpected table ${table}`);
      if (exactCount && Array.isArray(data)) data = data.filter(row => Object.entries(filters).every(([key, value]) =>
        Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
      const count = Array.isArray(data) ? data.length : undefined;
      if (page && Array.isArray(data)) data = data.slice(page[0], page[1] + 1);
      if (options.bulkDenied && table === "strategy_bulk_engine_updates")
        return { data: null, error: { code: "42501" }, status: 403 };
      return options.ledgerDenied && table === "robot_v1_live_slots"
        ? { data: null, error: { code: "42501" }, status: 403 } : { data, error: null,
          ...(exactCount ? { count: options.exposureCountMissing ? null : count } : {}) };
    };
    const chain = {
      select: (_columns?: string, options?: { count?: string }) => {
        exactCount = options?.count === "exact"; return chain;
      }, eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
      is: (key: string, value: unknown) => { filters[key] = value; return chain; },
      in: (key: string, value: unknown) => { filters[key] = value; return chain; },
      gte: () => chain, lte: () => chain, limit: () => chain,
      or: (value: string) => { filters.or = value; return chain; }, gt: () => chain, order: () => chain, abortSignal: () => chain,
      range: (start: number, end: number) => { page = [start, end]; return chain; },
      update: (data: Record<string, unknown>) => { mutation = data; return chain; },
      upsert: (data: Record<string, unknown>) => { mutation = data; return chain; },
      single: async () => response(true), maybeSingle: async () => response(true),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(response()).then(resolve),
    };
    return chain;
  } };
  const dependencies: Record<string, unknown> = {
    "./live-exposure-read": { readLiveExposure }, "./complete-ledger-read": { completeLedgerRead },
    "./live-ledger-read": { boundedLedgerRead, observeLedgerRows, observeLedgerRecord, assertPhysicalLedger },
    "./live-read-error": readErrors,
    "./live-bnb-fee-balance": { liveBnbFeeBalanceCheck },
    "node:crypto": { randomUUID: () => "lease" },
    "./live-read-recovery": { verifiedReadRecoveryAlert, isPermissionStateReadRecovery, assertPermissionReadRecoveryOrders,
      operatorRecoveryAlert },
    "../supabase/env": { getSupabaseDataSchema: () => "coinops", getCoinOpsServiceTenantId: () => "tenant" },
    "../supabase/service-role": { createServiceRoleClient: () => service },
    "./operator-context-server": { resolveOperatorEngine: async () => {
      if (options.registryDenied) throw new Error("COINOPS_OPERATOR_SCOPE_DENIED");
      return engine;
    } },
    "./operator-context": { assertRowEngine: (row: Record<string, unknown>) => {
      assert.equal(row.trading_engine_id, "engine-a"); assert.equal(row.exchange_account_id, "account-a");
    } },
    "./strategy-engine": { STRATEGY_VERSION: "fixture-v1" },
    "./monthly-slot-server": { loadMonthlySlotStatuses: async () => {
      if (options.monthlyFailure) throw new Error("COINOPS_MONTHLY_GAIN_LEDGER_MISMATCH");
      return [];
    } },
    "./live-executor-health": { loadLiveEngineExecutorStatus: async () => {
      calls.push("health"); return { gate: options.healthy === false ? "ATTENTION" : "LIVE_EXECUTOR_PROTECTED" };
    } },
    "./live-executor-transport": { readLiveExecutorOrder: async () => ({ order: null }),
      readLiveExecutorState: async () => {
      calls.push("exchange-state"); return { ...scope, filters: { quantityStep: 0.001 },
        price: { price: 630, observedAt: new Date().toISOString() }, observed_at: new Date().toISOString(),
        balances: options.unknownBnb ? [] : [{ asset: "BNB", free: options.bnbFree ?? .001 }],
        bnb_quote_price: { symbol: "BNBBRL", price: 6000,
          observedAt: new Date(Date.now() - (options.staleBnb ? 30_001 : 0)).toISOString() },
        open_orders: options.missingTp ? [] : options.caixetaLayout
          ? orders.map(order => ({ id: order.exchange_order_id, side: order.side,
            clientOrderId: order.client_order_id, status: "NEW", price: order.price,
            executedQuantity: 0, originalQuantity: 1 })) : options.permissionRecovery
          ? [{ id: "tp-a", side: "SELL", clientOrderId: "owned:tp", status: "NEW", price: 650, executedQuantity: 0, originalQuantity: 1 },
            { id: "buy-a", side: "BUY", clientOrderId: "owned:buy", status: "NEW", price: options.permissionResidentPrice ?? 630,
              executedQuantity: 0, originalQuantity: options.permissionResidentQuantity ?? 1 }]
          : [{ id: "tp-a", side: "SELL", clientOrderId: "owned:tp" }] };
    }, createLiveExecutorOrder: () => assert.fail("Resume must not send an order"),
    cancelLiveExecutorOrder: () => assert.fail("Resume must not cancel an order") },
    "./robot-v1-live-cycle": { LIVE_ACTIVE_ORDER_STATUSES: new Set(["NEW", "PREPARED", "PARTIALLY_FILLED"]),
      LIVE_TERMINAL_ORDER_STATUSES: new Set(["FILLED", "CANCELED"]), liveEngineOrderPrefix: () => "owned:",
      liveUncoveredQuantity: () => 0, liveExposure: () => ({ BTC: 0, SOL: 10, global: 10 }) },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./robot-v1-live-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((name: string) => dependencies[name] ?? {}, exports);
  const resume = exports.resumeLiveRun as (...args: string[]) => Promise<{ status: string }>;
  return { run: (source = "VERIFIED_READ_RECOVERY") => resume("run-a", "user", "SOL", source), calls, writes };
}

test("verified recovery claims lease, proves fresh health/protection and conditionally resolves only its incident", async () => {
  const scenario = fixture();
  assert.equal((await scenario.run()).status, "RESUMED");
  assert.deepEqual(scenario.calls, ["lease-claimed", "alert-read", "health", "exchange-state", "alert-read"]);
  const clear = scenario.writes.find((write) => write.table === "robot_v1_live_alerts" && write.data.resolved_at);
  assert.equal(clear?.filters.code, known.code);
  assert.equal(clear?.filters.last_seen_at, known.last_seen_at);
  assert.equal(clear?.filters.trading_engine_id, "engine-a");
  assert.equal(clear?.filters.first_seen_at, known.first_seen_at);
  assert.equal(clear?.filters["details->>stage"], null);
  assert.equal(clear?.filters["details->>root_code"], null);
  assert.equal(clear?.filters["details->>read_path"], null);
});

test("legacy exposure ARM_ENTRY recovers seven protected OPENs and one resident NEXT BUY only after complete account proof", async () => {
  const code = "COINOPS_LIVE_EXPOSURE_UNAVAILABLE";
  const incident = { ...known, code, details: { stage: "ARM_ENTRY", root_code: code } };
  const safe = fixture({ alerts: [[incident]], caixetaLayout: true });
  assert.equal((await safe.run()).status, "RESUMED");
  const clear = safe.writes.find(write => write.table === "robot_v1_live_alerts" && write.data.resolved_at)!;
  assert.equal(clear.filters.code, code); assert.equal(clear.filters.last_seen_at, incident.last_seen_at);
  assert.equal(clear.filters["details->>stage"], "ARM_ENTRY");
  assert.equal(clear.filters["details->>root_code"], code);
  assert.equal(clear.filters["details->>read_path"], null);
  assert.equal(safe.writes.some(write => ["robot_v1_live_orders", "robot_v1_live_slots", "robot_v1_live_slot_accounts"]
    .includes(write.table)), false);
  for (const options of [{ exposureCap: 5 }, { exposureCountMissing: true }, { missingTp: true },
    { missingSlot: true }, { ledgerDenied: true }, { healthy: false }, { configPending: true }, { bulkStatus: "PENDING" }]) {
    const denied = fixture({ alerts: [[incident]], caixetaLayout: true, ...options });
    await assert.rejects(denied.run());
    assert.equal(denied.writes.some(write => write.data.kill_switch === false), false);
  }
});

test("typed binding exhaustion resumes only its exact read checkpoint, while hard routing/cap errors never inherit a wrapper", async () => {
  const incident = { ...known, code: "COINOPS_LIVE_EXECUTOR_READ_STALE", details: {
    stage: "RECONCILE_ORDERS", root_code: "COINOPS_EXECUTOR_BINDING_READ_UNAVAILABLE", read_path: "executor_binding/engine" } };
  const safe = fixture({ alerts: [[incident]] });
  assert.equal((await safe.run()).status, "RESUMED");
  const clear = safe.writes.find(write => write.table === "robot_v1_live_alerts" && write.data.resolved_at)!;
  assert.equal(clear.filters["details->>read_path"], incident.details.read_path);
  for (const rootCode of ["EXECUTOR_ENGINE_SHARD_DENIED", "COINOPS_EXECUTOR_BINDING_READ_FAILED", "COINOPS_LIVE_HARD_CAP_BREACHED"]) {
    const hard = { ...known, code: "COINOPS_LIVE_RECONCILE_ORDERS_FAILED",
      details: { stage: "RECONCILE_ORDERS", root_code: rootCode, read_path: "executor_binding/engine" } };
    const denied = fixture({ alerts: [[hard]] });
    await assert.rejects(denied.run(), /RECOVERY_INCIDENT_CHANGED/);
    assert.equal(denied.writes.some(write => write.data.kill_switch === false), false);
    assert.equal(denied.calls.includes("exchange-state"), false);
  }
});

test("a newly added read_path after the second incident read loses the absent-field final CAS and recloses only its engine", async () => {
  const scenario = fixture({ alerts: [[known]], readPathAddedAtCas: true });
  await assert.rejects(scenario.run(), /RECOVERY_INCIDENT_CHANGED/);
  const clear = scenario.writes.find(write => write.table === "robot_v1_live_alerts" && write.data.resolved_at)!;
  assert.equal(clear.filters["details->>read_path"], null);
  assert.deepEqual(scenario.writes.filter(write => write.table === "trading_engines").map(write => write.data.kill_switch), [false, true]);
  assert.equal(scenario.writes.some(write => write.table === "robot_v1_live_events"
    && write.data.event_type === "LIVE_RESUMED"), false);
});

test("explicit operator resume of sole monitor-stale incident requires current full proof and scoped immutable CAS", async () => {
  const incident = { ...known, code: "COINOPS_LIVE_MONITOR_RECONCILIATION_STALE",
    details: { stage: "MONITOR", root_code: "COINOPS_LIVE_MONITOR_RECONCILIATION_STALE",
      read_path: "registry/trading_engines" } };
  const scenario = fixture({ alerts: [[incident]], operatorRecovery: true });
  assert.equal((await scenario.run("OPERATOR_CONTROL")).status, "RESUMED");
  assert.deepEqual(scenario.calls.filter(call => !call.startsWith("operator-")),
    ["lease-claimed", "alert-read", "health", "exchange-state", "alert-read"]);
  assert.equal(scenario.calls.filter(call => call === "operator-intent-read").length, 2);
  assert.equal(scenario.calls.filter(call => call === "operator-dispatch-read").length, 2);
  const clear = scenario.writes.find(write => write.table === "robot_v1_live_alerts" && write.data.resolved_at)!;
  for (const [key, value] of Object.entries({ code: incident.code, first_seen_at: incident.first_seen_at,
    last_seen_at: incident.last_seen_at, trading_engine_id: "engine-a", exchange_account_id: "account-a",
    operator_id: "operator", user_id: "user", tenant_id: "tenant", product_id: "product",
    alert_key: "LIVE_RUN:run-a:CRITICAL", resolved_at: null,
    "details->>stage": incident.details.stage, "details->>root_code": incident.details.root_code,
    "details->>read_path": incident.details.read_path })) assert.equal(clear.filters[key], value, key);
  const resumed = scenario.writes.find(write => write.table === "robot_v1_live_events"
    && write.data.event_type === "LIVE_RESUMED")!;
  assert.equal((resumed.data.details as Record<string, unknown>).source, "OPERATOR_CONTROL");
  assert.equal((resumed.data.details as Record<string, unknown>).recovered_alert_code, incident.code);
  assert.equal(scenario.writes.some(write => ["robot_v1_live_orders", "robot_v1_live_slots", "robot_v1_live_slot_accounts"]
    .includes(write.table)), false);
  assert.ok(scenario.writes.filter(write => write.table === "trading_engines")
    .every(write => write.filters.id === "engine-a" && write.filters.exchange_account_id === "account-a"));
});

test("explicit operator resume rejects new/additional/changed critical before unlocking an engine", async () => {
  const incident = { ...known, code: "COINOPS_LIVE_MONITOR_RECONCILIATION_STALE",
    details: { stage: "MONITOR", root_code: "COINOPS_LIVE_MONITOR_RECONCILIATION_STALE", read_path: "registry/trading_engines" } };
  for (const alerts of [
    [[incident, { ...incident, alert_key: "OTHER_CRITICAL" }]],
    [[incident], [incident, { ...incident, alert_key: "OTHER_CRITICAL" }]],
    [[incident], [{ ...incident, code: "COINOPS_LIVE_TP_FAILED" }]],
    [[incident], [{ ...incident, last_seen_at: "2026-09-27T00:01:00Z" }]],
    [[incident], [{ ...incident, first_seen_at: "2026-09-27T00:00:13Z" }]],
    [[incident], [{ ...incident, details: { ...incident.details, stage: "ARM_ENTRY" } }]],
    [[incident], [{ ...incident, details: { ...incident.details, root_code: "COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN" } }]],
    [[incident], [{ ...incident, details: { ...incident.details, read_path: "POST/order" } }]],
  ]) {
    const scenario = fixture({ alerts, operatorRecovery: true });
    await assert.rejects(scenario.run("OPERATOR_CONTROL"), /RECOVERY_INCIDENT_CHANGED/);
    assert.equal(scenario.writes.some(write => write.data.kill_switch === false), false);
    assert.equal(scenario.writes.some(write => write.table === "robot_v1_live_events"
      && write.data.event_type === "LIVE_RESUMED"), false);
  }
  const appeared = fixture({ runStatus: "PAUSED", alerts: [[], [incident]], operatorRecovery: true });
  await assert.rejects(appeared.run("OPERATOR_CONTROL"), /RECOVERY_INCIDENT_CHANGED/);
  assert.equal(appeared.writes.some(write => write.data.kill_switch === false), false);
});

test("explicit operator resume preserves fail-closed protection and re-closes on final incident CAS loss", async () => {
  const incident = { ...known, code: "COINOPS_LIVE_MONITOR_RECONCILIATION_STALE" };
  for (const options of [{ missingTp: true }, { healthy: false }, { missingSlot: true }, { ledgerDenied: true },
    { monthlyFailure: true }, { configPending: true }, { bulkStatus: "PENDING" }, { bulkStatus: "BLOCKED_SAFE" }]) {
    const scenario = fixture({ alerts: [[incident]], operatorRecovery: true, ...options });
    await assert.rejects(scenario.run("OPERATOR_CONTROL"));
    assert.equal(scenario.writes.some(write => write.data.kill_switch === false), false);
  }
  const lost = fixture({ alerts: [[incident]], casLost: true, operatorRecovery: true });
  await assert.rejects(lost.run("OPERATOR_CONTROL"), /RECOVERY_INCIDENT_CHANGED/);
  const gates = lost.writes.filter(write => write.table === "trading_engines");
  assert.deepEqual(gates.map(write => write.data.kill_switch), [false, true]);
  assert.ok(gates.every(write => write.filters.id === "engine-a" && write.filters.exchange_account_id === "account-a"));
  assert.equal(lost.writes.some(write => write.table === "robot_v1_live_events"
    && write.data.event_type === "LIVE_RESUMED"), false);
});

test("explicit operator resume never opens on prepared/unknown orders, pending dispatch or unsettled financial decisions", async () => {
  const incident = { ...known, code: "COINOPS_LIVE_MONITOR_RECONCILIATION_STALE" };
  for (const options of [{ operatorPendingDispatch: true }, { operatorUnsettledDecision: true },
    { operatorLatePendingDispatch: true }, { operatorLateUnsettledDecision: true }, { operatorProofDenied: true },
    { operatorExecutedQuantity: 1 }, { operatorClientOrderId: "another-engine:tp" },
    ...["PREPARED", "UNKNOWN", "FAILED", "SUBMITTING", "PENDING_CANCEL"].map(operatorOrderStatus => ({ operatorOrderStatus }))]) {
    const scenario = fixture({ alerts: [[incident]], operatorRecovery: true, ...options });
    await assert.rejects(scenario.run("OPERATOR_CONTROL"));
    assert.equal(scenario.writes.some(write => write.data.kill_switch === false), false);
    assert.equal(scenario.writes.some(write => write.table === "robot_v1_live_events"
      && write.data.event_type === "LIVE_RESUMED"), false);
    assert.equal(scenario.writes.some(write => ["robot_v1_live_orders", "robot_v1_live_slots", "robot_v1_live_slot_accounts"]
      .includes(write.table)), false);
  }
});

test("missing-order alert recovers only after a late trade-backed fill and current exchange agreement", async () => {
  const missing = { ...known, code: "COINOPS_LIVE_EXCHANGE_ORDER_MISSING" };
  const safe = fixture({ alerts: [[missing]], lateFill: true });
  assert.equal((await safe.run()).status, "RESUMED");
  assert.equal(safe.writes.some((write) => write.table === "trading_engines"
    && write.data.kill_switch === false), true);
  const unproven = fixture({ alerts: [[missing]], lateFill: false });
  await assert.rejects(unproven.run(), /RECOVERY_FILL_EVIDENCE_MISSING/);
  assert.equal(unproven.writes.some((write) => write.data.kill_switch === false), false);
});

test("legacy ledger incident opens only after complete physical rows, permissions and exchange TP proof", async () => {
  const incident = { ...known, code: "COINOPS_LIVE_LEDGER_INCOMPLETE",
    details: { stage: "RECONCILE_ORDERS", root_code: "COINOPS_LIVE_LEDGER_INCOMPLETE" } };
  const safe = fixture({ alerts: [[incident]] });
  assert.equal((await safe.run()).status, "RESUMED");
  for (const options of [{ missingSlot: true }, { duplicateSlot: true }, { ledgerDenied: true },
    { missingTp: true }, { healthy: false }]) {
    const denied = fixture({ alerts: [[incident]], ...options });
    await assert.rejects(denied.run(), /LEDGER_INCOMPLETE|LEDGER_READ_FAILED|EXCHANGE_ORDER_MISSING|EXECUTOR_NOT_ACTIVE/);
    assert.equal(denied.writes.some(w => w.data.kill_switch === false), false);
  }
  assert.ok(safe.writes.filter(w => w.table === "trading_engines")
    .every(w => w.filters.id === "engine-a" && w.filters.exchange_account_id === "account-a"));
});

test("registry recovery revalidates real permissions and TP before opening only its engine", async () => {
  const incident = { ...known, code: "COINOPS_OPERATOR_REGISTRY_UNAVAILABLE",
    details: { stage: "LOAD_LEDGER", root_code: "COINOPS_OPERATOR_REGISTRY_UNAVAILABLE" } };
  const safe = fixture({ alerts: [[incident]] });
  assert.equal((await safe.run()).status, "RESUMED");
  assert.ok(safe.writes.filter(w => w.table === "trading_engines")
    .every(w => w.filters.id === "engine-a" && w.filters.exchange_account_id === "account-a"));
  for (const options of [{ registryDenied: true }, { healthy: false }, { missingTp: true }]) {
    const denied = fixture({ alerts: [[incident]], ...options });
    await assert.rejects(denied.run(), /SCOPE_DENIED|RESUME_EXECUTOR_NOT_ACTIVE|EXCHANGE_ORDER_MISSING/);
    assert.equal(denied.writes.some(w => w.data.kill_switch === false), false);
  }
});

test("registry GET at later normal stages resumes only after complete unchanged engine-scoped proof", async () => {
  const code = "COINOPS_OPERATOR_REGISTRY_UNAVAILABLE";
  for (const stage of ["RECONCILE_ORDERS", "PROTECT_TP", "ASSERT_NEW_POSITION", "ARM_ENTRY",
    "ATH_TRANSITION", "RESTART_CYCLE", "CONFIG_UPDATE"]) {
    const incident = { ...known, code, details: { stage, root_code: code } };
    const safe = fixture({ alerts: [[incident]] });
    assert.equal((await safe.run()).status, "RESUMED", stage);
    assert.deepEqual(safe.calls, ["lease-claimed", "alert-read", "health", "exchange-state", "alert-read"]);
    assert.ok(safe.writes.filter(write => write.table === "trading_engines")
      .every(write => write.filters.id === "engine-a" && write.filters.exchange_account_id === "account-a"));
    assert.equal(safe.writes.some(write => ["robot_v1_live_orders", "robot_v1_live_slots", "robot_v1_live_slot_accounts"]
      .includes(write.table)), false);
  }
  const incident = { ...known, code, details: { stage: "ARM_ENTRY", root_code: code } };
  for (const options of [{ registryDenied: true }, { healthy: false }, { missingTp: true }, { missingSlot: true },
    { ledgerDenied: true }, { monthlyFailure: true }, { configPending: true },
    ...["PENDING", "APPLYING", "BLOCKED_SAFE"].map(bulkStatus => ({ bulkStatus }))]) {
    const denied = fixture({ alerts: [[incident]], ...options });
    await assert.rejects(denied.run());
    assert.equal(denied.writes.some(write => write.data.kill_switch === false), false);
  }
  const changed = fixture({ alerts: [[incident], [{ ...incident,
    details: { stage: "LOAD_LEDGER", root_code: code } }]] });
  await assert.rejects(changed.run(), /RECOVERY_INCIDENT_CHANGED/);
  assert.equal(changed.writes.some(write => write.data.kill_switch === false), false);
});

test("legacy monthly outage resumes under lease only after monthly, health, TP and incident CAS proofs", async () => {
  const incident = { ...known, code: "COINOPS_MONTHLY_GAIN_LEDGER_UNAVAILABLE",
    details: { stage: "RECYCLE_SLOTS", root_code: "COINOPS_MONTHLY_GAIN_LEDGER_UNAVAILABLE" } };
  const safe = fixture({ alerts: [[incident]] });
  assert.equal((await safe.run()).status, "RESUMED");
  for (const options of [{ monthlyFailure: true }, { missingTp: true }, { healthy: false },
    { ledgerDenied: true }, { missingSlot: true }]) {
    const denied = fixture({ alerts: [[incident]], ...options });
    await assert.rejects(denied.run(), /MONTHLY_GAIN_LEDGER_MISMATCH|EXCHANGE_ORDER_MISSING|EXECUTOR_NOT_ACTIVE|LEDGER_READ_FAILED|LEDGER_INCOMPLETE/);
    assert.equal(denied.writes.some(w => w.data.kill_switch === false), false);
  }
  assert.ok(safe.writes.filter(w => w.table === "trading_engines")
    .every(w => w.filters.id === "engine-a" && w.filters.exchange_account_id === "account-a"));
});

test("unknown/additional/changed critical incidents never open the BUY gate", async () => {
  for (const alerts of [
    [[{ ...known, code: "COINOPS_LIVE_TP_FAILED" }]],
    [[known, { ...known, alert_key: "OTHER_CRITICAL" }]],
    [[known], [{ ...known, last_seen_at: "2026-09-27T00:01:00.000Z" }]],
  ]) {
    const scenario = fixture({ alerts });
    await assert.rejects(scenario.run(), /RECOVERY_INCIDENT_CHANGED/);
    assert.equal(scenario.writes.some((write) => write.data.kill_switch === false), false);
  }
});

test("legacy checkpoint outage resumes only with no bulk edit, fresh gate, TP and incident proof", async () => {
  const code = "COINOPS_BULK_CHECKPOINT_UNAVAILABLE";
  const incident = { ...known, code, details: { stage: "CONFIG_UPDATE", root_code: code } };
  const safe = fixture({ alerts: [[incident]] });
  assert.equal((await safe.run()).status, "RESUMED");
  assert.ok(safe.writes.filter(w => w.table === "trading_engines")
    .every(w => w.filters.strategy_config_pending === false && w.filters.id === "engine-a"));
  for (const options of [{ configPending: true }, ...["PENDING", "APPLYING", "BLOCKED_SAFE"].map(bulkStatus => ({ bulkStatus })),
    { lateBulk: true }, { bulkDenied: true }, { missingTp: true }, { healthy: false }, { monthlyFailure: true }]) {
    const denied = fixture({ alerts: [[incident]], ...options });
    await assert.rejects(denied.run(), /CONFIG_UPDATE_PENDING|LEDGER_READ_FAILED|EXCHANGE_ORDER_MISSING|EXECUTOR_NOT_ACTIVE|MONTHLY_GAIN_LEDGER_MISMATCH/);
    assert.equal(denied.writes.some(w => w.data.kill_switch === false), false);
  }
});

test("a concurrent config gate CAS loss recloses only its engine/preparation, never emits RESUMED", async () => {
  const scenario = fixture({ configCasLost: true });
  await assert.rejects(scenario.run(), /RESUME_ENGINE_GATE_FAILED/);
  const gates = scenario.writes.filter(w => w.table === "trading_engines");
  assert.deepEqual(gates.map(w => w.data.kill_switch), [false, true]);
  assert.ok(gates.every(w => w.filters.id === "engine-a" && w.filters.exchange_account_id === "account-a"));
  assert.equal(scenario.writes.some(w => w.table === "robot_v1_live_events" && w.data.event_type === "LIVE_RESUMED"), false);
});

test("known monitor code still cannot bypass unhealthy executor or missing exchange TP", async () => {
  for (const options of [{ healthy: false }, { missingTp: true }]) {
    const scenario = fixture(options);
    await assert.rejects(scenario.run(), /RESUME_EXECUTOR_NOT_ACTIVE|EXCHANGE_ORDER_MISSING/);
    assert.equal(scenario.writes.some((write) => write.data.kill_switch === false), false);
  }
});

test("late incident CAS loss re-closes only this engine instead of reporting success", async () => {
  const scenario = fixture({ casLost: true });
  await assert.rejects(scenario.run(), /RECOVERY_INCIDENT_CHANGED/);
  const engineWrites = scenario.writes.filter((write) => write.table === "trading_engines");
  assert.deepEqual(engineWrites.map((write) => write.data.kill_switch), [false, true]);
  assert.equal(scenario.writes.some((write) => write.table === "robot_v1_live_events"
    && write.data.event_type === "LIVE_RESUMED"), false);
  assert.ok(engineWrites.every((write) => write.filters.id === "engine-a"
    && write.filters.exchange_account_id === "account-a"));
});

test("legacy permission GET wrapper resumes only after settled pre-incident order and dispatch proof under lease/CAS", async () => {
  for (const [code, stage] of [["COINOPS_LIVE_ARM_ENTRY_FAILED", "ARM_ENTRY"],
    ["COINOPS_LIVE_CREDIT_SLOTS_FAILED", "CREDIT_SLOTS"]]) {
    const incident = { ...known, code, details: { stage, root_code: "EXECUTOR_PRODUCTION_PERMISSION_DENIED" } };
    const safe = fixture({ alerts: [[incident]], permissionRecovery: true });
    assert.equal((await safe.run()).status, "RESUMED");
    assert.deepEqual(safe.calls, ["lease-claimed", "alert-read", "health", "exchange-state",
      "permission-intent-read", "permission-dispatch-read", "alert-read"]);
    assert.ok(safe.writes.every(write => !["robot_v1_live_orders", "robot_v1_live_slots", "robot_v1_live_slot_accounts"].includes(write.table)));
    const cleared = safe.writes.find(write => write.table === "robot_v1_live_alerts" && write.data.resolved_at)!;
    assert.equal(cleared.filters.code, code); assert.equal(cleared.filters.last_seen_at, incident.last_seen_at);
    assert.equal(cleared.filters.first_seen_at, incident.first_seen_at);
    assert.equal(cleared.filters["details->>stage"], stage);
    assert.equal(cleared.filters["details->>root_code"], incident.details.root_code);
    assert.equal(cleared.filters.trading_engine_id, "engine-a");
    const event = safe.writes.find(write => write.table === "robot_v1_live_events")!;
    assert.equal((event.data.details as Record<string, unknown>).source, "VERIFIED_READ_RECOVERY");
    assert.equal((event.data.details as Record<string, unknown>).recovered_alert_code, code);
    for (const options of [{ healthy: false }, { missingTp: true }, { missingSlot: true }, { ledgerDenied: true },
      { configPending: true }, { permissionResidentPrice: 631 }, { permissionResidentQuantity: 2 },
      { permissionRecentOrder: true }, { permissionRecentDecision: true }, { permissionUnsettledDecision: true }, { permissionPendingDispatch: true },
      { permissionProofDenied: true }, { permissionSiblingOrder: true },
      ...["PREPARED", "PARTIALLY_FILLED", "UNKNOWN", "SUBMITTING", "FAILED"].map(permissionOrderStatus => ({ permissionOrderStatus }))]) {
      const denied = fixture({ alerts: [[incident]], permissionRecovery: true, ...options });
      await assert.rejects(denied.run());
      assert.equal(denied.writes.some(write => write.data.kill_switch === false), false);
      assert.equal(denied.writes.some(write => write.table === "robot_v1_live_events" && write.data.event_type === "LIVE_RESUMED"), false);
    }
    const changed = fixture({ alerts: [[incident], [{ ...incident, last_seen_at: "2026-09-27T00:01:00Z" }]], permissionRecovery: true });
    await assert.rejects(changed.run(), /INCIDENT_CHANGED/);
    assert.equal(changed.writes.some(write => write.data.kill_switch === false), false);
  }
});

test("legacy permission recovery tolerates bounded DB/caller skew without rounding incident CAS timestamps", async () => {
  const incident = { ...known, code: "COINOPS_LIVE_ARM_ENTRY_FAILED",
    details: { stage: "ARM_ENTRY", root_code: "EXECUTOR_PRODUCTION_PERMISSION_DENIED" },
    first_seen_at: "2026-10-11 15:07:18.029158+00", last_seen_at: "2026-10-11 15:07:18.019+00" };
  const safe = fixture({ alerts: [[incident]], permissionRecovery: true,
    permissionExpectedCutoff: "2026-10-11T15:05:48.019Z" });
  assert.equal((await safe.run()).status, "RESUMED");
  const cleared = safe.writes.find(write => write.table === "robot_v1_live_alerts" && write.data.resolved_at)!;
  assert.equal(cleared.filters.first_seen_at, incident.first_seen_at);
  assert.equal(cleared.filters.last_seen_at, incident.last_seen_at);
  assert.equal(cleared.filters["details->>stage"], incident.details.stage);
  assert.equal(cleared.filters["details->>root_code"], incident.details.root_code);
});

test("fee observation outage cannot resume on TP proof alone; fresh known BNB resumes through the existing scoped lease/CAS", async () => {
  const incident = { ...known, code: "COINOPS_LIVE_EXECUTOR_READ_STALE", details: {
    root_code: "COINOPS_LIVE_BNB_FEE_BALANCE_UNAVAILABLE", stage: "OBSERVE_BNB_FEE", read_path: "snapshot/bnb_fee" } };
  for (const options of [{ staleBnb: true }, { unknownBnb: true }]) {
    const blocked = fixture({ alerts: [[incident]], ...options });
    await assert.rejects(blocked.run(), /BNB_FEE_BALANCE_UNAVAILABLE/);
    assert.equal(blocked.writes.some(write => write.data.kill_switch === false), false);
    assert.equal(blocked.writes.some(write => write.data.resolved_at), false);
    assert.ok(blocked.calls.includes("lease-claimed"));
  }
  for (const bnbFree of [0, .00001, .001]) {
    const safe = fixture({ alerts: [[incident]], bnbFree });
    assert.equal((await safe.run()).status, "RESUMED", "known shortage safely resumes to the normal BUY-only HOLD");
    const clear = safe.writes.find(write => write.table === "robot_v1_live_alerts" && write.data.resolved_at)!;
    assert.equal(clear.filters.trading_engine_id, "engine-a");
    assert.equal(clear.filters.exchange_account_id, "account-a");
    assert.equal(clear.filters.first_seen_at, incident.first_seen_at);
    assert.equal(clear.filters.last_seen_at, incident.last_seen_at);
    assert.equal(clear.filters["details->>root_code"], incident.details.root_code);
    assert.equal(clear.filters["details->>read_path"], incident.details.read_path);
    assert.ok(safe.writes.every(write => !["robot_v1_live_orders", "robot_v1_live_slots", "robot_v1_live_slot_accounts"].includes(write.table)));
  }
  for (const changed of [{ ...incident, details: { ...incident.details, root_code: "EXECUTOR_ORDER_QUERY_FAILED" } },
    { ...incident, details: { ...incident.details, read_path: "/v1/state" } }]) {
    const blocked = fixture({ alerts: [[incident], [changed]] });
    await assert.rejects(blocked.run(), /INCIDENT_CHANGED/);
    assert.equal(blocked.writes.some(write => write.data.kill_switch === false), false);
  }
});
