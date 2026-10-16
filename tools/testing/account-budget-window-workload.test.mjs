import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { BinanceLiveTransport } from "../../apps/live-executor/src/binance-live.mjs";
import { createAccountOrderBudgetReader, AccountOrderBudgetWindowExpired } from "../../apps/live-executor/src/account-order-budget.mjs";
import { completeLedgerRead } from "../../apps/web/lib/execution/complete-ledger-read.ts";
import { projectAccountBudgetObservation } from "../../apps/web/lib/execution/account-order-budget-observation.ts";
import { signedExecutorHeaders } from "../../apps/web/lib/execution/live-executor-client.ts";
import * as topology from "../../apps/web/lib/execution/engine-slot-topology.ts";

const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const ts = require("typescript");
const BASE = Date.parse("2026-10-16T18:00:00Z");
const OPERATOR = "00000000-0000-4000-8000-000000000001";
const ACCOUNT = "00000000-0000-4000-8000-000000000002";

// Executes the actual web collector, native reader/cache and native Binance
// transport. Database RPCs, connection resolution and network are fixtures.
// No strategy implementation, financial write, env/vault or remote DB exists.
function fixture({ globalOrders = false, symbols = ["BTCUSDT", "SOLBRL", "SOLUSDT"], minimumGetLatency = 0,
  completeWindowProtocol = false, expiredObservationPatch = null } = {}) {
  const callsPerProbe = 3 + symbols.length + (globalOrders ? 1 : symbols.length);
  let clock = BASE + 9999 - callsPerProbe * minimumGetLatency, owner = null, bridgeCalls = 0, records = 0;
  const probes = [], requests = [], waits = [];
  const target = { shardId: "executor-03", ip: "203.0.113.3", base: "https://fixture.invalid",
    credentialRef: "fixture-only", validatedVersion: "offline-release", secret: "fixture-secret-not-real-32-characters" };
  const scope = { operator_id: OPERATOR, exchange_account_id: ACCOUNT, environment: "REAL" };
  const engines = symbols.map((symbol, index) => ({ ...scope, id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`, symbol }));
  const weight = url => url.pathname === "/api/v3/time" ? 1 : url.pathname === "/api/v3/exchangeInfo" ? 20
    : ["/api/v3/rateLimit/order", "/api/v3/myFilters"].includes(url.pathname) ? 40
      : url.pathname === "/api/v3/openOrders" ? url.searchParams.has("symbol") ? 6 : 80 : assert.fail(url.pathname);
  const lastOrderRead = url => url.pathname === "/api/v3/openOrders"
    && (globalOrders || url.searchParams.get("symbol") === symbols.at(-1));
  let activeProbe = 0, collection = 0, probeInCollection = 0;
  const nativeFetch = async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? "GET", start = clock;
    assert.equal(method, "GET", "fixture must never submit/cancel Binance orders");
    assert.ok(["api.binance.com", "data-api.binance.vision"].includes(url.hostname));
    let delay = 0;
    // Native counter-crossing failures (not a web WINDOW_MARGIN sample) are
    // intentionally complete observations rejected only at the final check.
    if (collection === 1 && probeInCollection === 1 && lastOrderRead(url)) delay = 1;
    if (probeInCollection === 2 && lastOrderRead(url)) delay = 4500;
    if (collection === 2 && probeInCollection === 1 && url.pathname === "/api/v3/myFilters" && url.searchParams.get("symbol") === symbols[0]) delay = 5000;
    if (collection === 2 && probeInCollection === 1 && lastOrderRead(url)) delay = 5000;
    delay += minimumGetLatency;
    assert.ok(delay < 8000, "every individual GET remains inside the real 8s timeout");
    clock += delay;
    requests.push({ probe: activeProbe, host: url.hostname, path: url.pathname,
      symbol: url.searchParams.get("symbol"), start: start - BASE, end: clock - BASE,
      weight: weight(url), delay });
    if (url.pathname === "/api/v3/time") return Response.json({ serverTime: clock });
    if (url.pathname === "/api/v3/rateLimit/order") return Response.json([
      { rateLimitType: "ORDERS", interval: "SECOND", intervalNum: 10, limit: 50, count: 0 },
      { rateLimitType: "ORDERS", interval: "DAY", intervalNum: 1, limit: 160000, count: 0 } ]);
    if (url.pathname === "/api/v3/exchangeInfo") return Response.json({
      exchangeFilters: globalOrders ? [{ filterType: "EXCHANGE_MAX_NUM_ORDERS", maxNumOrders: 1000 }] : [],
      symbols: symbols.map(symbol => ({ symbol, status: "TRADING", filters: [
        { filterType: "MAX_NUM_ORDERS", maxNumOrders: 200 } ], allowedSelfTradePreventionModes: ["NONE", "EXPIRE_TAKER"] })) });
    if (url.pathname === "/api/v3/myFilters") return Response.json({ symbolFilters: [
      { filterType: "MAX_NUM_ORDERS", maxNumOrders: 200 } ], exchangeFilters: [], assetFilters: [] });
    if (url.pathname === "/api/v3/openOrders") return Response.json([]);
    assert.fail(url.pathname);
  };
  const nativeRead = createAccountOrderBudgetReader({ now: () => clock });
  class Query {
    constructor(table) { this.table = table; this.patch = null; this.filters = {}; }
    select() { return this; } order() { return this; } range() { return this; } in() { return this; } not() { return this; }
    eq(key, value) { this.filters[key] = value; return this; }
    update(patch) { this.patch = patch; return this; }
    then(resolve) {
      if (this.patch) {
        assert.equal(this.table, "account_order_budget_probe_leases");
        assert.equal(this.filters.operator_id, OPERATOR); assert.equal(this.filters.exchange_account_id, ACCOUNT);
        assert.equal(this.filters.lease_owner, owner); owner = null;
        return Promise.resolve(resolve({ error: null }));
      }
      return Promise.resolve(resolve({ data: this.table === "trading_engines" ? engines : [], error: null }));
    }
  }
  const service = { from: table => new Query(table), rpc: async (name, args) => {
    if (name === "acquire_account_order_budget_probe") {
      assert.equal(owner, null); owner = args.p_lease_owner; return { data: true, error: null };
    }
    assert.equal(name, "record_account_order_budget_sample");
    assert.equal(args.p_lease_owner, owner); records++; owner = null;
    return { data: true, error: null };
  } };
  const bridgeFetch = async (input, init) => {
    assert.equal(input, `${target.base}/v1/admin/order-budget`); assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    assert.equal(body.operator_id, OPERATOR); assert.equal(body.exchange_account_id, ACCOUNT);
    assert.equal(body.executor_shard_id, "executor-03"); assert.deepEqual(body.symbols, symbols);
    activeProbe = ++bridgeCalls; probeInCollection++;
    const started = clock;
    const transport = new BinanceLiveTransport({ apiKey: "offline-key", apiSecret: "offline-secret",
      fetcher: nativeFetch, now: () => clock });
    try {
      const sample = await nativeRead(scope, transport, symbols);
      const remaining = Math.min(...sample.intervals.map(row => (Math.floor(sample.serverTime / row.intervalMs) + 1) * row.intervalMs)) - clock;
      probes.push({ probe: activeProbe, start: started - BASE, end: clock - BASE, status: "PASS", remaining });
      assert.ok(clock - started < 20000, "successful probe is inside collector HTTP20s");
      return Response.json({ ...sample, ...scope, executor_shard_id: target.shardId,
        executor_ip: target.ip, credential_ref: target.credentialRef, executor_version: target.validatedVersion });
    } catch (error) {
      assert.ok(error instanceof AccountOrderBudgetWindowExpired);
      probes.push({ probe: activeProbe, start: started - BASE, end: clock - BASE, status: "COUNTER_CROSSING" });
      assert.ok(clock - started < 20000, "failed complete probe is inside collector HTTP20s");
      if (!completeWindowProtocol) {
        // The former wire protocol discarded a complete late-window snapshot
        // as generic UNKNOWN. Keep that historical witness reproducible.
        return Response.json({ error: "EXECUTOR_ACCOUNT_ORDER_BUDGET_UNKNOWN" }, { status: 503 });
      }
      return Response.json({ error: error.code, observation: { ...error.observation, ...scope,
        executor_shard_id: target.shardId, executor_ip: target.ip, credential_ref: target.credentialRef,
        executor_version: target.validatedVersion, ...expiredObservationPatch } }, { status: 409 });
    }
  };
  class Clock extends Date { constructor(value = clock) { super(value); } static now() { return clock; } }
  const dependencies = {
    "node:crypto": { randomUUID },
    "node:timers/promises": { setTimeout: async ms => { assert.equal(owner, null); waits.push(ms); clock += ms; } },
    "./complete-ledger-read.ts": { completeLedgerRead },
    "./engine-slot-topology.ts": topology,
    "./account-order-budget-observation.ts": { projectAccountBudgetObservation: (sample, context, at = clock) => projectAccountBudgetObservation(sample, context, at) },
    "./executor-shards-server.ts": {
      resolveExecutorForConnection: async () => target, resolveExecutorForEngine: async () => target,
      parseExecutorValidatedVersions: value => value === target.validatedVersion ? [value] : null,
      withExecutorShard: input => ({ ...input, executor_shard_id: target.shardId }) },
    "./live-executor-client.ts": { signedExecutorHeaders },
  };
  const source = readFileSync(new URL("../../apps/web/lib/execution/account-order-budget-server.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = {};
  new Function("require", "exports", "Date", "fetch", compiled)(name => {
    assert.ok(name in dependencies, name); return dependencies[name];
  }, loaded, Clock, bridgeFetch);
  return { probes, requests, waits, collect: () => { collection++; probeInCollection = 0;
    return loaded.collectAccountOrderBudget(service, OPERATOR, ACCOUNT,
      target.shardId, ["SOLBRL"], bridgeFetch, { minimumValidityMs: 4000 }); },
    get clock() { return clock; }, get records() { return records; },
    moveToNextWindow: () => { clock = Math.floor(clock / 10000) * 10000 + 10001; } };
}

for (const config of [{ globalOrders: false, symbols: ["BTCUSDT", "SOLBRL", "SOLUSDT"], cost: 199 },
  { globalOrders: false, symbols: ["BTCUSDT", "SOLBRL", "SOLUSDT"], cost: 199, minimumGetLatency: 10 },
  { globalOrders: true, symbols: ["BTCBRL", "BTCUSDT", "SOLBRL", "SOLUSDT"], cost: 301 }])
  test(`two canonical collectors can complete six full native probes below60s (${config.symbols.length} markets/global=${config.globalOrders}/baseGET=${config.minimumGetLatency ?? 0}ms)`, async () => {
    const f = fixture(config), started = f.clock;
    await f.collect(); const firstEnd = f.clock;
    f.moveToNextWindow(); const secondStart = f.clock;
    await f.collect();
    assert.deepEqual(f.probes.map(row => row.status), ["COUNTER_CROSSING", "COUNTER_CROSSING", "PASS",
      "COUNTER_CROSSING", "COUNTER_CROSSING", "PASS"]);
    const requestLatency = (3 + config.symbols.length + (config.globalOrders ? 1 : config.symbols.length)) * (config.minimumGetLatency ?? 0);
    assert.deepEqual(f.probes.map(row => row.start), [9999 - requestLatency, 15500, 25500 + requestLatency,
      30001, 45501 + requestLatency, 55501 + 2 * requestLatency]);
    assert.equal(firstEnd - started, 15501 + 3 * requestLatency);
    assert.equal(f.clock - secondStart, 25500 + 3 * requestLatency);
    assert.equal(f.clock - started, 45502 + 4 * requestLatency); assert.ok(f.clock - started < 60000);
    assert.equal(f.records, 2); assert.deepEqual(f.waits, [5500, 5500, 5500, 5500]);
    for (const row of f.probes.filter(row => row.status === "PASS")) assert.ok(row.remaining >= 4000);
    for (let probe = 1; probe <= 6; probe++) {
      const calls = f.requests.filter(row => row.probe === probe);
      assert.equal(calls.reduce((sum, row) => sum + row.weight, 0), config.cost);
      assert.equal(calls.filter(row => row.path === "/api/v3/myFilters").length, config.symbols.length);
      assert.equal(calls.filter(row => row.path === "/api/v3/openOrders").length, config.globalOrders ? 1 : config.symbols.length);
    }
    console.log(JSON.stringify({ contract: "ACCOUNT_BUDGET_WINDOW_WORKLOAD_WITNESS_V1", offline: true,
      production_writes: 0, financial_posts: 0, clock_offset: 0, symbols: config.symbols, global_orders: config.globalOrders,
      synthetic_minimum_get_latency_ms: config.minimumGetLatency ?? 0,
      collector_deadline_ms: 35000, http_deadline_ms: 20000, native_get_deadline_ms: 8000,
      elapsed_ms: f.clock - started, total_weight: 6 * config.cost, probes: f.probes,
      requests: f.requests.map(({ symbol, ...row }) => ({ ...row, ...(symbol ? { symbol } : {}) })) }));
  });

for (const config of [{ globalOrders: false, symbols: ["BTCUSDT", "SOLBRL", "SOLUSDT"], cost: 199 },
  { globalOrders: true, symbols: ["BTCBRL", "BTCUSDT", "SOLBRL", "SOLUSDT"], cost: 301 }])
  test(`complete-window409 aligns canonical collectors without changing dates/counters (${config.symbols.length} markets)`, async () => {
    const f = fixture({ ...config, completeWindowProtocol: true }), started = f.clock;
    await f.collect(); f.moveToNextWindow(); await f.collect();
    assert.deepEqual(f.probes.map(row => row.status), ["COUNTER_CROSSING", "PASS", "COUNTER_CROSSING", "PASS"]);
    assert.deepEqual(f.probes.map(row => row.start), [9999, 20000, 30001, 50000]);
    assert.deepEqual(f.waits, [10000, 9999]); assert.equal(f.records, 2);
    assert.equal(f.clock - started, 44501); assert.equal(f.requests.reduce((sum, row) => sum + row.weight, 0), 4 * config.cost);
    for (const row of f.probes.filter(row => row.status === "PASS")) assert.ok(row.remaining >= 4000);
    console.log(JSON.stringify({ contract: "ACCOUNT_BUDGET_WINDOW_WORKLOAD_WITNESS_V2", offline: true,
      financial_posts: 0, elapsed_ms: f.clock - started, total_weight: 4 * config.cost,
      probe_count: f.probes.length, records: f.records, waits: f.waits, probes: f.probes }));
  });

test("forged or unproved expired-window payload never schedules retries or saves a budget", async () => {
  for (const expiredObservationPatch of [{ exchange_account_id: "foreign" }, { executor_shard_id: "executor-02" },
    { executor_ip: "203.0.113.99" }, { symbols: [] }, { executor_version: "unreviewed" },
    { observedAt: BASE + 30000, serverTime: BASE + 30000 }]) {
    const f = fixture({ completeWindowProtocol: true, expiredObservationPatch });
    await assert.rejects(f.collect()); assert.equal(f.probes.length, 1);
    assert.equal(f.records, 0); assert.deepEqual(f.waits, []);
  }
});
