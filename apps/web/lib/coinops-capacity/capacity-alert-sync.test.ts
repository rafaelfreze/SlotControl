import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const compiled = ts.transpileModule(readFileSync(new URL("./capacity-server.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded: Record<string, unknown> = {};
new Function("require", "exports", compiled)(() => ({}), loaded);
const sync = loaded.updateCapacityAlerts as (service: unknown, shard: string,
  codes: Array<{ code: string; severity: string }>, details: object, resolve?: boolean) => Promise<void>;

function fixture(open: string[] = [], failure = "") {
  const calls: Array<{ kind: string; filters: Record<string, unknown>; value?: unknown }> = [];
  const service = { from(table: string) {
    assert.equal(table, "executor_capacity_alerts");
    const filters: Record<string, unknown> = {};
    let kind = "read", value: unknown;
    const result = () => {
      calls.push({ kind, filters: { ...filters }, value });
      return { data: open.map((code) => ({ code })), error: failure === kind ? { message: "fixture" } : null };
    };
    const chain = { select: () => chain,
      eq: (key: string, item: unknown) => { filters[key] = item; return chain; },
      in: (key: string, item: unknown) => { filters[key] = item; return chain; },
      is: (key: string, item: unknown) => { filters[key] = item; return chain; },
      update: (item: unknown) => { kind = "update"; value = item; return chain; },
      upsert: async (item: unknown, options: { onConflict: string }) => {
        assert.equal(options.onConflict, "shard_id,code"); kind = "upsert"; value = item; return result();
      },
      then: (fn: (item: unknown) => unknown) => Promise.resolve(result()).then(fn) };
    return chain;
  } };
  return { service, calls };
}

test("healthy capacity collector performs one internal read and zero alert writes per shard", async () => {
  for (const shard of ["executor-01", "executor-02", "executor-03", "executor-04"]) {
    const { service, calls } = fixture();
    await sync(service, shard, [], { state: "HEALTHY" });
    assert.deepEqual(calls.map((row) => row.kind), ["read"]);
    assert.equal(calls[0].filters.shard_id, shard);
    assert.equal(calls[0].filters.resolved_at, null);
  }
});

test("active alerts are batched, absent open alerts resolve once and remain shard-scoped", async () => {
  const { service, calls } = fixture(["EXECUTOR_OFFLINE", "ENGINE_STALE", "BINANCE_WEIGHT_WARNING"]);
  await sync(service, "executor-02", [{ code: "BINANCE_WEIGHT_WARNING", severity: "WARNING" },
    { code: "CAPACITY_LIMIT", severity: "CRITICAL" }], { state: "CAPACITY_LIMIT" });
  assert.deepEqual(calls.map((row) => row.kind), ["read", "upsert", "update"]);
  const rows = calls[1].value as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((row) => row.code), ["BINANCE_WEIGHT_WARNING", "CAPACITY_LIMIT"]);
  assert.ok(rows.every((row) => row.shard_id === "executor-02" && row.resolved_at === null));
  assert.deepEqual(calls[2].filters, { shard_id: "executor-02",
    code: ["EXECUTOR_OFFLINE", "ENGINE_STALE"], resolved_at: null });
});

test("missing telemetry never resolves previous incidents and needs no open-alert read", async () => {
  const { service, calls } = fixture(["ENGINE_STALE"]);
  await sync(service, "executor-03", [{ code: "EXECUTOR_OFFLINE", severity: "CRITICAL" }], {}, false);
  assert.deepEqual(calls.map((row) => row.kind), ["upsert"]);
});

test("read, publication and resolution failures remain visible and fail closed", async () => {
  const read = fixture([], "read");
  await assert.rejects(sync(read.service, "executor-01", [], {}), /COINOPS_CAPACITY_ALERT_READ_FAILED/);
  assert.deepEqual(read.calls.map((row) => row.kind), ["read"]);
  const write = fixture([], "upsert");
  await assert.rejects(sync(write.service, "executor-01", [{ code: "ENGINE_STALE", severity: "CRITICAL" }], {}),
    /COINOPS_CAPACITY_ALERT_WRITE_FAILED/);
  const clear = fixture(["ENGINE_STALE"], "update");
  await assert.rejects(sync(clear.service, "executor-01", [], {}), /COINOPS_CAPACITY_ALERT_RESOLVE_FAILED/);
});

test("repeat healthy collection does not rewrite closed history or duplicate alerts", async () => {
  const { service, calls } = fixture();
  await sync(service, "executor-03", [], {});
  await sync(service, "executor-03", [], {});
  assert.ok(calls.every((row) => row.kind === "read"));
});
