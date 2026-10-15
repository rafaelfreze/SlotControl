import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire as moduleRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as publicPolicy from "./push-policy.ts";

// The real dispatcher is executed with an in-memory Data API and an isolated
// Web Push provider. No Supabase client, endpoint or exchange is contacted.
type Row = Record<string, any>;
type Tables = Record<string, Row[]>;
const require = moduleRequire(import.meta.url);
const NOW = Date.parse("2026-10-15T14:24:00.000Z");
const iso = (offsetSeconds = 0) => new Date(NOW + offsetSeconds * 1_000).toISOString();
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const ENGINE = "00000000-0000-4000-8000-000000000002";
const SIBLING = "00000000-0000-4000-8000-000000000003";
const ALERT = "00000000-0000-4000-8000-000000000004";
const RUN = "00000000-0000-4000-8000-000000000005";
const INCIDENT = "00000000-0000-4000-8000-000000000006";

const alert = (extra: Row = {}) => ({
  id: ALERT, product_id: "product", tenant_id: "tenant", user_id: "admin", operator_id: "operator",
  exchange_account_id: ACCOUNT, trading_engine_id: ENGINE, asset: "SOL", severity: "CRITICAL",
  alert_key: `LIVE_RUN:${RUN}:CRITICAL`, code: "COINOPS_LIVE_LEDGER_READ_FAILED",
  first_seen_at: iso(-180), last_seen_at: iso(-30), resolved_at: null,
  details: { run_id: RUN, stage: "READ_LEDGER" }, ...extra,
});
const engine = (extra: Row = {}) => ({
  id: ENGINE, tenant_id: "tenant", operator_id: "operator", exchange_account_id: ACCOUNT,
  symbol: "SOLBRL", environment: "REAL", status: "ACTIVE", kill_switch: true,
  executor_shard_id: "executor-02", ...extra,
});
const account = (extra: Row = {}) => ({ id: ACCOUNT, operator_id: "operator", tenant_id: "tenant",
  display_name: "Conta Fixture", status: "ACTIVE", kill_switch: false,
  executor_shard_id: "executor-01", ...extra });
const run = (extra: Row = {}) => ({
  id: RUN, product_id: "product", tenant_id: "tenant", user_id: "admin", operator_id: "operator",
  exchange_account_id: ACCOUNT, trading_engine_id: ENGINE, symbol: "SOLBRL", asset: "SOL",
  status: "ACTIVE", last_error: "COINOPS_LIVE_LEDGER_READ_FAILED", last_reconciled_at: iso(-30),
  lease_owner: null, lease_until: null, created_at: iso(-86_400), ...extra,
});
const incident = (extra: Row = {}) => ({
  incident_id: INCIDENT, shard_id: "executor-02", account_id: ACCOUNT, engine_id: ENGINE,
  market: "SOLBRL", incident_key: `${RUN}:COINOPS_LIVE_LEDGER_READ_FAILED`,
  detected_condition: "COINOPS_LIVE_LEDGER_READ_FAILED", severity: "CRITICAL",
  state_before: "UNKNOWN", state_after: "BLOCKED", result: "OPEN", actions_taken: [],
  opened_at: iso(-180), last_seen_at: iso(-20), last_recovery_attempt_at: null,
  resolved_at: null, error_code: "COINOPS_LIVE_LEDGER_READ_FAILED", ...extra,
});
const check = (extra: Row = {}) => ({
  shard_id: "executor-02", checked_at: iso(-20), updated_at: iso(-20), shard_state: "BLOCKED",
  healthy_engines: 0, recovering_engines: 0, reconciling_engines: 0, blocked_engines: 1,
  stale_engines: 0, paused_engines: 0, ...extra,
});
const device = (extra: Row = {}) => ({
  id: "device", operator_id: "operator", user_id: "admin", enabled: true, warning_enabled: true,
  endpoint: "https://web.push.apple.com/fixture-not-a-real-subscription",
  p256dh: "fixture-public-key", auth_secret: "fixture-auth", ...extra,
});
const delivery = (extra: Row = {}) => ({
  id: "delivery", alert_id: ALERT, opened_at: iso(-180), subscription_id: "device", operator_id: "operator",
  account_id: ACCOUNT, engine_id: ENGINE, severity: "CRITICAL", device_count: 1,
  status: "PENDING", attempt_count: 0, next_attempt_at: iso(-1), created_at: iso(-1),
  lease_until: null, lease_token: null, ...extra,
});

function fixture(overrides: Partial<Tables> = {}) {
  const tables: Tables = {
    robot_v1_live_alerts: [alert()], robot_v1_live_runs: [run()], trading_engines: [engine()],
    exchange_accounts: [account()], operators: [{ id: "operator", user_id: "admin", tenant_id: "tenant",
      status: "ACTIVE", kill_switch: false }], operator_push_subscriptions: [device()],
    operator_push_deliveries: [], watchdog_incidents: [incident()], watchdog_checks: [check()],
    ...overrides,
  };
  const accessed: Array<{ table: string; operation: string; values?: Row }> = [];
  const attempts: Array<{ subscription: Row; message: Row; options: Row }> = [];
  const accepted: typeof attempts = [];
  const state = {
    now: NOW, readFailure: "", failSends: 0, providerStatus: 503, failSentAudit: 0,
    claimLost: false, expireAfterClaim: false, recoverAfterClaim: false,
    loseIncidentAfterClaim: false, loseCheckAfterClaim: false, disableDeviceAfterClaim: false,
    onTransport: null as (() => Promise<void>) | null,
    nextDeliveryId: null as string | null,
  };
  let nextId = 1;
  let nextLease = 1;
  class Query {
    operation = "select";
    filters: Array<(row: Row) => boolean> = [];
    values: Row = {};
    inserts: Row[] = [];
    conflictKeys: string[] = [];
    ignoreDuplicates = false;
    sorting: { key: string; ascending: boolean } | null = null;
    max = Infinity;
    start = 0;
    countExact = false;
    readonly table: string;
    constructor(table: string) {
      this.table = table;
      if (!(table in tables)) throw new Error(`Unexpected table: ${table}`);
    }
    select(_columns?: string, options?: { count?: string }) { this.countExact = options?.count === "exact"; return this; }
    eq(key: string, value: unknown) { this.filters.push(row => row[key] === value); return this; }
    neq(key: string, value: unknown) { this.filters.push(row => row[key] !== value); return this; }
    is(key: string, value: unknown) { this.filters.push(row => value === null ? row[key] == null : row[key] === value); return this; }
    lt(key: string, value: any) { this.filters.push(row => row[key] != null && row[key] < value); return this; }
    lte(key: string, value: any) { this.filters.push(row => row[key] != null && row[key] <= value); return this; }
    gt(key: string, value: any) { this.filters.push(row => row[key] != null && row[key] > value); return this; }
    gte(key: string, value: any) { this.filters.push(row => row[key] != null && row[key] >= value); return this; }
    in(key: string, values: unknown[]) { this.filters.push(row => values.includes(row[key])); return this; }
    order(key: string, options?: { ascending?: boolean }) { this.sorting = { key, ascending: options?.ascending ?? true }; return this; }
    limit(max: number) { this.max = max; return this; }
    range(start: number, end: number) { this.start = start; this.max = end - start + 1; return this; }
    abortSignal(_signal: AbortSignal) { return this; }
    update(values: Row) { this.operation = "update"; this.values = values; return this; }
    upsert(values: Row | Row[], options: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
      this.operation = "upsert"; this.inserts = Array.isArray(values) ? values : [values];
      this.conflictKeys = (options.onConflict ?? "id").split(","); this.ignoreDuplicates = options.ignoreDuplicates ?? false;
      return this;
    }
    execute(singular = false) {
      accessed.push({ table: this.table, operation: this.operation,
        ...(this.operation !== "select" ? { values: structuredClone(this.values) } : {}) });
      if (state.readFailure === this.table && this.operation === "select")
        return { data: null, error: { code: "FIXTURE_READ_FAILURE" }, count: null };
      if (this.operation === "upsert") {
        for (const values of this.inserts) {
          // PostgreSQL's timestamptz unique key compares instants, not their
          // PostgREST/JavaScript textual serialization.
          const match = tables[this.table].find(row => this.conflictKeys.every(key => key === "opened_at"
            ? Date.parse(row[key]) === Date.parse(values[key]) : row[key] === values[key]));
          if (match) { if (!this.ignoreDuplicates) Object.assign(match, structuredClone(values)); }
          else if (this.table === "operator_push_deliveries") {
            const id = state.nextDeliveryId ?? `delivery-${nextId++}`;
            state.nextDeliveryId = null;
            tables[this.table].push(delivery({ ...structuredClone(values), id,
              created_at: new Date(state.now).toISOString() }));
          } else tables[this.table].push(structuredClone(values));
        }
        return { data: null, error: null };
      }
      let selected = tables[this.table].filter(row => this.filters.every(filter => filter(row)));
      const count = selected.length;
      const sorting = this.sorting;
      if (sorting) selected = selected.sort((a, b) => String(a[sorting.key]).localeCompare(String(b[sorting.key]))
        * (sorting.ascending ? 1 : -1));
      selected = selected.slice(this.start, this.start + this.max);
      if (this.table === "operator_push_deliveries" && this.operation === "update") {
        if (this.values.status === "SENDING" && state.claimLost) selected = [];
        if (this.values.status === "SENT" && state.failSentAudit > 0) {
          state.failSentAudit--;
          return { data: null, error: { code: "FIXTURE_AUDIT_WRITE_FAILED" } };
        }
      }
      if (this.operation === "update") {
        selected.forEach(row => Object.assign(row, structuredClone(this.values)));
        if (this.table === "operator_push_deliveries" && this.values.status === "SENDING" && selected.length) {
          if (state.expireAfterClaim) tables.robot_v1_live_alerts.forEach(row => { row.resolved_at = iso(); });
          if (state.recoverAfterClaim) tables.watchdog_incidents.forEach(row => { row.state_after = "RECOVERING"; row.result = "RECOVERING"; });
          if (state.loseIncidentAfterClaim) tables.watchdog_incidents = [];
          if (state.loseCheckAfterClaim) tables.watchdog_checks = [];
          if (state.disableDeviceAfterClaim) tables.operator_push_subscriptions.forEach(row => { row.enabled = false; });
        }
      }
      return { data: structuredClone(singular ? selected[0] ?? null : selected), error: null,
        ...(this.countExact ? { count } : {}) };
    }
    async maybeSingle() { return this.execute(true); }
    async single() { return this.execute(true); }
    then(resolve: (value: any) => any, reject?: (reason: unknown) => any) {
      return Promise.resolve(this.execute()).then(resolve, reject);
    }
  }
  const service = { from: (table: string) => new Query(table) };
  const ecdh = createECDH("prime256v1");
  const privateBytes = Buffer.alloc(32, 1);
  ecdh.setPrivateKey(privateBytes);
  const env = {
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: ecdh.getPublicKey("base64url", "uncompressed"),
    VAPID_PRIVATE_KEY: privateBytes.toString("base64url"), VAPID_SUBJECT: "mailto:fixture@example.invalid",
  };
  class FixtureDate extends Date {
    constructor(value?: any) { super(value === undefined ? state.now : value); }
    static now() { return state.now; }
  }
  const transport = {
    setVapidDetails: () => undefined,
    sendNotification: async (subscription: Row, json: string, options: Row) => {
      const attempt = { subscription, message: JSON.parse(json), options };
      attempts.push(attempt);
      const overlap = state.onTransport;
      state.onTransport = null;
      if (overlap) await overlap();
      if (state.failSends > 0) { state.failSends--; throw { statusCode: state.providerStatus }; }
      accepted.push(attempt);
    },
  };
  const modules = new Map<string, any>();
  const load = (filename: string) => {
    if (modules.has(filename)) return modules.get(filename);
    const source = readFileSync(new URL(filename, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS } }).outputText;
    const loaded = { exports: {} as any };
    modules.set(filename, loaded.exports);
    new Function("require", "module", "exports", "process", "Date", compiled)((name: string) => {
      if (name === "server-only") return {};
      if (name === "web-push") return { __esModule: true, default: transport, ...transport };
      if (name === "@/lib/supabase/env" || name === "../supabase/env")
        return { getSupabaseDataSchema: () => "coinops", getCoinOpsServiceTenantId: () => "tenant" };
      if (name === "@/lib/supabase/service-role" || name === "../supabase/service-role")
        return { createServiceRoleClient: () => service };
      if (name === "./push-policy") return publicPolicy;
      if (name === "./operational-push-policy") return load("./operational-push-policy.ts");
      if (name === "node:crypto") return { ...require(name), randomUUID: () => `lease-${nextLease++}` };
      throw new Error(`Unexpected import: ${name}`);
    }, loaded, loaded.exports, { env }, FixtureDate);
    return loaded.exports;
  };
  const exported = load("./push-server.ts");
  return { dispatch: exported.dispatchOperationalPush as () => Promise<Row>, send: exported.sendToDevice,
    tables, state, attempts, accepted, accessed };
}

test("a transient alert across multiple engines does not send during normal reconciliation or Watchdog recovery", async () => {
  for (const recovery of ["RECONCILING", "RECOVERING"]) {
    const f = fixture({ robot_v1_live_alerts: [alert({ severity: "WARNING" }),
      alert({ id: "00000000-0000-4000-8000-000000000007", trading_engine_id: SIBLING })],
    watchdog_incidents: [incident({ state_after: recovery, result: recovery === "RECOVERING" ? "RECOVERING" : "OPEN" })],
    trading_engines: [engine(), engine({ id: SIBLING, kill_switch: false, executor_shard_id: "executor-03" })] });
    await f.dispatch();
    assert.equal(f.attempts.length, 0);
    assert.equal(f.accepted.length, 0);
    assert.ok(f.tables.robot_v1_live_alerts.every(row => row.resolved_at === null));
    // The normal engine subsequently resolves it; dispatch must not emit a
    // delayed notification from this now-healthy episode.
    f.tables.robot_v1_live_alerts.forEach(row => { row.resolved_at = iso(); });
    f.tables.watchdog_incidents.forEach(row => { row.resolved_at = iso(); row.result = "RECOVERED"; });
    await f.dispatch();
    assert.equal(f.attempts.length, 0);
  }
});

test("a confirmed persistent blocked incident sends once per device and repeated dispatch remains quiet", async () => {
  const f = fixture();
  await f.dispatch();
  assert.equal(f.accepted.length, 1);
  await f.dispatch();
  assert.equal(f.accepted.length, 1);
  assert.equal(f.tables.operator_push_deliveries.filter(row => row.status === "SENT").length, 1);
  assert.ok(f.accepted[0].message.url.includes(`engine=${ENGINE}`));
  assert.match(f.accepted[0].message.title, /BLOQUEIO/);
  assert.match(f.accepted[0].message.body, /Executor 02/);
  assert.match(f.accepted[0].message.body, /Watchdog não resolveu/);
});

test("a long-standing proven block escalates despite a protection lease, but ongoing recovery never does", async () => {
  for (const recovering of [false, true]) {
    const f = fixture({
      robot_v1_live_alerts: [alert({ first_seen_at: iso(-601) })],
      robot_v1_live_runs: [run({ lease_until: iso(30) })],
      watchdog_incidents: [incident({ opened_at: iso(-601),
        state_after: recovering ? "RECOVERING" : "BLOCKED", result: recovering ? "RECOVERING" : "OPEN" })],
    });
    await f.dispatch();
    assert.equal(f.accepted.length, recovering ? 0 : 1);
    assert.equal(f.tables.robot_v1_live_alerts[0].resolved_at, null);
  }
});

test("an alert resolved before dispatch never queues or sends", async () => {
  const f = fixture({ robot_v1_live_alerts: [alert({ resolved_at: iso(-1) })],
    operator_push_deliveries: [delivery()] });
  await f.dispatch();
  assert.equal(f.attempts.length, 0);
  assert.equal(f.tables.operator_push_deliveries[0].status, "EXPIRED");
});

test("resolution or healthy recovery after claim is rechecked before transport", async () => {
  const closed = fixture(); closed.state.expireAfterClaim = true;
  await closed.dispatch();
  assert.equal(closed.attempts.length, 0);
  assert.equal(closed.tables.operator_push_deliveries[0].status, "EXPIRED");
  const recovering = fixture(); recovering.state.recoverAfterClaim = true;
  await recovering.dispatch();
  assert.equal(recovering.attempts.length, 0);
  assert.ok(recovering.tables.robot_v1_live_alerts.every(row => row.resolved_at === null));
});

test("missing stale or provider-failed Watchdog evidence defers without resolving ledger alerts", async () => {
  for (const checks of [[], [check({ checked_at: iso(-151) })]]) {
    const f = fixture({ watchdog_checks: checks });
    await f.dispatch();
    assert.equal(f.attempts.length, 0);
    assert.equal(f.tables.robot_v1_live_alerts[0].resolved_at, null);
    assert.equal(f.tables.watchdog_incidents[0].resolved_at, null);
  }
  const denied = fixture(); denied.state.readFailure = "watchdog_checks";
  await assert.rejects(denied.dispatch());
  assert.equal(denied.attempts.length, 0);
  assert.equal(denied.tables.robot_v1_live_alerts[0].resolved_at, null);
});

test("an already queued delivery remains eligible for later escalation after unknown or recovering evidence", async () => {
  for (const incomplete of ["UNKNOWN", "RECOVERING"]) {
    const f = fixture({ operator_push_deliveries: [delivery()] });
    if (incomplete === "UNKNOWN") f.tables.watchdog_checks = [];
    else { f.tables.watchdog_incidents[0].state_after = "RECOVERING"; f.tables.watchdog_incidents[0].result = "RECOVERING"; }
    await f.dispatch();
    assert.equal(f.attempts.length, 0);
    assert.equal(f.tables.robot_v1_live_alerts[0].resolved_at, null);
    assert.notEqual(f.tables.operator_push_deliveries[0].status, "EXPIRED");
    f.tables.watchdog_checks = [check()];
    f.tables.watchdog_incidents[0].state_after = "BLOCKED";
    f.tables.watchdog_incidents[0].result = "BLOCKED_SAFE";
    f.state.now += 60_000;
    await f.dispatch();
    assert.equal(f.accepted.length, 1);
  }
});

test("evidence missing after a successful claim is deferred, never mislabeled as a resolved incident", async () => {
  for (const kind of ["incident", "check"]) {
    const f = fixture();
    if (kind === "incident") f.state.loseIncidentAfterClaim = true;
    else f.state.loseCheckAfterClaim = true;
    await f.dispatch();
    assert.equal(f.attempts.length, 0);
    assert.equal(f.tables.robot_v1_live_alerts[0].resolved_at, null);
    assert.notEqual(f.tables.operator_push_deliveries[0].status, "EXPIRED", kind);
    f.state.loseIncidentAfterClaim = false; f.state.loseCheckAfterClaim = false;
    f.tables.watchdog_incidents = [incident()]; f.tables.watchdog_checks = [check()];
    f.state.now += 60_000;
    await f.dispatch();
    assert.equal(f.accepted.length, 1);
  }
});

test("primary and derived Watchdog alerts for one blocked engine create only one notification episode", async () => {
  const f = fixture({ robot_v1_live_alerts: [alert(), alert({ id: "00000000-0000-4000-8000-000000000007",
    alert_key: `WATCHDOG:${RUN}`, first_seen_at: iso(-170) })] });
  await f.dispatch();
  await f.dispatch();
  assert.equal(f.accepted.length, 1);
  assert.equal(f.tables.operator_push_deliveries.length, 1);
});

test("a later primary alert does not notify twice for the same already escalated Watchdog episode", async () => {
  const derivedId = "00000000-0000-4000-8000-000000000007";
  const f = fixture({ robot_v1_live_alerts: [alert({ id: derivedId, alert_key: `WATCHDOG:${RUN}` })] });
  await f.dispatch();
  assert.equal(f.accepted.length, 1);
  f.tables.robot_v1_live_alerts.push(alert());
  await f.dispatch();
  assert.equal(f.accepted.length, 1);
});

test("concurrent dispatch with a different primary alert cannot duplicate an already sending engine episode", async () => {
  const derivedId = "00000000-0000-4000-8000-000000000007";
  const f = fixture({ robot_v1_live_alerts: [alert({ id: derivedId, alert_key: `WATCHDOG:${RUN}` })] });
  f.state.onTransport = async () => {
    // Dispatcher A has passed fresh eligibility and submitted to the provider,
    // but its acknowledgement/audit is still pending. Dispatcher B discovers
    // a newly available root alert with another ID for the same incident.
    f.tables.robot_v1_live_alerts.push(alert());
    await f.dispatch();
  };
  await f.dispatch();
  assert.equal(f.attempts.length, 1);
  assert.equal(f.accepted.length, 1);
  await f.dispatch();
  assert.equal(f.accepted.length, 1);
});

test("a same-timestamp later carrier cannot overtake another episode delivery already in transport", async () => {
  const derivedId = "00000000-0000-4000-8000-000000000007";
  const f = fixture({ robot_v1_live_alerts: [alert({ id: derivedId, alert_key: `WATCHDOG:${RUN}` })] });
  f.state.onTransport = async () => {
    f.tables.robot_v1_live_alerts.push(alert());
    // PostgreSQL timestamps can share the same parsed millisecond. A random
    // UUID that sorts before the in-flight carrier is not permission to send.
    f.state.nextDeliveryId = "0000-later-primary-carrier";
    await f.dispatch();
  };
  await f.dispatch();
  assert.equal(f.attempts.length, 1);
  assert.equal(f.accepted.length, 1);
  await f.dispatch();
  assert.equal(f.accepted.length, 1);
});

test("same-account same-symbol engines stay isolated by engine and executor, never account bootstrap shard", async () => {
  const f = fixture({
    trading_engines: [engine({ id: SIBLING, executor_shard_id: "executor-03", kill_switch: false }), engine()],
    robot_v1_live_runs: [run({ id: "00000000-0000-4000-8000-000000000008", trading_engine_id: SIBLING,
      last_error: null }), run()],
    watchdog_checks: [check(), check({ shard_id: "executor-03", shard_state: "HEALTHY", blocked_engines: 0, healthy_engines: 1 })],
  });
  await f.dispatch();
  assert.equal(f.accepted.length, 1);
  assert.ok(f.accepted[0].message.url.includes(`engine=${ENGINE}`));
  assert.ok(!f.accepted[0].message.url.includes(SIBLING));
  assert.match(f.accepted[0].message.body, /Executor 02/);
});

test("foreign engine account operator or incident shard cannot authorize an external notification", async () => {
  for (const override of [
    { trading_engines: [engine({ exchange_account_id: "foreign-account" })] },
    { exchange_accounts: [account({ operator_id: "foreign-operator" })] },
    { watchdog_incidents: [incident({ shard_id: "executor-03" })] },
    { watchdog_incidents: [incident({ engine_id: SIBLING })] },
  ]) {
    const f = fixture(override);
    await f.dispatch();
    assert.equal(f.attempts.length, 0);
  }
});

test("only the active tenant operator's enabled device receives a blocked notification", async () => {
  const f = fixture({ operator_push_subscriptions: [device(), device({ id: "viewer", user_id: "viewer" }),
    device({ id: "foreign", operator_id: "foreign", user_id: "foreign" }),
    device({ id: "disabled", enabled: false })] });
  await f.dispatch();
  assert.equal(f.accepted.length, 1);
  const disabledAfterClaim = fixture(); disabledAfterClaim.state.disableDeviceAfterClaim = true;
  await disabledAfterClaim.dispatch();
  assert.equal(disabledAfterClaim.attempts.length, 0);
  assert.equal(disabledAfterClaim.tables.operator_push_deliveries[0].status, "EXPIRED");
});

test("simultaneous dispatchers claim only one delivery and a lost claim never transports", async () => {
  const f = fixture();
  await Promise.all([f.dispatch(), f.dispatch()]);
  assert.equal(f.accepted.length, 1);
  assert.equal(f.tables.operator_push_deliveries.length, 1);
  const lost = fixture(); lost.state.claimLost = true;
  await lost.dispatch();
  assert.equal(lost.attempts.length, 0);
});

test("expired sender leases and legacy uncertain retries never restart an ambiguous transport", async () => {
  for (const row of [delivery({ status: "SENDING", attempted_at: iso(-120), lease_until: iso(-30), attempt_count: 1 }),
    delivery({ status: "PENDING", attempt_count: 1, error_code: "DELIVERY_FAILED" })]) {
    const f = fixture({ operator_push_deliveries: [row] });
    await f.dispatch();
    assert.equal(f.attempts.length, 0);
    assert.equal(f.tables.operator_push_deliveries[0].status, "FAILED");
    assert.equal(f.tables.operator_push_deliveries[0].error_code, "DELIVERY_OUTCOME_UNKNOWN");
  }
});

test("provider acceptance followed by failed SENT audit never retries transport blindly", async () => {
  const f = fixture(); f.state.failSentAudit = 1;
  await f.dispatch();
  assert.equal(f.accepted.length, 1);
  f.state.now += 180_000;
  // Keep operational evidence fresh while checking the delivery outcome fence.
  f.tables.watchdog_checks[0].checked_at = new Date(f.state.now - 10_000).toISOString();
  f.tables.watchdog_incidents[0].last_seen_at = new Date(f.state.now - 10_000).toISOString();
  f.tables.robot_v1_live_runs[0].last_reconciled_at = new Date(f.state.now - 10_000).toISOString();
  await f.dispatch();
  assert.equal(f.attempts.length, 1);
  assert.notEqual(f.tables.operator_push_deliveries[0].status, "PENDING");
});

test("HTTP 410 disables the expired device and never retries it", async () => {
  const f = fixture(); f.state.failSends = 1; f.state.providerStatus = 410;
  await f.dispatch();
  assert.equal(f.attempts.length, 1);
  assert.equal(f.tables.operator_push_subscriptions[0].enabled, false);
  assert.equal(f.tables.operator_push_deliveries[0].status, "EXPIRED");
  f.state.now += 180_000;
  await f.dispatch();
  assert.equal(f.attempts.length, 1);
});

test("only explicit provider rejections retry with bounded backoff; an unknown network outcome never does", async () => {
  const rejected = fixture(); rejected.state.failSends = 3; rejected.state.providerStatus = 503;
  for (let index = 0; index < 3; index++) {
    if (index > 0) {
      rejected.state.now += 120_000;
      rejected.tables.watchdog_checks[0].checked_at = new Date(rejected.state.now - 10_000).toISOString();
      rejected.tables.watchdog_incidents[0].last_seen_at = new Date(rejected.state.now - 10_000).toISOString();
    }
    await rejected.dispatch();
    const queued = rejected.tables.operator_push_deliveries[0];
    assert.equal(queued.attempt_count, index + 1);
    assert.equal(queued.status, index === 2 ? "FAILED" : "PENDING");
    assert.equal(queued.error_code, "PROVIDER_REJECTED_HTTP_503");
  }
  assert.equal(rejected.attempts.length, 3);
  assert.equal(rejected.accepted.length, 0);
  const uncertain = fixture(); uncertain.state.failSends = 1; uncertain.state.providerStatus = NaN;
  await uncertain.dispatch();
  assert.equal(uncertain.tables.operator_push_deliveries[0].status, "FAILED");
  assert.equal(uncertain.tables.operator_push_deliveries[0].error_code, "DELIVERY_OUTCOME_UNKNOWN");
  uncertain.state.now += 120_000;
  await uncertain.dispatch();
  assert.equal(uncertain.attempts.length, 1);
});

test("promotion to a primary alert cannot reset an episode's three rejected transport attempts", async () => {
  const derivedId = "00000000-0000-4000-8000-000000000007";
  const f = fixture({
    robot_v1_live_alerts: [alert(), alert({ id: derivedId, alert_key: `WATCHDOG:${RUN}` })],
    operator_push_deliveries: [delivery({ id: "previous-derived-delivery", alert_id: derivedId,
      status: "FAILED", attempt_count: 3, attempted_at: iso(-30), error_code: "PROVIDER_REJECTED_HTTP_503" })],
  });
  await f.dispatch();
  assert.equal(f.attempts.length, 0);
  assert.equal(f.accepted.length, 0);
});

test("equivalent Data API timestamp formats preserve an existing delivery instead of reopening it", async () => {
  const f = fixture({ operator_push_deliveries: [delivery({ opened_at: iso(-180).replace(".000Z", "+00:00") })] });
  await f.dispatch();
  await f.dispatch();
  assert.equal(f.accepted.length, 1);
});

test("operational blocked alerts use a 60 second TTL without changing the manual test default", async () => {
  const f = fixture();
  await f.dispatch();
  assert.equal(f.accepted.length, 1);
  assert.equal(f.accepted[0].options.TTL, 60);
  await f.send(device(), { title: "Teste", body: "Teste manual", url: "/automacao", tag: "manual-test" });
  assert.equal(f.accepted.length, 2);
  assert.equal(f.accepted[1].options.TTL, 3600);
});

test("push dispatch never mutates financial state or clears the underlying incidents", async () => {
  const f = fixture();
  await f.dispatch();
  const writes = f.accessed.filter(row => row.operation !== "select");
  assert.ok(writes.every(row => ["operator_push_deliveries", "operator_push_subscriptions"].includes(row.table)));
  assert.equal(f.tables.robot_v1_live_alerts.find(row => row.id === ALERT)?.resolved_at, null);
  assert.equal(f.tables.watchdog_incidents[0].resolved_at, null);
  assert.equal(f.tables.trading_engines[0].kill_switch, true);
});
