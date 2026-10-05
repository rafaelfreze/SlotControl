import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type * as OperatorServer from "../execution/operator-context-server.ts";
import { assertDomainRegistry, resolveEngineContext, visibleOperatorRegistry } from "../execution/operator-context.ts";
import { LiveReadUnavailable } from "../execution/live-read-error.ts";

type Row = Record<string, unknown>;
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const scope = { product_id: uuid(1), tenant_id: uuid(2), user_id: uuid(3) };

function compile(timeout = AbortSignal.timeout) {
  const source = readFileSync(new URL("../execution/operator-context-server.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const exports: Row = {};
  new Function("require", "exports", "AbortSignal", compiled)((name: string) => {
    if (name === "server-only") return {};
    if (name === "./live-read-error") return { LiveReadUnavailable };
    if (name === "./operator-context") return { assertDomainRegistry, resolveEngineContext, visibleOperatorRegistry };
    throw new Error(`Unexpected dependency: ${name}`);
  }, exports, { timeout });
  return exports as unknown as typeof OperatorServer;
}

function database(failTable?: string, options: { timeouts?: number; missing?: boolean;
  wrongScope?: boolean; failAfterFirstPage?: boolean; permissionAfterTimeout?: boolean } = {}) {
  const operatorId = uuid(4), accountId = uuid(5), engineId = uuid(6);
  const tables: Record<string, Row[]> = {
    operators: [{ id: operatorId, ...scope, status: "ACTIVE", kill_switch: false }],
    exchange_accounts: [{ id: accountId, operator_id: operatorId, display_name: "Fixture", status: "ACTIVE",
      is_legacy_default: false, kill_switch: false, executor_shard_id: "executor-01" }],
    trading_engines: [{ id: engineId, operator_id: operatorId, exchange_account_id: accountId, environment: "REAL",
      symbol: "SOLBRL", base_asset: "SOL", quote_asset: "BRL", status: "ACTIVE", kill_switch: false,
      strategy_config_pending: false, hard_cap_quote: 275, legacy_compatible: false, ath_reference_symbol: "SOLBRL" }],
  };
  const signals: AbortSignal[] = [];
  let failures = 0, operatorReads = 0;
  const client = { from(table: string) {
    let single = false;
    let start = 0, end = 499, signal: AbortSignal;
    const predicates: Array<(row: Row) => boolean> = [];
    const builder = {
      select() { return builder; },
      eq(key: string, value: unknown) { predicates.push((row) => row[key] === value); return builder; },
      order() { return builder; },
      range(from: number, to: number) { start = from; end = to; return builder; },
      abortSignal(value: AbortSignal) { signal = value; signals.push(value); return builder; },
      single() { single = true; return builder; },
      then(resolve: (value: unknown) => unknown) {
        if (table === "operators") operatorReads++;
        const rows = tables[table]!.filter((row) => predicates.every((predicate) => predicate(row))).slice(start, end + 1);
        const failingPage = !options.failAfterFirstPage || start >= 500;
        if (table === failTable && failingPage && (options.timeouts === undefined || failures < options.timeouts)) {
          failures++;
          if (options.timeouts !== undefined) controllers.get(signal)!.abort();
          return Promise.resolve(resolve({ data: null, error: options.missing ? null
            : { code: options.timeouts === undefined || options.permissionAfterTimeout ? "42501" : "", message: "must not leak" } }));
        }
        if (options.wrongScope && table === "operators") rows[0]!.tenant_id = uuid(999);
        return Promise.resolve(resolve({ data: single ? rows[0] ?? null : rows, error: null }));
      },
    };
    return builder;
  } } as unknown as Parameters<typeof OperatorServer.loadOperatorRegistry>[0];
  return { client, signals, tables, operatorReads: () => operatorReads };
}

const controllers = new Map<AbortSignal, AbortController>();
function controlledDeadline(ms: number) {
  assert.equal(ms, 5000);
  const controller = new AbortController();
  controllers.set(controller.signal, controller);
  return controller.signal;
}

const server = compile();

test("registry uses one bounded deadline across every critical read", async () => {
  const db = database();
  const registry = await server.loadOperatorRegistry(db.client, scope);
  assert.equal(registry.accounts.length, 1);
  assert.equal(registry.engines.length, 1);
  assert.equal(db.signals.length, 3);
  assert.ok(db.signals.every((signal) => signal === db.signals[0]));
});

test("registry failure stays fail-closed and does not expose provider details", async () => {
  const db = database("exchange_accounts");
  const previous = console.error;
  console.error = () => undefined;
  try {
    await assert.rejects(server.loadOperatorRegistry(db.client, scope), (error: unknown) =>
      error instanceof Error && error.message === "COINOPS_OPERATOR_REGISTRY_UNAVAILABLE"
      && !error.message.includes("must not leak"));
  } finally {
    console.error = previous;
  }
});

test("one timeout rereads the complete scope with a fresh deadline, without duplicated pages", async () => {
  const db = database("trading_engines", { timeouts: 1, failAfterFirstPage: true });
  db.tables.trading_engines = Array.from({ length: 501 }, (_, index) => ({
    ...db.tables.trading_engines[0], id: uuid(index + 100),
  }));
  const registry = await compile(controlledDeadline).loadOperatorRegistry(db.client, scope);
  assert.equal(registry.engines.length, 501);
  assert.equal(new Set(registry.engines.map(row => row.id)).size, 501);
  assert.equal(db.operatorReads(), 2);
  assert.equal(new Set(db.signals).size, 2);
});

test("persistent registry timeout is typed and finite, not a cached/partial permission", async () => {
  for (const table of ["operators", "exchange_accounts", "trading_engines"]) {
    const db = database(table, { timeouts: 10 });
    await assert.rejects(compile(controlledDeadline).loadOperatorRegistry(db.client, scope), (error: unknown) =>
      error instanceof LiveReadUnavailable && error.code === "COINOPS_OPERATOR_REGISTRY_READ_TIMEOUT"
      && error.path === `registry/${table}` && error.attempts === 2);
    assert.equal(db.operatorReads(), 2);
  }
});

test("permissions, missing operator and invalid tenant never receive the timeout retry", async () => {
  for (const db of [database("trading_engines"), database("operators", { missing: true }),
    database(undefined, { wrongScope: true }),
    database("trading_engines", { timeouts: 1, permissionAfterTimeout: true })]) {
    await assert.rejects(compile(controlledDeadline).loadOperatorRegistry(db.client, scope), (error: unknown) =>
      error instanceof Error && !(error instanceof LiveReadUnavailable));
    assert.equal(db.operatorReads(), 1);
  }
});
