import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import ts from "typescript";
import { assertExecutorAccountBinding, resolveExecutorShard, withExecutorShard } from "./executor-shards-server.ts";
import { signedExecutorHeaders } from "./live-executor-client.ts";
import { readLiveExecutorState, createLiveExecutorOrder } from "./live-executor-transport.ts";
import { loadLiveExecutorStatus } from "./live-executor-health.ts";

const configs = { "executor-02": { egressIp: "203.0.113.22", baseUrl: "https://203.0.113.22",
  hmacSecret: "fixture-second-shard-secret-only".repeat(2), validatedVersion: "shard02" } };
const environment = { LIVE_EXECUTOR_EGRESS_IP: "46.101.104.48", LIVE_EXECUTOR_BASE_URL: "https://46.101.104.48",
  COINOPS_EXECUTOR_HMAC_SECRET: "first-shard-fixture-secret".repeat(2), LIVE_EXECUTOR_VALIDATED_VERSION: "legacy01",
  COINOPS_EXECUTOR_SHARDS_JSON: JSON.stringify(configs) };
const target = resolveExecutorShard("executor-02", environment);
const engine = { operator_id: "operator-fixture", exchange_account_id: "account-fixture",
  trading_engine_id: "engine-fixture", symbol: "BTCBRL", quote_asset: "BRL" };

test("shard configuration has explicit01 compatibility and never falls back02", () => {
  assert.equal(resolveExecutorShard("executor-01", environment).ip, "46.101.104.48");
  assert.equal(target.ip, "203.0.113.22");
  assert.throws(() => resolveExecutorShard("executor-03", environment), /NOT_CONFIGURED/);
  assert.throws(() => resolveExecutorShard("__proto__", environment), /SHARD_INVALID/);
  assert.throws(() => resolveExecutorShard("executor-02", { ...environment, COINOPS_EXECUTOR_SHARDS_JSON: "{}" }), /NOT_CONFIGURED/);
  for (const patch of [{ egressIp: "999.1.1.1" }, { baseUrl: "http://203.0.113.22" },
    { baseUrl: "https://203.0.113.22/other" }, { hmacSecret: "short" }]) {
    assert.throws(() => resolveExecutorShard("executor-02", { COINOPS_EXECUTOR_SHARDS_JSON:
      JSON.stringify({ "executor-02": { ...configs["executor-02"], ...patch } }) }), /CONFIG_INVALID/);
  }
  const collision = { ...configs["executor-02"], egressIp: environment.LIVE_EXECUTOR_EGRESS_IP,
    baseUrl: environment.LIVE_EXECUTOR_BASE_URL };
  const colliding = { ...environment, COINOPS_EXECUTOR_SHARDS_JSON: JSON.stringify({ "executor-02": collision }) };
  assert.throws(() => resolveExecutorShard("executor-02", colliding), /COLLISION/);
  assert.equal(resolveExecutorShard("executor-01", colliding).ip, environment.LIVE_EXECUTOR_EGRESS_IP);
  for (const malformed of ["{broken", "[]", "null", '"string"']) {
    const corrupted = { ...environment, COINOPS_EXECUTOR_SHARDS_JSON: malformed };
    assert.equal(resolveExecutorShard("executor-01", corrupted).ip, environment.LIVE_EXECUTOR_EGRESS_IP);
    assert.throws(() => resolveExecutorShard("executor-02", corrupted), /CONFIG_INVALID/);
  }
  assert.equal(resolveExecutorShard("executor-01", { ...environment, COINOPS_EXECUTOR_SHARDS_JSON:
    JSON.stringify({ "executor-01": configs["executor-02"] }) }).ip, environment.LIVE_EXECUTOR_EGRESS_IP);
});

test("account ownership is tenant and operator scoped; capacity enabled never controls existing routing", () => {
  const op = { id: "operator", tenant_id: "tenant", status: "ACTIVE" };
  const account = { id: "account", operator_id: "operator", executor_shard_id: "executor-02" };
  assert.equal(assertExecutorAccountBinding(op, account, "operator", "account", "tenant"), "executor-02");
  for (const bad of [null, { ...account, operator_id: "other" }, { ...account, id: "other" },
    { ...account, executor_shard_id: "" }])
    assert.throws(() => assertExecutorAccountBinding(op, bad, "operator", "account", "tenant"), /DENIED/);
  assert.throws(() => assertExecutorAccountBinding(op, account, "operator", "account", "other"), /DENIED/);
});

test("existing01 durable input is byte-identical; new shards bind signed body; Testnet route accepted", () => {
  const payload = { action: "CREATE", clientOrderId: "durable", ...engine };
  assert.equal(withExecutorShard(payload, resolveExecutorShard("executor-01", environment)), payload);
  assert.equal(JSON.stringify(withExecutorShard(payload, resolveExecutorShard("executor-01", environment))), JSON.stringify(payload));
  assert.equal(withExecutorShard(payload, target).executor_shard_id, "executor-02");
  assert.throws(() => withExecutorShard({ ...payload, executor_shard_id: "executor-01" }, target), /MISMATCH/);
  assert.ok(signedExecutorHeaders(target.secret, "/v1/testnet/transport", "{}", "fixture").get("x-coinops-signature"));
});

test("LIVE transport and health use only the authoritative shard; reject wrong-shard responses", async () => {
  const state = { ...engine, executor_shard_id: "executor-02", environment: "REAL", balances: [], open_orders: [],
    filters: { symbol: "BTCBRL", baseAsset: "BTC", quoteAsset: "BRL", quantityStep: .00001, minNotional: 10, priceTick: 1 },
    price: { symbol: "BTCBRL", price: 400000, observedAt: new Date().toISOString() }, observed_at: new Date().toISOString() };
  const resolver = async (operatorId: string, accountId: string) => {
    assert.equal(operatorId, engine.operator_id); assert.equal(accountId, engine.exchange_account_id); return target;
  };
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.ok(String(url).startsWith(target.base));
    assert.equal(JSON.parse(String(init?.body)).executor_shard_id, "executor-02");
    return Response.json(state);
  }) as typeof fetch;
  assert.deepEqual(await readLiveExecutorState(engine, fetcher, resolver), state);
  await assert.rejects(readLiveExecutorState(engine, (async () => Response.json({ ...state,
    executor_shard_id: "executor-01" })) as typeof fetch, resolver), /RESPONSE_SHARD_MISMATCH/);
  const health = { ...state, healthy: true, version: "shard02", binance_connectivity: "OK",
    account_permission: "SPOT_RESTRICTED", egress_ipv4: target.ip, egress_ipv4_verified: true,
    clock_drift_ms: 0, trading_enabled: true, kill_switch: false };
  const result = await loadLiveExecutorStatus(undefined, undefined,
    (async () => Response.json(health)) as typeof fetch, undefined, engine, resolver);
  assert.equal(result.gate, "LIVE_EXECUTOR_ACTIVE"); assert.equal(result.ip, target.ip);
});

test("missing binding blocks dispatch and an uncertain write never retries or switches shard", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return Response.json({}, { status: 503 }); }) as typeof fetch;
  await assert.rejects(createLiveExecutorOrder({ clientOrderId: "fixture" }, engine, "decision", fetcher,
    async () => { throw new Error("EXECUTOR_ACCOUNT_SHARD_DENIED"); }), /DENIED/);
  assert.equal(calls, 0);
  await assert.rejects(createLiveExecutorOrder({ clientOrderId: "fixture" }, engine, "decision", fetcher,
    async () => target), /503/);
  assert.equal(calls, 1);
});

test("real resolver queries authoritative tenant/account, coalesces bindings, and never caches a failed lookup", async () => {
  const operatorId = "00000000-0000-4000-8000-000000000001";
  const accountId = "00000000-0000-4000-8000-000000000002";
  const queries: Array<{ table: string; filters: Record<string, unknown> }> = [];
  let broken = false, databaseIp = target.ip;
  const service = { from(table: string) {
    const query = { table, filters: {} as Record<string, unknown> }; queries.push(query);
    const chain = { select: () => chain,
      eq: (key: string, value: unknown) => { query.filters[key] = value; return chain; },
      single: async () => ({ error: broken ? { message: "fixture unavailable" } : null,
        data: table === "operators" ? { id: operatorId, tenant_id: "tenant", status: "ACTIVE" }
          : table === "executor_shards" ? { id: "executor-02", egress_ipv4: databaseIp }
            : { id: accountId, operator_id: operatorId, executor_shard_id: "executor-02" } }) };
    return chain;
  } };
  const dependencies: Record<string, unknown> = { "node:net": { isIP },
    "../supabase/env": { getCoinOpsServiceTenantId: () => "tenant", getSupabaseDataSchema: () => "coinops" },
    "../supabase/service-role": { createServiceRoleClient: () => service } };
  const loadedModule = () => {
    const source = readFileSync(new URL("./executor-shards-server.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: Record<string, unknown> = {};
    new Function("require", "exports", "process", compiled)((name: string) => {
      assert.ok(name in dependencies, `Unexpected resolver dependency: ${name}`); return dependencies[name];
    }, exports, { env: environment });
    return exports.resolveExecutorForAccount as (operatorId: string, accountId: string) => Promise<typeof target>;
  };
  const resolve = loadedModule();
  const [first, second] = await Promise.all([resolve(operatorId, accountId), resolve(operatorId, accountId)]);
  assert.equal(first.shardId, "executor-02"); assert.deepEqual(second, first); assert.equal(queries.length, 3);
  assert.deepEqual(queries.find((row) => row.table === "operators")?.filters, { id: operatorId, tenant_id: "tenant" });
  assert.deepEqual(queries.find((row) => row.table === "exchange_accounts")?.filters,
    { id: accountId, operator_id: operatorId });
  const retry = loadedModule(); broken = true;
  await assert.rejects(retry(operatorId, accountId), /ACCOUNT_SHARD_DENIED/);
  broken = false;
  assert.equal((await retry(operatorId, accountId)).shardId, "executor-02");
  assert.equal(queries.length, 8, "recovery reads the binding again; never falls back to01");
  databaseIp = "203.0.113.23";
  await assert.rejects(loadedModule()(operatorId, accountId), /SHARD_IP_MISMATCH/);
});
