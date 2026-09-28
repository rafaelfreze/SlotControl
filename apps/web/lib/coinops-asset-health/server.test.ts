import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as policy from "./collector-policy.ts";
import * as rules from "./rules.ts";

const localRequire = createRequire(import.meta.url);
const ts = localRequire("typescript") as typeof import("typescript");
function load(file: string, imports: Record<string, unknown>): Record<string, (...args: any[]) => any> {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", code)((name: string) => {
    if (name === "node:crypto") return localRequire(name);
    if (!(name in imports)) throw new Error(`FORBIDDEN_IMPORT:${name}`);
    return imports[name];
  }, mod, mod.exports);
  return mod.exports;
}
function query(data: unknown, error: unknown = null, record?: (method: string, args: unknown[]) => void) {
  const q: Record<string, any> = {};
  for (const method of ["select", "eq", "neq", "gte", "order", "limit", "update"])
    q[method] = (...args: unknown[]) => { record?.(method, args); return q; };
  q.single = q.maybeSingle = async () => ({ data, error });
  q.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error }).then(resolve);
  return q;
}
const now = new Date("2026-09-27T12:00:00Z");
const snapshotView = load("./snapshot-view.ts", { "./rules": rules });
test("cadences split fast30m, structural6h, development24h and stale does not imply structural risk", () => {
  assert.deepEqual(policy.dueCadences(null, now), ["FAST", "STRUCTURAL", "DEVELOPMENT"]);
  const state = { status: "HEALTHY", last_run_at: now.toISOString(), last_success_at: now.toISOString(),
    cadence_completed_at: { FAST: "2026-09-27T11:30:00Z", STRUCTURAL: "2026-09-27T08:00:00Z", DEVELOPMENT: "2026-09-27T00:00:00Z" } };
  assert.deepEqual(policy.dueCadences(state, now), ["FAST"]);
  assert.equal(policy.collectorStatus(state, now).status, "HEALTHY");
  assert.equal(policy.collectorStatus({ ...state, last_success_at: "2026-09-27T09:00:00Z" }, now).status, "STALE");
  assert.equal(policy.collectorStatus({ ...state, status: "DEGRADED" }, now).status, "FAILED");
  assert.equal(policy.collectorStatus(null, now).status, "NOT_RUN");
  assert.equal(policy.historyDays("100000"), 30);
});

function worker(options: { claimed?: boolean; finish?: boolean; collectionError?: boolean; readError?: boolean } = {}) {
  const calls: Array<{ name: string; args?: any }> = [];
  const service = {
    from(table: string) {
      assert.ok(["asset_health_collector_state", "asset_health_current", "asset_health_events", "executor_shards", "executor_capacity_samples"].includes(table), `Forbidden table: ${table}`);
      calls.push({ name: table });
      return query(table === "asset_health_collector_state" ? { status: "RUNNING", cadence_completed_at: {} } : [], options.readError ? {} : null,
        (method) => assert.equal(method === "update", false, "Page/worker reads cannot directly mutate rows"));
    },
    async rpc(name: string, args: unknown) {
      assert.match(name, /^asset_health_(claim|finish|fail)$/);
      calls.push({ name, args });
      return { data: name === "asset_health_claim" ? options.claimed !== false : name === "asset_health_finish" ? options.finish !== false : true, error: null };
    },
  };
  const code = load("./server.ts", { "server-only": {}, "./access": { assetHealthService: () => service },
    "./collector-policy": policy, "./rules": rules, "./snapshot-view": snapshotView,
    "./binance": { collectBinanceMetrics: async () => [], mergeBinanceMetrics: () => [],
      deriveBinanceHealth: ({ now }: { now: Date }) => ({ asset: "BINANCE", status: "INSUFFICIENT_DATA", metrics: [],
        reasons: [], sources: [], trigger: "NO_EVIDENCE", evaluatedAt: now.toISOString(), validUntil: now.toISOString() }) },
    "./sources": { collectAssetHealthMetrics: async (cadences: unknown) => {
      calls.push({ name: "collect", args: cadences }); if (options.collectionError) throw new Error("SECRET_AND_RAW_URL_NOT_LOGGED"); return [];
    } } });
  return { calls, code };
}
test("worker acquires lease before source requests and atomically persists BTC, SOL and Binance", async () => {
  const w = worker();
  const result = await w.code.syncAssetHealth();
  assert.equal(result.status, "SYNCED");
  assert.equal(w.calls[0].name, "asset_health_claim");
  const save = w.calls.find((item) => item.name === "asset_health_finish")!;
  assert.deepEqual(save.args.p_snapshots.map((item: { asset: string }) => item.asset), ["BTC", "SOL", "BINANCE"]);
  assert.equal(save.args.p_token, w.calls[0].args.p_token);
  assert.equal(save.args.p_snapshots[0].status, "INSUFFICIENT_DATA");
  assert.equal(w.calls.filter((item) => item.name === "collect").length, 1);
});
test("duplicate worker/cooldown has no source queries or writes beyond claim", async () => {
  const w = worker({ claimed: false });
  assert.equal((await w.code.syncAssetHealth()).status, "SKIPPED_LOCK_OR_COOLDOWN");
  assert.deepEqual(w.calls.map((item) => item.name), ["asset_health_claim"]);
});
test("stale lease cannot report successful finish and fails only its own token", async () => {
  const w = worker({ finish: false });
  await assert.rejects(w.code.syncAssetHealth(), /FINISH_FAILED/);
  assert.equal(w.calls.at(-1)!.name, "asset_health_fail");
  assert.equal(w.calls.at(-1)!.args.p_token, w.calls[0].args.p_token);
});
test("source crash is sanitized and current snapshots are never overwritten by partial commit", async () => {
  const w = worker({ collectionError: true });
  await assert.rejects(w.code.syncAssetHealth(), /COINOPS_ASSET_HEALTH_SYNC_FAILED/);
  assert.equal(w.calls.some((item) => item.name === "asset_health_finish"), false);
  assert.equal(w.calls.at(-1)!.args.p_error_code, "COINOPS_ASSET_HEALTH_SYNC_FAILED");
});
test("GET snapshot is strictly persisted read only, bounded history and no collection", async () => {
  const w = worker();
  const result = await w.code.loadAssetHealthDashboard(365);
  assert.equal(result.collector.status, "NOT_RUN");
  assert.equal(w.calls.some((item) => item.name === "collect" || item.name.startsWith("asset_health_claim")), false);
  const failed = worker({ readError: true });
  await assert.rejects(failed.code.loadAssetHealthDashboard(), /READ_FAILED/);
});
test("page reads never extend snapshot validity or promote a new structural status", () => {
  const original = { ...rules.deriveAssetHealth({ asset: "BTC", metrics: [], now }), previousStatus: null,
    status: "ATTENTION" as const, validUntil: "2026-09-27T12:30:00Z" };
  const expired = snapshotView.snapshotForDisplay(original, new Date("2026-09-27T14:00:00Z"));
  assert.equal(expired.status, "INSUFFICIENT_DATA");
  assert.equal(expired.validUntil, original.validUntil);
  assert.equal(expired.evaluatedAt, original.evaluatedAt);
  assert.equal(original.status, "ATTENTION");
});

function access(options: { auth?: boolean; role?: string; operator?: boolean; binding?: boolean; account?: boolean; schema?: string } = {}) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  return { calls, code: load("./access.ts", { "server-only": {},
    "../supabase/env": { getSupabaseDataSchema: () => options.schema ?? "coinops", getCoinOpsServiceTenantId: () => "official-tenant" },
    "../supabase/server": { createClient: () => ({ auth: { getUser: async () => ({ data: { user: options.auth === false ? null
      : { id: "user", app_metadata: { coinops_role: options.role } } }, error: null }) } }) },
    "../supabase/service-role": { createServiceRoleClient: () => ({ from(table: string) {
      const data = table === "operators" ? options.operator === false ? null : { id: "op" }
        : table === "viewer_access" ? options.binding === false ? null : { operator_id: "op", exchange_account_id: "account" }
          : options.account === false ? null : { id: "account" };
      return query(data, null, (method, args) => {
        // Accounts inherit tenant scope through operator_id; this table has no tenant_id column.
        if (table === "exchange_accounts" && args[0] === "tenant_id") throw new Error("UNDEFINED_COLUMN:exchange_accounts.tenant_id");
        calls.push({ table, method, args });
      });
    } }) } }) };
}
test("ADMIN requires authenticated active official-tenant operator, never metadata alone", async () => {
  assert.equal((await access().code.requireAssetHealthAccess(true)).role, "ADMIN");
  await assert.rejects(access({ auth: false }).code.requireAssetHealthAccess(), /AUTH_REQUIRED/);
  await assert.rejects(access({ operator: false }).code.requireAssetHealthAccess(), /ACCESS_DENIED/);
  await assert.rejects(access({ schema: "other" }).code.requireAssetHealthAccess(), /SCOPE_INVALID/);
});
test("VIEWER can read public facts only after binding+tenant+account validation, never sync", async () => {
  const a = access({ role: "VIEWER" });
  assert.equal((await a.code.requireAssetHealthAccess()).role, "VIEWER");
  assert.ok(a.calls.some((item) => item.table === "exchange_accounts" && item.args[0] === "operator_id" && item.args[1] === "op"));
  assert.ok(a.calls.some((item) => item.table === "exchange_accounts" && item.args[0] === "id" && item.args[1] === "account"));
  assert.equal(a.calls.some((item) => item.table === "exchange_accounts" && item.args[0] === "tenant_id"), false);
  assert.ok(a.calls.some((item) => item.table === "operators" && item.args[0] === "tenant_id" && item.args[1] === "official-tenant"));
  assert.ok(a.calls.some((item) => item.table === "operators" && item.args[0] === "id" && item.args[1] === "op"));
  assert.ok(a.calls.some((item) => item.table === "operators" && item.args[0] === "status" && item.args[1] === "ACTIVE"));
  await assert.rejects(a.code.requireAssetHealthAccess(true), /ADMIN_REQUIRED/);
  await assert.rejects(access({ role: "VIEWER", binding: false }).code.requireAssetHealthAccess(), /ACCESS_DENIED/);
  await assert.rejects(access({ role: "VIEWER", operator: false }).code.requireAssetHealthAccess(), /ACCESS_DENIED/);
  await assert.rejects(access({ role: "VIEWER", account: false }).code.requireAssetHealthAccess(), /ACCESS_DENIED/);
});
test("watchdog collector failure is informational and has no engine/capacity access", async () => {
  const code = load("./collector-monitor.ts", { "server-only": {}, "./collector-policy": policy,
    "./access": { assetHealthService: () => ({ from(table: string) {
      assert.equal(table, "asset_health_collector_state"); return query(null, { code: "503" });
    } }) } });
  assert.equal((await code.monitorAssetHealthCollector()).status, "UNAVAILABLE");
  const cron = readFileSync(new URL("../../app/api/cron/coinops-watchdog/route.ts", import.meta.url), "utf8");
  assert.match(cron, /const result = await runServerWatchdog\(\)/);
  assert.match(cron, /\.\.\.result, assetHealthCollector/);
});
test("isolated cron requires CRON_SECRET, persists snapshots, never sources from frontend", () => {
  const cron = readFileSync(new URL("../../app/api/cron/coinops-asset-health/route.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../../app/api/coinops-asset-health/route.ts", import.meta.url), "utf8");
  assert.match(cron, /!process.env.CRON_SECRET/);
  assert.match(cron, /Bearer \$\{process.env.CRON_SECRET\}/);
  assert.match(route, /await requireAssetHealthAccess\(true\)/);
  assert.match(route, /get\("origin"\) !== request.nextUrl.origin/);
  assert.match(route, /historyDays/);
});
