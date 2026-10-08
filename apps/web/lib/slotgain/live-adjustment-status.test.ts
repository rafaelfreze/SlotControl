import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { completeLedgerRead } from "../execution/complete-ledger-read.ts";
import * as plans from "../execution/live-adjustment-plans.ts";
import * as validation from "../execution/live-adjustment-validation.ts";
import { adjustmentEngineInventory } from "../execution/adjustment-engine-inventory.ts";
import { projectCurrentLiveSlotRanks } from "./live-slot-read-model.ts";

const routeSource = readFileSync(new URL("../../app/api/coinops-live-adjustments/route.ts", import.meta.url), "utf8");
const uiSource = readFileSync(new URL("../../app/automacao/live-adjustments-center.tsx", import.meta.url), "utf8");
type Row = Record<string, unknown>;
const operator = { id: "operator", user_id: "admin", tenant_id: "tenant", product_id: "product", status: "ACTIVE", kill_switch: false };

function compile(source: string, modules: Record<string, unknown>, extras: Record<string, unknown> = {}) {
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports: Record<string, any> = {};
  new Function("require", "exports", ...Object.keys(extras), code)(
    (name: string) => { assert.ok(name in modules, `Unexpected dependency ${name}`); return modules[name]; },
    exports, ...Object.values(extras));
  return exports;
}

function routeHarness(options: { engines?: number; user?: string | null; schema?: string; tenant?: string;
  denied?: boolean; killed?: boolean; failureOffset?: number; duplicate?: boolean } = {}) {
  const count = options.engines ?? 2;
  const engines = Array.from({ length: count }, (_, n) => ({ id: `engine-${String(n).padStart(3, "0")}`,
    operator_id: operator.id, exchange_account_id: "account", symbol: "SOLBRL", quote_asset: "BRL",
    base_asset: "SOL", status: "ACTIVE", environment: "REAL", hard_cap_quote: 250,
    executor_shard_id: n % 2 ? "executor-03" : "executor-02" }));
  const balances = engines.flatMap(engine => Array.from({ length: 25 }, (_, n) => ({
    operator_id: operator.id, trading_engine_id: engine.id, slot_number: n + 1,
    balance_quote: 10, contribution_quote: 10, market_pnl_quote: 0, fees_quote: 0, gain_count: 0,
  })));
  if (options.duplicate) balances[balances.length - 1] = { ...balances[0] };
  const rows: Record<string, Row[]> = {
    exchange_accounts: [{ id: "account", operator_id: operator.id, display_name: "Fixture", status: "ACTIVE" }],
    trading_engines: engines,
    robot_v1_live_runs: engines.map(engine => ({ id: `run-${engine.id}`, operator_id: operator.id,
      trading_engine_id: engine.id, status: "ACTIVE", last_error: null })),
    robot_v1_live_slot_accounts: [...balances, { ...balances[0], operator_id: "other-operator" }],
  };
  const pages: number[] = [], warnings: unknown[] = [], calls: string[] = [];
  const forbidden = () => { throw new Error("UNEXPECTED_MUTATION_OR_EXCHANGE_CALL"); };
  const service = { rpc: forbidden, from(table: string) {
    calls.push(table);
    let fields: string[] = [], offset = 0, end = Infinity;
    const filters: Array<(row: Row) => boolean> = [], ordering: string[] = [];
    const query = {
      select(value: string) {
        fields = value.split(",");
        if (table === "robot_v1_live_slot_accounts") assert.ok(!fields.includes("id"), "no id column in the deployed schema");
        return this;
      },
      eq(key: string, value: unknown) { filters.push(row => row[key] === value); return this; },
      in(key: string, values: unknown[]) { filters.push(row => values.includes(row[key])); return this; },
      order(key: string) { ordering.push(key); return this; },
      range(start: number, last: number) { offset = start; end = last; return this; },
      limit(size: number) { end = size - 1; return this; },
      insert: forbidden, update: forbidden, delete: forbidden,
      then(resolve: (value: { data: Row[] | null; error: unknown }) => unknown) {
        if (table === "robot_v1_live_slot_accounts") {
          assert.deepEqual(ordering, ["trading_engine_id", "slot_number"]);
          pages.push(offset);
          if (offset === options.failureOffset) return Promise.resolve(resolve({ data: null, error: { code: "42501" } }));
        }
        const scoped = (rows[table] ?? []).filter(row => filters.every(filter => filter(row)));
        scoped.sort((a, b) => {
          for (const key of ordering) {
            const difference = typeof a[key] === "number" ? Number(a[key]) - Number(b[key]) : String(a[key]).localeCompare(String(b[key]));
            if (difference) return difference;
          }
          return 0;
        });
        return Promise.resolve(resolve({ data: scoped.slice(offset, end + 1)
          .map(row => Object.fromEntries(fields.map(field => [field, row[field]]))), error: null }));
      },
    };
    return query;
  } };
  const adminFilters: Array<[string, unknown]> = [];
  const adminQuery = { select() { return this; }, eq(key: string, value: unknown) { adminFilters.push([key, value]); return this; }, async single() {
    return options.denied || adminFilters.some(([key, value]) => operator[key as keyof typeof operator] !== value)
      ? { data: null, error: { code: "PGRST116" } }
      : { data: { ...operator, kill_switch: options.killed ?? false }, error: null };
  } };
  const modules = {
    "node:crypto": { createHash },
    "next/server": { NextResponse: { json: (body: unknown, init: { status: number }) => ({ body, status: init.status }) } },
    "next/cache": { revalidatePath: forbidden },
    "@/lib/execution/live-adjustment-plans": plans,
    "@/lib/execution/selective-contribution-presets": {},
    "@/lib/execution/operator-executor-admin": { operatorAccountSnapshot: forbidden, operatorExecutorAdmin: forbidden },
    "@/lib/execution/operator-context": {},
    "@/lib/execution/live-adjustment-validation": validation,
    "@/lib/execution/complete-ledger-read": { completeLedgerRead },
    "@/lib/execution/adjustment-engine-inventory": { adjustmentEngineInventory },
    "@/lib/slotgain/live-slot-read-model": { projectCurrentLiveSlotRanks },
    "@/lib/supabase/env": { getSupabaseDataSchema: () => options.schema ?? "coinops", getCoinOpsServiceTenantId: () => options.tenant ?? "tenant" },
    "@/lib/supabase/service-role": { createServiceRoleClient: () => service },
    "@/lib/supabase/server": { createClient: () => ({ auth: { getUser: async () => ({ data: {
      user: options.user === null ? null : { id: options.user ?? "admin" },
    } }) }, from: () => adminQuery }) },
  };
  const route = compile(routeSource, modules, { console: { warn: (...args: unknown[]) => warnings.push(args) } });
  return { get: route.GET as () => Promise<{ body: any; status: number }>, pages, warnings, calls, balances };
}

test("Ajustes GET uses deployed composite slot identity, including same symbol across shards", async () => {
  const harness = routeHarness();
  const result = await harness.get();
  assert.equal(result.status, 200);
  assert.equal(result.body.slotAccounts.length, 50);
  for (const engine of result.body.engines) {
    assert.equal(result.body.slotAccounts.filter((row: Row) => row.trading_engine_id === engine.id).length, 25);
  }
  assert.equal(new Set(result.body.slotAccounts.map((row: Row) => `${row.trading_engine_id}:${row.slot_number}`)).size, 50);
  assert.deepEqual(harness.pages, [0]);
  assert.deepEqual(harness.warnings, []);
});

test("Ajustes composite inventory reads 1000+ balances without truncation or cross-operator rows", async () => {
  const harness = routeHarness({ engines: 41 });
  const result = await harness.get();
  assert.equal(result.status, 200);
  assert.equal(result.body.slotAccounts.length, 1025);
  assert.deepEqual(harness.pages, [0, 500, 1000]);
  assert.equal(result.body.slotAccounts.reduce((sum: number, row: Row) => sum + Number(row.balance_quote), 0), 10250);
});

test("later-page failure or duplicate composite identity fails closed as availability, not ADMIN denial", async () => {
  for (const options of [{ engines: 41, failureOffset: 500 }, { duplicate: true }]) {
    const harness = routeHarness(options);
    const result = await harness.get();
    assert.equal(result.status, 503);
    assert.equal(result.body.error, "COINOPS_ADJUSTMENT_LEDGER_UNHEALTHY");
    assert.equal(result.body.slotAccounts, undefined);
    assert.equal(harness.warnings.length, 1);
    assert.doesNotMatch(JSON.stringify(harness.warnings), /operator|engine-|42501/);
  }
});

test("session, viewer/other-tenant denial, operator kill switch and schema guards remain before ledger access", async () => {
  for (const [options, status, error] of [
    [{ user: null }, 401, "COINOPS_ADJUSTMENT_AUTH_REQUIRED"],
    [{ denied: true }, 403, "COINOPS_ADJUSTMENT_ADMIN_DENIED"],
    [{ user: "viewer" }, 403, "COINOPS_ADJUSTMENT_ADMIN_DENIED"],
    [{ tenant: "other-tenant" }, 403, "COINOPS_ADJUSTMENT_ADMIN_DENIED"],
    [{ killed: true }, 403, "COINOPS_ADJUSTMENT_ADMIN_DENIED"],
    [{ schema: "public" }, 403, "COINOPS_ADJUSTMENT_SCHEMA_DENIED"],
  ] as const) {
    const harness = routeHarness(options);
    const result = await harness.get();
    assert.equal(result.status, status);
    assert.equal(result.body.error, error);
    assert.deepEqual(harness.calls, []);
  }
});

type Element = { type: string; props: Record<string, any> };
function uiHarness() {
  const names = [...uiSource.matchAll(/const \[([^,]+),[^\]]+\]\s*=\s*useState/g)].map(match => match[1]);
  const state = new Map<string, unknown>();
  let cursor = 0;
  const requests: Array<{ url: string; method: string }> = [];
  let responseOk = false;
  const jsx = (type: string, props: Record<string, unknown>) => ({ type, props });
  const ui = compile(uiSource, {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react": { useState: (initial: unknown) => {
      const name = names[cursor++];
      if (!state.has(name)) state.set(name, typeof initial === "function" ? initial() : initial);
      return [state.get(name), (value: unknown) => state.set(name, value)];
    }, useCallback: (fn: unknown) => fn, useEffect: () => {}, useId: () => "reason", useRef: () => ({ current: null }),
    useMemo: (fn: () => unknown) => fn() },
    "@/lib/slotgain/operational-slot-order": { orderOperationalSlots: (rows: unknown[]) => rows },
    "@/lib/execution/monthly-slot-policy": { monthlyPeriodKey: () => "2026-10" },
    "@/lib/execution/engine-display": {},
    "@/lib/execution/live-adjustment-plans": plans,
    "@/lib/execution/selective-contribution-presets": {},
    "@/lib/execution/live-adjustment-validation": validation,
    "./live-adjustments-center.css": {},
  }, { fetch: async (url: string, options: { method?: string }) => {
    requests.push({ url, method: options.method ?? "GET" });
    return { ok: responseOk, json: async () => responseOk ? {
      accounts: [], engines: [], slots: [], slotAccounts: [], totals: [], batches: [], plans: [],
      selectiveBatches: [], selectiveAllocations: [], orders: [], presets: [],
    } : { error: "COINOPS_ADJUSTMENT_STATUS_UNAVAILABLE" } };
  } });
  const render = () => { cursor = 0; return ui.LiveAdjustmentsCenter({ active: true }) as Element; };
  const flatten = (element: unknown): Array<Element | string> => Array.isArray(element) ? element.flatMap(flatten)
    : typeof element === "string" ? [element] : element && typeof element === "object" && "props" in element
      ? [element as Element, ...flatten((element as Element).props.children)] : [];
  return { state, requests, render, flatten, succeed: () => { responseOk = true; } };
}

test("failed UI load is not stuck loading; manual reload does only GET and recovers without a financial action", async () => {
  const harness = uiHarness();
  let elements = harness.flatten(harness.render());
  const retry = elements.find((element): element is Element => typeof element !== "string" && element.type === "button")!;
  const attempt = retry.props.onClick();
  assert.equal(harness.state.get("loadingStatus"), true);
  assert.ok(harness.flatten(harness.render()).includes("Carregando contas e ledger…"));
  await attempt;
  elements = harness.flatten(harness.render());
  assert.equal(harness.state.get("loadingStatus"), false);
  assert.ok(elements.some(element => typeof element !== "string" && element.props.role === "alert"));
  assert.ok(!elements.includes("Carregando contas e ledger…"));
  harness.succeed();
  await retry.props.onClick();
  assert.equal(harness.state.get("error"), "");
  assert.ok(harness.state.get("status"));
  assert.deepEqual(harness.requests, [
    { url: "/api/coinops-live-adjustments", method: "GET" },
    { url: "/api/coinops-live-adjustments", method: "GET" },
  ]);
});
