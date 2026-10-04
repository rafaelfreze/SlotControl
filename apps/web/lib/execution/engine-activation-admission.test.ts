import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { assertOperationalEnvironment } from "./testnet-policy.ts";

function fixture(environment: "REAL" | "TESTNET", decision = "CAPACITY_OK", alreadyActive = false,
  identity = "BOUND", accountStatus = "INACTIVE", engineShard = "executor-02", budget = "PASS") {
  const calls: string[] = [];
  const operator = { id: "operator", product_id: "product", tenant_id: "tenant", user_id: "user", kill_switch: false };
  const account = { id: "account", status: accountStatus, kill_switch: accountStatus !== "ACTIVE",
    is_legacy_default: false, credential_ref: "fixture-vault", executor_shard_id: "executor-02",
    onboarding_environment: environment };
  const engine = { operator_id: "operator", exchange_account_id: "account", trading_engine_id: "engine",
    environment, base_asset: "SOL", symbol: environment === "REAL" ? "SOLBRL" : "SOLUSDT",
    quote_asset: environment === "REAL" ? "BRL" : "USDT", hard_cap_quote: 100,
    status: "INACTIVE", engine_kill_switch: true, executor_shard_id: engineShard };
  const service = { from(table: string) {
    let mutation = false;
    const data = () => table === "exchange_accounts" ? account : table === "operators" ? operator
      : table === "account_onboarding_checks" ? { status: "PASS", evidence: { status: "PASS", environment, symbol: engine.symbol } }
        : table === "robot_v1_testnet_runs" ? alreadyActive ? { id: "cycle", status: "ACTIVE" } : null
          : table === "robot_v1_live_runs" ? { id: "cycle", status: alreadyActive ? "ACTIVE" : "PREPARING", last_error: null }
            : table === "account_quote_caps" ? { hard_cap_quote: 100 }
              : table === "robot_v1_live_preparations" ? { configured_live_capital_brl: 100, kill_switch: true, live_enabled: false }
                : { id: "engine" };
    const response = () => ({ data: mutation ? { id: "fixture" } : data(), error: null });
    const chain = { select: () => chain, eq: () => chain, in: () => chain, order: () => chain,
      limit: () => chain, update: () => { mutation = true; calls.push(`write:${table}`); return chain; },
      single: async () => response(), maybeSingle: async () => response(),
      then: (fulfilled: (value: unknown) => unknown) => Promise.resolve(response()).then(fulfilled) };
    return chain;
  }, rpc: async (name: string) => { calls.push(`rpc:${name}`); return { data: { status: "ACTIVE" }, error: null }; } };
  const dependencies: Record<string, unknown> = {
    "node:crypto": { randomUUID: () => "request", createHash: () => ({ update: () => ({ digest: () => "fixture-prefix" }) }) },
    "next/server": { NextResponse: { json: (body: unknown, options: { status: number }) => ({ body, status: options.status }) } },
    "@/lib/execution/binance-account-registry-server": {},
    "@/lib/execution/testnet-policy": { assertOperationalEnvironment },
    "@/lib/execution/binance-identity-server": { requireAccountIdentityBinding: async () => {
      calls.push("identity"); if (identity !== "BOUND") throw new Error(identity);
    } },
    "@/lib/execution/binance-spot-testnet-adapter": {},
    "@/lib/execution/live-executor-health": { loadLiveEngineExecutorStatus: async () => ({ gate: "LIVE_EXECUTOR_ACTIVE" }) },
    "@/lib/execution/live-preparation": {},
    "@/lib/execution/operator-executor-admin": {
      operatorAccountSnapshot: async (_op: string, _account: string, _quote: string, _symbols: string[], _ref: string, _env: string, engineId: string) => {
        assert.equal(engineId, "engine"); return { balances: [{ asset: engine.quote_asset, free: 1000 }], markets: [{ open_orders: [] }] };
      },
      operatorExecutorAdmin: async (_path: string, payload: Record<string, unknown>) => {
        assert.equal(payload.trading_engine_id, "engine"); calls.push("promote"); return { status: "ACTIVE", trading_engine_id: "engine" };
      },
    },
    "@/lib/execution/operator-engine-plan": {},
    "@/lib/execution/engine-admission-router-server": {},
    "@/lib/execution/engine-append-server": { allocatedCapital: async () => ({ free: 1000, requiredFree: 100 }) },
    "@/lib/execution/engine-append-exposure": { allocationSnapshotFingerprint: () => "stable-fixture-wallet" },
    "@/lib/execution/executor-shards-server": { resolveExecutorForConnection: async (_op: string, _acct: string, shard: string) => {
      assert.equal(shard, engineShard); return { shardId: shard, credentialRef: "fixture-vault" };
    } },
    "@/lib/execution/account-order-budget-server": {
      collectAccountOrderBudget: async (_service: unknown, _op: string, _acct: string, shard: string) => { assert.equal(shard, engineShard); },
      previewAccountOrderBudget: async (_service: unknown, _op: string, _acct: string, additional: string[], resident: string[]) => {
        assert.deepEqual(additional, []); assert.deepEqual(resident, [engine.symbol]); return { code: budget };
      } },
    "@/lib/execution/complete-ledger-read": {},
    "@/lib/execution/engine-account-catalog": {},
    "@/lib/coinops-capacity/activation-admission-view": {},
    "@/lib/execution/operator-context-server": { resolveOperatorEngine: async () => engine },
    "@/lib/execution/robot-v1-live-server": { advanceLiveRun: async () => { calls.push("start"); return {}; } },
    "@/lib/execution/robot-v1-testnet-server": { startTestnetRun: async () => { calls.push("start"); return "cycle"; } },
    "@/lib/supabase/env": { getCoinOpsServiceTenantId: () => "tenant", getSupabaseDataSchema: () => "coinops" },
    "@/lib/supabase/service-role": { createServiceRoleClient: () => service },
    "@/lib/supabase/server": { createClient: () => ({ ...service, auth: { getUser: async () => ({ data: { user: { id: "user" } } }) } }) },
    "@/lib/coinops-capacity/capacity-server": { reserveEngineCapacity: async () => {
      calls.push("capacity"); if (decision !== "CAPACITY_OK") throw new Error(`COINOPS_${decision}`);
    } },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("../../app/api/coinops-engine-control/route.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", "process", compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name];
  }, exports, { env: { VERCEL_ENV: "production", COINOPS_LIVE_CRON_ENABLED: "true" } });
  const post = exports.POST as (request: unknown) => Promise<{ body: { error?: string; status?: string }; status: number }>;
  const request = { nextUrl: new URL("https://cripto-flax.vercel.app/api/coinops-engine-control"),
    headers: new Headers({ origin: "https://cripto-flax.vercel.app", "content-type": "application/json", "x-coinops-admin-intent": "engine-control" }),
    text: async () => JSON.stringify({ action: "ACTIVATE", accountId: "account", engineId: "engine" }) };
  return { run: () => post(request), calls };
}

for (const environment of ["REAL"] as const) {
  test(`${environment} final capacity and physical identity checks precede every activation write`, async () => {
    for (const failure of ["CAPACITY_UNKNOWN", "CAPACITY_REQUIRED"]) {
      const scenario = fixture(environment, failure);
      assert.equal((await scenario.run()).body.error, `COINOPS_${failure}`);
      assert.deepEqual(scenario.calls, ["identity", "capacity"]);
    }
    const missingIdentity = fixture(environment, "CAPACITY_OK", false, "COINOPS_BINANCE_IDENTITY_REQUIRED");
    assert.equal((await missingIdentity.run()).body.error, "COINOPS_BINANCE_IDENTITY_REQUIRED");
    assert.deepEqual(missingIdentity.calls, ["identity"]);
    const newEngineInActiveAccount = fixture(environment, "CAPACITY_OK", false,
      "COINOPS_BINANCE_IDENTITY_REQUIRED", "ACTIVE");
    assert.equal((await newEngineInActiveAccount.run()).body.error, "COINOPS_BINANCE_IDENTITY_REQUIRED");
    assert.deepEqual(newEngineInActiveAccount.calls, ["identity"]);
    const healthy = fixture(environment);
    assert.equal((await healthy.run()).body.status, "ACTIVATING");
    assert.deepEqual(healthy.calls.slice(0, 3), ["identity", "capacity", "write:exchange_accounts"]);
    assert.equal(healthy.calls.includes("start"), false);
  });
  test(`${environment} existing ACTIVE run never depends on capacity or identity admission`, async () => {
    const scenario = fixture(environment, "CAPACITY_UNKNOWN", true, "COINOPS_BINANCE_IDENTITY_REQUIRED");
    assert.equal((await scenario.run()).body.status, "ALREADY_ACTIVE");
    assert.deepEqual(scenario.calls, []);
  });
}

test("retired Testnet activation cannot bypass product policy even with prepared fixtures", async () => {
  const scenario = fixture("TESTNET");
  assert.equal((await scenario.run()).body.error, "COINOPS_TESTNET_DISABLED");
  assert.deepEqual(scenario.calls, []);
});

test("new same-account engine activates on its own shard without mutating the active account; global budget fails before writes", async () => {
  const valid = fixture("REAL", "CAPACITY_OK", false, "BOUND", "ACTIVE", "executor-03");
  assert.equal((await valid.run()).body.status, "ACTIVATING");
  assert.equal(valid.calls.includes("write:exchange_accounts"), false);
  assert.ok(valid.calls.includes("promote"));
  for (const code of ["ACCOUNT_ORDER_BUDGET_UNKNOWN", "ACCOUNT_ORDER_CAPACITY_REQUIRED"]) {
    const blocked = fixture("REAL", "CAPACITY_OK", false, "BOUND", "ACTIVE", "executor-03", code);
    assert.equal((await blocked.run()).body.error, `COINOPS_${code}`);
    assert.deepEqual(blocked.calls, ["identity"]);
  }
});
