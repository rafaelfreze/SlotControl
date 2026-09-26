import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const tenant = "11111111-1111-4111-8111-111111111111", operator = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const manifest = () => [1, 2, 3, 4].map((n) => ({ accountId: id(n), operatorId: operator,
  shardId: "executor-01", environment: "REAL", identityHash: String(n).repeat(64) }));
const source = readFileSync(new URL("./initial-identity-bootstrap.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded: Record<string, unknown> = {};
new Function("require", "exports", compiled)((name: string) => { assert.equal(name, "server-only"); return {}; }, loaded);
const bootstrap = loaded.bootstrapInitialIdentityBindings as (db: unknown, tenantId: string, config?: string) =>
  Promise<{ status: string; boundCount: number; createdCount: number }>;
const coverage = loaded.requireLiveIdentityCoverage as (db: unknown, tenantId: string) => Promise<void>;

function fixture() {
  const rows: Record<string, Array<Record<string, unknown>>> = {
    operators: [{ id: operator, tenant_id: tenant, status: "ACTIVE" }],
    trading_engines: [1, 2, 3, 4].map((n) => ({ id: id(n), operator_id: operator,
      exchange_account_id: id(n), environment: "REAL", status: "ACTIVE" })),
    robot_v1_live_runs: [1, 2, 3, 4].map((n) => ({ id: id(n), operator_id: operator,
      exchange_account_id: id(n), status: "ACTIVE" })),
    exchange_accounts: manifest().map((row) => ({ id: row.accountId, operator_id: operator,
      status: "ACTIVE", executor_shard_id: "executor-01" })),
    binance_account_identity_bindings: [],
  };
  const writes: Array<Record<string, unknown>> = [];
  let failure: string | null = null;
  const service = { from(table: string) {
    let selected = [...rows[table]];
    const chain = { select: () => chain, order: () => chain,
      eq: (key: string, value: unknown) => { selected = selected.filter((row) => row[key] === value); return chain; },
      neq: (key: string, value: unknown) => { selected = selected.filter((row) => row[key] !== value); return chain; },
      in: (key: string, values: unknown[]) => { selected = selected.filter((row) => values.includes(row[key])); return chain; },
      range: (start: number, end: number) => { selected = selected.slice(start, end + 1); return chain; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: failure === table ? {} : null, data: selected }).then(resolve) };
    return chain;
  }, rpc: async (name: string, input: Record<string, unknown>) => {
    assert.equal(name, "claim_binance_account_identity"); writes.push(input);
    rows.binance_account_identity_bindings.push({ exchange_account_id: input.p_account_id,
      operator_id: input.p_operator_id, identity_hash: input.p_identity_hash, environment: "REAL" });
    return { error: null, data: "BOUND" };
  } };
  return { service, rows, writes, fail: (table: string) => { failure = table; } };
}
test("verified bootstrap binds four current01 LIVE identities once, returning no hashes", async () => {
  const db = fixture(), raw = JSON.stringify(manifest());
  assert.deepEqual(await bootstrap(db.service, tenant, raw), { status: "COMPLETE", boundCount: 4, createdCount: 4 });
  assert.deepEqual(await bootstrap(db.service, tenant, raw), { status: "COMPLETE", boundCount: 4, createdCount: 0 });
  assert.equal(db.writes.length, 4);
  await coverage(db.service, tenant);
  assert.equal((await bootstrap(db.service, tenant, "")).status, "NOT_CONFIGURED");
});
test("all manifest schema, identity uniqueness and scope checks occur before any write", async () => {
  for (const mutate of [
    (value: ReturnType<typeof manifest>) => value.slice(0, 3),
    (value: ReturnType<typeof manifest>) => [{ ...value[0], apiSecret: "must-not-be-accepted" }, ...value.slice(1)],
    (value: ReturnType<typeof manifest>) => [{ ...value[0], shardId: "executor-02" }, ...value.slice(1)],
    (value: ReturnType<typeof manifest>) => [{ ...value[0], environment: "TESTNET" }, ...value.slice(1)],
    (value: ReturnType<typeof manifest>) => [{ ...value[0], identityHash: "invalid" }, ...value.slice(1)],
    (value: ReturnType<typeof manifest>) => [{ ...value[0], identityHash: [value[0].identityHash] }, ...value.slice(1)],
    (value: ReturnType<typeof manifest>) => [{ ...value[0], identityHash: value[1].identityHash }, ...value.slice(1)],
    (value: ReturnType<typeof manifest>) => [{ ...value[0], accountId: value[1].accountId }, ...value.slice(1)],
    (value: ReturnType<typeof manifest>) => [{ ...value[0], accountId: id(99) }, ...value.slice(1)],
    (value: ReturnType<typeof manifest>) => [{ ...value[0], operatorId: id(98) }, ...value.slice(1)],
  ]) { const db = fixture(); await assert.rejects(bootstrap(db.service, tenant, JSON.stringify(mutate(manifest()))),
    /BOOTSTRAP_(INVALID|SCOPE_DENIED)/); assert.equal(db.writes.length, 0); }
  const db = fixture();
  await assert.rejects(bootstrap(db.service, id(99), JSON.stringify(manifest())), /BOOTSTRAP_SCOPE_DENIED/);
  assert.equal(db.writes.length, 0);
});
test("current identity conflict or unavailable data denies bootstrap without replacing a binding", async () => {
  const conflict = fixture(); conflict.rows.binance_account_identity_bindings.push({ exchange_account_id: id(4),
    operator_id: operator, environment: "REAL", identity_hash: "f".repeat(64) });
  await assert.rejects(bootstrap(conflict.service, tenant, JSON.stringify(manifest())), /BOOTSTRAP_CONFLICT/);
  assert.equal(conflict.writes.length, 0);
  const db = fixture(); db.fail("exchange_accounts");
  await assert.rejects(bootstrap(db.service, tenant, JSON.stringify(manifest())), /BOOTSTRAP_REQUIRED/);
  assert.equal(db.writes.length, 0);
});
test("missing coverage fails new admission; never-traded, Testnet and Shadow do not invent LIVE ownership", async () => {
  const db = fixture(); await assert.rejects(coverage(db.service, tenant), /BOOTSTRAP_REQUIRED/);
  await bootstrap(db.service, tenant, JSON.stringify(manifest()));
  db.rows.trading_engines.push({ id: id(5), exchange_account_id: id(5), operator_id: operator, environment: "REAL", status: "INACTIVE" },
    { id: id(6), exchange_account_id: id(6), operator_id: operator, environment: "TESTNET", status: "ACTIVE" },
    { id: id(7), exchange_account_id: id(7), operator_id: operator, environment: "SHADOW", status: "ACTIVE" });
  db.rows.robot_v1_live_runs.push({ id: id(5), exchange_account_id: id(5), operator_id: operator, status: "PREPARING" });
  await coverage(db.service, tenant);
  db.rows.exchange_accounts.push({ id: id(8), operator_id: operator, executor_shard_id: "executor-02", status: "DISABLED" });
  db.rows.robot_v1_live_runs.push({ id: id(8), exchange_account_id: id(8), operator_id: operator, status: "COMPLETED" });
  await assert.rejects(coverage(db.service, tenant), /BOOTSTRAP_REQUIRED/);
});
test("bootstrap never writes account status, registry, engine, credential or an order", () => {
  assert.doesNotMatch(source, /\.update\(|\.insert\(|fetch\(|apiKey|apiSecret|createOrder|cancelOrder/);
  assert.match(source, /rpc\("claim_binance_account_identity"/);
});
