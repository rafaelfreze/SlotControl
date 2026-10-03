import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as manager from "./capacity-manager.ts";
import * as aggregation from "./capacity-aggregation.ts";
import * as reservations from "./admission-reservations.ts";
import * as environmentTelemetry from "./environment-telemetry.ts";
import * as testnetPolicy from "../execution/testnet-policy.ts";

// Historical transport fixtures stay offline; the default exercises retirement.
async function collect(testnetFailure = false, testnetAvailable = true, historicalTestnet = false) {
  const reads: string[] = [];
  const writes: Array<{ table: string; value: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; value: Record<string, unknown> }> = [];
  const now = new Date().toISOString();
  const service = { from(table: string) {
    reads.push(table);
    const filters: Record<string, unknown> = {};
    const query = () => {
      let data: unknown = [];
      if (table === "operators") data = [{ id: "operator" }];
      if (table === "executor_shards") data = [{ id: "executor-02", egress_ipv4: "192.0.2.2",
        enabled: true, binance_limit_per_min: 6000, admission_ratio: .65 }];
      if (table === "exchange_accounts") data = [{ id: "real-account", executor_shard_id: "executor-02" },
        { id: "testnet-account", executor_shard_id: "executor-02" }];
      if (table === "trading_engines") data = [{ id: filters.environment === "TESTNET" ? "testnet-engine" : "real-engine",
        exchange_account_id: filters.environment === "TESTNET" ? "testnet-account" : "real-account" }];
      if (table === "robot_v1_live_runs" || table === "robot_v1_testnet_runs") data = [{
        trading_engine_id: table === "robot_v1_testnet_runs" ? "testnet-engine" : "real-engine",
        status: "ACTIVE", last_reconciled_at: now, created_at: now, last_error: null }];
      return { data, error: testnetFailure && table === "robot_v1_testnet_runs" ? { message: "unavailable" } : null };
    };
    const chain = { select: () => chain, order: () => chain, in: () => chain, is: () => chain, gte: () => chain,
      eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
      upsert: async (value: Record<string, unknown>) => { writes.push({ table, value }); return { error: null }; },
      update: (value: Record<string, unknown>) => { updates.push({ table, value }); return chain; },
      lte: () => chain, gt: () => chain,
      then: (fn: (value: unknown) => unknown) => Promise.resolve(query()).then(fn) };
    return chain;
  } };
  const common = { shard_id: "executor-02", egress_ipv4: "192.0.2.2", heartbeat_at: now,
    weight_observed_at: now, binance_weight_samples: 3, cpu_percent: 5, ram_used_mb: 147, ram_limit_mb: 961,
    executor_version: "fixture", request_errors_last_5m: 0, probable_retries_last_5m: 0 };
  const sample = { ...common, binance_weight_current: 2200, binance_weight_average: 2300, binance_weight_peak: 2400,
    account_count: 1, engine_count: 1, account_ids: ["real-account"], engine_ids: ["real-engine"],
    environments: testnetAvailable ? { TESTNET: { ...common, binance_weight_current: 20,
      binance_weight_average: 25, binance_weight_peak: 30, registry_scope: "CREDENTIAL_BOUND_TRANSPORT",
      credential_account_ids: ["testnet-account", "inactive-account"] } } : undefined };
  const dependencies: Record<string, unknown> = {
    "../execution/testnet-policy": historicalTestnet
      ? { isTestnetEnabled: () => true } : testnetPolicy,
    "node:crypto": { randomUUID: () => "request" },
    "@/lib/execution/live-executor-client": { signedExecutorHeaders: () => ({}) },
    "@/lib/execution/executor-shards-server": { resolveExecutorShard: async () => ({
      base: "https://192.0.2.2", secret: "fixture", ip: "192.0.2.2" }), withExecutorShard: (value: unknown) => value },
    "@/lib/execution/binance-identity-server": {},
    "@/lib/execution/initial-identity-bootstrap": { bootstrapInitialIdentityBindings: async () => { throw Error("unavailable"); } },
    "@/lib/supabase/env": { getCoinOpsServiceTenantId: () => "tenant", getSupabaseDataSchema: () => "coinops" },
    "@/lib/supabase/service-role": { createServiceRoleClient: () => service },
    "./capacity-manager": manager, "./capacity-aggregation": aggregation,
    "./admission-reservations": reservations, "./environment-telemetry": environmentTelemetry,
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./capacity-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded: Record<string, unknown> = {};
  new Function("require", "exports", "fetch", compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name];
  }, loaded, async () => ({ ok: true, json: async () => sample }));
  await (loaded.refreshExecutorCapacity as () => Promise<unknown>)();
  return { writes, updates, reads };
}

test("offline historical collector preserves independent Testnet evidence and vault coverage", async () => {
  const { writes, updates } = await collect(false, true, true);
  const real = writes.find((row) => row.table === "executor_capacity_samples")!.value;
  const testnet = writes.find((row) => row.table === "executor_capacity_environment_samples")!.value;
  assert.equal(real.binance_weight_peak, 2400);
  assert.equal(testnet.binance_weight_peak, 30);
  assert.equal(testnet.environment, "TESTNET");
  assert.equal(testnet.registry_match, true);
  assert.equal(testnet.inventory_source, "LEDGER_CREDENTIAL_BOUND_TRANSPORT");
  assert.equal(testnet.account_count, 1);
  assert.equal(testnet.engine_count, 1);
  assert.ok(writes.indexOf(writes.find((row) => row.table === "executor_capacity_samples")!)
    < writes.indexOf(writes.find((row) => row.table === "executor_capacity_environment_samples")!));
  assert.equal(updates.filter((row) => row.table === "executor_capacity_admissions").length, 2,
    "fresh REAL and TESTNET samples consume only reservations already reflected by their own registries");
});

test("offline historical Testnet failure cannot invalidate Production telemetry", async () => {
  for (const { writes } of [await collect(true, true, true), await collect(false, false, true)]) {
    assert.equal(writes.filter((row) => row.table === "executor_capacity_samples").length, 1);
    assert.equal(writes.filter((row) => row.table === "executor_capacity_environment_samples").length, 0);
  }
});

test("retired Testnet never collects or writes even when the executor sends historical payload", async () => {
  const { writes, reads, updates } = await collect();
  assert.equal(testnetPolicy.isTestnetEnabled(), false);
  assert.equal(writes.filter((row) => row.table === "executor_capacity_samples").length, 1);
  assert.equal(writes.filter((row) => row.table === "executor_capacity_environment_samples").length, 0);
  assert.ok(!reads.includes("robot_v1_testnet_runs"));
  assert.equal(updates.filter((row) => row.table === "executor_capacity_admissions").length, 1);
});
