import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { capacityAlertMessage } from "./capacity-alert-policy.ts";
import { unresolvedInfrastructureBlock } from "../coinops-notifications/infrastructure-push-policy.ts";
import { samePushInstant, OPERATIONAL_PUSH_TTL_SECONDS } from "../coinops-notifications/operational-push-policy.ts";

// Execute the real capacity dispatcher against an in-memory Data API and a
// typed provider fixture. No credentials, network, exchange or financial write.
type Row = Record<string, any>;
const NOW = Date.parse("2026-10-15T16:00:00Z");
const iso = (seconds = 0) => new Date(NOW + seconds * 1_000).toISOString();
const initialAlert = (extra: Row = {}) => ({ id: "alert", shard_id: "executor-03", code: "EXECUTOR_OFFLINE",
  severity: "CRITICAL", first_seen_at: iso(-180), resolved_at: null, ...extra });
const initialDelivery = (extra: Row = {}) => ({ id: "delivery", alert_id: "alert", opened_at: iso(-180),
  subscription_id: "device", status: "PENDING", attempt_count: 0, next_attempt_at: iso(-1), created_at: iso(-1),
  lease_until: null, error_code: null, ...extra });
class PushTransportError extends Error {
  readonly outcome: "REJECTED" | "UNKNOWN";
  readonly statusCode: number | undefined;
  constructor(statusCode?: number) { super("TYPED_PROVIDER_FAILURE"); this.statusCode = statusCode;
    this.outcome = statusCode ? "REJECTED" : "UNKNOWN"; }
}

function fixture(overrides: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    executor_capacity_alerts: [initialAlert()], operators: [{ id: "operator", user_id: "admin", tenant_id: "tenant", status: "ACTIVE" }],
    watchdog_checks: [{ shard_id: "executor-03", checked_at: iso(-20), shard_state: "OFFLINE" }],
    watchdog_incidents: [{ shard_id: "executor-03", engine_id: null, account_id: null,
      incident_key: "SHARD:EXECUTOR_OFFLINE", detected_condition: "EXECUTOR_OFFLINE", opened_at: iso(-180),
      last_seen_at: iso(-20), state_after: "OFFLINE", result: "OPEN", resolved_at: null }],
    operator_push_subscriptions: [{ id: "device", operator_id: "operator", user_id: "admin", enabled: true,
      endpoint: "https://web.push.apple.com/fixture", p256dh: "fixture", auth_secret: "fixture", warning_enabled: true }],
    executor_capacity_deliveries: [], ...overrides,
  };
  const writes: Array<{ table: string; values: Row; filters: Record<string, unknown> }> = [];
  const attempts: Array<{ device: Row; message: Row; options: Row }> = [], accepted: typeof attempts = [];
  const state = { now: NOW, afterClaim: "", failReadAfterClaim: false, failSentAudit: 0, failAllAudit: false,
    failProvider: 0, providerStatus: 503 as number | undefined, loseClaim: false,
    onTransport: null as (() => Promise<void>) | null };
  let nextId = 1, claimed = false;
  class Query {
    action = "select"; values: Row = {}; filters: Record<string, unknown> = {};
    predicates: Array<(row: Row) => boolean> = []; inserts: Row[] = []; conflict: string[] = [];
    max = Infinity; ordering = "";
    readonly table: string;
    constructor(table: string) { this.table = table; assert.ok(table in tables, `Unexpected table ${table}`); }
    select() { return this; }
    eq(key: string, value: unknown) { this.filters[key] = value;
      this.predicates.push(row => key.endsWith("_at") && row[key] && value
        ? Date.parse(row[key]) === Date.parse(String(value)) : row[key] === value); return this; }
    is(key: string, value: unknown) { this.filters[key] = value;
      this.predicates.push(row => value === null ? row[key] == null : row[key] === value); return this; }
    neq(key: string, value: unknown) { this.predicates.push(row => row[key] !== value); return this; }
    in(key: string, value: unknown[]) { this.predicates.push(row => value.includes(row[key])); return this; }
    lt(key: string, value: string) { this.predicates.push(row => row[key] != null && Date.parse(row[key]) < Date.parse(value)); return this; }
    lte(key: string, value: string) { this.predicates.push(row => row[key] != null && Date.parse(row[key]) <= Date.parse(value)); return this; }
    gte(key: string, value: string) { this.predicates.push(row => row[key] != null && Date.parse(row[key]) >= Date.parse(value)); return this; }
    limit(max: number) { this.max = max; return this; }
    order(key: string) { this.ordering = key; return this; }
    update(values: Row) { this.action = "update"; this.values = values; return this; }
    upsert(values: Row[], config: { onConflict: string; ignoreDuplicates: boolean }) {
      assert.equal(config.ignoreDuplicates, true); this.action = "upsert"; this.inserts = values;
      this.conflict = config.onConflict.split(","); return this;
    }
    execute(single = false) {
      if (this.action === "select" && state.failReadAfterClaim && claimed && this.table === "watchdog_checks")
        return { data: null, error: { code: "OBSERVATION_FAILED" } };
      if (this.action === "upsert") {
        for (const values of this.inserts) {
          if (!tables[this.table].some(row => this.conflict.every(key => key === "opened_at"
            ? samePushInstant(row[key], values[key]) : row[key] === values[key])))
            tables[this.table].push(initialDelivery({ ...values, id: `delivery-${nextId++}` }));
        }
        return { data: null, error: null };
      }
      let rows = tables[this.table].filter(row => this.predicates.every(predicate => predicate(row)));
      if (this.ordering) rows.sort((a, b) => String(a[this.ordering]).localeCompare(String(b[this.ordering])));
      rows = rows.slice(0, this.max);
      if (this.action === "update") {
        writes.push({ table: this.table, values: structuredClone(this.values), filters: { ...this.filters } });
        if (this.values.status === "SENDING" && state.loseClaim) rows = [];
        if ((this.values.status === "SENT" && state.failSentAudit-- > 0 || state.failAllAudit)
          && this.table === "executor_capacity_deliveries" && this.values.status !== "SENDING")
          return { data: null, error: { code: "AUDIT_FAILED" } };
        rows.forEach(row => Object.assign(row, structuredClone(this.values)));
        if (this.values.status === "SENDING" && rows.length) {
          claimed = true;
          if (state.afterClaim === "resolved") tables.executor_capacity_alerts[0].resolved_at = iso();
          if (state.afterClaim === "recovered") tables.watchdog_checks[0].shard_state = "HEALTHY";
          if (state.afterClaim === "missing") tables.watchdog_incidents = [];
          if (state.afterClaim === "disabled") tables.operator_push_subscriptions[0].enabled = false;
        }
      }
      return { data: structuredClone(single ? rows[0] ?? null : rows), error: null };
    }
    maybeSingle() { return Promise.resolve(this.execute(true)); }
    then(resolve: (value: unknown) => unknown) { return Promise.resolve(this.execute()).then(resolve); }
  }
  const service = { from: (table: string) => new Query(table) };
  class FixtureDate extends Date {
    constructor(value?: any) { super(value === undefined ? state.now : value); }
    static now() { return state.now; }
  }
  const dependencies: Record<string, unknown> = {
    "@/lib/coinops-notifications/push-server": { PushTransportError,
      sendToDevice: async (device: Row, message: Row, options: Row) => {
        const value = { device, message, options }; attempts.push(value);
        const callback = state.onTransport; state.onTransport = null; if (callback) await callback();
        if (state.failProvider > 0) { state.failProvider--; throw new PushTransportError(state.providerStatus); }
        accepted.push(value);
      } },
    "@/lib/coinops-notifications/infrastructure-push-policy": {
      unresolvedInfrastructureBlock: (alert: any, check: any, incident: any) => unresolvedInfrastructureBlock(alert, check, incident, state.now) },
    "@/lib/coinops-notifications/operational-push-policy": { samePushInstant, OPERATIONAL_PUSH_TTL_SECONDS },
    "@/lib/supabase/env": { getCoinOpsServiceTenantId: () => "tenant" },
    "./capacity-server": { capacityScope: () => service }, "./capacity-alert-policy": { capacityAlertMessage },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./capacity-push.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exported: Record<string, any> = {};
  new Function("require", "exports", "Date", compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name];
  }, exported, FixtureDate);
  const refresh = () => {
    tables.watchdog_checks.forEach(row => { row.checked_at = new Date(state.now - 20_000).toISOString(); });
    tables.watchdog_incidents.forEach(row => { row.last_seen_at = new Date(state.now - 20_000).toISOString(); });
  };
  return { dispatch: exported.dispatchCapacityPush as () => Promise<Row>, tables, state, writes, attempts, accepted, refresh };
}

test("capacity, resource and short-lived outages remain panel-only; only persistent WD outage sends once", async () => {
  for (const code of ["CAPACITY_LIMIT", "EXECUTOR_CAPACITY_WARNING", "EXECUTOR_RESOURCE_WARNING", "ENGINE_STALE"] ) {
    const f = fixture({ executor_capacity_alerts: [initialAlert({ code })] });
    await f.dispatch(); assert.equal(f.attempts.length, 0); assert.equal(f.tables.executor_capacity_deliveries.length, 0);
  }
  const young = fixture({ executor_capacity_alerts: [initialAlert({ first_seen_at: iso(-30) })] });
  await young.dispatch(); assert.equal(young.attempts.length, 0);
  const f = fixture(); await f.dispatch(); await f.dispatch();
  assert.equal(f.accepted.length, 1); assert.equal(f.tables.executor_capacity_deliveries[0].status, "SENT");
  assert.equal(f.attempts[0].options.ttl, 60); assert.match(f.attempts[0].message.title, /BLOQUEIO PERSISTENTE/);
  assert.ok(f.writes.every(write => ["executor_capacity_deliveries", "operator_push_subscriptions"].includes(write.table)));
});

test("same timestamp instant deduplicates and sends even with differing PostgREST serialization", async () => {
  const f = fixture({ executor_capacity_deliveries: [initialDelivery({ opened_at: iso(-180).replace(".000Z", "+00:00") })] });
  await f.dispatch(); assert.equal(f.tables.executor_capacity_deliveries.length, 1); assert.equal(f.accepted.length, 1);
});

test("pre-transport unknown or recovered evidence defers without consuming provider attempts", async () => {
  for (const mode of ["read-error", "missing", "recovered"]) {
    const f = fixture(); f.state.failReadAfterClaim = mode === "read-error";
    f.state.afterClaim = mode; await f.dispatch();
    assert.equal(f.attempts.length, 0); assert.equal(f.tables.executor_capacity_deliveries[0].status, "PENDING");
    assert.equal(f.tables.executor_capacity_deliveries[0].attempt_count, 0);
    assert.equal(f.tables.executor_capacity_deliveries[0].error_code, "BLOCK_EVIDENCE_UNAVAILABLE");
  }
});

test("resolved alert or disabled device after claim expires without external delivery", async () => {
  for (const mode of ["resolved", "disabled"]) {
    const f = fixture(); f.state.afterClaim = mode; await f.dispatch();
    assert.equal(f.attempts.length, 0); assert.equal(f.tables.executor_capacity_deliveries[0].status, "EXPIRED");
  }
});

test("two dispatchers and lost claims cannot deliver twice; all claim writes carry attempt fences", async () => {
  const f = fixture(); f.state.onTransport = async () => { await f.dispatch(); }; await f.dispatch();
  assert.equal(f.accepted.length, 1);
  const claims = f.writes.filter(write => write.values.status === "SENDING");
  assert.equal(claims.length, 1); assert.equal(claims[0].filters.attempt_count, 0);
  const completion = f.writes.find(write => write.values.status === "SENT")!;
  assert.equal(completion.filters.attempt_count, 1); assert.equal(completion.filters.attempted_at, iso());
  const lost = fixture(); lost.state.loseClaim = true; await lost.dispatch(); assert.equal(lost.attempts.length, 0);
});

test("typed safe provider rejection retries at most three times; 410 disables and unknown never retries", async () => {
  const rejected = fixture(); rejected.state.failProvider = 4;
  for (let i = 0; i < 4; i++) { await rejected.dispatch(); rejected.state.now += 180_000; rejected.refresh(); }
  assert.equal(rejected.attempts.length, 3); assert.equal(rejected.tables.executor_capacity_deliveries[0].status, "FAILED");
  assert.equal(rejected.tables.executor_capacity_deliveries[0].error_code, "PROVIDER_REJECTED_HTTP_503");
  const expired = fixture(); expired.state.failProvider = 1; expired.state.providerStatus = 410;
  await expired.dispatch(); assert.equal(expired.tables.operator_push_subscriptions[0].enabled, false);
  assert.equal(expired.tables.executor_capacity_deliveries[0].status, "EXPIRED");
  const unknown = fixture(); unknown.state.failProvider = 1; unknown.state.providerStatus = undefined;
  await unknown.dispatch(); unknown.state.now += 180_000; unknown.refresh(); await unknown.dispatch();
  assert.equal(unknown.attempts.length, 1); assert.equal(unknown.tables.executor_capacity_deliveries[0].status, "FAILED");
});

test("provider acceptance followed by failed audit never resends; expired SENDING stays UNKNOWN", async () => {
  const f = fixture(); f.state.failSentAudit = 1; await f.dispatch();
  f.state.now += 180_000; f.refresh(); await f.dispatch();
  assert.equal(f.accepted.length, 1); assert.equal(f.tables.executor_capacity_deliveries[0].status, "FAILED");
  assert.equal(f.tables.executor_capacity_deliveries[0].error_code, "PROVIDER_ACCEPTED_AUDIT_FAILED");
  const stale = fixture({ executor_capacity_deliveries: [initialDelivery({ status: "SENDING", attempt_count: 1,
    lease_until: iso(-10), attempted_at: iso(-100) })] });
  await stale.dispatch(); assert.equal(stale.attempts.length, 0);
  assert.equal(stale.tables.executor_capacity_deliveries[0].error_code, "DELIVERY_OUTCOME_UNKNOWN");
});

test("foreign tenant/device outbox is untouched and wrong subscription user cannot receive", async () => {
  const foreign = initialDelivery({ id: "foreign", subscription_id: "foreign-device", status: "SENDING",
    attempt_count: 1, lease_until: iso(-10) });
  const pending = initialDelivery({ id: "foreign-pending", subscription_id: "foreign-device" });
  const otherDevice = { id: "foreign-device", operator_id: "foreign-operator", user_id: "other-admin", enabled: true };
  const f = fixture({ operators: [{ id: "operator", user_id: "admin", tenant_id: "tenant", status: "ACTIVE" },
    { id: "foreign-operator", user_id: "other-admin", tenant_id: "other-tenant", status: "ACTIVE" }],
    operator_push_subscriptions: [{ id: "device", operator_id: "operator", user_id: "admin", enabled: true }, otherDevice],
    executor_capacity_deliveries: [foreign, pending] });
  const before = structuredClone([foreign, pending]); await f.dispatch();
  assert.deepEqual(f.tables.executor_capacity_deliveries.filter(row => row.subscription_id === "foreign-device"), before);
  assert.equal(f.accepted.length, 1); assert.equal(f.accepted[0].device.id, "device");
  const wrong = fixture({ operator_push_subscriptions: [{ id: "wrong-user", operator_id: "operator", user_id: "viewer", enabled: true }] });
  await wrong.dispatch(); assert.equal(wrong.attempts.length, 0);
});

test("legacy PENDING with ambiguous prior delivery is final; safe rejection identity survives a deferred GET", async () => {
  for (const error_code of [null, "DELIVERY_FAILED", "DELIVERY_OUTCOME_UNKNOWN", "PROVIDER_ACCEPTED_AUDIT_FAILED"]) {
    const f = fixture({ executor_capacity_deliveries: [initialDelivery({ attempt_count: 1, error_code })] });
    await f.dispatch(); assert.equal(f.attempts.length, 0);
    assert.equal(f.tables.executor_capacity_deliveries[0].status, "FAILED");
    assert.equal(f.tables.executor_capacity_deliveries[0].error_code, "DELIVERY_OUTCOME_UNKNOWN");
  }
  const f = fixture({ executor_capacity_deliveries: [initialDelivery({ attempt_count: 1,
    error_code: "PROVIDER_REJECTED_HTTP_503" })] });
  f.state.failReadAfterClaim = true; await f.dispatch();
  assert.equal(f.attempts.length, 0); assert.equal(f.tables.executor_capacity_deliveries[0].attempt_count, 1);
  assert.equal(f.tables.executor_capacity_deliveries[0].status, "PENDING");
  assert.equal(f.tables.executor_capacity_deliveries[0].error_code, "PROVIDER_REJECTED_HTTP_503");
});

test("capacity alert reopen during a continuous Watchdog outage does not repeat a physical push", async () => {
  const f = fixture(); await f.dispatch();
  f.tables.executor_capacity_alerts[0].first_seen_at = iso(-130);
  await f.dispatch(); assert.equal(f.accepted.length, 1);
  assert.equal(f.tables.executor_capacity_deliveries.length, 2);
  assert.equal(f.tables.executor_capacity_deliveries[1].status, "EXPIRED");
  assert.equal(f.tables.executor_capacity_deliveries[1].error_code, "INCIDENT_ALREADY_ESCALATED");
});
