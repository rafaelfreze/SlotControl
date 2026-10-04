import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { completeLedgerRead } from "./complete-ledger-read.ts";

test("first CONNECT leaves an empty shard registry empty until engines are provisioned", async () => {
  let resolved = 0, dispatched = 0;
  const account = { id: "account", operator_id: "operator", status: "INACTIVE", kill_switch: true,
    is_legacy_default: false, executor_profile: "coinops-fixed-ip" };
  const service = { from(table: string) {
    assert.ok(["exchange_accounts", "trading_engines"].includes(table));
    const response = { data: table === "exchange_accounts" ? account : [], error: null };
    const chain = { select: () => chain, eq: () => chain, order: () => chain, range: () => chain, single: async () => response,
      then: (fulfilled: (value: unknown) => unknown) => Promise.resolve(response).then(fulfilled) };
    return chain;
  } };
  const dependencies: Record<string, unknown> = {
    "server-only": {}, "./complete-ledger-read.ts": { completeLedgerRead },
    "./operator-executor-admin.ts": { operatorConnectionAdmin: () => { dispatched++; } },
    "./executor-shards-server.ts": { resolveExecutorForConnection: () => { resolved++; } },
  };
  const source = readFileSync(new URL("./binance-account-registry-server.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", "fetch", compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name];
  }, exports, () => { dispatched++; });
  const sync = exports.syncInactiveBinanceAccount as (...args: unknown[]) => Promise<unknown>;
  assert.deepEqual(await sync(service, "operator", "account", "vault-ref", "REAL"),
    { registered_engines: 0, status: "INACTIVE" });
  assert.equal(resolved, 0); assert.equal(dispatched, 0);
  account.kill_switch = false;
  await assert.rejects(sync(service, "operator", "account", "vault-ref", "REAL"), /SCOPE_DENIED/);
});

test("inactive same-symbol engines synchronize only to their own validated shard, retry without duplicates", async () => {
  const account = { status: "INACTIVE", kill_switch: true, is_legacy_default: false, executor_profile: "coinops-fixed-ip" };
  const engines = ["executor-02", "executor-03"].map((shard, index) => ({ id: `engine-${index}`, symbol: "SOLBRL",
    base_asset: "SOL", quote_asset: "BRL", status: "INACTIVE", kill_switch: true, executor_shard_id: shard,
    hard_cap_quote: 100, config: { slot_count: 25, max_order_quote: 100 } }));
  const service = { from(table: string) {
    const response = { data: table === "exchange_accounts" ? account : table === "trading_engines" ? engines : { hard_cap_quote: 200 }, error: null };
    const chain = { select: () => chain, eq: () => chain, order: () => chain, range: () => chain, single: async () => response,
      then: (fulfilled: (value: unknown) => unknown) => Promise.resolve(response).then(fulfilled) }; return chain;
  } };
  let denied = false; const calls: string[] = [], installed = new Set<string>();
  const deps: Record<string, unknown> = { "server-only": {}, "./complete-ledger-read.ts": { completeLedgerRead },
    "./executor-shards-server.ts": { resolveExecutorForConnection: async (_op: string, _account: string, shard: string) => {
      if (denied && shard === "executor-03") throw new Error("VALIDATION_REQUIRED");
      return { shardId: shard, credentialRef: `vault-${shard}` };
    } }, "./operator-executor-admin.ts": { operatorConnectionAdmin: async (_op: string, _account: string, shard: string,
      path: string, payload: { engines?: Array<Record<string, unknown>>; account_cap_quote?: number }) => {
      calls.push(`${shard}:${path}`);
      if (path.endsWith("account-cap")) { assert.deepEqual(payload, { quote_asset: "BRL", account_cap_quote: 200 }); return {}; }
      assert.equal(payload.engines?.length, 1);
      const row = payload.engines![0], engine = engines.find((engine) => engine.id === row.trading_engine_id)!;
      assert.equal(engine.executor_shard_id, shard); assert.equal(row.credential_ref, `vault-${shard}`);
      assert.equal(row.execution_allowed, false); assert.equal(row.kill_switch, true); assert.equal(row.status, "INACTIVE");
      installed.add(String(row.trading_engine_id)); return { registered_engines: 1, status: "INACTIVE", trading_enabled: false };
    } } };
  const compiled = ts.transpileModule(readFileSync(new URL("./binance-account-registry-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((name: string) => { assert.ok(name in deps, name); return deps[name]; }, exports);
  const sync = exports.syncInactiveBinanceAccount as (...args: unknown[]) => Promise<unknown>;
  denied = true;
  await assert.rejects(sync(service, "operator", "account", "old-primary-ref", "REAL"), /VALIDATION_REQUIRED/);
  assert.equal(calls.length, 0); denied = false;
  for (let retry = 0; retry < 2; retry++) assert.deepEqual(await sync(service, "operator", "account", "old-primary-ref", "REAL"),
    { registered_engines: 2, status: "INACTIVE" });
  assert.equal(installed.size, 2); assert.equal(calls.length, 8);
  engines[1].kill_switch = false; calls.length = 0;
  await assert.rejects(sync(service, "operator", "account", "old-primary-ref", "REAL"), /ENGINE_ACTIVE/);
  assert.equal(calls.length, 0);
});
