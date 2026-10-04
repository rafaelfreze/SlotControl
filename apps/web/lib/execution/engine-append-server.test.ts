import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { validateEnginePlan } from "./operator-engine-plan.ts";
import { completeLedgerRead } from "./complete-ledger-read.ts";
import { engineAppendAvailableCapital, engineAppendPreviewHash } from "./engine-append-allocation.ts";
import { allocationSnapshotFingerprint, confirmedEngineCapitalExposure } from "./engine-append-exposure.ts";
import { buildLiveSizing, parseLiveRules } from "./live-preparation.ts";
import type { AppendPlanInput } from "./engine-append-server.ts";
import type { OperatorExchangeSnapshot } from "./operator-executor-admin.ts";

const account = "11111111-1111-4111-8111-111111111111";
const operator = "22222222-2222-4222-8222-222222222222";
const original = "33333333-3333-4333-8333-333333333333";
const appended = "44444444-4444-4444-8444-444444444444";
const input: AppendPlanInput = { accountId: account, requestId: "55555555-5555-4555-8555-555555555555",
  quote: "BRL", capital: "100.00", shardId: "executor-03", engines: [
    { asset: "SOL", capital: "100.00", gainPercent: "5.5", spacingPercent: "3", postAthPercent: "8", monthlyTarget: 2 }] };
type Row = Record<string, any>;
function fixture(options: { capacity?: string; credential?: string; budget?: string; changedWallet?: boolean;
  insufficient?: boolean; registryFailure?: boolean; sqlBudgetFailures?: number; sqlError?: string;
  previewExpiry?: boolean } = {}) {
  const calls: Array<{ shard: string; path: string; payload: Row }> = [];
  const events: string[] = [];
  let registryFails = !!options.registryFailure, snapshots = 0, creates = 0, sqlCalls = 0, previewCalls = 0;
  const waits: number[] = [], ids: string[] = [];
  const oldEngine: Row = { id: original, operator_id: operator, exchange_account_id: account,
    environment: "REAL", quote_asset: "BRL", base_asset: "SOL", symbol: "SOLBRL", legacy_compatible: false,
    hard_cap_quote: 100, executor_shard_id: "executor-02", status: "ACTIVE", config: { immutable: "old" } };
  const before = structuredClone(oldEngine);
  const tables: Record<string, Row[]> = { trading_engines: [oldEngine], account_quote_caps: [{
    operator_id: operator, exchange_account_id: account, quote_asset: "BRL", hard_cap_quote: 100 }],
    robot_v1_live_runs: [], robot_v1_live_slots: [], robot_v1_live_orders: [],
    account_engine_append_previews: [], account_onboarding_checks: [] };
  class Query {
    predicates: Array<(row: Row) => boolean> = []; start = 0; end = Infinity; one = false;
    readonly table: string;
    constructor(table: string) { this.table = table; assert.ok(table in tables, table); }
    select() { return this; }
    eq(key: string, value: unknown) { this.predicates.push(row => row[key] === value); return this; }
    in(key: string, values: unknown[]) { this.predicates.push(row => values.includes(row[key])); return this; }
    order() { return this; }
    range(start: number, end: number) { this.start = start; this.end = end; return this; }
    single() { this.one = true; return this; }
    maybeSingle() { this.one = true; return this; }
    async upsert(row: Row) { tables[this.table] = [structuredClone(row)]; return { error: null }; }
    then(resolve: (value: { data: any; error: null }) => unknown) {
      const rows = tables[this.table].filter(row => this.predicates.every(test => test(row)))
        .slice(this.start, this.end + 1);
      return Promise.resolve(resolve({ data: this.one ? rows[0] ?? null : rows, error: null }));
    }
  }
  const service = { from: (name: string) => new Query(name), rpc: async (name: string, args: Row) => {
    assert.equal(name, "append_operator_engine_plan"); events.push("SQL_APPEND"); sqlCalls++; ids.push(args.p_request_id);
    assert.equal(events.at(-2), "ACCOUNT_BUDGET_GET", "fresh observation LAST before SQL, not before allocation upsert");
    if (sqlCalls <= (options.sqlBudgetFailures ?? 0)) return { data: null,
      error: { code: options.sqlError ?? "P0001", message: "COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN" } };
    creates++;
    assert.equal(args.p_shard_id, "executor-03");
    const saved = tables.account_engine_append_previews[0];
    assert.ok(saved); assert.equal(saved.available_capital >= 100, true);
    const result = [{ engineId: appended, symbol: "SOLBRL" }];
    tables.trading_engines.push({ ...oldEngine, id: appended, hard_cap_quote: 100,
      executor_shard_id: "executor-03", status: "INACTIVE", config: { max_order_quote: 4 } });
    tables.account_quote_caps[0].hard_cap_quote += 100;
    tables.account_onboarding_checks.push({ operator_id: operator, exchange_account_id: account,
      idempotency_key: `engine-append:${input.requestId}`, evidence: { result, shardId: "executor-03", input: saved.input } });
    return { data: result, error: null };
  } };
  const snapshot = (): OperatorExchangeSnapshot => {
    snapshots++; events.push("WALLET_GET");
    const now = new Date().toISOString();
    return { operator_id: operator, exchange_account_id: account, environment: "REAL", quote_asset: "BRL",
      observed_at: now, executor_ip: "203.0.113.3", whitelist_accepted: true, permission: { spotTrading: true, withdrawals: false },
      balances: [{ asset: "BRL", free: options.insufficient ? 199 : 200 + (options.changedWallet && snapshots > 1 ? 1 : 0), locked: 0 }],
      markets: ["BTC", "SOL"].map(asset => ({ symbol: `${asset}BRL`, price: 100, observed_at: now, open_orders: [],
        rules: { symbol: `${asset}BRL`, status: "TRADING", baseAsset: asset, quoteAsset: "BRL",
          baseAssetPrecision: 8, quoteAssetPrecision: 8, quoteOrderQtyMarketAllowed: true, orderTypes: ["MARKET", "LIMIT"],
          filters: [{ filterType: "LOT_SIZE", minQty: "0.0001", maxQty: "10000", stepSize: "0.0001" },
            { filterType: "PRICE_FILTER", minPrice: "0.01", maxPrice: "1000000", tickSize: "0.01" },
            { filterType: "MIN_NOTIONAL", minNotional: "1" }] } })) };
  };
  const dependencies: Record<string, unknown> = {
    "node:timers/promises": { setTimeout: async (ms: number) => { waits.push(ms); } },
    "./operator-engine-plan.ts": { validateEnginePlan }, "./complete-ledger-read.ts": { completeLedgerRead },
    "./engine-append-allocation.ts": { engineAppendAvailableCapital, engineAppendPreviewHash },
    "./engine-append-exposure.ts": { allocationSnapshotFingerprint, confirmedEngineCapitalExposure },
    "./live-preparation.ts": { buildLiveSizing, parseLiveRules },
    "./engine-admission-router-server.ts": { loadEngineAdmissionOptions: async () => [
      { shardId: "executor-02", capacityCode: "CAPACITY_REQUIRED", credential: "VALIDATED" },
      { shardId: "executor-03", ip: "203.0.113.3", capacityCode: options.capacity ?? "CAPACITY_OK", credential: options.credential ?? "VALIDATED" }] },
    "./operator-executor-admin.ts": { operatorConnectionSnapshot: async (op: string, acct: string, shard: string) => {
      assert.equal(op, operator); assert.equal(acct, account); assert.equal(shard, "executor-03"); return snapshot(); },
      operatorConnectionAdmin: async (_op: string, _acct: string, shard: string, path: string, payload: Row) => {
        calls.push({ shard, path, payload: structuredClone(payload) }); events.push(path);
        if (path === "/v1/admin/registry-append" && registryFails) { registryFails = false; throw new Error("EXECUTOR_TEMP_UNAVAILABLE"); }
        assert.ok(["/v1/admin/account-cap", "/v1/admin/registry-append"].includes(path));
        return { registered_engines: 1, status: "INACTIVE", trading_enabled: false };
      } },
    "./account-order-budget-server.ts": { collectAccountOrderBudget: async (_s: unknown, _o: unknown, _a: unknown,
      _sh: unknown, _sy: unknown, _fetch: unknown, safety: { minimumValidityMs: number; deadline: number }) => {
      assert.equal(safety.minimumValidityMs, 4000); assert.ok(Number.isFinite(safety.deadline)); events.push("ACCOUNT_BUDGET_GET"); },
      previewAccountOrderBudget: async () => ({ code: options.previewExpiry && previewCalls++ === 0
        ? "ACCOUNT_ORDER_BUDGET_UNKNOWN" : options.budget ?? "PASS", reason: "interval expired or invalid" }) },
    "./account-execution-policy-server.ts": { ensureAccountExecutionPolicy: async () => events.push("ALL_HOST_POLICY") },
    "./executor-shards-server.ts": { resolveExecutorForConnection: async () => ({ credentialRef: "fixture-reference-not-a-secret" }) },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./engine-append-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded: Row = {};
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name];
  }, loaded);
  return { tables, before, calls, events, waits, ids, get sqlCalls() { return sqlCalls; }, get creates() { return creates; },
    preview: () => loaded.previewEngineAppend(service, operator, input),
    provision: (hash: string, change: Partial<AppendPlanInput> = {}) =>
      loaded.provisionEngineAppend(service, operator, { ...input, previewHash: hash, ...change }) };
}

test("append orchestration: same SOLBRL A/02 → B/03, policy before SQL, only new ID registered INACTIVE; old untouched", async () => {
  const f = fixture(), preview = await f.preview();
  assert.equal(preview.status, "PREVIEW_NO_ORDER"); assert.equal(preview.engines[0].validSlots, 25);
  assert.equal(preview.availableCapital, 100); assert.equal(f.creates, 0); assert.equal(f.calls.length, 0);
  const result = await f.provision(preview.previewHash);
  assert.equal(result.status, "INACTIVE"); assert.equal(f.creates, 1);
  assert.ok(f.events.indexOf("ALL_HOST_POLICY") < f.events.indexOf("SQL_APPEND"));
  assert.deepEqual(f.tables.trading_engines[0], f.before);
  assert.equal(f.tables.account_quote_caps[0].hard_cap_quote, 200);
  assert.deepEqual(f.calls.map(call => [call.shard, call.path]), [
    ["executor-02", "/v1/admin/account-cap"], ["executor-03", "/v1/admin/account-cap"],
    ["executor-03", "/v1/admin/registry-append"]]);
  const registered = f.calls[2].payload.engines;
  assert.deepEqual(registered.map((engine: Row) => engine.trading_engine_id), [appended]);
  assert.equal(registered[0].execution_allowed, false); assert.equal(registered[0].kill_switch, true);
  assert.equal(f.tables.robot_v1_live_orders.length, 0);
});

test("confirmation: expired SQL gate rolls back, refreshes complete preview, same UUID creates exactly once", async () => {
  const f = fixture({ sqlBudgetFailures: 1 }), preview = await f.preview();
  await f.provision(preview.previewHash);
  assert.equal(f.sqlCalls, 2); assert.equal(f.creates, 1); assert.deepEqual(f.ids, [input.requestId, input.requestId]);
  assert.deepEqual(f.waits, [5500]); assert.deepEqual(f.tables.trading_engines[0], f.before);
  assert.equal(f.tables.account_quote_caps[0].hard_cap_quote, 200);
  assert.equal(f.events.filter(e => e === "ALL_HOST_POLICY").length, 1);
});
test("confirmation: repeated UNKNOWN fails closed; network/uncertain outcome never retries SQL", async () => {
  for (const error of ["P0001", "PGRST003", "08006"]) {
    const f = fixture({ sqlBudgetFailures: 9, sqlError: error }), preview = await f.preview();
    await assert.rejects(f.provision(preview.previewHash), /BUDGET_UNKNOWN/);
    assert.equal(f.sqlCalls, error === "P0001" ? 2 : 1); assert.equal(f.creates, 0);
    assert.equal(f.tables.trading_engines.length, 1); assert.equal(f.calls.length, 0);
    assert.equal(f.tables.account_quote_caps[0].hard_cap_quote, 100);
  }
});
test("preview: SQL interval expiry refreshes signed evidence, never forces PASS", async () => {
  const f = fixture({ previewExpiry: true }), preview = await f.preview();
  assert.equal(preview.status, "PREVIEW_NO_ORDER"); assert.deepEqual(f.waits, [5500]); assert.equal(f.creates, 0);
});
test("append orchestration: lost registry ACK retries exact request without second engine/cap/preview", async () => {
  const f = fixture({ registryFailure: true }), preview = await f.preview();
  await assert.rejects(f.provision(preview.previewHash), /EXECUTOR_TEMP_UNAVAILABLE/);
  const walletReads = f.events.filter(event => event === "WALLET_GET").length;
  const result = await f.provision(preview.previewHash);
  assert.equal(result.status, "INACTIVE"); assert.equal(f.creates, 1);
  assert.equal(f.tables.trading_engines.length, 2); assert.equal(f.tables.account_quote_caps[0].hard_cap_quote, 200);
  assert.equal(f.events.filter(event => event === "WALLET_GET").length, walletReads);
  await assert.rejects(f.provision(preview.previewHash, { capital: "101.00", engines: [{ ...input.engines[0], capital: "101.00" }] }), /REPLAY_MISMATCH/);
  assert.deepEqual(f.tables.trading_engines[0], f.before);
});
test("append orchestration: unknown capacity/credential, shared-account limit, insufficient or changing wallet never create", async () => {
  for (const [options, error] of [
    [{ capacity: "CAPACITY_UNKNOWN" }, /CAPACITY_REQUIRED/],
    [{ credential: "VALIDATION_REQUIRED" }, /CREDENTIAL_SHARD_VALIDATION_REQUIRED/],
    [{ budget: "ACCOUNT_ORDER_LIMIT" }, /ACCOUNT_ORDER_LIMIT/],
    [{ insufficient: true }, /BALANCE_INSUFFICIENT/],
    [{ changedWallet: true }, /SNAPSHOT_CHANGED/],
  ] as const) {
    const f = fixture(options); await assert.rejects(f.preview(), error);
    assert.equal(f.creates, 0); assert.equal(f.calls.length, 0);
    assert.deepEqual(f.tables.trading_engines[0], f.before);
  }
});
