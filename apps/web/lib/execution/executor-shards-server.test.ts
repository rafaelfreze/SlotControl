import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import ts from "typescript";
import { assertExecutorAccountBinding, parseExecutorValidatedVersions, resolveExecutorShard,
  resolveExecutorValidatedVersion, withExecutorShard } from "./executor-shards-server.ts";
import { signedExecutorHeaders } from "./live-executor-client.ts";
import { readLiveExecutorState, createLiveExecutorOrder } from "./live-executor-transport.ts";
import { loadLiveExecutorStatus } from "./live-executor-health.ts";

const configs = { "executor-02": { egressIp: "203.0.113.22", baseUrl: "https://203.0.113.22",
  hmacSecret: "fixture-second-shard-secret-only".repeat(2), validatedVersion: "shard02" } };
const environment = { LIVE_EXECUTOR_EGRESS_IP: "46.101.104.48", LIVE_EXECUTOR_BASE_URL: "https://46.101.104.48",
  COINOPS_EXECUTOR_HMAC_SECRET: "first-shard-fixture-secret".repeat(2), LIVE_EXECUTOR_VALIDATED_VERSION: "legacy01",
  COINOPS_EXECUTOR_SHARDS_JSON: JSON.stringify(configs) };
const target = resolveExecutorShard("executor-02", environment);
test("isolated new-shard config preserves sensitive fleet JSON and existing routing", () => {
  const third = { egressIp: "203.0.113.33", baseUrl: "https://203.0.113.33",
    hmacSecret: "third-shard-fixture-only".repeat(3), validatedVersion: "shard03" };
  const env = { ...environment, COINOPS_EXECUTOR_03_CONFIG_JSON: JSON.stringify(third) };
  const snapshot = structuredClone(env);
  assert.deepEqual(resolveExecutorShard("executor-01", env), resolveExecutorShard("executor-01", environment));
  assert.deepEqual(resolveExecutorShard("executor-02", env), target);
  assert.equal(resolveExecutorShard("executor-03", env).ip, third.egressIp);
  assert.equal(resolveExecutorShard("executor-03", env).validatedVersion, "shard03");
  assert.deepEqual(env, snapshot);
  for (const invalid of ["{broken", "null", "[]", JSON.stringify({ ...third, hmacSecret: "short" })]) {
    const bad = { ...env, COINOPS_EXECUTOR_03_CONFIG_JSON: invalid };
    assert.throws(() => resolveExecutorShard("executor-03", bad), /CONFIG_INVALID/);
    assert.deepEqual(resolveExecutorShard("executor-02", bad), target);
  }
  for (const collision of [configs["executor-02"], { ...third,
    hmacSecret: environment.COINOPS_EXECUTOR_HMAC_SECRET }, { ...third,
    egressIp: environment.LIVE_EXECUTOR_EGRESS_IP, baseUrl: environment.LIVE_EXECUTOR_BASE_URL }])
    assert.throws(() => resolveExecutorShard("executor-03", { ...env,
      COINOPS_EXECUTOR_03_CONFIG_JSON: JSON.stringify(collision) }), /COLLISION/);
  assert.throws(() => resolveExecutorShard("executor-02", { ...env,
    COINOPS_EXECUTOR_02_CONFIG_JSON: JSON.stringify(third) }), /COLLISION/);
  const future = { ...env, COINOPS_EXECUTOR_04_CONFIG_JSON: JSON.stringify({ ...third,
    egressIp: "203.0.113.44", baseUrl: "https://203.0.113.44", hmacSecret: "fourth-fixture".repeat(4) }) };
  assert.equal(resolveExecutorShard("executor-04", future).ip, "203.0.113.44");
  assert.throws(() => resolveExecutorShard("executor-04", { ...future,
    COINOPS_EXECUTOR_04_CONFIG_JSON: JSON.stringify(third) }), /COLLISION/);
});
const engine = { operator_id: "operator-fixture", exchange_account_id: "account-fixture",
  trading_engine_id: "engine-fixture", symbol: "BTCBRL", quote_asset: "BRL" };
const rolloutStart = "2026-09-28T04:00:00.000Z", rolloutUntil = "2026-09-28T05:00:00.000Z";
const rolloutNow = Date.parse(rolloutStart) + 30_000;
const rolloutBounds = { COINOPS_EXECUTOR_01_VERSION_TRANSITION_START: rolloutStart,
  COINOPS_EXECUTOR_01_VERSION_TRANSITION_UNTIL: rolloutUntil,
  COINOPS_EXECUTOR_02_VERSION_TRANSITION_START: rolloutStart,
  COINOPS_EXECUTOR_02_VERSION_TRANSITION_UNTIL: rolloutUntil };

test("version-only promotion keeps sensitive config intact across successive bounded rollouts", () => {
  const current = "a".repeat(40), upcoming = "b".repeat(40);
  for (const id of ["executor-01", "executor-02", "executor-03", "executor-04"]) {
    const prefix = `COINOPS_${id.toUpperCase().replaceAll("-", "_")}`;
    const env = { [`${prefix}_VALIDATED_VERSION`]: current,
      [`${prefix}_NEXT_VALIDATED_VERSION`]: upcoming,
      [`${prefix}_VERSION_TRANSITION_START`]: rolloutStart,
      [`${prefix}_VERSION_TRANSITION_UNTIL`]: rolloutUntil };
    const snapshot = structuredClone(env);
    assert.equal(resolveExecutorValidatedVersion(id, "historical-base", env, Date.parse(rolloutStart) - 1), current);
    assert.equal(resolveExecutorValidatedVersion(id, "historical-base", env, rolloutNow), `${current},${upcoming}`);
    assert.equal(resolveExecutorValidatedVersion(id, "historical-base", env, Date.parse(rolloutUntil)), upcoming);
    assert.equal(resolveExecutorValidatedVersion(id, "historical-base", { [`${prefix}_VALIDATED_VERSION`]: current }), current);
    assert.deepEqual(env, snapshot);
    for (const invalid of ["", "alias", `${current},${upcoming}`, "*", "A".repeat(40), "a".repeat(39)])
      assert.throws(() => resolveExecutorValidatedVersion(id, "historical-base", { ...env,
        [`${prefix}_VALIDATED_VERSION`]: invalid }, rolloutNow), /CONFIG_INVALID/);
    assert.throws(() => resolveExecutorValidatedVersion(id, "historical-base", { ...env,
      [`${prefix}_VERSION_TRANSITION_UNTIL`]: undefined }, rolloutNow), /CONFIG_INVALID/);
  }
  const promoted = { ...environment, COINOPS_EXECUTOR_02_VALIDATED_VERSION: current,
    COINOPS_EXECUTOR_02_NEXT_VALIDATED_VERSION: upcoming,
    COINOPS_EXECUTOR_02_VERSION_TRANSITION_START: rolloutStart,
    COINOPS_EXECUTOR_02_VERSION_TRANSITION_UNTIL: rolloutUntil };
  const actual = resolveExecutorShard("executor-02", promoted, rolloutNow);
  assert.deepEqual({ ...actual, validatedVersion: "shard02" }, target);
  assert.equal(actual.validatedVersion, `${current},${upcoming}`);
  assert.deepEqual(resolveExecutorShard("executor-01", promoted, rolloutNow), resolveExecutorShard("executor-01", environment));
});

test("validated releases allow at most two exact bounded versions and reject malformed lists per shard", () => {
  for (const valid of ["release-a", "release-a,release-b", "a".repeat(100), `${"a".repeat(100)},${"b".repeat(100)}`]) {
    assert.deepEqual(parseExecutorValidatedVersions(valid), valid.split(","));
    assert.equal(resolveExecutorShard("executor-01", { ...environment,
      ...(valid.includes(",") ? rolloutBounds : {}), LIVE_EXECUTOR_VALIDATED_VERSION: valid }, rolloutNow).validatedVersion, valid);
    assert.equal(resolveExecutorShard("executor-02", { ...environment,
      ...(valid.includes(",") ? rolloutBounds : {}),
      COINOPS_EXECUTOR_SHARDS_JSON: JSON.stringify({ "executor-02": {
        ...configs["executor-02"], validatedVersion: valid } }) }, rolloutNow).validatedVersion, valid);
  }
  for (const invalid of ["", "a,b,c", "a,", ",a", "a,,b", "a,a", "a, b", "a,b\n", "a,*",
    "a,b/other", "a".repeat(101), ["a", "b"], null, 123]) {
    assert.equal(parseExecutorValidatedVersions(invalid), null);
    assert.throws(() => resolveExecutorShard("executor-02", { ...environment,
      COINOPS_EXECUTOR_SHARDS_JSON: JSON.stringify({ "executor-02": {
        ...configs["executor-02"], validatedVersion: invalid } }) }), /CONFIG_INVALID/);
    assert.equal(resolveExecutorShard("executor-01", { ...environment,
      COINOPS_EXECUTOR_SHARDS_JSON: JSON.stringify({ "executor-02": {
        ...configs["executor-02"], validatedVersion: invalid } }) }).validatedVersion, "legacy01");
  }
});

test("per-shard next release combines two exact versions without changing protected routing configuration", () => {
  const rolling = { ...environment, ...rolloutBounds, COINOPS_EXECUTOR_01_NEXT_VALIDATED_VERSION: "new01",
    COINOPS_EXECUTOR_02_NEXT_VALIDATED_VERSION: "new02", COINOPS_EXECUTOR_03_NEXT_VALIDATED_VERSION: "malformed,*" };
  const original = structuredClone(rolling);
  const first = resolveExecutorShard("executor-01", rolling, rolloutNow);
  const second = resolveExecutorShard("executor-02", rolling, rolloutNow);
  assert.equal(first.validatedVersion, "legacy01,new01");
  assert.equal(second.validatedVersion, "shard02,new02");
  assert.deepEqual({ ...first, validatedVersion: "legacy01" }, resolveExecutorShard("executor-01", environment));
  assert.deepEqual({ ...second, validatedVersion: "shard02" }, target);
  assert.deepEqual(rolling, original, "resolving the next version never rewrites env/secrets");
  assert.equal(resolveExecutorShard("executor-02", { ...rolling,
    COINOPS_EXECUTOR_02_NEXT_VALIDATED_VERSION: "shard02" }, rolloutNow).validatedVersion, "shard02");
});

test("malformed next release blocks only its own shard and cannot bootstrap a missing base", () => {
  for (const invalid of ["", " ", "a,b", "a,a", "new*", "new\n", "a".repeat(101)]) {
    const badSecond = { ...environment, COINOPS_EXECUTOR_02_NEXT_VALIDATED_VERSION: invalid,
      COINOPS_EXECUTOR_02_VERSION_TRANSITION_START: rolloutStart,
      COINOPS_EXECUTOR_02_VERSION_TRANSITION_UNTIL: rolloutUntil };
    assert.throws(() => resolveExecutorShard("executor-02", badSecond), /CONFIG_INVALID/);
    assert.equal(resolveExecutorShard("executor-01", badSecond).validatedVersion, "legacy01");
    const badFirst = { ...environment, COINOPS_EXECUTOR_01_NEXT_VALIDATED_VERSION: invalid,
      COINOPS_EXECUTOR_01_VERSION_TRANSITION_START: rolloutStart,
      COINOPS_EXECUTOR_01_VERSION_TRANSITION_UNTIL: rolloutUntil };
    assert.throws(() => resolveExecutorShard("executor-01", badFirst), /CONFIG_INVALID/);
    assert.equal(resolveExecutorShard("executor-02", badFirst).validatedVersion, "shard02");
  }
  for (const base of [undefined, "old,other"]) {
    assert.throws(() => resolveExecutorShard("executor-01", { ...environment,
      ...rolloutBounds,
      LIVE_EXECUTOR_VALIDATED_VERSION: base, COINOPS_EXECUTOR_01_NEXT_VALIDATED_VERSION: "next" }), /CONFIG_INVALID/);
    assert.throws(() => resolveExecutorShard("executor-02", { ...environment,
      ...rolloutBounds,
      COINOPS_EXECUTOR_02_NEXT_VALIDATED_VERSION: "next",
      COINOPS_EXECUTOR_SHARDS_JSON: JSON.stringify({ "executor-02": {
        ...configs["executor-02"], validatedVersion: base } }) }), /CONFIG_INVALID/);
  }
});

test("version transition is explicit, bounded, per request and becomes only the new release at the exact cutoff", () => {
  const env = { ...environment, ...rolloutBounds, COINOPS_EXECUTOR_01_NEXT_VALIDATED_VERSION: "new01",
    COINOPS_EXECUTOR_02_NEXT_VALIDATED_VERSION: "new02" };
  const start = Date.parse(rolloutStart), until = Date.parse(rolloutUntil);
  for (const [time, expected] of [[start - 1, "legacy01"], [start, "legacy01,new01"],
    [until - 1, "legacy01,new01"], [until, "new01"], [until + 365 * 86_400_000, "new01"]] as const)
    assert.equal(resolveExecutorShard("executor-01", env, time).validatedVersion, expected);
  assert.equal(resolveExecutorShard("executor-02", env, until).validatedVersion, "new02");
  assert.equal(resolveExecutorValidatedVersion("executor-01", "legacy01,new01", rolloutBounds, until), "new01");
  assert.equal(resolveExecutorValidatedVersion("executor-01", "legacy01", {}, until), "legacy01");
  assert.equal(resolveExecutorValidatedVersion("executor-01", undefined, {}, until), undefined);
  const sixHours = { ...env, COINOPS_EXECUTOR_01_VERSION_TRANSITION_UNTIL: "2026-09-28T10:00:00Z" };
  assert.equal(resolveExecutorShard("executor-01", sixHours, start).validatedVersion, "legacy01,new01");
  assert.equal(resolveExecutorShard("executor-01", { ...env,
    COINOPS_EXECUTOR_02_VERSION_TRANSITION_UNTIL: "malformed" }, start).validatedVersion, "legacy01,new01");
});

test("invalid or incomplete transition bounds never create an indefinite or cross-shard version exception", () => {
  const env = { ...environment, ...rolloutBounds, COINOPS_EXECUTOR_01_NEXT_VALIDATED_VERSION: "new01" };
  for (const until of [undefined, "", "2026-09-28T05:00:00", "2026-09-28T05:00:00+00:00",
    "2026-02-30T05:00:00Z", "2026-09-28T05:00:00Z\n", rolloutStart, "2026-09-28T03:59:59Z",
    "2026-09-28T10:00:00.001Z"])
    assert.throws(() => resolveExecutorShard("executor-01", { ...env,
      COINOPS_EXECUTOR_01_VERSION_TRANSITION_UNTIL: until }, rolloutNow), /CONFIG_INVALID/);
  assert.throws(() => resolveExecutorShard("executor-01", { ...env,
    COINOPS_EXECUTOR_01_VERSION_TRANSITION_START: undefined }, rolloutNow), /CONFIG_INVALID/);
  assert.throws(() => resolveExecutorShard("executor-01", env, NaN), /CONFIG_INVALID/);
  assert.throws(() => resolveExecutorShard("executor-01", { ...environment,
    LIVE_EXECUTOR_VALIDATED_VERSION: "legacy01,new01" }, rolloutNow), /CONFIG_INVALID/);
  assert.throws(() => resolveExecutorShard("executor-01", { ...environment,
    COINOPS_EXECUTOR_01_NEXT_VALIDATED_VERSION: "new01" }, rolloutNow), /CONFIG_INVALID/);
  assert.throws(() => resolveExecutorShard("executor-01", { ...environment, ...rolloutBounds }, rolloutNow), /CONFIG_INVALID/);
});

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
