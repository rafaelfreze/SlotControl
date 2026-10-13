import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { completeLedgerRead } from "./complete-ledger-read.ts";
import { projectAccountBudgetObservation } from "./account-order-budget-observation.ts";

// Execute the actual collector with isolated database/transport fixtures. No
// Supabase connection, key, Binance request, order or real engine is created.
function fixture(options: { busy?: number; acquireError?: boolean; recordError?: boolean;
  releaseError?: boolean; responses?: string[]; successor?: boolean; latency?: number;
  minimumValidityMs?: number; recordLatency?: number; observationLag?: number; reservationShortAfterRefresh?: boolean;
  startsAt?: number; latencies?: number[]; observationOffset?: number; releaseLatency?: number; deadlineMs?: number;
  intervalMs?: number } = {}) {
  let now = options.startsAt ?? Date.parse("2026-10-04T18:58:18Z"), owner: string | null = null;
  const deadline = options.deadlineMs === undefined ? undefined : now + options.deadlineMs;
  let acquired = 0, reads = 0, records = 0, reserves = 0, busy = options.busy ?? 0;
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
      now += options.releaseLatency ?? 0;
      if (!options.releaseError && owner === this.filters.lease_owner) owner = null;
      return Promise.resolve(resolve({ error: options.releaseError ? { message: "db" } : null }));
    }
  }
  const service = { from: (table: string) => new Query(table), rpc: async (name: string, args: any) => {
    if (name === "reserve_account_order_budget") {
      reserves++; events.push("RESERVE");
      return { error: null, data: { code: "PASS", operatorId: "op", accountId: "account", engineId: "engine",
        shardId: target.shardId, clientOrderId: args.p_client_order_id,
        expiresAt: reserves === 1 || options.reservationShortAfterRefresh ? now + 100 : Math.floor(now / 10000) * 10000 + 10000 } };
    }
    if (name === "acquire_account_order_budget_probe") {
      acquired++; events.push("ACQUIRE");
      if (options.acquireError) return { data: null, error: { message: "db" } };
      if (busy-- > 0) return { data: false, error: null };
      assert.equal(owner, null, "no overlapping account probes"); owner = args.p_lease_owner;
      return { data: true, error: null };
    }
    assert.equal(name, "record_account_order_budget_sample"); records++; events.push("RECORD");
    now += options.recordLatency ?? 0;
    assert.equal(args.p_lease_owner, owner);
    if (options.recordError) return { data: false, error: { message: "db" } };
    owner = null; return { data: true, error: null };
  } };
  class Clock extends Date { constructor(value: string | number = now) { super(value); } static now() { return now; } }
  const dependencies: Record<string, any> = {
    "node:crypto": { randomUUID: () => `owner-${acquired}-${reads}` },
    "node:timers/promises": { setTimeout: async (ms: number) => { assert.equal(owner, null); events.push(`WAIT:${ms}`); now += ms; } },
    "./complete-ledger-read.ts": { completeLedgerRead },
    "./account-order-budget-observation.ts": { projectAccountBudgetObservation: (sample: any, input: any, at = now) => projectAccountBudgetObservation(sample, input, at) },
    "./executor-shards-server.ts": { resolveExecutorForConnection: async () => target, resolveExecutorForEngine: async () => target,
      parseExecutorValidatedVersions: () => ["release"], withExecutorShard: (input: any) => ({ ...input, executor_shard_id: target.shardId }) },
    "./live-executor-client.ts": { signedExecutorHeaders: () => ({ "content-type": "application/json" }) },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./account-order-budget-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded: Record<string, any> = {};
  new Function("require", "exports", "Date", "fetch", compiled)((name: string) => {
    assert.ok(name in dependencies, name); return dependencies[name];
  }, loaded, Clock, (...args: any[]) => fetcher(args[0], args[1]));
  const fetcher = async (url: string, init: RequestInit) => {
    assert.equal(url, "https://executor.invalid/v1/admin/order-budget");
    assert.equal(init.method, "POST"); // Signed administrative GET-only probe, not an order route.
    const body = JSON.parse(String(init.body)); assert.equal(body.exchange_account_id, "account");
    assert.deepEqual(body.symbols, ["BTCBRL", "SOLBRL"]); reads++; events.push("READ");
    now += options.latencies?.[reads - 1] ?? options.latency ?? 0;
    const state = options.responses?.[reads - 1] ?? "OK";
    if (options.successor) owner = "successor-owner";
    if (state === "NETWORK") throw new Error("transport failed");
    if (state !== "OK" && state !== "INVALID") return new Response(JSON.stringify({ error: state }), { status: state === "DENIED" ? 403 : 503 });
    return new Response(JSON.stringify({ operator_id: "op", exchange_account_id: state === "INVALID" ? "foreign" : "account",
      environment: "REAL", executor_shard_id: "executor-02", executor_ip: target.ip,
      credential_ref: target.credentialRef, executor_version: "release", observedAt: now - (reads === 1 ? options.observationLag ?? 0 : 0),
      serverTime: now - (reads === 1 ? options.observationLag ?? 0 : 0) + (options.observationOffset ?? 0),
      intervals: [{ intervalMs: options.intervalMs ?? 10000, limit: 100, count: 0 }], restrictions: [],
      symbols: body.symbols.map((symbol: string) => ({ symbol, maxOrders: 200, selfTradePrevention: "EXPIRE_TAKER", openOrders: [] })),
      exchangeOrders: null }));
  };
  return { collect: () => loaded.collectAccountOrderBudget(service, "op", "account", "executor-02", ["BTCBRL"], fetcher,
    { minimumValidityMs: options.minimumValidityMs, deadline }),
    reserve: () => loaded.reserveAccountOrderDispatch(service, { operator_id: "op", exchange_account_id: "account",
      trading_engine_id: "engine", symbol: "BTCBRL", quote_asset: "BRL" }, "C2-fixture-2-B-0123456789abcd", "BUY", "lease", true),
    events, releases, get owner() { return owner; }, get reads() { return reads; }, get records() { return records; }, get acquired() { return acquired; } };
}

test("interval-boundary rejection releases only own lease before cooldown and fresh successful retry", async () => {
  const f = fixture({ responses: ["EXECUTOR_ACCOUNT_ORDER_BUDGET_UNKNOWN", "OK"] });
  assert.equal((await f.collect()).shardId, "executor-02");
  assert.deepEqual(f.events, ["ACQUIRE", "READ", "RELEASE", "WAIT:5500", "ACQUIRE", "READ", "RECORD"]);
  assert.equal(f.records, 1); assert.equal(f.owner, null);
  await f.collect(); assert.equal(f.records, 2); assert.equal(f.owner, null);
});

test("dispatch refreshes near-expiry PASS before guard; short refreshed permit stays held without dispatch", async () => {
  const f = fixture(); const reservation = await f.reserve();
  assert.equal(reservation.code, "PASS"); assert.equal(f.reads, 2);
  assert.deepEqual(f.events.filter(event => event === "RESERVE"), ["RESERVE", "RESERVE"]);
  const short = fixture({ reservationShortAfterRefresh: true });
  await assert.rejects(short.reserve(), /BUDGET_UNKNOWN/);
  assert.ok(short.events.every(event => !/DISPATCH|CREATE|GUARD/.test(event)));
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

test("confirmation margin recollects near-end sample, including database latency, without extending its window", async () => {
  const near = fixture({ minimumValidityMs: 4000 }); await near.collect();
  assert.equal(near.reads, 2); assert.equal(near.records, 1); assert.equal(near.owner, null);
  const afterRecord = fixture({ minimumValidityMs: 1000, recordLatency: 1500 }); await afterRecord.collect();
  assert.equal(afterRecord.reads, 2); assert.equal(afterRecord.records, 2); assert.equal(afterRecord.owner, null);
  const expired = fixture({ observationLag: 9000 }); await expired.collect();
  assert.equal(expired.reads, 2); assert.equal(expired.records, 1);
  const invalid = fixture({ minimumValidityMs: 4000, responses: ["INVALID"] });
  await assert.rejects(invalid.collect(), /OBSERVATION_INVALID/); assert.equal(invalid.reads, 1);
});

test("live late-window phase sequence converges by the third read without extending a signed interval", async () => {
  // Synthetic zero-offset reconstruction consistent with Production HTTP end
  // times 11:04:50.598 UNKNOWN, 11:04:59.116 OK and 11:05:07.661 OK. These
  // HTTP timestamps alone do NOT prove each historical signed window/margin:
  // its server offset and observation timing were not preserved in the alert.
  // Here fixed 5.5s delays exhaust all three reads; an aligned third read
  // starts at 11:05:10 rather than the old late-phase 11:05:05.327.
  // Effective latencies include the measured HTTP RTT and inter-probe RPC
  // overhead (second:2322+696ms; third:2334+711ms), all simulated locally.
  const f = fixture({ startsAt: Date.parse("2026-10-13T11:04:49.064Z"),
    responses: ["EXECUTOR_ACCOUNT_ORDER_BUDGET_UNKNOWN", "OK", "OK"],
    latencies: [1534, 3018, 3045], minimumValidityMs: 4000 });
  const sample = await f.collect();
  assert.equal(sample.observedAt, "2026-10-13T11:05:13.045Z");
  assert.equal(f.reads, 3); assert.equal(f.records, 1); assert.equal(f.owner, null);
  assert.deepEqual(f.events.filter(event => event.startsWith("WAIT:")), ["WAIT:5500", "WAIT:10884"]);
  assert.ok(f.events.every(event => !/DISPATCH|CREATE|GUARD/.test(event)));
});

test("validated retry uses the signed clock offset and aligns only after lease release", async () => {
  const f = fixture({ startsAt: Date.parse("2026-10-13T11:04:57Z"),
    minimumValidityMs: 4000, observationOffset: 1500, releaseLatency: 2500 });
  const sample = await f.collect();
  assert.equal(sample.observedAt, "2026-10-13T11:05:08.500Z");
  assert.equal(f.reads, 2); assert.equal(f.records, 1); assert.equal(f.owner, null);
  assert.deepEqual(f.events.filter(event => event.startsWith("WAIT:")), ["WAIT:9000"]);
});

test("aligned late-window retry cannot exceed the original deadline", async () => {
  const f = fixture({ startsAt: Date.parse("2026-10-13T11:04:57Z"),
    minimumValidityMs: 4000, deadlineMs: 10000 });
  await assert.rejects(f.collect(), /BUDGET_UNKNOWN/);
  assert.equal(f.reads, 1); assert.equal(f.records, 0); assert.equal(f.owner, null);
  assert.ok(f.events.every(event => !event.startsWith("WAIT:")));
  const delayedRelease = fixture({ startsAt: Date.parse("2026-10-13T11:04:57Z"),
    minimumValidityMs: 4000, deadlineMs: 14000, releaseLatency: 8000 });
  await assert.rejects(delayedRelease.collect(), /BUDGET_UNKNOWN/);
  assert.equal(delayedRelease.reads, 1); assert.equal(delayedRelease.records, 0);
  assert.equal(delayedRelease.owner, null);
  assert.ok(delayedRelease.events.every(event => !event.startsWith("WAIT:")));
});

test("only ownership-validated window failures retain coarse typed exhaustion evidence", async () => {
  const nearEnd = fixture({ startsAt: Date.parse("2026-10-13T11:04:57Z"),
    minimumValidityMs: 4000, deadlineMs: 10000 });
  await assert.rejects(nearEnd.collect(), (error: Error & { observationFailure?: unknown }) => {
    assert.deepEqual(error.observationFailure, { reason: "WINDOW_MARGIN", phase: "BEFORE_RECORD",
      attempts: 1, minimumValidityMs: 4000, remainingValidityMs: 3000 });
    return true;
  });
  const expired = fixture({ startsAt: Date.parse("2026-10-13T11:04:34Z"),
    minimumValidityMs: 4000, observationLag: 9000, deadlineMs: 6000 });
  await assert.rejects(expired.collect(), (error: Error & { observationFailure?: unknown }) => {
    assert.deepEqual(error.observationFailure, { reason: "WINDOW_EXPIRED", phase: "BEFORE_RECORD",
      attempts: 1, minimumValidityMs: 4000, remainingValidityMs: -4000 });
    return true;
  });
  const persistedLate = fixture({ startsAt: Date.parse("2026-10-13T11:04:01Z"),
    minimumValidityMs: 4000, recordLatency: 7500, deadlineMs: 10000 });
  await assert.rejects(persistedLate.collect(), (error: Error & { observationFailure?: unknown }) => {
    assert.deepEqual(error.observationFailure, { reason: "WINDOW_MARGIN", phase: "AFTER_RECORD",
      attempts: 1, minimumValidityMs: 4000, remainingValidityMs: 1500 });
    return true;
  });
  for (const f of [nearEnd, expired, persistedLate]) {
    assert.equal(f.owner, null);
    assert.ok(f.events.every(event => !/DISPATCH|CREATE|GUARD/.test(event)));
  }
});

test("dispatch Hold preserves only proved window evidence, never fabricates a reason for other failures", async () => {
  const window = fixture({ startsAt: Date.parse("2026-10-13T11:04:57Z"), latencies: [0, 7000, 7000] });
  await assert.rejects(window.reserve(), (error: Error & { observationFailure?: any }) => {
    assert.equal(error.message, "COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN");
    assert.deepEqual(error.observationFailure, { reason: "WINDOW_MARGIN", phase: "BEFORE_RECORD",
      attempts: 3, minimumValidityMs: 4000, remainingValidityMs: 3000 });
    return true;
  });
  for (const options of [{ responses: ["NETWORK"] }, { responses: ["INVALID"] },
    { responses: ["DENIED"] }, { recordError: true },
    { startsAt: Date.parse("2026-10-13T11:04:01Z"), recordLatency: 35000, intervalMs: 60000 }]) {
    const f = fixture(options);
    await assert.rejects(f.reserve(), (error: Error & { observationFailure?: unknown }) => {
      assert.equal(error.message, "COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN");
      assert.equal(error.observationFailure, null);
      return true;
    });
    assert.ok(f.events.every(event => !/DISPATCH|CREATE|GUARD/.test(event)));
  }
});

test("post-record database latency cannot return success beyond 35s even with a valid long counter window", async () => {
  const f = fixture({ startsAt: Date.parse("2026-10-13T11:04:01Z"),
    minimumValidityMs: 4000, recordLatency: 35000, intervalMs: 60000 });
  await assert.rejects(f.collect(), (error: Error & { observationFailure?: unknown }) => {
    assert.equal(error.message, "COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN");
    assert.equal(error.observationFailure, undefined, "deadline alone cannot invent a window failure");
    return true;
  });
  assert.equal(f.reads, 1); assert.equal(f.records, 1); assert.equal(f.owner, null);
  assert.ok(f.events.every(event => !/WAIT|DISPATCH|CREATE|GUARD/.test(event)));
});
