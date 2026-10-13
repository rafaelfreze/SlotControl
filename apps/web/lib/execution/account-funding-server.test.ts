import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { assertDomainRegistry, type DomainRegistry } from "./operator-context.ts";
import type { AccountFundingInput } from "./account-funding.ts";
import { liveEngineOrderPrefix } from "./robot-v1-live-cycle.ts";

const uuid = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const operatorId = uuid(1), accountId = uuid(2);
const scope = { product_id: uuid(3), tenant_id: uuid(4), user_id: uuid(5) };
const at = "2026-10-13T12:00:00.000Z";
const source = readFileSync(new URL("./account-funding-server.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../../app/api/coinops-live-balances/route.ts", import.meta.url), "utf8");

type RecordRow = Record<string, unknown>;
// Projection audited against Production information_schema on 2026-10-13.
// In particular the operational orders table has quote_asset, not symbol.
const orderColumns = new Set(["id", "run_id", "operator_id", "exchange_account_id", "trading_engine_id",
  "quote_asset", "side", "status", "client_order_id", "exchange_order_id", "requested_quantity",
  "executed_quantity", "reserved_notional_quote", "cumulative_quote", "price", "trades_reconciled"]);
function fixture(options: { engines?: number; missingPage?: boolean; duplicatePage?: boolean;
  truncated?: boolean; changedCount?: boolean; mixedCurrency?: boolean; archive?: boolean;
  preparing?: boolean; failedTable?: string } = {}) {
  const count = options.engines ?? 2;
  const registry: DomainRegistry = {
    operator: { ...scope, id: operatorId, status: "ACTIVE", kill_switch: false },
    accounts: [{ id: accountId, operator_id: operatorId, display_name: "Renato", status: "ACTIVE",
      is_legacy_default: false, kill_switch: false, executor_shard_id: "executor-02" }],
    engines: Array.from({ length: count }, (_, index) => ({ id: uuid(100 + index),
      operator_id: operatorId, exchange_account_id: accountId, environment: "REAL", symbol: "SOLBRL",
      base_asset: "SOL", quote_asset: "BRL", status: "ACTIVE", hard_cap_quote: "275",
      kill_switch: false, legacy_compatible: false, executor_shard_id: index % 2 ? "executor-03" : "executor-02" })),
  };
  if (options.mixedCurrency) {
    registry.engines[1].symbol = "BTCUSDT"; registry.engines[1].base_asset = "BTC";
    registry.engines[1].quote_asset = "USDT";
  }
  if (options.archive) registry.engines[1].status = "INACTIVE";
  if (options.preparing) registry.engines[1].status = "INACTIVE";
  const rows: Record<string, RecordRow[]> = {
    trading_engines: registry.engines as unknown as RecordRow[],
    robot_v1_live_runs: registry.engines.flatMap((engine, index) => options.archive && index === 1 ? [] : [{
      ...scope, id: uuid(1_000 + index), operator_id: operatorId, exchange_account_id: accountId,
      trading_engine_id: engine.id, status: options.preparing && index === 1 ? "PREPARING" : index === 0 ? "PAUSED" : "ACTIVE",
      last_reconciled_at: options.preparing && index === 1 ? null : at, last_error: null,
    }]),
    robot_v1_live_slot_accounts: registry.engines.flatMap((engine) => Array.from({ length: 25 }, (_, index) => ({
      ...scope, operator_id: operatorId, exchange_account_id: accountId, trading_engine_id: engine.id,
      slot_number: index + 1, balance_quote: "11", dust_cost_quote: "0",
    }))),
    robot_v1_live_slots: registry.engines.flatMap((engine, engineIndex) => Array.from({ length: 25 }, (_, index) => ({
      ...scope, id: uuid(10_000 + engineIndex * 25 + index), run_id: uuid(1_000 + engineIndex),
      operator_id: operatorId, exchange_account_id: accountId, trading_engine_id: engine.id,
      slot_number: index + 1, position_quantity: index === 0 ? "0.02" : "0",
      position_committed_quote: index === 0 ? "11" : "0",
    }))),
    robot_v1_live_orders: [],
    robot_v1_live_selective_contribution_allocations: [{ ...scope, id: uuid(20_000), operator_id: operatorId,
      exchange_account_id: accountId, trading_engine_id: registry.engines[0].id, amount_quote: "5", status: "PENDING" },
    { ...scope, id: uuid(20_001), operator_id: operatorId, exchange_account_id: accountId,
      trading_engine_id: registry.engines[0].id, amount_quote: "8", status: "APPLIED" }],
  };
  const calls: Array<{ table: string; filters: Record<string, unknown>; columns: string; page: number[]; signal?: AbortSignal }> = [];
  const captured: AccountFundingInput[] = [];
  const warnings: unknown[][] = [];
  const db = { from(table: string) {
    const filters: Record<string, unknown> = {};
    let columns = "", page = [0, 499], signal: AbortSignal | undefined;
    const response = () => {
      calls.push({ table, filters: { ...filters }, columns, page: [...page], signal });
      let values = (rows[table] ?? []).filter((row) => Object.entries(filters).every(([field, expected]) => {
        if (field === "$or") return true;
        if (field.startsWith("!")) return row[field.slice(1)] !== expected;
        return Array.isArray(expected) ? expected.includes(row[field]) : row[field] === expected;
      }));
      const total = values.length;
      values = values.slice(page[0], page[1] + 1);
      if (options.truncated && table === "robot_v1_live_slots") values = values.slice(0, 250);
      if (options.duplicatePage && table === "robot_v1_live_slots" && page[0] > 0 && values.length)
        values[0] = { ...values[0], id: rows[table][0].id };
      if (options.failedTable === table || options.missingPage && table === "robot_v1_live_slots" && page[0] > 0)
        return { data: null, error: { code: "42501", message: "private provider message" }, count: null };
      return { data: values.map((row) => Object.fromEntries(columns.split(",").map((key) => [key, row[key]]))), error: null,
        count: options.changedCount && table === "robot_v1_live_slots" && page[0] > 0 ? total - 1 : total };
    };
    const chain = {
      select(value: string, settings: { count: string }) {
        columns = value; assert.equal(settings.count, "exact");
        if (table === "robot_v1_live_orders")
          for (const field of columns.split(",")) assert.ok(orderColumns.has(field), `Unknown Production order column: ${field}`);
        return chain;
      },
      eq(field: string, value: unknown) { filters[field] = value; return chain; },
      neq(field: string, value: unknown) { filters[`!${field}`] = value; return chain; },
      in(field: string, value: unknown[]) { filters[field] = value; return chain; },
      or(value: string) { filters.$or = value; return chain; },
      order() { return chain; },
      range(start: number, end: number) { page = [start, end]; return chain; },
      abortSignal(value: AbortSignal) { signal = value; return chain; },
      then(resolve: (value: unknown) => unknown) { return Promise.resolve(response()).then(resolve); },
    };
    return chain;
  } };
  const dependencies: Record<string, unknown> = {
    "./robot-v1-live-cycle": { liveEngineOrderPrefix },
    "server-only": {}, "./operator-context": { assertDomainRegistry,
      isIdentity: (value: unknown) => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) },
    "./account-funding": { buildAccountFunding: (input: AccountFundingInput) => {
      captured.push(input);
      return [...new Set(input.engines.map((engine) => engine.quote_asset))].sort().map((currency) => ({ currency }));
    } },
  };
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const compiledModule = { exports: {} as { loadAccountFunding: (db: unknown, options: unknown) => Promise<unknown> } };
  new Function("require", "module", "exports", "console", compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name];
  }, compiledModule, compiledModule.exports, { warn: (...args: unknown[]) => warnings.push(args) });
  return { db, registry, rows, calls, captured, warnings, load: compiledModule.exports.loadAccountFunding,
    options: { scope, registry, accountId, states: [], now: Date.parse(at) } };
}

test("authenticated funding reads use exact product/tenant/user/operator/account scope and never write", async () => {
  const f = fixture(); await f.load(f.db, f.options);
  for (const call of f.calls) {
    assert.equal(call.filters.operator_id, operatorId); assert.equal(call.filters.exchange_account_id, accountId);
    if (call.table !== "trading_engines") {
      for (const [key, value] of Object.entries(scope)) assert.equal(call.filters[key], value);
    }
    assert.ok(call.signal instanceof AbortSignal);
  }
  assert.doesNotMatch(source, /createServiceRoleClient|\.rpc\(|\.update\(|\.insert\(|\.upsert\(|\.delete\(|readLiveExecutorState/);
  assert.equal(f.captured.length, 1);
});

test("another account or an invalid operator scope is denied before any read", async () => {
  const f = fixture();
  await assert.rejects(f.load(f.db, { ...f.options, accountId: uuid(999) }), /FUNDING_SCOPE_DENIED/);
  await assert.rejects(f.load(f.db, { ...f.options, scope: { ...scope, user_id: uuid(998) } }), /OPERATOR_SCOPE_DENIED/);
  assert.equal(f.calls.length, 0);
});

test("same-symbol cross-shard engines and PENDING contributions retain independent engine identities", async () => {
  const f = fixture(); await f.load(f.db, f.options);
  const input = f.captured[0];
  assert.equal(input.engines.length, 2);
  assert.deepEqual(input.engines.map((engine) => engine.executor_shard_id), ["executor-02", "executor-03"]);
  assert.equal(input.slotAccounts.length, 50); assert.equal(input.slots.length, 50);
  assert.ok(input.engines.every((engine) => engine.orderPrefix?.startsWith("C2-")));
  assert.notEqual(input.engines[0].orderPrefix, input.engines[1].orderPrefix);
  assert.equal(input.pending.length, 1); assert.equal(input.pending[0].amount_quote, "5");
  assert.deepEqual(input.runs.map((run) => run.status), ["PAUSED", "ACTIVE"]);
});

test("more than 1000 account slots are fully paginated rather than silently truncated", async () => {
  const f = fixture({ engines: 42 }); await f.load(f.db, f.options);
  assert.equal(f.captured[0].slots.length, 1050);
  assert.equal(f.captured[0].slotAccounts.length, 1050);
  assert.deepEqual(f.calls.filter((call) => call.table === "robot_v1_live_slots").map((call) => call.page),
    [[0, 499], [500, 999], [1000, 1499]]);
});

for (const [name, option] of [["later-page provider failure", "missingPage"], ["duplicate page identity", "duplicatePage"],
  ["provider response cap", "truncated"], ["concurrent count change", "changedCount"]] as const)
  test(`${name} cannot return a convincing partial funding total`, async () => {
    const f = fixture({ engines: 42, [option]: true });
    await assert.rejects(f.load(f.db, f.options), /FUNDING_READ_UNAVAILABLE/);
    assert.equal(f.captured.length, 0);
  });

test("permissions/schema failures are sanitized and have no retry or service fallback", async () => {
  const f = fixture({ failedTable: "robot_v1_live_slots" });
  await assert.rejects(f.load(f.db, f.options), { message: "COINOPS_ACCOUNT_FUNDING_READ_UNAVAILABLE" });
  assert.equal(f.calls.filter((call) => call.table === "robot_v1_live_slots").length, 1);
  assert.equal(f.captured.length, 0);
  assert.deepEqual(f.warnings, [["COINOPS_ACCOUNT_FUNDING_READ_FAILED", { stage: "slots", provider_code: "42501" }]]);
  assert.doesNotMatch(JSON.stringify(f.warnings), /private provider message|Renato|balance|00000000-/);
});

function storedOrder(f: ReturnType<typeof fixture>, engineIndex: number) {
  const engine = f.registry.engines[engineIndex];
  return { ...scope, id: uuid(30_000 + engineIndex), run_id: uuid(1_000 + engineIndex),
    operator_id: operatorId, exchange_account_id: accountId, trading_engine_id: engine.id,
    quote_asset: engine.quote_asset, side: "BUY", status: "NEW", client_order_id: "fixture-order",
    exchange_order_id: "123456", requested_quantity: "1", executed_quantity: "0",
    reserved_notional_quote: "10", cumulative_quote: "0", price: "10", trades_reconciled: false };
}

test("Production orders projection has no guessed symbol column and derives market from its exact engine/run", async () => {
  const f = fixture({ mixedCurrency: true });
  f.rows.robot_v1_live_orders = [storedOrder(f, 1)];
  await f.load(f.db, f.options);
  assert.equal(f.captured[0].orders[0].symbol, "BTCUSDT");
  const projected = f.calls.find((call) => call.table === "robot_v1_live_orders")!.columns.split(",");
  assert.ok(projected.includes("quote_asset")); assert.ok(!projected.includes("symbol"));
  assert.ok(projected.every((field) => orderColumns.has(field)));
});

test("same-account same-symbol order cannot borrow another engine's current run", async () => {
  const f = fixture();
  f.rows.robot_v1_live_orders = [{ ...storedOrder(f, 0), run_id: uuid(1_001) }];
  await assert.rejects(f.load(f.db, f.options), /FUNDING_READ_UNAVAILABLE/);
  assert.equal(f.captured.length, 0);
  assert.deepEqual(f.warnings, [["COINOPS_ACCOUNT_FUNDING_READ_FAILED", { stage: "order_scope", provider_code: null }]]);
});

test("stored order currency must agree with the exact owned engine, with no account/symbol fallback", async () => {
  const f = fixture({ mixedCurrency: true });
  f.rows.robot_v1_live_orders = [{ ...storedOrder(f, 1), quote_asset: "BRL" }];
  await assert.rejects(f.load(f.db, f.options), /FUNDING_READ_UNAVAILABLE/);
  assert.equal(f.captured.length, 0);
});

test("mixed native currencies are preserved without conversion or choosing an account primary shard", async () => {
  const f = fixture({ mixedCurrency: true });
  assert.deepEqual(await f.load(f.db, f.options), [{ currency: "BRL" }, { currency: "USDT" }]);
  assert.deepEqual(f.captured[0].engines.map((engine) => engine.symbol), ["SOLBRL", "BTCUSDT"]);
});

test("retired INACTIVE history is excluded but a new PREPARING engine stays explicitly incomplete", async () => {
  const archived = fixture({ archive: true }); await archived.load(archived.db, archived.options);
  assert.equal(archived.captured[0].engines.length, 1);
  assert.equal(archived.captured[0].slotAccounts.length, 25);
  const preparing = fixture({ preparing: true }); await preparing.load(preparing.db, preparing.options);
  assert.equal(preparing.captured[0].engines.length, 2);
  assert.equal(preparing.captured[0].runs[1].last_reconciled_at, null);
});

test("an engine added after registry discovery invalidates this funding observation", async () => {
  const f = fixture(); f.rows.trading_engines = [...f.rows.trading_engines,
    { ...f.rows.trading_engines[0], id: uuid(888) }];
  await assert.rejects(f.load(f.db, f.options), /FUNDING_READ_UNAVAILABLE/);
  assert.equal(f.captured.length, 0);
});

test("API funding mode requires one owned account and reuses bounded read-only state collection", () => {
  assert.match(route, /fundingRequested && accountId === "ALL"/);
  assert.match(route, /COINOPS_ACCOUNT_FUNDING_SINGLE_ACCOUNT_REQUIRED/);
  assert.match(route, /fundingRequested \? engine\.symbol : engine\.quote_asset/);
  assert.match(route, /fundingRequested && requests\+\+ > 0/);
  assert.match(route, /states: successful\.map\(\(item\) => item\.state\)/);
  assert.match(route, /fundingUnavailable = true/);
  assert.doesNotMatch(route, /createServiceRoleClient|createLiveExecutorOrder|cancelLiveExecutorOrder|reconcileLiveRun/);
});
