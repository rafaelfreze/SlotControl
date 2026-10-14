import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import ts from "typescript";
import type * as Shards from "./executor-shards-server.ts";
import { boundedExecutorBindingRead, completeExecutorBindingFacts, observeExecutorBindingRecord } from "./executor-binding-read.ts";
import { LiveLedgerReadFailed, LiveReadUnavailable, liveFailureEvidence } from "./live-read-error.ts";
import { createLiveExecutorOrder } from "./live-executor-transport.ts";

type Row = Record<string, unknown>;
type Fault = { status?: number; code?: string; message?: string; thrown?: unknown;
  data?: unknown; delay?: number; deadline?: boolean };
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const operatorId = uuid(1), accountId = uuid(2), engineId = uuid(3);
const scope = { operator_id: operatorId, exchange_account_id: accountId, trading_engine_id: engineId,
  symbol: "SOLBRL", quote_asset: "BRL" };
const environment = { COINOPS_EXECUTOR_SHARDS_JSON: JSON.stringify({
  "executor-02": { egressIp: "203.0.113.22", baseUrl: "https://203.0.113.22",
    hmacSecret: "nonproduction-second-fixture".repeat(3), validatedVersion: "fixture-second" },
  "executor-03": { egressIp: "203.0.113.33", baseUrl: "https://203.0.113.33",
    hmacSecret: "nonproduction-third-fixture".repeat(3), validatedVersion: "fixture-third" },
}) };

/** Compile the real resolver; only the provider is an in-memory fixture. No
 * filesystem writes, credentials, provider calls or financial mutations. */
function fixture(faults: Record<string, Fault[]> = {}) {
  const rows: Record<string, Row> = {
    operators: { id: operatorId, tenant_id: "fixture-tenant", status: "ACTIVE" },
    exchange_accounts: { id: accountId, operator_id: operatorId, executor_shard_id: "executor-01" },
    trading_engines: { id: engineId, operator_id: operatorId, exchange_account_id: accountId, executor_shard_id: "executor-02" },
    executor_shards: { id: "executor-02", egress_ipv4: "203.0.113.22/32" },
  };
  const queries: Array<{ table: string; filters: Row; signal?: AbortSignal }> = [];
  const service = { from(table: string) {
    const query = { table, filters: {} as Row, signal: undefined as AbortSignal | undefined };
    queries.push(query);
    const chain = {
      select: () => chain,
      eq: (key: string, value: unknown) => { query.filters[key] = value; return chain; },
      abortSignal: (signal: AbortSignal) => { query.signal = signal; return chain; },
      single: () => chain,
      then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
        const read = async () => {
          const fault = faults[table]?.shift();
          if (fault) {
            if (fault.delay) await new Promise(done => setTimeout(done, fault.delay));
            if (fault.deadline) controllers.get(query.signal!)!.abort();
            if (fault.thrown) throw fault.thrown;
            return Object.hasOwn(fault, "data")
              ? { data: fault.data, error: null, status: fault.status ?? 200 }
              : { data: null, error: { code: fault.code ?? "", message: fault.message ?? "must not leak" }, status: fault.status };
          }
          const row = rows[table]!;
          return { data: Object.entries(query.filters).every(([key, value]) => row[key] === value) ? row : null,
            error: null, status: 200 };
        };
        return read().then(resolve, reject);
      },
    };
    return chain;
  } };
  const dependencies: Record<string, unknown> = { "node:net": { isIP },
    "./executor-binding-read.ts": { boundedExecutorBindingRead, completeExecutorBindingFacts, observeExecutorBindingRecord },
    "../supabase/env": { getCoinOpsServiceTenantId: () => "fixture-tenant", getSupabaseDataSchema: () => "coinops" },
    "../supabase/service-role": { createServiceRoleClient: () => service } };
  const compiled = ts.transpileModule(readFileSync(new URL("./executor-shards-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Row = {};
  new Function("require", "exports", "process", compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected resolver dependency: ${name}`); return dependencies[name];
  }, exports, { env: environment });
  return { rows, queries, resolve: exports.resolveExecutorForEngine as typeof Shards.resolveExecutorForEngine,
    reads: (table: string) => queries.filter(query => query.table === table).length };
}

const controllers = new Map<AbortSignal, AbortController>();

test("one complete bounded engine binding uses exact scope and never account bootstrap routing", async () => {
  const db = fixture();
  const [first, second] = await Promise.all([
    db.resolve(operatorId, accountId, engineId), db.resolve(operatorId, accountId, engineId),
  ]);
  assert.equal(first.shardId, "executor-02"); assert.deepEqual(second, first);
  assert.equal(db.queries.length, 4, "coalesced and cached only the complete success");
  assert.ok(db.queries.every(query => query.signal === db.queries[0]!.signal));
  assert.deepEqual(db.queries.find(query => query.table === "operators")?.filters,
    { id: operatorId, tenant_id: "fixture-tenant" });
  assert.deepEqual(db.queries.find(query => query.table === "trading_engines")?.filters,
    { id: engineId, exchange_account_id: accountId, operator_id: operatorId });
  assert.equal(db.rows.exchange_accounts!.executor_shard_id, "executor-01");
});

test("proven transient provider GETs reread all binding facts with one fresh deadline", async () => {
  for (const table of ["operators", "exchange_accounts", "trading_engines", "executor_shards"]) {
    for (const fault of [{ status: 502 }, { status: 503 }, { status: 504 },
      { status: 503, code: "PGRST001" }, { status: 0, message: "TypeError: fetch failed" },
      { thrown: new TypeError("fetch failed; must not leak") }]) {
      const db = fixture({ [table]: [fault] });
      assert.equal((await db.resolve(operatorId, accountId, engineId)).shardId, "executor-02");
      assert.equal(db.reads("operators"), 2); assert.equal(db.reads("exchange_accounts"), 2);
      assert.equal(db.reads("trading_engines"), 2);
      assert.equal(db.reads("executor_shards"), table === "executor_shards" ? 2 : 1);
      assert.equal(new Set(db.queries.map(query => query.signal)).size, 2);
    }
  }
});

test("persistent GET outage is finite, typed and preserves only sanitized evidence", async () => {
  for (const [table, path] of [["operators", "operator"], ["exchange_accounts", "account"],
    ["trading_engines", "engine"], ["executor_shards", "shard"]]) {
    const faults = Array.from({ length: 3 }, () => ({ status: 503, code: "PGRST001", message: "must not leak" }));
    const db = fixture({ [table]: faults });
    await assert.rejects(db.resolve(operatorId, accountId, engineId), (error: unknown) => {
      assert.ok(error instanceof LiveReadUnavailable);
      assert.deepEqual(liveFailureEvidence(error, "READ_STATE", "LIVE_CRON"), {
        stage: "READ_STATE", source: "ENGINE", root_code: "COINOPS_EXECUTOR_BINDING_READ_UNAVAILABLE",
        read_path: `executor_binding/${path}`, read_attempts: 2, http_status: 503, provider_code: "PGRST001",
      });
      return true;
    });
    assert.equal(db.reads("operators"), 2); assert.equal(faults.length, 1);
  }
});

test("own expired GET deadline is bounded; permission/schema never become a timeout", async () => {
  const previous = AbortSignal.timeout;
  AbortSignal.timeout = (ms: number) => {
    assert.equal(ms, 5000); const controller = new AbortController();
    controllers.set(controller.signal, controller); return controller.signal;
  };
  try {
    const db = fixture({ trading_engines: [{ deadline: true, status: 0 }, { deadline: true, status: 0 }] });
    await assert.rejects(db.resolve(operatorId, accountId, engineId), (error: unknown) =>
      error instanceof LiveReadUnavailable && error.attempts === 2
      && error.path === "executor_binding/engine");
    const denied = fixture({ trading_engines: [{ deadline: true, status: 503, code: "42501" }] });
    await assert.rejects(denied.resolve(operatorId, accountId, engineId), (error: unknown) =>
      error instanceof LiveLedgerReadFailed && error.providerCode === "42501");
    assert.equal(denied.reads("operators"), 1);
  } finally { AbortSignal.timeout = previous; controllers.clear(); }
});

test("permission/schema/unclassified GET failures stay fail-closed and never retry", async () => {
  for (const fault of [{ status: 503, code: "42501" }, { status: 504, code: "42P01" },
    { status: 503, code: "PGRST204" }, { status: 401 }, { status: 500 },
    { status: 0, message: "unclassified read failure" }, { thrown: new Error("must not leak") },
    { status: 503, code: "must not leak secret" }]) {
    const db = fixture({ trading_engines: [fault] });
    await assert.rejects(db.resolve(operatorId, accountId, engineId), (error: unknown) => {
      assert.ok(error instanceof LiveLedgerReadFailed);
      assert.equal(error.message, "COINOPS_EXECUTOR_BINDING_READ_FAILED");
      assert.equal(error.path, "executor_binding/engine"); assert.equal(error.attempts, 1);
      assert.ok(!JSON.stringify(liveFailureEvidence(error, "READ_STATE", "LIVE_CRON")).includes("must not leak"));
      return true;
    });
    assert.equal(db.reads("operators"), 1);
  }
});

test("successful missing/malformed rows and true owner/shard mismatches never retry or fall back", async () => {
  for (const data of [null, [], "bad"]) {
    const db = fixture({ trading_engines: [{ data }] });
    await assert.rejects(db.resolve(operatorId, accountId, engineId), /EXECUTOR_ENGINE_SHARD_DENIED/);
    assert.equal(db.reads("operators"), 1);
  }
  for (const [table, patch] of [["operators", { status: "DISABLED" }], ["operators", { tenant_id: "foreign" }],
    ["exchange_accounts", { operator_id: uuid(90) }], ["trading_engines", { exchange_account_id: uuid(91) }],
    ["trading_engines", { executor_shard_id: "" }], ["executor_shards", { egress_ipv4: "malformed" }]] as const) {
    const db = fixture(); Object.assign(db.rows[table]!, patch);
    await assert.rejects(db.resolve(operatorId, accountId, engineId), /EXECUTOR_ENGINE_SHARD_DENIED/);
    assert.equal(db.reads("operators"), 1);
  }
  const differentIp = fixture(); differentIp.rows.executor_shards!.egress_ipv4 = "203.0.113.99";
  await assert.rejects(differentIp.resolve(operatorId, accountId, engineId), /EXECUTOR_SHARD_IP_MISMATCH/);
  assert.equal(differentIp.reads("operators"), 1);
});

test("parallel slow permission failure wins over fast transient routing observation", async () => {
  const db = fixture({ exchange_accounts: [{ status: 403, code: "42501", delay: 10 }],
    trading_engines: [{ status: 503 }] });
  await assert.rejects(db.resolve(operatorId, accountId, engineId), (error: unknown) =>
    error instanceof LiveLedgerReadFailed && error.path === "executor_binding/account" && error.providerCode === "42501");
  assert.equal(db.reads("operators"), 1);
});

test("fulfilled disabled/foreign/invalid routing facts outrank a parallel transient GET", async () => {
  for (const [table, data, transientTable] of [
    ["operators", { id: operatorId, tenant_id: "fixture-tenant", status: "DISABLED" }, "trading_engines"],
    ["operators", { id: operatorId, tenant_id: "foreign", status: "ACTIVE" }, "trading_engines"],
    ["exchange_accounts", { id: accountId, operator_id: uuid(99) }, "trading_engines"],
    ["trading_engines", { id: engineId, operator_id: operatorId, exchange_account_id: accountId, executor_shard_id: "" }, "exchange_accounts"],
  ] as const) {
    const db = fixture({ [table]: [{ data, delay: 10 }], [transientTable]: [{ status: 503 }] });
    await assert.rejects(db.resolve(operatorId, accountId, engineId), /EXECUTOR_ENGINE_SHARD_DENIED/);
    assert.equal(db.reads("operators"), 1, "known successful scope denial must not receive an observation retry");
  }
});

test("failed lookup never enters route cache; fresh retry still resolves exact engine/shard", async () => {
  const db = fixture({ trading_engines: [{ status: 503 }, { status: 503 }] });
  await assert.rejects(db.resolve(operatorId, accountId, engineId), /COINOPS_EXECUTOR_BINDING_READ_UNAVAILABLE/);
  assert.equal((await db.resolve(operatorId, accountId, engineId)).shardId, "executor-02");
  assert.equal(db.reads("operators"), 3);
  await assert.rejects(db.resolve(operatorId, accountId, uuid(99)), /EXECUTOR_ENGINE_SHARD_DENIED/);
  assert.equal(db.reads("operators"), 4, "another engine cannot inherit the successful cached binding");
});

test("same-symbol sibling on another shard resolves separately, never from shared account bootstrap", async () => {
  const db = fixture();
  assert.equal((await db.resolve(operatorId, accountId, engineId)).shardId, "executor-02");
  db.rows.trading_engines = { ...db.rows.trading_engines, id: uuid(4), executor_shard_id: "executor-03" };
  db.rows.executor_shards = { id: "executor-03", egress_ipv4: "203.0.113.33" };
  assert.equal((await db.resolve(operatorId, accountId, uuid(4))).shardId, "executor-03");
  assert.equal((await db.resolve(operatorId, accountId, engineId)).shardId, "executor-02");
  assert.equal(db.reads("operators"), 2);
});

test("binding retry cannot retry a financial POST or turn outage into dispatch authorization", async () => {
  let posts = 0;
  const fetcher = (async () => { posts++; return Response.json({}, { status: 503 }); }) as typeof fetch;
  const failed = fixture({ trading_engines: [{ status: 503 }, { status: 503 }] });
  await assert.rejects(createLiveExecutorOrder({ clientOrderId: "fixture-order" }, scope, "fixture-decision", fetcher,
    failed.resolve), /COINOPS_EXECUTOR_BINDING_READ_UNAVAILABLE/);
  assert.equal(posts, 0);
  const recovered = fixture({ trading_engines: [{ status: 503 }] });
  await assert.rejects(createLiveExecutorOrder({ clientOrderId: "fixture-order" }, scope, "fixture-decision", fetcher,
    recovered.resolve), /EXECUTOR_HTTP_503/);
  assert.equal(posts, 1, "only the GET retry converges; uncertain financial write is never repeated");
  assert.equal(recovered.reads("operators"), 2);
});
