import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { shouldNotifyAssetHealthTransition } from "./rules.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("./push.ts", import.meta.url), "utf8");
type Row = Record<string, any>;
type Tables = Record<string, Row[]>;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const ahead = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const event = (id = "event-1", before: string | null = "HEALTHY", after = "ATTENTION") => ({
  id, asset: "SOL", status_before: before, status_after: after, created_at: ago(1),
});
const device = (id = "device-1", extra: Row = {}) => ({
  id, user_id: "admin-1", operator_id: "operator-1", endpoint: `https://push.example.invalid/${id}`,
  p256dh: "fixture-public-key", auth_secret: "fixture-auth", warning_enabled: true, enabled: true, ...extra,
});
const delivery = (extra: Row = {}) => ({
  id: "delivery-1", event_id: "event-1", subscription_id: "device-1", status: "PENDING", attempt_count: 0,
  next_attempt_at: ago(1), lease_token: null, lease_until: null, ...extra,
});

function fixture(overrides: Partial<Tables> = {}) {
  const tables: Tables = {
    asset_health_events: [event()], operators: [{ id: "operator-1", user_id: "admin-1", tenant_id: "tenant-coinops", status: "ACTIVE" }],
    operator_push_subscriptions: [device()], asset_health_deliveries: [], ...overrides,
  };
  const accessed: Array<{ table: string; operation: string }> = [];
  const attempts: Array<{ device: Row; message: Row }> = [];
  const successful: Array<{ device: Row; message: Row }> = [];
  const state = { failSends: 0, readFailure: "", queueFailure: false };
  let nextId = 1;
  class Query {
    operation = "select";
    filters: Array<(row: Row) => boolean> = [];
    values: Row = {};
    inserts: Row[] = [];
    sorting: { key: string; ascending: boolean } | null = null;
    max = Infinity;
    readonly table: string;
    constructor(table: string) { this.table = table; if (!(table in tables)) throw new Error(`Unexpected table: ${table}`); }
    select(_columns: string) { return this; }
    eq(key: string, value: unknown) { this.filters.push((row) => row[key] === value); return this; }
    lt(key: string, value: unknown) { this.filters.push((row) => row[key] != null && row[key] < value!); return this; }
    lte(key: string, value: unknown) { this.filters.push((row) => row[key] != null && row[key] <= value!); return this; }
    gte(key: string, value: unknown) { this.filters.push((row) => row[key] != null && row[key] >= value!); return this; }
    in(key: string, values: unknown[]) { this.filters.push((row) => values.includes(row[key])); return this; }
    order(key: string, options?: { ascending: boolean }) { this.sorting = { key, ascending: options?.ascending ?? true }; return this; }
    limit(max: number) { this.max = max; return this; }
    update(values: Row) { this.operation = "update"; this.values = values; return this; }
    upsert(values: Row[], options: { onConflict: string; ignoreDuplicates: boolean }) {
      assert.deepEqual(options, { onConflict: "event_id,subscription_id", ignoreDuplicates: true });
      this.operation = "upsert"; this.inserts = values; return this;
    }
    execute() {
      accessed.push({ table: this.table, operation: this.operation });
      if (state.readFailure === this.table && this.operation === "select") return { data: null, error: { code: "FIXTURE_READ_FAILURE" } };
      if (state.queueFailure && this.operation === "upsert") return { data: null, error: { code: "FIXTURE_QUEUE_FAILURE" } };
      if (this.operation === "upsert") {
        for (const values of this.inserts) if (!tables[this.table].some((row) => row.event_id === values.event_id && row.subscription_id === values.subscription_id)) {
          tables[this.table].push(delivery({ ...values, id: `delivery-generated-${nextId++}` }));
        }
        return { data: null, error: null };
      }
      let selected = tables[this.table].filter((row) => this.filters.every((filter) => filter(row)));
      const sorting = this.sorting;
      if (sorting) selected = selected.sort((a, b) => String(a[sorting.key]).localeCompare(String(b[sorting.key])) * (sorting.ascending ? 1 : -1));
      selected = selected.slice(0, this.max);
      if (this.operation === "update") selected.forEach((row) => Object.assign(row, this.values));
      return { data: structuredClone(selected), error: null };
    }
    then<TResult1 = any, TResult2 = never>(resolve?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null, reject?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null) {
      return Promise.resolve(this.execute()).then(resolve, reject);
    }
  }
  const service = { from: (table: string) => new Query(table) };
  const loadedModule = { exports: {} as { dispatchAssetHealthPush: () => Promise<{ status: string; sent: number; failed?: number }> } };
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "module", "exports", compiled)((name: string) => {
    if (name === "server-only") return {};
    if (name === "../supabase/env") return { getCoinOpsServiceTenantId: () => "tenant-coinops" };
    if (name === "./access") return { assetHealthService: () => service };
    if (name === "./rules") return { shouldNotifyAssetHealthTransition };
    if (name === "../coinops-notifications/push-server") return { sendToDevice: async (target: Row, message: Row) => {
      attempts.push({ device: target, message });
      if (state.failSends > 0) { state.failSends--; throw new Error("FIXTURE_PUSH_PROVIDER_UNAVAILABLE"); }
      successful.push({ device: target, message });
    } };
    if (name !== "node:crypto") throw new Error(`Unexpected import: ${name}`);
    return require(name);
  }, loadedModule, loadedModule.exports);
  return { dispatch: loadedModule.exports.dispatchAssetHealthPush, tables, state, attempts, successful, accessed };
}

test("initial, unchanged and missing-data transitions do not create push deliveries", async () => {
  const f = fixture({ asset_health_events: [event("initial", null, "HEALTHY"), event("same", "HEALTHY", "HEALTHY"),
    event("missing", "HEALTHY", "INSUFFICIENT_DATA"), event("initial-evidence", "INSUFFICIENT_DATA", "HEALTHY")] });
  assert.equal((await f.dispatch()).sent, 0);
  assert.equal(f.tables.asset_health_deliveries.length, 0);
  assert.equal(f.attempts.length, 0);
});

test("changed health is delivered once per event/device and repeated dispatch remains deduplicated", async () => {
  const f = fixture({ operator_push_subscriptions: [device("phone"), device("desktop")] });
  assert.equal((await f.dispatch()).sent, 2);
  assert.equal((await f.dispatch()).sent, 0);
  assert.equal(f.tables.asset_health_deliveries.length, 2);
  assert.ok(f.tables.asset_health_deliveries.every((row) => row.status === "SENT" && row.attempt_count === 1 && row.lease_token === null));
  assert.equal(f.attempts.length, 2);
  assert.ok(f.successful.every(({ message }) => message.url === "/automacao?view=live&account=ALL&assetHealth=SOL"
    && message.tag === "asset-health:event-1" && message.body.includes("nenhuma ordem foi alterada")));
  assert.ok(f.accessed.every(({ table, operation }) => operation === "select" || table === "asset_health_deliveries"));
});

test("only enabled subscriptions owned by active CoinOps tenant administrators receive internal alerts", async () => {
  const f = fixture({
    operators: [{ id: "operator-1", user_id: "admin-1", tenant_id: "tenant-coinops", status: "ACTIVE" },
      { id: "foreign", user_id: "foreign-admin", tenant_id: "another-tenant", status: "ACTIVE" },
      { id: "inactive", user_id: "inactive-admin", tenant_id: "tenant-coinops", status: "INACTIVE" }],
    operator_push_subscriptions: [device(), device("viewer", { user_id: "viewer-1" }), device("disabled", { enabled: false }),
      device("foreign", { operator_id: "foreign", user_id: "foreign-admin" }), device("inactive", { operator_id: "inactive", user_id: "inactive-admin" })],
  });
  await f.dispatch();
  assert.deepEqual(f.successful.map((row) => row.device.id), ["device-1"]);
  const absent = fixture({ operators: [] });
  assert.equal((await absent.dispatch()).status, "NO_ADMIN_DEVICES");
  assert.equal(absent.attempts.length, 0);
});

test("warning preference suppresses ordinary transitions but preserves structural risk and its recovery", async () => {
  const f = fixture({
    operator_push_subscriptions: [device("quiet", { warning_enabled: false })],
    asset_health_events: [event("warning", "HEALTHY", "ATTENTION"), event("risk", "ATTENTION", "STRUCTURAL_RISK"),
      event("risk-recovery", "STRUCTURAL_RISK", "ATTENTION"), event("normal", "ATTENTION", "HEALTHY")],
  });
  assert.equal((await f.dispatch()).sent, 2);
  assert.deepEqual(f.tables.asset_health_deliveries.map((row) => row.event_id).sort(), ["risk", "risk-recovery"]);
});

test("Binance critical transition is admin-only, deduplicated and deep-links to its drawer", async () => {
  const f = fixture({ asset_health_events: [{ ...event("binance-risk", "ATTENTION", "CRITICAL_RISK"), asset: "BINANCE" }] });
  assert.equal((await f.dispatch()).sent, 1);
  assert.equal((await f.dispatch()).sent, 0);
  assert.equal(f.successful[0].message.url, "/automacao?view=live&account=ALL&assetHealth=BINANCE");
  assert.match(f.successful[0].message.body, /RISCO CRÍTICO/);
});

test("two concurrent dispatchers claim the same pending delivery only once", async () => {
  const f = fixture();
  const outcomes = await Promise.all([f.dispatch(), f.dispatch()]);
  assert.equal(outcomes.reduce((sum, outcome) => sum + outcome.sent, 0), 1);
  assert.equal(f.successful.length, 1);
  assert.equal(f.tables.asset_health_deliveries.length, 1);
  assert.equal(f.tables.asset_health_deliveries[0].attempt_count, 1);
});

test("active sending lease is preserved and expired sending lease can be recovered", async () => {
  const f = fixture({ asset_health_deliveries: [delivery({ status: "SENDING", lease_token: "previous-worker", lease_until: ahead(1) })] });
  assert.equal((await f.dispatch()).sent, 0);
  assert.equal(f.tables.asset_health_deliveries[0].lease_token, "previous-worker");
  f.tables.asset_health_deliveries[0].lease_until = ago(1);
  assert.equal((await f.dispatch()).sent, 1);
  assert.equal(f.tables.asset_health_deliveries[0].status, "SENT");
  assert.equal(f.successful[0].message.tag, "asset-health:event-1");
});

test("delivery provider failures back off, retry at most three times and persist terminal failure", async () => {
  const f = fixture(); f.state.failSends = 3;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) f.tables.asset_health_deliveries[0].next_attempt_at = ago(1);
    const result = await f.dispatch();
    assert.equal(result.status, "PARTIAL_FAILURE");
    const row = f.tables.asset_health_deliveries[0];
    assert.equal(row.attempt_count, attempt);
    assert.equal(row.status, attempt === 3 ? "FAILED" : "PENDING");
    assert.equal(row.error_code, "DELIVERY_FAILED");
    assert.equal(row.lease_token, null);
    assert.ok(Date.parse(row.next_attempt_at) >= Date.now() + 29 * 60_000);
    assert.equal((await f.dispatch()).sent, 0);
    assert.equal(f.attempts.length, attempt);
  }
  assert.equal(f.successful.length, 0);
  assert.equal(f.tables.asset_health_deliveries.length, 1);
});

test("stale queued events expire and unavailable database/queue fails before sending", async () => {
  const expired = fixture({ asset_health_events: [], asset_health_deliveries: [delivery()] });
  await expired.dispatch();
  assert.equal(expired.tables.asset_health_deliveries[0].status, "EXPIRED");
  assert.equal(expired.attempts.length, 0);
  const readFailure = fixture(); readFailure.state.readFailure = "asset_health_events";
  await assert.rejects(readFailure.dispatch(), /COINOPS_ASSET_HEALTH_PUSH_READ_FAILED/);
  assert.equal(readFailure.attempts.length, 0);
  const queueFailure = fixture(); queueFailure.state.queueFailure = true;
  await assert.rejects(queueFailure.dispatch(), /COINOPS_ASSET_HEALTH_PUSH_QUEUE_FAILED/);
  assert.equal(queueFailure.attempts.length, 0);
});
