import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isIdentity, resolveEngineContext } from "../../../lib/execution/operator-context.ts";

const localRequire = createRequire(import.meta.url);
const ts = localRequire("typescript") as typeof import("typescript");
const next = localRequire("next/server") as typeof import("next/server");
const ids = {
  operator: "10000000-0000-4000-8000-000000000001", tenant: "20000000-0000-4000-8000-000000000001",
  owner: "30000000-0000-4000-8000-000000000001", viewer: "30000000-0000-4000-8000-000000000002",
  product: "40000000-0000-4000-8000-000000000001", account: "50000000-0000-4000-8000-000000000001",
  otherAccount: "50000000-0000-4000-8000-000000000002", engine: "60000000-0000-4000-8000-000000000001",
  sibling: "60000000-0000-4000-8000-000000000002", otherEngine: "60000000-0000-4000-8000-000000000003",
  run: "70000000-0000-4000-8000-000000000001", siblingRun: "70000000-0000-4000-8000-000000000002",
  otherRun: "70000000-0000-4000-8000-000000000003", request: "80000000-0000-4000-8000-000000000001",
  stranger: "90000000-0000-4000-8000-000000000001",
};
type RecordValue = Record<string, unknown>;
type Options = { actor?: "owner" | "viewer" | "anonymous"; environment?: string; schema?: string;
  runStatus?: string; engineStatus?: string; canHide?: boolean; snapshotFailure?: boolean;
  pauseError?: string; preferenceError?: boolean; operatorKill?: boolean };

function fixture(options: Options = {}) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const operator = { id: ids.operator, product_id: ids.product, tenant_id: ids.tenant, user_id: ids.owner,
    status: "ACTIVE", kill_switch: options.operatorKill ?? false };
  const account = { id: ids.account, operator_id: ids.operator, display_name: "Account A", status: "ACTIVE",
    kill_switch: false, is_legacy_default: false, executor_shard_id: "executor-02" };
  const otherAccount = { ...account, id: ids.otherAccount, display_name: "Account B" };
  const engine = { id: ids.engine, operator_id: ids.operator, exchange_account_id: ids.account,
    environment: "REAL" as const, symbol: "SOLBRL", base_asset: "SOL", quote_asset: "BRL",
    status: options.engineStatus ?? "ACTIVE", kill_switch: false, legacy_compatible: false,
    hard_cap_quote: 275, executor_shard_id: "executor-02" };
  const registry = { operator, accounts: [account, otherAccount], engines: [engine,
    { ...engine, id: ids.sibling, executor_shard_id: "executor-03" },
    { ...engine, id: ids.otherEngine, exchange_account_id: ids.otherAccount }] };
  const runs = [
    { id: ids.run, status: options.runStatus ?? "ACTIVE", operator_id: ids.operator,
      exchange_account_id: ids.account, trading_engine_id: ids.engine, tenant_id: ids.tenant, user_id: ids.owner },
    { id: ids.siblingRun, status: "ACTIVE", operator_id: ids.operator,
      exchange_account_id: ids.account, trading_engine_id: ids.sibling, tenant_id: ids.tenant, user_id: ids.owner },
    { id: ids.otherRun, status: "ACTIVE", operator_id: ids.operator,
      exchange_account_id: ids.otherAccount, trading_engine_id: ids.otherEngine, tenant_id: ids.tenant, user_id: ids.owner },
  ];
  const service = { from(table: string) {
    assert.equal(table, "robot_v1_live_runs");
    const filters: RecordValue = {};
    const query = { select: () => query,
      eq: (key: string, value: unknown) => { filters[key] = value; return query; },
      in: (key: string, value: unknown[]) => { filters[`in:${key}`] = value; return query; },
      maybeSingle: async () => {
        calls.push({ name: "read-run", args: [filters] });
        const result = runs.filter(row => Object.entries(filters).every(([key, value]) =>
          key.startsWith("in:") ? (value as unknown[]).includes(row[key.slice(3) as keyof typeof row])
            : row[key as keyof typeof row] === value));
        return { data: result.length === 1 ? result[0] : null, error: null };
      } };
    return query;
  }, rpc: async (name: string, args: RecordValue) => {
    calls.push({ name: "preference-rpc", args: [name, args] });
    return options.preferenceError ? { data: null, error: { code: "57014" } }
      : { data: { hidden: args.p_hidden }, error: null };
  } };
  const authClient = { auth: { getUser: async () => ({ data: { user: options.actor === "anonymous" ? null
    : { id: options.actor === "viewer" ? ids.viewer : ids.owner } } }) }, from(table: string) {
    assert.equal(table, "operators");
    const filters: RecordValue = {};
    const query = { select: () => query,
      eq: (key: string, value: unknown) => { filters[key] = value; return query; },
      single: async () => {
        calls.push({ name: "owner-auth", args: [filters] });
        const matches = filters.tenant_id === ids.tenant && filters.user_id === ids.owner && filters.status === "ACTIVE";
        return { data: matches ? operator : null, error: matches ? null : { code: "PGRST116" } };
      } };
    return query;
  } };
  const dependencies = {
    "next/server": next,
    "node:crypto": { randomUUID: () => ids.request },
    "@/lib/supabase/env": { getSupabaseDataSchema: () => options.schema ?? "coinops", getCoinOpsServiceTenantId: () => ids.tenant },
    "@/lib/supabase/server": { createClient: () => authClient },
    "@/lib/supabase/service-role": { createServiceRoleClient: () => { calls.push({ name: "service-client", args: [] }); return service; } },
    "@/lib/execution/operator-context": { isIdentity, resolveEngineContext },
    "@/lib/execution/operator-context-server": { loadOperatorRegistry: async (db: unknown, op: unknown) => {
      assert.equal(db, service); assert.deepEqual(op, operator); return registry;
    } },
    "@/lib/execution/account-pause-home-server": { loadAccountPauseHome: async (db: unknown, loadedRegistry: unknown, accountId: string) => {
      assert.equal(db, service); assert.equal(loadedRegistry, registry);
      calls.push({ name: "snapshot", args: [accountId] });
      if (options.snapshotFailure) throw new Error("COINOPS_ACCOUNT_PAUSE_SNAPSHOT_UNAVAILABLE");
      return { accountId, canHide: options.canHide ?? true,
        engines: [{ engineId: ids.engine }, { engineId: ids.sibling }] };
    } },
    "@/lib/execution/robot-v1-live-server": { pauseLiveRun: async (...args: unknown[]) => {
      calls.push({ name: "pause-core", args });
      if (options.pauseError) throw new Error(options.pauseError);
      return { status: "PAUSED", cycle_id: args[0] };
    } },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./route.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: { GET?: (request: import("next/server").NextRequest) => Promise<Response>;
    POST?: (request: import("next/server").NextRequest) => Promise<Response> } = {};
  new Function("require", "exports", "process", compiled)((name: keyof typeof dependencies) => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name];
  }, exports, { env: { VERCEL_ENV: options.environment ?? "production" } });
  return { GET: exports.GET!, POST: exports.POST!, calls };
}

const origin = "https://cripto-flax.vercel.app";
type RequestOptions = { url?: string; headers?: Record<string, string>; omit?: string[] };
function request(body: RecordValue, options: RequestOptions = {}) {
  const headers: Record<string, string> = { origin, "content-type": "application/json", "sec-fetch-site": "same-origin",
    "x-coinops-admin-intent": "account-pause", ...options.headers };
  for (const key of options.omit ?? []) delete headers[key];
  return new next.NextRequest(options.url ?? `${origin}/api/coinops-account-pause`,
    { method: "POST", headers, body: JSON.stringify(body) });
}
const pauseInput = { action: "PAUSE_ENGINE", accountId: ids.account, engineId: ids.engine, runId: ids.run };
const hideInput = { action: "HIDE_PAUSED", accountId: ids.account, expectedEngineIds: [ids.sibling, ids.engine], requestId: ids.request };
const mutations = (api: ReturnType<typeof fixture>) => api.calls.filter(call => ["pause-core", "preference-rpc"].includes(call.name));

test("owner GET uses authenticated scope; anonymous and VIEWER never obtain service or invoke financial control", async () => {
  const owner = fixture();
  assert.equal((await owner.GET(new next.NextRequest(`${origin}/api/coinops-account-pause?account=${ids.account}`))).status, 200);
  assert.deepEqual(owner.calls.find(call => call.name === "snapshot")?.args, [ids.account]);
  for (const [actor, expected] of [["anonymous", 401], ["viewer", 403]] as const) {
    const api = fixture({ actor });
    assert.equal((await api.GET(new next.NextRequest(`${origin}/api/coinops-account-pause?account=${ids.account}`))).status, expected);
    assert.equal((await api.POST(request(pauseInput))).status, expected);
    assert.equal(api.calls.some(call => call.name === "service-client"), false);
    assert.deepEqual(mutations(api), []);
  }
});

test("POST requires Production canonical host, same-origin JSON and explicit admin intent before auth", async () => {
  const variants: RequestOptions[] = [
    { url: "https://other.test/api/coinops-account-pause" },
    { headers: { origin: "https://other.test" } }, { headers: { "sec-fetch-site": "cross-site" } },
    { headers: { "content-type": "text/plain" } }, { omit: ["x-coinops-admin-intent"] }, { omit: ["origin"] },
  ];
  for (const variant of variants) {
    const api = fixture();
    const response = await api.POST(request(pauseInput, variant));
    assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: "COINOPS_ACCOUNT_PAUSE_ORIGIN_DENIED" });
    assert.deepEqual(api.calls, []);
  }
  const preview = fixture({ environment: "preview" });
  assert.equal((await preview.POST(request(pauseInput))).status, 403); assert.deepEqual(preview.calls, []);
});

test("one PAUSE_ENGINE request calls only its exact canonical engine/run and owner; persisted PAUSED retry revalidates core", async () => {
  for (const runStatus of ["ACTIVE", "PAUSED"]) {
    const api = fixture({ runStatus });
    assert.equal((await api.POST(request({ ...pauseInput, operatorId: ids.stranger, userId: ids.stranger,
      tenantId: ids.stranger, symbol: "BTCUSDT", executorShardId: "executor-99" }))).status, 200);
    assert.deepEqual(mutations(api), [{ name: "pause-core", args: [ids.run, ids.owner, "SOL"] }]);
    assert.deepEqual(api.calls.find(call => call.name === "read-run")?.args, [{ operator_id: ids.operator,
      exchange_account_id: ids.account, trading_engine_id: ids.engine, tenant_id: ids.tenant, user_id: ids.owner,
      "in:status": ["ACTIVE", "PAUSED", "PREPARING"] }]);
    assert.equal(api.calls.some(call => call.name === "snapshot"), false);
  }
});

test("cross-account, cross-engine and forged run IDs cannot pause a sibling or foreign motor", async () => {
  for (const body of [
    { ...pauseInput, accountId: ids.stranger }, { ...pauseInput, accountId: ids.otherAccount },
    { ...pauseInput, engineId: ids.otherEngine }, { ...pauseInput, engineId: ids.stranger },
    { ...pauseInput, runId: ids.siblingRun }, { ...pauseInput, runId: ids.otherRun },
  ]) {
    const api = fixture(); assert.equal((await api.POST(request(body))).status, 403);
    assert.deepEqual(mutations(api), []);
  }
});

test("PREPARING run and inactive engine are never treated as operational pause; busy/unknown core errors do not hide account", async () => {
  for (const options of [{ runStatus: "PREPARING" }, { engineStatus: "INACTIVE" }]) {
    const api = fixture(options); assert.equal((await api.POST(request(pauseInput))).status, 403);
    assert.deepEqual(mutations(api), []);
  }
  for (const [pauseError, status] of [["COINOPS_LIVE_PAUSE_LEASE_BUSY", 409], ["COINOPS_LIVE_PAUSE_BUY_UNRESOLVED", 403]] as const) {
    const api = fixture({ runStatus: "PAUSED", pauseError });
    assert.equal((await api.POST(request(pauseInput))).status, status);
    assert.deepEqual(mutations(api), [{ name: "pause-core", args: [ids.run, ids.owner, "SOL"] }]);
  }
});

test("HIDE requires full current proof and exact inventory, never caller-supplied canHide or incomplete/duplicate IDs", async () => {
  for (const expectedEngineIds of [[ids.engine], [ids.engine, ids.engine], [ids.engine, ids.otherEngine],
    [ids.engine, ids.sibling, ids.otherEngine], ["invalid", ids.sibling]]) {
    const api = fixture(); const response = await api.POST(request({ ...hideInput, expectedEngineIds, canHide: true }));
    assert.equal(response.status, 403); assert.deepEqual(mutations(api), []);
  }
  const unproven = fixture({ canHide: false });
  assert.equal((await unproven.POST(request({ ...hideInput, canHide: true, protectionVerified: true }))).status, 403);
  assert.deepEqual(mutations(unproven), []);
  const unavailable = fixture({ snapshotFailure: true });
  assert.equal((await unavailable.POST(request(hideInput))).status, 503); assert.deepEqual(mutations(unavailable), []);
});

test("HIDE preference RPC uses service-only server ownership and verified inventory, never financial pause or attacker metadata", async () => {
  const api = fixture();
  const response = await api.POST(request({ ...hideInput, operatorId: ids.stranger, userId: ids.stranger, tenantId: ids.stranger,
    p_operator_id: ids.stranger, p_user_id: ids.stranger, p_account_id: ids.otherAccount, hidden: false }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accountId: ids.account, hidden: true, status: "PAUSED_HIDDEN" });
  assert.deepEqual(mutations(api), [{ name: "preference-rpc", args: ["set_account_home_preference", {
    p_operator_id: ids.operator, p_account_id: ids.account, p_user_id: ids.owner, p_hidden: true,
    p_request_id: ids.request, p_expected_engine_ids: [ids.engine, ids.sibling],
  }] }]);
});

test("SHOW is nonfinancial and works during financial-snapshot outage without running pause/resume or snapshot", async () => {
  const api = fixture({ snapshotFailure: true, canHide: false });
  const response = await api.POST(request({ action: "SHOW", accountId: ids.account, operatorId: ids.stranger,
    userId: ids.stranger, expectedEngineIds: [ids.stranger] }));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { accountId: ids.account, hidden: false, status: "VISIBLE" });
  assert.equal(api.calls.some(call => ["snapshot", "pause-core", "read-run"].includes(call.name)), false);
  assert.deepEqual(mutations(api), [{ name: "preference-rpc", args: ["set_account_home_preference", {
    p_operator_id: ids.operator, p_account_id: ids.account, p_user_id: ids.owner, p_hidden: false,
    p_request_id: ids.request, p_expected_engine_ids: null,
  }] }]);
});

test("invalid request id, unsupported commands, wrong schema and failed preference write cannot report success", async () => {
  const invalid = fixture();
  assert.equal((await invalid.POST(request({ ...hideInput, requestId: "invalid" }))).status, 403);
  assert.deepEqual(mutations(invalid), []);
  const unsupported = fixture();
  assert.equal((await unsupported.POST(request({ action: "RESUME", accountId: ids.account }))).status, 403);
  assert.deepEqual(unsupported.calls, []);
  const wrongSchema = fixture({ schema: "public" });
  assert.equal((await wrongSchema.POST(request(pauseInput))).status, 403); assert.deepEqual(wrongSchema.calls, []);
  const failed = fixture({ preferenceError: true });
  const result = await failed.POST(request({ action: "SHOW", accountId: ids.account }));
  assert.equal(result.status, 503); assert.deepEqual(await result.json(), { error: "COINOPS_ACCOUNT_PAUSE_PREFERENCE_UNAVAILABLE" });
});
