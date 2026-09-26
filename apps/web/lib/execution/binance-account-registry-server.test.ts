import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("first CONNECT leaves an empty shard registry empty until engines are provisioned", async () => {
  let resolved = 0, dispatched = 0;
  const account = { id: "account", operator_id: "operator", status: "INACTIVE", kill_switch: true,
    is_legacy_default: false, executor_profile: "coinops-fixed-ip" };
  const service = { from(table: string) {
    assert.ok(["exchange_accounts", "trading_engines"].includes(table));
    const response = { data: table === "exchange_accounts" ? account : [], error: null };
    const chain = { select: () => chain, eq: () => chain, single: async () => response,
      then: (fulfilled: (value: unknown) => unknown) => Promise.resolve(response).then(fulfilled) };
    return chain;
  } };
  const dependencies: Record<string, unknown> = {
    "server-only": {}, "node:crypto": { randomUUID: () => "fixture" },
    "./live-executor-client": { signedExecutorHeaders: () => { throw new Error("must not sign"); } },
    "./executor-shards-server": { resolveExecutorForAccount: () => { resolved++; }, withExecutorShard: () => ({}) },
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
