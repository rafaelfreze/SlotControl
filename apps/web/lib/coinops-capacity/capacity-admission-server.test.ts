import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as manager from "./capacity-manager.ts";
import * as reservations from "./admission-reservations.ts";
import * as environmentTelemetry from "./environment-telemetry.ts";

function fixture(environment: "REAL" | "TESTNET", realReserved = 0, testnetFresh = false, testnetReserved = 9000) {
  const calls: string[] = [];
  const now = new Date().toISOString();
  const rows: Record<string, unknown> = {
    exchange_accounts: { executor_shard_id: "executor-01", operator_id: "operator" },
    trading_engines: { environment, exchange_account_id: "account", operator_id: "operator" },
    executor_shards: { id: "executor-01", enabled: true, binance_limit_per_min: 6000,
      admission_ratio: .65, incremental_engine_weight: 900 },
    executor_capacity_samples: { shard_id: "executor-01", observed_at: now, heartbeat_at: now,
      weight_observed_at: now, binance_weight_current: 2200, binance_weight_average: 2300,
      binance_weight_peak: 2400, binance_weight_samples: 3, registry_match: true,
      cpu_percent: 5, ram_used_mb: 147, ram_limit_mb: 961, reconciliation_p95_ms: 1000,
      scheduler_backlog: 0, errors_last_5m: 0, retries_last_5m: 0, account_count: 4, engine_count: 7 },
    // Deliberately return all scopes to prove the helper also filters defensively.
    executor_capacity_admissions: [
      { shard_id: "executor-01", environment: "REAL", reserved_weight: realReserved },
      { shard_id: "executor-01", environment: "TESTNET", reserved_weight: testnetReserved },
      { shard_id: "executor-02", environment: "REAL", reserved_weight: 9000 },
    ],
  };
  rows.executor_capacity_environment_samples = testnetFresh
    ? { ...(rows.executor_capacity_samples as Record<string, unknown>), environment: "TESTNET",
      binance_weight_current: 20, binance_weight_average: 25, binance_weight_peak: 30 } : null;
  const service = { from(table: string) {
    calls.push(`read:${table}`);
    const result = { data: rows[table], error: null };
    const chain = { select: () => chain, eq: () => chain, gt: () => chain,
      single: async () => result, maybeSingle: async () => result,
      then: (fn: (value: unknown) => unknown) => Promise.resolve(result).then(fn) };
    return chain;
  }, rpc: async () => { calls.push("reserve"); return {
    data: environment === "TESTNET" && !testnetFresh ? "CAPACITY_UNKNOWN" : "CAPACITY_OK", error: null }; } };
  const dependencies: Record<string, unknown> = {
    "node:crypto": {}, "@/lib/execution/live-executor-client": {},
    "@/lib/execution/executor-shards-server": {},
    "@/lib/execution/binance-identity-server": { requireAccountIdentityBinding: async () => { calls.push("identity"); } },
    "@/lib/execution/initial-identity-bootstrap": { requireLiveIdentityCoverage: async () => { calls.push("coverage"); } },
    "@/lib/supabase/env": { getCoinOpsServiceTenantId: () => "tenant" }, "@/lib/supabase/service-role": {},
    "./capacity-manager": manager, "./capacity-aggregation": {}, "./admission-reservations": reservations,
    "./environment-telemetry": environmentTelemetry,
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./capacity-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name];
  }, loaded);
  const preview = loaded.previewAccountCapacity as
    (service: unknown, account: string, count: number, environment: string) => Promise<{ code: string }>;
  const reserve = loaded.reserveEngineCapacity as
    (service: unknown, engine: string, account: string) => Promise<{ status: string }>;
  return { calls, preview: () => preview(service, "account", 1, environment),
    reserve: () => reserve(service, "engine", "account") };
}

test("Production preview retains 900-per-engine/65-percent gate without invented Testnet weight", async () => {
  assert.equal((await fixture("REAL").preview()).code, "CAPACITY_OK");
  assert.equal((await fixture("REAL", 900).preview()).code, "CAPACITY_REQUIRED");
});

test("new Testnet preview and final activation fail closed before reservation writes without own telemetry", async () => {
  const scenario = fixture("TESTNET");
  assert.equal((await scenario.preview()).code, "CAPACITY_UNKNOWN");
  await assert.rejects(scenario.reserve(), /COINOPS_CAPACITY_UNKNOWN/);
  assert.ok(scenario.calls.includes("read:executor_capacity_environment_samples"));
  assert.ok(!scenario.calls.includes("read:executor_capacity_samples"));
  assert.deepEqual(scenario.calls.slice(-4), ["read:exchange_accounts", "read:trading_engines", "identity", "reserve"]);
});

test("fresh Testnet telemetry permits final admission using its own independent reservations", async () => {
  const scenario = fixture("TESTNET", 9000, true, 0);
  assert.equal((await scenario.preview()).code, "CAPACITY_OK", "Production's 9000 must not be charged to Testnet");
  assert.equal((await fixture("TESTNET", 0, true, 9000).preview()).code, "CAPACITY_REQUIRED");
  assert.equal((await scenario.reserve()).status, "CAPACITY_OK");
});

test("Production final reservation still requires identity before serialized capacity RPC", async () => {
  const scenario = fixture("REAL");
  assert.equal((await scenario.reserve()).status, "CAPACITY_OK");
  assert.deepEqual(scenario.calls, ["read:exchange_accounts", "read:trading_engines", "coverage", "identity", "reserve"]);
});
