import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as model from "./model.ts";
import * as repair from "./fx-repair.ts";
import type { FinopsDashboard, FinopsScope, FxQuote } from "./types";

const localRequire = createRequire(import.meta.url);
const ts = localRequire("typescript") as typeof import("typescript");
const compiled = ts.transpileModule(readFileSync(new URL("./server.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
type SyncOptions = { refreshExternal?: boolean; force?: boolean; trigger?: "SCHEDULED" };
type Result = { status: string; nextSyncAt?: string | null; nextOperationalSyncAt?: string; repair?: string };
type Call = { name: string; args?: Record<string, unknown> };
type Options = { at?: string; actualMonthCost?: number; billingPeriod?: { start: string; end: string };
  operationalAgo?: number; externalAgo?: number; missingFx?: boolean; fxAgo?: number;
  failFx?: boolean; failCapital?: boolean; incompleteCapital?: boolean; failedProvider?: boolean;
  capitalFailureAlert?: boolean; denyClaim?: boolean; failFinish?: boolean; capitalWait?: Promise<void>; capitalEntered?: () => void };

/** Executes the real worker with in-memory scoped reads and fenced publication.
 * No network, exchange transport, trading function or real database is loaded. */
function worker(options: Options = {}) {
  const at = new Date(options.at ?? "2026-09-28T09:00:00.000Z");
  class Clock extends Date {
    constructor(value?: string | number) { super(value ?? at.getTime()); }
    static now() { return at.getTime(); }
  }
  const scope: FinopsScope = { operatorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", userId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
  const externalAt = new Date(at.getTime() - (options.externalAgo ?? 600_000)).toISOString();
  const operationalAt = new Date(at.getTime() - (options.operationalAgo ?? 600_000)).toISOString();
  const previousPeriod = model.periodAt(new Date(externalAt));
  const currency = options.missingFx ? "USDT" : "BRL";
  const quote: FxQuote = { base: "USDT", quote: "BRL", rate: 5, source: "fixture",
    observedAt: externalAt, fetchedAt: externalAt };
  const serviceRow = { id: "cost", provider: "Fixture", name: "Known service", currency: "BRL",
    recurring_monthly: 6, allocation_percent: 100, cost_period: previousPeriod, enabled: true,
    actual_month_cost: options.actualMonthCost ?? null,
    ...(options.billingPeriod ? { billing_period_start: options.billingPeriod.start, billing_period_end: options.billingPeriod.end } : {}),
    origin: options.actualMonthCost !== undefined ? "REAL" : "ESTIMADO", source_mode: "DOCUMENTED", sync_status: options.failedProvider ? "FAILED" : "OK",
    synced_at: externalAt, billing_mode: "MANUAL" };
  const cost = model.enrichService(serviceRow, [], new Date(externalAt));
  const capital: FinopsDashboard["capital"] = {
    accounts: [{ accountId: "account", accountName: "Fixture account", shardId: "executor-02", currency,
      monitored: 275, free: 250, reserved: 10, positions: 25, realizedPnl: 2, openPnl: 1,
      observedAt: externalAt, source: "Old fixture observation", complete: true }],
    markets: [{ accountId: "account", accountName: "Fixture account", shardId: "executor-02", market: `SOL${currency}`,
      currency, positions: 25, reserved: 10, realizedPnl: 2, openPnl: 1 }], notes: [],
  };
  const previous: FinopsDashboard = { capturedAt: externalAt, externalCapturedAt: externalAt,
    operationalCapturedAt: operationalAt, period: previousPeriod, syncStatus: options.missingFx ? "PARTIAL" : "OK",
    ...(options.fxAgo !== undefined ? { fxRepairCapturedAt: new Date(at.getTime() - options.fxAgo).toISOString() } : {}),
    capital, services: [cost], fx: options.missingFx ? [] : [quote], executors: [], history: [], alerts: [], sources: [],
    summary: { accounts: 1, engines: 1, executors: 1, capitalBrl: options.missingFx ? null : 275,
      capitalByCurrency: { [currency]: 275 }, capitalComplete: !options.missingFx, nativeCapitalComplete: true,
      actualBrl: cost.actualBrl, projectedBrl: cost.projectedBrl, knownActualBrl: cost.actualBrl ?? 0, knownProjectedBrl: cost.projectedBrl ?? 0,
      costPerAccountBrl: 6, costPerEngineBrl: 6, unavailableServices: 0 } };
  let latest = structuredClone(previous), lastExternalAt = externalAt, owner: string | null = null;
  const calls: Call[] = [];
  const openAlerts: Array<Record<string, unknown>> = options.failedProvider ? [{ id: "provider-error", code: "BILLING_SYNC_FAILED",
    service_id: "cost", message: "Provider unavailable", first_seen_at: externalAt, last_seen_at: externalAt }] : [];
  if (options.capitalFailureAlert) openAlerts.push({ id: "capital-error", code: "BILLING_SYNC_FAILED", service_id: null,
    message: "Não foi possível atualizar o capital monitorado. Trading permanece independente.", first_seen_at: externalAt, last_seen_at: externalAt });
  const service = {
    from(table: string) {
      calls.push({ name: `read:${table}` });
      let mode = "read", values: unknown;
      const filters: Record<string, unknown> = {};
      let fxQuery = false;
      const query: Record<string, unknown> = {};
      for (const method of ["select", "order", "limit", "is"]) query[method] = () => query;
      query.eq = (key: string, value: unknown) => { filters[key] = value; return query; };
      query.like = () => { fxQuery = true; return query; };
      for (const method of ["update", "upsert"]) query[method] = (value: unknown) => {
        mode = method; values = value; return query;
      };
      const response = () => {
        if (mode !== "read") {
          calls.push({ name: `${mode}:${table}`, args: { values, filters: { ...filters } } });
          if (table === "finops_sync_state" && mode === "update" && filters.lease_owner === owner
            && (values as { lease_owner?: unknown }).lease_owner === null) owner = null;
          return { data: null, error: null };
        }
        const data = table === "finops_snapshots" ? fxQuery ? null : { payload: latest }
          : table === "finops_sync_state" ? { last_external_synced_at: lastExternalAt }
          : table === "finops_alerts" ? openAlerts
          : table === "executor_shards" ? [{ id: "executor-02", egress_ipv4: "192.0.2.2", enabled: true,
            binance_limit_per_min: 6000, admission_ratio: .6 }]
          : table === "executor_capacity_samples" ? [{ shard_id: "executor-02", cpu_percent: 2, ram_used_mb: 120,
            binance_weight_current: 1000, heartbeat_at: new Date(at.getTime() - 1000).toISOString(), scheduler_backlog: 0 }]
          : table === "finops_services" ? [serviceRow] : undefined;
        if (data === undefined) throw new Error(`Unexpected table: ${table}`);
        return { data, error: null };
      };
      query.maybeSingle = async () => response();
      query.range = async () => response();
      query.then = (done: (value: unknown) => unknown) => Promise.resolve(response()).then(done);
      return query;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "finops_claim_sync") {
        if (options.denyClaim || owner) return { data: false, error: null };
        owner = String(args.p_owner); return { data: true, error: null };
      }
      if (name === "finops_monthly_history") return { data: [], error: null };
      if (name === "finops_finish_sync") {
        if (options.failFinish || owner !== args.p_owner) return { data: null, error: new Error("Lease lost") };
        latest = structuredClone(args.p_payload as FinopsDashboard);
        if (args.p_external) lastExternalAt = latest.capturedAt!;
        return { data: null, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    },
  };
  const imports: Record<string, unknown> = {
    "server-only": {}, "../supabase/server": {},
    "../supabase/service-role": { createServiceRoleClient: () => service },
    "../supabase/env": { getSupabaseDataSchema: () => "coinops", getCoinOpsServiceTenantId: () => scope.tenantId },
    "../execution/operator-context": { isIdentity: (value: unknown) => typeof value === "string" && value.length === 36 },
    "../coinops-capacity/capacity-manager": { DEFAULT_CAPACITY_POLICY: {}, assessShardCapacity: () => ({ binancePercent: 20, state: "HEALTHY", action: null }) },
    "../coinops-capacity/capacity-server": { asShardMetrics: (value: unknown) => value },
    "./capital-server": { loadFinopsCapital: async (_client: unknown, args: Record<string, unknown>) => {
      calls.push({ name: "capital", args }); options.capitalEntered?.(); await options.capitalWait;
      if (options.failCapital) throw new Error("COINOPS_FINOPS_CAPITAL_READ_FAILED");
      return { counts: { activeAccounts: 1, activeEngines: 1 }, accounts: [{ currencies: [{ complete: !options.incompleteCapital }] }],
        mapped: { ...capital, accounts: capital.accounts.map((row) => ({ ...row,
          monitored: options.incompleteCapital ? null : 1050, free: options.incompleteCapital ? null : 1025,
          complete: !options.incompleteCapital, observedAt: options.incompleteCapital ? null : new Date(at.getTime() - 2000).toISOString(),
          source: "Fresh fixture wallet" })) } };
    } },
    "./capital": { finopsCapitalRows: (raw: { mapped: FinopsDashboard["capital"] }) => raw.mapped },
    "./model": model, "./fx-repair": repair,
    "./providers": {
      fetchFinopsFx: async () => { calls.push({ name: "fx" }); if (options.failFx) throw new Error("FX_DOWN"); return [{ ...quote, fetchedAt: at.toISOString() }]; },
      fetchDigitalOceanCosts: () => { throw new Error("BILLING_MUST_NOT_BE_CALLED"); },
      fetchVercelProjectCosts: () => { throw new Error("BILLING_MUST_NOT_BE_CALLED"); },
    },
  };
  const mod = { exports: {} as { syncFinops: (scope: FinopsScope, options?: SyncOptions) => Promise<Result> } };
  new Function("require", "module", "exports", "Date", compiled)((name: string) => {
    if (name === "node:crypto") return localRequire(name);
    if (!(name in imports)) throw new Error(`Unexpected import: ${name}`);
    return imports[name];
  }, mod, mod.exports, Clock);
  return { run: (input?: SyncOptions) => mod.exports.syncFinops(scope, input), calls, previous, at,
    latest: () => latest, externalAt: () => lastExternalAt,
    saves: () => calls.filter((call) => call.name === "finops_finish_sync").map((call) => call.args!) };
}

test("ADMIN refresh updates operational capital inside billing cooldown and preserves provider/FX evidence", async () => {
  const instance = worker(), response = await instance.run();
  assert.equal(response.status, "OPERATIONAL_UPDATED");
  assert.equal(response.nextSyncAt, "2026-09-28T14:50:00.000Z");
  assert.equal(instance.latest().summary.capitalBrl, 1050);
  assert.equal(instance.latest().operationalCapturedAt, instance.at.toISOString());
  assert.equal(instance.latest().capital.accounts[0]!.observedAt, "2026-09-28T08:59:58.000Z");
  assert.equal(instance.latest().executors[0]!.heartbeatAt, "2026-09-28T08:59:59.000Z");
  assert.deepEqual(instance.latest().services, instance.previous.services);
  assert.deepEqual(instance.latest().fx, instance.previous.fx);
  assert.equal(instance.latest().externalCapturedAt, instance.previous.externalCapturedAt);
  assert.equal(instance.externalAt(), instance.previous.externalCapturedAt);
  assert.deepEqual(instance.calls.find((call) => call.name === "capital")!.args, {
    operatorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", refreshWallets: true,
  });
  assert.equal(instance.calls.some((call) => call.name === "fx" || call.name === "read:finops_services"), false);
  assert.match(String(instance.saves()[0]!.p_snapshot_key), /^OPERATIONAL:/);
  assert.equal(instance.saves()[0]!.p_external, false);
});

test("operational cooldown is durable across requests and does not use the billing clock", async () => {
  const instance = worker(); await instance.run();
  const response = await instance.run();
  assert.equal(response.status, "FRESH");
  assert.equal(response.nextOperationalSyncAt, "2026-09-28T09:01:00.000Z");
  assert.equal(response.nextSyncAt, "2026-09-28T14:50:00.000Z");
  assert.equal(instance.calls.filter((call) => call.name === "capital").length, 1);
  assert.equal(instance.saves().length, 1);
});

test("month rollover expires old-month actuals from persisted services without refreshing provider clocks", async () => {
  for (const missingFx of [false, true]) {
    const instance = worker({ at: "2026-10-01T00:00:00.000Z", actualMonthCost: 53, missingFx });
    assert.equal(instance.previous.services[0]!.actualBrl, 53);
    assert.equal(instance.previous.period, "2026-09-01");
    assert.equal((await instance.run()).status, "OPERATIONAL_UPDATED");
    assert.equal(instance.latest().period, "2026-10-01");
    assert.equal(instance.latest().services[0]!.actualMonthCost, null);
    assert.equal(instance.latest().services[0]!.actualBrl, null);
    assert.equal(instance.latest().services[0]!.origin, "ESTIMADO");
    assert.equal(instance.latest().summary.actualBrl, null);
    assert.equal(instance.latest().summary.knownRealBrl, null);
    assert.equal(instance.latest().services[0]!.costPeriod, "2026-09-01");
    assert.equal(instance.latest().services[0]!.syncedAt, "2026-09-30T23:50:00.000Z");
    assert.equal(instance.externalAt(), "2026-09-30T23:50:00.000Z");
    assert.equal(instance.latest().externalCapturedAt, instance.previous.externalCapturedAt);
    assert.equal(instance.calls.some((call) => call.name === "read:finops_services"), true);
    assert.equal(instance.calls.some((call) => /^(?:upsert|update):finops_services$/.test(call.name)), false);
    assert.equal(instance.calls.filter((call) => call.name === "fx").length, missingFx ? 1 : 0);
    assert.equal(instance.calls.filter((call) => call.name === "capital").length, 1);
    assert.equal(instance.saves().length, 1);
    assert.equal(instance.saves()[0]!.p_external, false);
    assert.equal(instance.previous.services[0]!.actualBrl, 53);
  }
});

test("month rollover preserves actuals for an explicitly evidenced custom billing cycle still in effect", async () => {
  const instance = worker({ at: "2026-10-01T00:00:00.000Z", actualMonthCost: 53, missingFx: true,
    billingPeriod: { start: "2026-09-14T00:00:00.000Z", end: "2026-10-14T00:00:00.000Z" } });
  assert.equal((await instance.run()).status, "OPERATIONAL_UPDATED");
  assert.equal(instance.latest().services[0]!.actualBrl, 53);
  assert.equal(instance.latest().summary.actualBrl, 53);
  assert.equal(instance.latest().services[0]!.billingPeriodEnd, "2026-10-14T00:00:00.000Z");
  assert.equal(instance.latest().services[0]!.costPeriod, "2026-09-01");
  assert.equal(instance.externalAt(), instance.previous.externalCapturedAt);
});

test("operational cooldown opens at exactly sixty seconds, not one millisecond before", async () => {
  assert.equal((await worker({ operationalAgo: 59_999 }).run()).status, "FRESH");
  assert.equal((await worker({ operationalAgo: 60_000 }).run()).status, "OPERATIONAL_UPDATED");
});

test("scheduled FRESH remains read-only even when operational data is older than one minute", async () => {
  const instance = worker(), response = await instance.run({ trigger: "SCHEDULED" });
  assert.equal(response.status, "FRESH");
  assert.equal(instance.calls.some((call) => ["capital", "fx", "read:executor_shards"].includes(call.name)), false);
  assert.equal(instance.saves().length, 0);
});

test("manual service snapshot does not query wallets or advance operational/provider clocks", async () => {
  const instance = worker(); await instance.run({ refreshExternal: false, force: true });
  assert.deepEqual(instance.latest().capital, instance.previous.capital);
  assert.equal(instance.latest().operationalCapturedAt, instance.previous.operationalCapturedAt);
  assert.equal(instance.latest().externalCapturedAt, instance.previous.externalCapturedAt);
  assert.equal(instance.calls.some((call) => ["capital", "fx"].includes(call.name)), false);
  assert.match(String(instance.saves()[0]!.p_snapshot_key), /^MANUAL:/);
  assert.equal(instance.saves()[0]!.p_external, false);
});

test("normal six-hour collection still updates both clocks and calls FX once", async () => {
  const instance = worker({ externalAgo: 7 * 60 * 60_000 });
  assert.equal((await instance.run()).status, "OK");
  assert.equal(instance.calls.filter((call) => call.name === "capital").length, 1);
  assert.equal(instance.calls.filter((call) => call.name === "fx").length, 1);
  assert.equal(instance.latest().externalCapturedAt, instance.at.toISOString());
  assert.equal(instance.latest().operationalCapturedAt, instance.at.toISOString());
  assert.equal(instance.saves()[0]!.p_external, true);
  assert.match(String(instance.saves()[0]!.p_snapshot_key), /^SIX_HOUR:/);
});

test("missing FX does not skip eligible operational collection; both publish atomically once", async () => {
  const instance = worker({ missingFx: true });
  assert.equal((await instance.run()).status, "OPERATIONAL_UPDATED");
  assert.equal(instance.calls.filter((call) => call.name === "capital").length, 1);
  assert.equal(instance.calls.filter((call) => call.name === "fx").length, 1);
  assert.equal(instance.latest().summary.capitalBrl, 5250);
  assert.equal(instance.latest().fxRepairCapturedAt, instance.at.toISOString());
  assert.equal(instance.saves().length, 1);
  assert.equal(instance.saves()[0]!.p_external, false);
  assert.equal(instance.externalAt(), instance.previous.externalCapturedAt);
});

test("FX repair cooldown does not block operational refresh or invent a converted total", async () => {
  const instance = worker({ missingFx: true, fxAgo: 30_000 });
  assert.equal((await instance.run()).status, "PARTIAL");
  assert.equal(instance.calls.filter((call) => call.name === "capital").length, 1);
  assert.equal(instance.calls.some((call) => call.name === "fx"), false);
  assert.equal(instance.latest().summary.capitalByCurrency.USDT, 1050);
  assert.equal(instance.latest().summary.capitalBrl, null);
  assert.equal(instance.latest().fxRepairCapturedAt, instance.previous.fxRepairCapturedAt);
});

test("failed combined FX attempt is persisted and cannot be retried on every click", async () => {
  const instance = worker({ missingFx: true, failFx: true });
  assert.equal((await instance.run()).status, "PARTIAL");
  assert.equal(instance.latest().summary.capitalBrl, null);
  assert.equal(instance.latest().fxRepairCapturedAt, instance.at.toISOString());
  assert.equal((await instance.run()).status, "FRESH");
  assert.equal(instance.calls.filter((call) => call.name === "fx").length, 1);
  assert.equal(instance.calls.filter((call) => call.name === "capital").length, 1);
});

test("failed or incomplete wallet collection is PARTIAL, never zero or fresh evidence", async () => {
  for (const options of [{ failCapital: true }, { incompleteCapital: true }]) {
    const instance = worker(options);
    assert.equal((await instance.run()).status, "PARTIAL");
    assert.equal(instance.latest().summary.capitalBrl, null);
    assert.equal(instance.latest().summary.capitalComplete, false);
    assert.equal(instance.latest().operationalCapturedAt, instance.at.toISOString());
    assert.equal(instance.latest().capital.accounts.some((row) => row.observedAt === instance.at.toISOString()), false);
    assert.equal(instance.externalAt(), instance.previous.externalCapturedAt);
    assert.equal((await instance.run()).status, "FRESH");
    assert.equal(instance.calls.filter((call) => call.name === "capital").length, 1);
  }
});

test("operational success cannot resolve or mask unrelated provider failures", async () => {
  const instance = worker({ failedProvider: true });
  assert.equal((await instance.run()).status, "PARTIAL");
  assert.equal(instance.latest().summary.capitalBrl, 1050);
  assert.equal(instance.calls.some((call) => call.name === "update:finops_alerts"), false);
  assert.equal(instance.latest().services[0]!.syncStatus, "FAILED");
});

test("fresh complete capital resolves only the exact prior capital failure, never another billing source", async () => {
  for (const failedProvider of [false, true]) {
    const instance = worker({ capitalFailureAlert: true, failedProvider });
    assert.equal((await instance.run()).status, failedProvider ? "PARTIAL" : "OPERATIONAL_UPDATED");
    const resolved = instance.calls.filter((call) => call.name === "update:finops_alerts");
    assert.equal(resolved.length, 1);
    assert.equal((resolved[0]!.args!.filters as Record<string, unknown>).id, "capital-error");
    assert.equal((resolved[0]!.args!.filters as Record<string, unknown>).code, "BILLING_SYNC_FAILED");
  }
});

test("incomplete capital cannot resolve its previous failure and new failure has an isolated alert key", async () => {
  const incomplete = worker({ capitalFailureAlert: true, incompleteCapital: true });
  assert.equal((await incomplete.run()).status, "PARTIAL");
  assert.equal(incomplete.calls.some((call) => call.name === "update:finops_alerts"), false);
  const failed = worker({ failCapital: true }); await failed.run();
  const alert = failed.calls.find((call) => call.name === "upsert:finops_alerts")!.args!.values as Record<string, unknown>;
  assert.equal(alert.alert_key, "BILLING_SYNC_FAILED:CAPITAL:2026-09-01");
});

test("lease serializes concurrent ADMIN refreshes before any wallet call", async () => {
  let resume!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { resume = resolve; });
  const instance = worker({ capitalWait: wait, capitalEntered: entered });
  const first = instance.run(); await started;
  assert.equal((await instance.run()).status, "IN_PROGRESS");
  resume(); assert.equal((await first).status, "OPERATIONAL_UPDATED");
  assert.equal(instance.calls.filter((call) => call.name === "capital").length, 1);
  assert.equal(instance.saves().length, 1);
});

test("fenced publication failure never reports operational success or advances persisted clocks", async () => {
  const instance = worker({ failFinish: true });
  await assert.rejects(instance.run(), /SNAPSHOT_SAVE_FAILED/);
  assert.deepEqual(instance.latest(), instance.previous);
  assert.equal(instance.externalAt(), instance.previous.externalCapturedAt);
});
