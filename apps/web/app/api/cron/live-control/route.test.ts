import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isIdentity } from "../../../../lib/execution/operator-context.ts";

const localRequire = createRequire(import.meta.url);
const ts = localRequire("typescript") as typeof import("typescript");
const next = localRequire("next/server") as typeof import("next/server");
const account = "10000000-0000-4000-8000-000000000001";
const engineId = "20000000-0000-4000-8000-000000000001";
const runId = "30000000-0000-4000-8000-000000000001";
const secret = "offline-test-only-control-key-00000000";
const owner = { tenant_id: "tenant", user_id: "owner", product_id: "coinops" };

function fixture(options: { status?: string; health?: string; count?: number; product?: string;
  error?: boolean; coreError?: string; cronEnabled?: boolean; environment?: string; schema?: string } = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const engine = { trading_engine_id: engineId, exchange_account_id: account, executor_shard_id: "executor-02" };
  const service = { from(table: string) {
    const filters: Record<string, unknown> = {};
    const response = table === "operators" ? { data: [owner], error: null } : {
      data: Array.from({ length: options.count ?? 1 }, () => ({ id: runId,
        status: options.status ?? "PAUSED", product_id: options.product ?? "coinops" })),
      error: options.error ? { code: "57014" } : null };
    const query = { select: () => query,
      eq: (key: string, value: unknown) => { filters[key] = value; return query; },
      in: (key: string, value: unknown) => { filters[key] = value; return query; },
      then: (resolve: (value: unknown) => unknown) => {
        calls.push({ name: table, args: [filters] }); return Promise.resolve(response).then(resolve);
      } };
    return query;
  }, rpc: async (...args: unknown[]) => {
    calls.push({ name: "activate", args }); return { data: { id: runId, status: "ACTIVE" }, error: null };
  } };
  const deps = {
    "next/server": next,
    "@/lib/execution/live-executor-health": { loadLiveEngineExecutorStatus: async () => ({ gate: options.health ?? "LIVE_EXECUTOR_ACTIVE" }) },
    "@/lib/execution/operator-context-server": { resolveOperatorEngine: async (_db: unknown, op: unknown, selection: unknown) => {
      assert.equal(op, owner); calls.push({ name: "resolve", args: [selection] }); return engine;
    } },
    "@/lib/execution/robot-v1-live-cycle": { liveEngineOrderPrefix: () => "own-engine:" },
    "@/lib/execution/operator-context": { isIdentity },
    "@/lib/execution/live-executor-transport": { readLiveExecutorState: async () => {
      calls.push({ name: "exchange", args: [] }); return { observed_at: new Date().toISOString(), open_orders: [] };
    } },
    "@/lib/execution/robot-v1-live-server": {
      prepareLiveCycle: async (...args: unknown[]) => { calls.push({ name: "prepare", args }); return runId; },
      resumeLiveRun: async (...args: unknown[]) => {
        calls.push({ name: "resume", args });
        if (options.coreError) throw new Error(options.coreError);
        return { status: "RESUMED", cycle_id: runId };
      } },
    "@/lib/supabase/env": { getSupabaseDataSchema: () => options.schema ?? "coinops", getCoinOpsServiceTenantId: () => "tenant" },
    "@/lib/supabase/service-role": { createServiceRoleClient: () => service },
    "@/lib/coinops-capacity/capacity-server": { reserveEngineCapacity: async (...args: unknown[]) => { calls.push({ name: "reserve", args }); } },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./route.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: { POST?: (request: import("next/server").NextRequest) => Promise<Response> } = {};
  new Function("require", "exports", "process", compiled)((name: keyof typeof deps) => {
    assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name];
  }, exports, { env: { COINOPS_LIVE_CONTROL_SECRET: secret, VERCEL_ENV: options.environment ?? "production",
    COINOPS_LIVE_CRON_ENABLED: options.cronEnabled === false ? "false" : "true" } });
  return { post: exports.POST!, calls };
}

function request(action = "RESUME", auth = secret, host = "cripto-flax.vercel.app", extras = {}) {
  return new next.NextRequest(`https://${host}/api/cron/live-control`, { method: "POST",
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({ action, asset: "SOL", exchange_account_id: account, trading_engine_id: engineId, ...extras }) });
}

test("intentional PAUSED and blocked ACTIVE use canonical RESUME, exact engine/run, never activation or order transport", async () => {
  for (const status of ["PAUSED", "ACTIVE"]) for (const health of ["LIVE_EXECUTOR_ACTIVE", "LIVE_EXECUTOR_PROTECTED"]) {
    const api = fixture({ status, health }); const result = await api.post(request());
    assert.equal(result.status, 200); assert.deepEqual(await result.json(), { status: "RESUMED", cycle_id: runId });
    assert.deepEqual(api.calls.find(call => call.name === "resolve")?.args, [{ environment: "REAL", asset: "SOL",
      exchange_account_id: account, trading_engine_id: engineId }]);
    assert.deepEqual(api.calls.find(call => call.name === "robot_v1_live_runs")?.args, [{ tenant_id: "tenant", user_id: "owner",
      trading_engine_id: engineId, status: ["PREPARING", "ACTIVE", "PAUSED"] }]);
    assert.deepEqual(api.calls.filter(call => call.name === "resume"), [{ name: "resume", args: [runId, "owner", "SOL"] }]);
    assert.equal(api.calls.some(call => ["reserve", "activate", "exchange", "prepare"].includes(call.name)), false);
  }
});

test("resume denies PREPARING, terminal/unknown, incomplete/ambiguous runs and foreign product before canonical mutation", async () => {
  for (const options of [{ status: "PREPARING" }, { status: "COMPLETED" }, { status: "UNKNOWN" },
    { count: 0 }, { count: 2 }, { product: "other" }, { error: true }]) {
    const api = fixture(options); const result = await api.post(request());
    assert.equal(result.status, 503); assert.deepEqual(await result.json(), { error: "COINOPS_LIVE_RUN_GATE_DENIED" });
    assert.equal(api.calls.some(call => call.name === "resume"), false);
  }
});

test("resume retains health, cron, scope, secret and no-extra-financial-input gates", async () => {
  for (const health of ["LIVE_EXECUTOR_READY", "ATTENTION", "UNCONFIGURED"]) {
    const api = fixture({ health }); assert.equal((await api.post(request())).status, 503);
    assert.equal(api.calls.some(call => call.name === "resume"), false);
  }
  for (const options of [{ cronEnabled: false }, { environment: "preview" }, { schema: "public" }]) {
    const api = fixture(options); assert.notEqual((await api.post(request())).status, 200);
    assert.equal(api.calls.some(call => call.name === "resume"), false);
  }
  for (const req of [request("RESUME", "invalid"), request("RESUME", secret, "other.test"),
    request("RESUME", secret, "cripto-flax.vercel.app", { amount: 50 })]) {
    const api = fixture(); assert.notEqual((await api.post(req)).status, 200); assert.deepEqual(api.calls, []);
  }
});

test("canonical protection/ownership/lease rejection is propagated without retry or bypass", async () => {
  for (const coreError of ["COINOPS_LIVE_RESUME_LEASE_BUSY", "COINOPS_LIVE_RESUME_GATE_DENIED", "COINOPS_LIVE_TP_REQUIRED"]) {
    const api = fixture({ coreError }); const result = await api.post(request());
    assert.equal(result.status, 503); assert.deepEqual(await result.json(), { error: coreError });
    assert.equal(api.calls.filter(call => call.name === "resume").length, 1);
    assert.equal(api.calls.some(call => ["reserve", "activate", "exchange"].includes(call.name)), false);
  }
});

test("RESUME requires explicit account and engine UUIDs, never implicit legacy account/symbol fallback", async () => {
  for (const extras of [
    { exchange_account_id: undefined, trading_engine_id: undefined }, { exchange_account_id: undefined },
    { trading_engine_id: undefined }, { exchange_account_id: null }, { trading_engine_id: null },
    { exchange_account_id: "" }, { trading_engine_id: "SOLBRL" }, { exchange_account_id: 5 },
  ]) {
    const api = fixture(); const result = await api.post(request("RESUME", secret, "cripto-flax.vercel.app", extras));
    assert.equal(result.status, 400); assert.deepEqual(await result.json(), { error: "COINOPS_LIVE_CONTROL_INVALID" });
    assert.deepEqual(api.calls, []);
  }
});

test("ACTIVATE remains PREPARING and ACTIVE-health only; PREPARE remains READY-health only", async () => {
  for (const status of ["ACTIVE", "PAUSED"]) {
    const api = fixture({ status }); assert.equal((await api.post(request("ACTIVATE"))).status, 503);
    assert.equal(api.calls.some(call => call.name === "activate"), false);
  }
  const protectedActivation = fixture({ status: "PREPARING", health: "LIVE_EXECUTOR_PROTECTED" });
  assert.equal((await protectedActivation.post(request("ACTIVATE"))).status, 503);
  const activePreparation = fixture(); assert.equal((await activePreparation.post(request("PREPARE"))).status, 503);
  const prepare = fixture({ health: "LIVE_EXECUTOR_READY" }); assert.equal((await prepare.post(request("PREPARE"))).status, 200);
  const activate = fixture({ status: "PREPARING" }); assert.equal((await activate.post(request("ACTIVATE"))).status, 200);
  assert.equal(activate.calls.filter(call => call.name === "activate").length, 1);
  assert.equal(activate.calls.some(call => call.name === "resume"), false);
});
