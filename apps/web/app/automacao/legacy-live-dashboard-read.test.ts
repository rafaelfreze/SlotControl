import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { assertPhysicalLedger, boundedLedgerRead, observeLedgerRecord, observeLedgerRows } from "../../lib/execution/live-ledger-read.ts";
import { LiveLedgerReadFailed, LiveReadUnavailable } from "../../lib/execution/live-read-error.ts";
import { isIdentity } from "../../lib/execution/operator-context.ts";

const source = readFileSync(new URL("./legacy-live-dashboard-read.ts", import.meta.url), "utf8");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { operatorId: id(1), accountId: id(2), productId: id(3), tenantId: id(4), userId: id(5), engineIds: [id(10), id(11)] };
type Asset = "BTC" | "SOL";
type Row = Record<string, unknown>;
type Result = { data: Record<Asset, { slots: Row[]; orders: Row[]; accounts: Row[]; events: Row[];
  alerts: Row[]; displayProtectionComplete?: boolean }>;
  unavailableAssets: Asset[]; historyUnavailableAssets: Asset[] };

function fixture(options: { transientOrders?: boolean; deniedOrders?: boolean; historyTimeout?: boolean;
  missingSlot?: boolean; duplicateSlot?: boolean; wrongEngine?: boolean; absentBtc?: boolean;
  orderCount?: number; latePageDenied?: boolean; schemaError?: boolean; alertCount?: number;
  unknownAlertCount?: boolean; duplicateAlertId?: boolean } = {}) {
  const attempts = { BTC: 0, SOL: 0 }, warnings: unknown[][] = [];
  const calls: Array<{ table: string; filters: Row; asset: Asset; range: number[] | null; attempt: number; signal?: AbortSignal }> = [];
  const rows: Record<string, Row[]> = Object.fromEntries(["robot_v1_live_runs", "robot_v1_live_slots", "robot_v1_live_orders",
    "robot_v1_live_slot_accounts", "robot_v1_live_selective_contribution_allocations", "robot_v1_live_events", "robot_v1_live_alerts"].map((table) => [table, []]));
  for (const [assetIndex, asset] of (["BTC", "SOL"] as const).entries()) {
    const owner = { operator_id: scope.operatorId, exchange_account_id: scope.accountId,
      trading_engine_id: scope.engineIds[assetIndex], product_id: scope.productId, tenant_id: scope.tenantId, user_id: scope.userId };
    const run = { ...owner, id: id(100 + assetIndex), asset, symbol: `${asset}BRL`, status: "ACTIVE",
      entry_regime: "NORMAL", last_reconciled_at: "2026-10-13T13:00:00Z", last_error: null,
      config_version: 1, gain_rate: 0.02, entry_spacing: 0.02 };
    if (!(options.absentBtc && asset === "BTC")) rows.robot_v1_live_runs.push(run);
    const slots = Array.from({ length: 25 }, (_, index) => ({ ...owner, asset, id: id(1_000 + assetIndex * 25 + index),
      run_id: run.id, slot_number: index + 1, entry_state: index === 0 ? "OPEN" : "PLANNED", target_buy_price: 100,
      operational_rank: index + 1, post_ath_group: null, post_ath_group_rank: null, operation_sequence: 1,
      position_quantity: index === 0 ? 1 : 0, position_committed_brl: index === 0 ? 10 : 0, missed_at: null }));
    const accounts = slots.map((slot) => ({ ...slot, balance_brl: 11, contribution_brl: 11, market_pnl_brl: 0,
      manual_gain_brl: 0, fees_brl: 0, gain_count: 0, dust_quantity: 0, dust_cost_brl: 0 }));
    if (options.missingSlot && asset === "BTC") slots.pop();
    if (options.duplicateSlot && asset === "BTC") slots[24].slot_number = 1;
    rows.robot_v1_live_slots.push(...slots); rows.robot_v1_live_slot_accounts.push(...accounts);
    rows.robot_v1_live_orders.push(...Array.from({ length: options.orderCount ?? 2 }, (_, index) => ({
      ...owner, id: id(10_000 + assetIndex * 2_000 + index), run_id: run.id, slot_number: 1, side: "SELL", purpose: "TP",
      status: "NEW", client_order_id: `${asset}-owned-${index}`, exchange_order_id: String(index + 1), price: 110,
      requested_quantity: 1, requested_quote: null, executed_quantity: 0, cumulative_quote: 0,
      fee_base: 0, fee_quote: 0, fee_other: [], reserved_notional_brl: 0,
      created_at: "2026-10-13T13:00:00Z", updated_at: "2026-10-13T13:00:00Z",
    })));
    rows.robot_v1_live_events.push({ ...owner, id: id(20_000 + assetIndex), run_id: run.id,
      event_type: "LIVE_MONITOR_PASS", slot_number: null, observed_at: "2026-10-13T13:00:00Z", details: {} });
    rows.robot_v1_live_alerts.push(...Array.from({ length: options.alertCount ?? 0 }, (_, index) => ({
      ...owner, asset, id: id(30_000 + assetIndex * 2_000 + (options.duplicateAlertId && asset === "BTC" ? 0 : index)),
      resolved_at: null, severity: index === options.alertCount! - 1 ? "CRITICAL" : "WARNING",
      code: index === options.alertCount! - 1 ? "COINOPS_LIVE_REAL_CRITICAL" : "COINOPS_LIVE_QUOTE_BALANCE_INSUFFICIENT",
      last_seen_at: new Date(Date.parse("2026-10-13T13:00:00Z") - index * 1000).toISOString(),
    })));
  }
  const db = { from(table: string) {
    const filters: Row = {};
    let columns = "", range: number[] | null = null, limit: number | null = null, signal: AbortSignal | undefined, exactCount = false;
    const response = (single = false) => {
      const asset = filters.asset as Asset ?? (filters.trading_engine_id === scope.engineIds[0] ? "BTC" : "SOL");
      if (table === "robot_v1_live_runs") attempts[asset]++;
      const attempt = attempts[asset];
      calls.push({ table, filters: { ...filters }, asset, range, attempt, signal });
      if (asset === "BTC" && table === "robot_v1_live_orders" && (options.deniedOrders || options.schemaError
        || options.transientOrders && attempt === 1 || options.latePageDenied && (range?.[0] ?? 0) > 0))
        return { data: null, count: null, status: options.deniedOrders ? 403 : options.schemaError ? 400 : 503,
          error: { code: options.deniedOrders ? "42501" : options.schemaError ? "42703" : "PGRST000",
            message: "private account and financial payload never log" } };
      if (asset === "BTC" && table === "robot_v1_live_events" && options.historyTimeout)
        return { data: null, count: null, status: 500, error: { code: "57014", message: "private slow query" } };
      let selected = rows[table].filter((row) => Object.entries(filters).every(([key, value]) =>
        key.startsWith("$in:") ? (value as unknown[]).includes(row[key.slice(4)]) : row[key] === value));
      const total = selected.length;
      if (range) selected = selected.slice(range[0], range[1] + 1);
      if (limit !== null) selected = selected.slice(0, limit);
      selected = selected.map((row) => Object.fromEntries(columns.split(",").map((column) => [column, row[column]])));
      if (options.transientOrders && asset === "BTC" && table === "robot_v1_live_slots")
        selected[0].position_quantity = attempt;
      if (options.wrongEngine && asset === "BTC" && table === "robot_v1_live_slots")
        selected[0].trading_engine_id = scope.engineIds[1];
      return { data: single ? selected[0] ?? null : selected,
        count: exactCount && !(options.unknownAlertCount && asset === "BTC" && table === "robot_v1_live_alerts") ? total : null,
        status: 200, error: null };
    };
    const query = {
      select(value: string, options?: { count?: string }) { columns = value; exactCount = options?.count === "exact"; return query; },
      eq(key: string, value: unknown) { filters[key] = value; return query; },
      in(key: string, values: unknown[]) { filters[`$in:${key}`] = values; return query; },
      is(key: string, value: unknown) { filters[key] = value; return query; },
      order() { return query; }, limit(value: number) { limit = value; return query; },
      range(start: number, end: number) { range = [start, end]; return query; },
      abortSignal(value: AbortSignal) { signal = value; return query; },
      maybeSingle() { return Promise.resolve(response(true)); },
      then(resolve: (value: unknown) => unknown) { return Promise.resolve(response()).then(resolve); },
    };
    return query;
  } };
  const imports: Record<string, unknown> = { "server-only": {},
    "../../lib/execution/live-ledger-read": { assertPhysicalLedger, boundedLedgerRead, observeLedgerRecord, observeLedgerRows },
    "../../lib/execution/live-read-error": { LiveLedgerReadFailed, LiveReadUnavailable },
    "../../lib/execution/operator-context": { isIdentity } };
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const compiledModule = { exports: {} as { loadLegacyLiveDashboard: (db: unknown, service: unknown, scope: unknown) => Promise<Result> } };
  new Function("require", "module", "exports", "console", compiled)((name: string) => {
    assert.ok(name in imports, `Unexpected dependency ${name}`); return imports[name];
  }, compiledModule, compiledModule.exports, { warn: (...args: unknown[]) => warnings.push(args) });
  return { db, rows, calls, attempts, warnings, load: () => compiledModule.exports.loadLegacyLiveDashboard(db, db, scope) };
}

test("legacy core query scope is exact and never invokes a financial worker or write", async () => {
  const f = fixture(), result = await f.load();
  assert.deepEqual(result.unavailableAssets, []); assert.deepEqual(result.historyUnavailableAssets, []);
  assert.equal(result.data.BTC.displayProtectionComplete, true); assert.equal(result.data.SOL.displayProtectionComplete, true);
  for (const call of f.calls) {
    for (const [key, value] of Object.entries({ operator_id: scope.operatorId, exchange_account_id: scope.accountId,
      product_id: scope.productId, tenant_id: scope.tenantId, user_id: scope.userId })) assert.equal(call.filters[key], value);
    assert.deepEqual(call.filters["$in:trading_engine_id"], scope.engineIds);
    if (call.table !== "robot_v1_live_runs") assert.equal(call.filters.trading_engine_id, scope.engineIds[call.asset === "BTC" ? 0 : 1]);
    assert.ok(call.signal instanceof AbortSignal);
  }
  assert.doesNotMatch(source, /\.rpc\(|\.update\(|\.insert\(|\.upsert\(|\.delete\(|reconcileLiveRun|createLiveExecutorOrder|createServiceRoleClient\(\)/);
});

test("transient 503 discards the partial financial set and retries one complete GET set", async () => {
  const f = fixture({ transientOrders: true }), result = await f.load();
  assert.deepEqual(f.attempts, { BTC: 2, SOL: 1 });
  assert.equal(result.data.BTC.slots[0].position_quantity, 2);
  assert.equal(result.data.SOL.slots[0].position_quantity, 1);
  assert.deepEqual(result.unavailableAssets, []); assert.equal(f.warnings.length, 0);
});

test("optional history statement timeout preserves verified current positions without retrying the core", async () => {
  const f = fixture({ historyTimeout: true }), result = await f.load();
  assert.deepEqual(f.attempts, { BTC: 1, SOL: 1 });
  assert.equal(result.data.BTC.slots.length, 25); assert.equal(result.data.BTC.accounts.length, 25);
  assert.deepEqual(result.data.BTC.events, []); assert.equal(result.data.SOL.events.length, 1);
  assert.deepEqual(result.unavailableAssets, []); assert.deepEqual(result.historyUnavailableAssets, ["BTC"]);
  assert.equal(f.calls.filter((call) => call.table === "robot_v1_live_events" && call.asset === "BTC").length, 1);
  assert.deepEqual(f.warnings, [["COINOPS_LEGACY_DASHBOARD_HISTORY_UNAVAILABLE",
    { stage: "events", http_status: 500, provider_code: "57014", attempts: 1 }]]);
  assert.doesNotMatch(JSON.stringify(f.warnings), /private|00000000-|position_quantity/);
});

for (const [name, options] of [["permission denial", { deniedOrders: true }], ["schema error", { schemaError: true }]] as const)
  test(`${name} is not retried and cannot make the affected ledger look healthy`, async () => {
    const f = fixture(options), result = await f.load();
    assert.deepEqual(f.attempts, { BTC: 1, SOL: 1 });
    assert.equal(result.data.BTC, undefined); assert.equal(result.data.SOL.slots.length, 25);
    assert.deepEqual(result.unavailableAssets, ["BTC"]);
    assert.equal(f.calls.filter((call) => call.table === "robot_v1_live_events" && call.asset === "BTC").length, 0);
  });

test("current-cycle orders exceeding 1000 rows are completely paginated with stable identity", async () => {
  const f = fixture({ orderCount: 1005 }), result = await f.load();
  assert.equal(result.data.BTC.orders.length, 1005); assert.equal(result.data.SOL.orders.length, 1005);
  assert.deepEqual(f.calls.filter((call) => call.table === "robot_v1_live_orders" && call.asset === "BTC").map((call) => call.range),
    [[0, 499], [500, 999], [1000, 1499]]);
});

test("a later-page provider failure never publishes a partial order truth", async () => {
  const f = fixture({ orderCount: 1005, latePageDenied: true }), result = await f.load();
  assert.equal(result.data.BTC, undefined); assert.equal(result.data.SOL.orders.length, 1005);
  assert.deepEqual(result.unavailableAssets, ["BTC"]); assert.equal(f.attempts.BTC, 2);
});

test("all unresolved alerts are complete and paginated; older CRITICAL after the first ten remains visible", async () => {
  const f = fixture({ alertCount: 515 }), result = await f.load();
  assert.deepEqual(result.unavailableAssets, []);
  for (const asset of ["BTC", "SOL"] as const) {
    assert.equal(result.data[asset].displayProtectionComplete, true);
    assert.equal(result.data[asset].alerts.length, 515);
    assert.equal(result.data[asset].alerts[514].severity, "CRITICAL");
    assert.equal(result.data[asset].alerts[514].code, "COINOPS_LIVE_REAL_CRITICAL");
    assert.deepEqual(f.calls.filter(call => call.table === "robot_v1_live_alerts" && call.asset === asset).map(call => call.range),
      [[0, 499], [500, 999]]);
  }
});

test("unknown alert count or duplicate alert identity invalidates only its affected asset, never certifies partial protection", async () => {
  for (const options of [{ unknownAlertCount: true }, { duplicateAlertId: true, alertCount: 12 }]) {
    const f = fixture(options), result = await f.load();
    assert.equal(result.data.BTC, undefined); assert.equal(result.data.SOL.displayProtectionComplete, true);
    assert.deepEqual(result.unavailableAssets, ["BTC"]); assert.equal(f.attempts.BTC, 1);
    assert.equal(f.calls.filter(call => call.table === "robot_v1_live_events" && call.asset === "BTC").length, 0);
  }
});

for (const [name, options] of [["missing physical slot", { missingSlot: true }], ["duplicate physical slot", { duplicateSlot: true }],
  ["another engine row", { wrongEngine: true }]] as const)
  test(`${name} invalidates only its affected asset`, async () => {
    const f = fixture(options), result = await f.load();
    assert.equal(result.data.BTC, undefined); assert.equal(result.data.SOL.slots.length, 25);
    assert.deepEqual(result.unavailableAssets, ["BTC"]); assert.equal(f.attempts.BTC, 1);
  });

test("an optional absent current run is normal and never falls back to another engine", async () => {
  const f = fixture({ absentBtc: true }), result = await f.load();
  assert.equal(result.data.BTC, undefined); assert.equal(result.data.SOL.slots.length, 25);
  assert.deepEqual(result.unavailableAssets, []); assert.deepEqual(result.historyUnavailableAssets, []);
  assert.equal(f.calls.filter((call) => call.asset === "BTC").length, 1);
});
