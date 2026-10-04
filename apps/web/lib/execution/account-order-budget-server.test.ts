import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { completeLedgerRead } from "./complete-ledger-read.ts";
import { projectAccountBudgetObservation } from "./account-order-budget-observation.ts";

// Execute the actual collector with isolated database/transport fixtures. No
// Supabase connection, key, Binance request, order or real engine is created.
function fixture(options: { busy?: number; acquireError?: boolean; recordError?: boolean;
  releaseError?: boolean; responses?: string[]; successor?: boolean; latency?: number } = {}) {
  let now = Date.parse("2026-10-04T18:58:18Z"), owner: string | null = null;
  let acquired = 0, reads = 0, records = 0, busy = options.busy ?? 0;
  const events: string[] = [], releases: Record<string, unknown>[] = [];
  const target = { shardId: "executor-02", ip: "203.0.113.2", base: "https://executor.invalid",
    credentialRef: "fixture", validatedVersion: "release", secret: "fixture-not-a-secret" };
  const tables: Record<string, unknown[]> = { trading_engines: [{ id: "engine", operator_id: "op",
    exchange_account_id: "account", symbol: "SOLBRL" }], robot_v1_live_orders: [] };
  class Query {
    filters: Record<string, unknown> = {}; patch: Record<string, unknown> | null = null;
    readonly table: string;
    constructor(table: string) { this.table = table; }
    select() { return this; } order() { return this; } range() { return this; }
    in() { return this; } not() { return this; }
    eq(key: string, value: unknown) { this.filters[key] = value; return this; }
    update(patch: Record<string, unknown>) { this.patch = patch; return this; }
    then(resolve: (value: any) => unknown) {
      if (!this.patch) return Promise.resolve(resolve({ data: tables[this.table], error: null }));
      assert.equal(this.table, "account_order_budget_probe_leases");
      assert.equal(this.filters.operator_id, "op"); assert.equal(this.filters.exchange_account_id, "account");
      assert.equal(typeof this.filters.lease_owner, "string");
      assert.deepEqual(Object.keys(this.patch), ["expires_at"]);
      releases.push(this.filters); events.push("RELEASE");
      if (!options.releaseError && owner === this.filters.lease_owner) owner = null;
      return Promise.resolve(resolve({ error: options.releaseError ? { message: "db" } : null }));
    }
  }
  const service = { from: (table: string) => new Query(table), rpc: async (name: string, args: any) => {
    if (name === "acquire_account_order_budget_probe") {
      acquired++; events.push("ACQUIRE");
      if (options.acquireError) return { data: null, error: { message: "db" } };
      if (busy-- > 0) return { data: false, error: null };
      assert.equal(owner, null, "no overlapping account probes"); owner = args.p_lease_owner;
      return { data: true, error: null };
    }
    assert.equal(name, "record_account_order_budget_sample"); records++; events.push("RECORD");
    assert.equal(args.p_lease_owner, owner);
    if (options.recordError) return { data: false, error: { message: "db" } };
    owner = null; return { data: true, error: null };
  } };
  class Clock extends Date { constructor(value: string | number = now) { super(value); } static now() { return now; } }
  const dependencies: Record<string, any> = {
    "node:crypto": { randomUUID: () => `owner-${acquired}-${reads}` },
    "node:timers/promises": { setTimeout: async (ms: number) => { assert.equal(owner, null); events.push(`WAIT:${ms}`); now += ms; } },
    "./complete-ledger-read.ts": { completeLedgerRead },
    "./account-order-budget-observation.ts": { projectAccountBudgetObservation: (sample: any, input: any) => projectAccountBudgetObservation(sample, input, now) },
    "./executor-shards-server.ts": { resolveExecutorForConnection: async () => target,
      parseExecutorValidatedVersions: () => ["release"], withExecutorShard: (input: any) => ({ ...input, executor_shard_id: target.shardId }) },
    "./live-executor-client.ts": { signedExecutorHeaders: () => ({ "content-type": "application/json" }) },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./account-order-budget-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded: Record<string, any> = {};
  new Function("require", "exports", "Date", compiled)((name: string) => {
    assert.ok(name in dependencies, name); return dependencies[name];
  }, loaded, Clock);
  const fetcher = async (url: string, init: RequestInit) => {
    assert.equal(url, "https://executor.invalid/v1/admin/order-budget");
    assert.equal(init.method, "POST"); // Signed administrative GET-only probe, not an order route.
    const body = JSON.parse(String(init.body)); assert.equal(body.exchange_account_id, "account");
    assert.deepEqual(body.symbols, ["BTCBRL", "SOLBRL"]); reads++; events.push("READ");
    now += options.latency ?? 0;
    const state = options.responses?.[reads - 1] ?? "OK";
    if (options.successor) owner = "successor-owner";
    if (state === "NETWORK") throw new Error("transport failed");
    if (state !== "OK" && state !== "INVALID") return new Response(JSON.stringify({ error: state }), { status: state === "DENIED" ? 403 : 503 });
    return new Response(JSON.stringify({ operator_id: "op", exchange_account_id: state === "INVALID" ? "foreign" : "account",
      environment: "REAL", executor_shard_id: "executor-02", executor_ip: target.ip,
      credential_ref: target.credentialRef, executor_version: "release", observedAt: now, serverTime: now,
      intervals: [{ intervalMs: 10000, limit: 100, count: 0 }], restrictions: [],
      symbols: body.symbols.map((symbol: string) => ({ symbol, maxOrders: 200, selfTradePrevention: "EXPIRE_TAKER", openOrders: [] })),
      exchangeOrders: null }));
  };
  return { collect: () => loaded.collectAccountOrderBudget(service, "op", "account", "executor-02", ["BTCBRL"], fetcher),
    events, releases, get owner() { return owner; }, get reads() { return reads; }, get records() { return records; }, get acquired() { return acquired; } };
}

test("interval-boundary rejection releases only own lease before cooldown and fresh successful retry", async () => {
  const f = fixture({ responses: ["EXECUTOR_ACCOUNT_ORDER_BUDGET_UNKNOWN", "OK"] });
  assert.equal((await f.collect()).shardId, "executor-02");
  assert.deepEqual(f.events, ["ACQUIRE", "READ", "RELEASE", "WAIT:5500", "ACQUIRE", "READ", "RECORD"]);
  assert.equal(f.records, 1); assert.equal(f.owner, null);
  await f.collect(); assert.equal(f.records, 2); assert.equal(f.owner, null);
});
test("failed transport, invalid scope or persistence failure releases lease without saving false evidence", async () => {
  for (const options of [{ responses: ["NETWORK"] }, { responses: ["INVALID"] }, { recordError: true },
    { responses: ["DENIED"] }, { responses: ["EXECUTOR_BINANCE_RATE_LIMITED"] }]) {
    const f = fixture(options); await assert.rejects(f.collect());
    assert.equal(f.reads, 1); assert.equal(f.releases.length, 1); assert.equal(f.owner, null);
  }
});
test("another worker's active lease is never stolen, and bounded contention can recover", async () => {
  const f = fixture({ busy: 2 }); await f.collect();
  assert.equal(f.acquired, 3); assert.equal(f.reads, 1); assert.equal(f.releases.length, 0);
  const blocked = fixture({ busy: 3 }); await assert.rejects(blocked.collect(), /PROBE_BUSY/);
  assert.equal(blocked.reads, 0); assert.equal(blocked.releases.length, 0);
});
test("expired collector cannot release successor; release failure and RPC error remain fail-closed", async () => {
  const f = fixture({ successor: true, responses: ["NETWORK"] }); await assert.rejects(f.collect());
  assert.equal(f.owner, "successor-owner"); assert.notEqual(f.releases[0].lease_owner, f.owner);
  const unavailable = fixture({ releaseError: true, responses: ["EXECUTOR_ACCOUNT_ORDER_BUDGET_UNKNOWN"] });
  await assert.rejects(unavailable.collect(), /BUDGET_UNKNOWN/); assert.equal(unavailable.reads, 1);
  const db = fixture({ acquireError: true }); await assert.rejects(db.collect(), /BUDGET_UNKNOWN/);
  assert.equal(db.reads, 0); assert.equal(db.releases.length, 0);
});
test("persistent unknown sample has at most three read-only attempts and an overall deadline", async () => {
  const responses = Array(3).fill("EXECUTOR_ACCOUNT_ORDER_BUDGET_UNKNOWN");
  const f = fixture({ responses }); await assert.rejects(f.collect(), /BUDGET_UNKNOWN/);
  assert.equal(f.reads, 3); assert.equal(f.releases.length, 3); assert.equal(f.records, 0);
  const slow = fixture({ responses, latency: 16000 }); await assert.rejects(slow.collect(), /BUDGET_UNKNOWN/);
  assert.equal(slow.reads, 2); assert.equal(slow.records, 0); assert.equal(slow.owner, null);
});
