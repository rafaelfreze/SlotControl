import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { verifiedReadRecoveryAlert } from "./live-read-recovery.ts";

const known = { alert_key: "LIVE_RUN:run-a:CRITICAL", code: "COINOPS_LIVE_MONITOR_EXECUTOR_UNHEALTHY",
  last_seen_at: "2026-09-27T00:00:12.000Z" };

function fixture(options: { alerts?: Array<typeof known[]>; healthy?: boolean; missingTp?: boolean;
  casLost?: boolean } = {}) {
  const calls: string[] = [];
  const writes: Array<{ table: string; data: Record<string, unknown>; filters: Record<string, unknown> }> = [];
  const scope = { product_id: "product", tenant_id: "tenant", user_id: "user", operator_id: "operator",
    exchange_account_id: "account-a", trading_engine_id: "engine-a", symbol: "SOLBRL", quote_asset: "BRL" };
  const run = { ...scope, id: "run-a", asset: "SOL", status: "ACTIVE", strategy_version: "fixture-v1",
    last_error: null, last_reconciled_at: new Date().toISOString(), lease_owner: "lease" };
  const engine = { ...scope, base_asset: "SOL", status: "ACTIVE", engine_kill_switch: true,
    global_kill_switch: false, account_kill_switch: false };
  const slots = Array.from({ length: 25 }, (_, index) => ({ ...scope, id: `slot-${index}`, run_id: run.id,
    slot_number: index + 1, position_quantity: index === 0 ? 1 : 0, position_committed_brl: index === 0 ? 10 : 0 }));
  const accounts = slots.map((slot) => ({ ...slot, balance_brl: 11, gain_count: 0 }));
  const orders = [{ ...scope, run_id: run.id, slot_id: "slot-0", side: "SELL", status: "NEW",
    client_order_id: "owned:tp", exchange_order_id: "tp-a", submission_guarded_at: known.last_seen_at,
    executed_quantity: 0, cumulative_quote: 0, reserved_notional_brl: 0 }];
  let alertReads = 0;
  const service = { from(table: string) {
    const filters: Record<string, unknown> = {};
    let mutation: Record<string, unknown> | null = null;
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
      } else if (table === "robot_v1_live_alerts") data = options.casLost ? [] : [{ id: "incident" }];
      else if (table === "robot_v1_live_runs") {
        if (mutation?.lease_owner) calls.push("lease-claimed");
        data = singular ? run : [run];
      } else if (table === "operators") data = scope;
      else if (table === "robot_v1_live_preparations") data = { ...scope, id: "prep", live_enabled: true,
        kill_switch: mutation?.kill_switch ?? true, max_total_exposure_brl: 275 };
      else if (table === "trading_engines") data = singular ? engine : [engine];
      else if (table === "robot_v1_live_slots") data = slots;
      else if (table === "robot_v1_live_slot_accounts") data = accounts;
      else if (table === "robot_v1_live_orders") data = orders;
      else if (table === "account_quote_caps") data = { hard_cap_quote: 275 };
      else if (table === "robot_v1_live_events") data = {};
      else assert.fail(`Unexpected table ${table}`);
      return { data, error: null };
    };
    const chain = {
      select: () => chain, eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
      is: (key: string, value: unknown) => { filters[key] = value; return chain; },
      in: () => chain, or: () => chain, gt: () => chain, order: () => chain,
      update: (data: Record<string, unknown>) => { mutation = data; return chain; },
      upsert: (data: Record<string, unknown>) => { mutation = data; return chain; },
      single: async () => response(true), maybeSingle: async () => response(true),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(response()).then(resolve),
    };
    return chain;
  } };
  const dependencies: Record<string, unknown> = {
    "node:crypto": { randomUUID: () => "lease" },
    "./live-read-recovery": { verifiedReadRecoveryAlert },
    "../supabase/env": { getSupabaseDataSchema: () => "coinops", getCoinOpsServiceTenantId: () => "tenant" },
    "../supabase/service-role": { createServiceRoleClient: () => service },
    "./operator-context-server": { resolveOperatorEngine: async () => engine },
    "./operator-context": { assertRowEngine: (row: Record<string, unknown>) => {
      assert.equal(row.trading_engine_id, "engine-a"); assert.equal(row.exchange_account_id, "account-a");
    } },
    "./strategy-engine": { STRATEGY_VERSION: "fixture-v1" },
    "./monthly-slot-server": { loadMonthlySlotStatuses: async () => [] },
    "./live-executor-health": { loadLiveEngineExecutorStatus: async () => {
      calls.push("health"); return { gate: options.healthy === false ? "ATTENTION" : "LIVE_EXECUTOR_PROTECTED" };
    } },
    "./live-executor-transport": { readLiveExecutorState: async () => {
      calls.push("exchange-state"); return { ...scope, filters: { quantityStep: 0.001 },
        price: { price: 630, observedAt: new Date().toISOString() }, observed_at: new Date().toISOString(),
        open_orders: options.missingTp ? [] : [{ id: "tp-a", side: "SELL", clientOrderId: "owned:tp" }] };
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
  return { run: () => resume("run-a", "user", "SOL", "VERIFIED_READ_RECOVERY"), calls, writes };
}

test("verified recovery claims lease, proves fresh health/protection and conditionally resolves only its incident", async () => {
  const scenario = fixture();
  assert.equal((await scenario.run()).status, "RESUMED");
  assert.deepEqual(scenario.calls, ["lease-claimed", "alert-read", "health", "exchange-state", "alert-read"]);
  const clear = scenario.writes.find((write) => write.table === "robot_v1_live_alerts" && write.data.resolved_at);
  assert.equal(clear?.filters.code, known.code);
  assert.equal(clear?.filters.last_seen_at, known.last_seen_at);
  assert.equal(clear?.filters.trading_engine_id, "engine-a");
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
