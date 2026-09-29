import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type * as OperatorServer from "../execution/operator-context-server.ts";
import { assertDomainRegistry, resolveEngineContext, visibleOperatorRegistry } from "../execution/operator-context.ts";

type Row = Record<string, unknown>;
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const scope = { product_id: uuid(1), tenant_id: uuid(2), user_id: uuid(3) };

function compile() {
  const source = readFileSync(new URL("../execution/operator-context-server.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const exports: Row = {};
  new Function("require", "exports", compiled)((name: string) => {
    if (name === "server-only") return {};
    if (name === "./operator-context") return { assertDomainRegistry, resolveEngineContext, visibleOperatorRegistry };
    throw new Error(`Unexpected dependency: ${name}`);
  }, exports);
  return exports as unknown as typeof OperatorServer;
}

function database(failTable?: string) {
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
  const client = { from(table: string) {
    let single = false;
    const predicates: Array<(row: Row) => boolean> = [];
    const builder = {
      select() { return builder; },
      eq(key: string, value: unknown) { predicates.push((row) => row[key] === value); return builder; },
      order() { return builder; },
      range() { return builder; },
      abortSignal(signal: AbortSignal) { signals.push(signal); return builder; },
      single() { single = true; return builder; },
      then(resolve: (value: unknown) => unknown) {
        const rows = tables[table]!.filter((row) => predicates.every((predicate) => predicate(row)));
        return Promise.resolve(resolve(failTable === table
          ? { data: null, error: { code: "42501", message: "must not leak" } }
          : { data: single ? rows[0] ?? null : rows, error: null }));
      },
    };
    return builder;
  } } as unknown as Parameters<typeof OperatorServer.loadOperatorRegistry>[0];
  return { client, signals };
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
