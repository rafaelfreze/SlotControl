import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createExecutorHandler } from "../src/server.mjs";
import { assertExecutorShardContext, assertRegistryShard, durableIntent,
  mergeDynamicRegistry, validateExecutorRegistry, saveInactiveRegistryAccount,
  loadCombinedRegistry, promoteRegistryEngine, resolveExecutorContext } from "../src/account-registry.mjs";
import { createCapacityTelemetry } from "../src/capacity-telemetry.mjs";
import { requestSignature, sha256, withWriteIdempotency } from "../src/security.mjs";
import { saveCredential } from "../src/credential-vault.mjs";
import { ACCOUNT_A, ACCOUNT_B, OPERATOR, engineFixture, registryFixture } from "./registry-fixture.mjs";

const NOW = Date.parse("2026-09-26T19:00:00Z");
const SECRET = "fixture-only-shard02-secret-not-a-real-credential";
const IP = "203.0.113.22";
const emptyRegistry = () => ({ version: 1, executor_shard_id: "executor-02", engines: [], credentials: {} });
const headers = (path, body, key, secret = SECRET) => {
  const nonce = randomUUID().replaceAll("-", "");
  return { "content-type": "application/json", "x-coinops-timestamp": String(NOW),
    "x-coinops-nonce": nonce, "x-coinops-body-sha256": sha256(body),
    "x-coinops-signature": requestSignature(secret, "POST", path, NOW, nonce, body),
    "x-coinops-idempotency-key": key };
};
function marketFetcher(calls, fail = () => false) {
  return async (url, init) => {
    calls.push({ url, method: init?.method });
    if (fail()) throw new Error("FIXTURE_SHARD_OFFLINE");
    if (url.includes("exchangeInfo")) return Response.json({ symbols: ["BTCBRL", "SOLBRL"].map((symbol) => ({ symbol, status: "TRADING" })) });
    if (url.includes("ticker/price")) return Response.json([{ symbol: "BTCBRL", price: "400000" }, { symbol: "SOLBRL", price: "600" }]);
    if (url.includes("/api/v3/time")) return Response.json({ serverTime: NOW }, { headers: { "x-mbx-used-weight-1m": "2" } });
    if (url.includes("ipify")) return Response.json({ ip: IP });
    throw new Error("UNEXPECTED_FIXTURE_REQUEST");
  };
}
async function serve(options = {}) {
  const stateDirectory = options.stateDirectory ?? await mkdtemp(join(tmpdir(), "coinops-shard-"));
  const server = createServer(createExecutorHandler({ secret: SECRET, stateDirectory,
    shardId: "executor-02", expectedEgressIp: IP, registry: emptyRegistry(),
    fetcher: marketFetcher([]), now: () => NOW, logger: () => {}, ...options }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { stateDirectory, server, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)) };
}
async function post(url, path, payload, key, secret) {
  const body = JSON.stringify(payload);
  return fetch(url + path, { method: "POST", body, headers: headers(path, body, key, secret) });
}

test("only explicitly identified nonlegacy shards can start empty; mixed registry ownership fails closed", () => {
  assert.equal(validateExecutorRegistry(emptyRegistry()).engines.length, 0);
  for (const patch of [{ executor_shard_id: undefined }, { executor_shard_id: "executor-01" },
    { executor_shard_id: "unexpected" }, { credentials: { cloned: { vault: true } } }])
    assert.throws(() => validateExecutorRegistry({ ...emptyRegistry(), ...patch }), /REGISTRY_INVALID/);
  assert.throws(() => assertRegistryShard(emptyRegistry(), "executor-01"), /SHARD_MISMATCH/);
  const row = { ...engineFixture("SOLBRL", ACCOUNT_B, 7, false), executor_shard_id: "executor-02" };
  const registry = { ...registryFixture([row]), executor_shard_id: "executor-02" };
  assert.equal(validateExecutorRegistry(registry).engines.length, 1);
  assert.throws(() => validateExecutorRegistry({ ...registry, engines: [{ ...row, executor_shard_id: "executor-01" }] }), /SHARD_MISMATCH/);
  assert.throws(() => validateExecutorRegistry({ ...registry, engines: [{ ...row, is_legacy_default: true }] }), /SHARD_MISMATCH/);
  assert.doesNotThrow(() => assertExecutorShardContext("executor-01", {}));
  assert.throws(() => assertExecutorShardContext("executor-02", {}), /SHARD_SCOPE_DENIED/);
  assert.throws(() => assertExecutorShardContext("executor-01", { executor_shard_id: "executor-02" }), /SHARD_SCOPE_DENIED/);
});

test("signed wrong or omitted shard is rejected before credentials, Testnet, registry, state or exchange", async () => {
  const calls = [], running = await serve({ tradingEnabled: true, killSwitch: false, fetcher: marketFetcher(calls) });
  try {
    for (const path of ["/v1/capacity", "/v1/admin/credentials", "/v1/admin/registry", "/v1/admin/snapshot",
      "/v1/admin/promote", "/v1/admin/capital", "/v1/testnet/transport", "/v1/state", "/v1/health",
      "/v1/create-order", "/v1/cancel-order", "/v1/query-order", "/v1/trades", "/v1/dry-run"]) {
      for (const payload of [{}, { executor_shard_id: "executor-01" }]) {
        const result = await post(running.url, path, payload, "fixture-shard-denied-key");
        assert.equal(result.status, 403, path);
        assert.equal((await result.json()).error, "EXECUTOR_SHARD_SCOPE_DENIED");
      }
    }
    const foreign = await post(running.url, "/v1/capacity", { executor_shard_id: "executor-02" },
      "fixture-shard-denied-key", "fixture-different-shard01-secret-never-production");
    assert.equal(foreign.status, 401);
    assert.equal((await foreign.json()).error, "EXECUTOR_SIGNATURE_INVALID");
    assert.equal(calls.length, 0);
  } finally { await running.close(); await rm(running.stateDirectory, { recursive: true, force: true }); }
});

test("empty Executor02 proves infrastructure health and measured weight without a Binance credential", async () => {
  const calls = [], running = await serve({ fetcher: marketFetcher(calls) });
  try {
    const response = await fetch(running.url + "/health");
    const health = await response.json();
    assert.equal(response.status, 200);
    assert.equal(health.executor_shard_id, "executor-02");
    assert.equal(health.health_scope, "SHARD_INFRASTRUCTURE");
    assert.equal(health.account_permission, "NOT_ASSIGNED");
    assert.equal(health.egress_ipv4_verified, true);
    assert.equal(health.trading_enabled, false);
    const request_id = randomUUID();
    const sample = await (await post(running.url, "/v1/capacity", { request_id, executor_shard_id: "executor-02" }, `CAPACITY:${request_id}`)).json();
    assert.equal(sample.account_count, 0); assert.equal(sample.engine_count, 0);
    assert.deepEqual(sample.engine_ids, []); assert.deepEqual(sample.account_ids, []);
    assert.equal(sample.binance_weight_current, 2);
    assert.equal(sample.binance_weight_samples, 1);
    assert.ok(calls.every((call) => call.method === "GET"));
    assert.ok(calls.every((call) => !call.url.includes("account") && !call.url.includes("order")));
  } finally { await running.close(); await rm(running.stateDirectory, { recursive: true, force: true }); }
});

test("idle sample is measured once per minute, concurrent probes dedupe and missing headers stay unknown", async () => {
  let at = NOW, calls = 0;
  const telemetry = createCapacityTelemetry({ now: () => at, fetcher: async () => {
    calls++; return Response.json({ serverTime: at }, { headers: { "x-mbx-used-weight-1m": String(calls * 2) } });
  } });
  await Promise.all(Array.from({ length: 8 }, () => telemetry.sampleIfIdle()));
  assert.equal(calls, 1);
  at += 59_999; await telemetry.sampleIfIdle(); assert.equal(calls, 1);
  at++; await telemetry.sampleIfIdle(); assert.equal(calls, 2);
  assert.equal(telemetry.snapshot().binance_weight_samples, 2);
  const noHeader = createCapacityTelemetry({ now: () => at, fetcher: async () => Response.json({ serverTime: at }) });
  await noHeader.sampleIfIdle(); assert.equal(noHeader.snapshot().binance_weight_current, null);
});

test("corrupt or wrong-shard dynamic account never removes a healthy sibling", () => {
  const rows = [ACCOUNT_A, ACCOUNT_B].map((id, index) => ({ ...engineFixture("SOLBRL", id, index + 1, false),
    executor_shard_id: index ? "executor-02" : "executor-03", is_legacy_default: false,
    credential_ref: `account_${id.replaceAll("-", "")}` }));
  const dynamic = { version: 1, executor_shard_id: "executor-02", engines: rows,
    credentials: Object.fromEntries(rows.map((row) => [row.credential_ref, { vault: true }])) };
  const failures = [], merged = mergeDynamicRegistry(emptyRegistry(), dynamic, (code) => failures.push(code));
  assert.equal(merged.engines.length, 1);
  assert.equal(merged.engines[0].exchange_account_id, ACCOUNT_B);
  assert.deepEqual(failures, ["EXECUTOR_DYNAMIC_ACCOUNT_REJECTED"]);
  assert.deepEqual(mergeDynamicRegistry(emptyRegistry(), { ...dynamic, executor_shard_id: "executor-01" }).engines, []);
});

test("empty shard stages, restarts and promotes only its own engine with persistent shard ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coinops-shard-onboarding-"));
  const scope = { executor_shard_id: "executor-02", operator_id: OPERATOR, exchange_account_id: ACCOUNT_B,
    environment: "REAL", credential_ref: `account_${ACCOUNT_B.replaceAll("-", "")}` };
  const row = { ...engineFixture("SOLBRL", ACCOUNT_B, 7, false), ...scope,
    status: "INACTIVE", execution_allowed: false, kill_switch: true, account_kill_switch: true,
    global_kill_switch: true, is_legacy_default: false, legacy_ownership: false };
  try {
    const staged = await saveInactiveRegistryAccount(emptyRegistry(), directory, scope, [row]);
    assert.equal(staged.registered_engines, 1);
    const reloaded = await loadCombinedRegistry(emptyRegistry(), directory);
    assert.equal(reloaded.executor_shard_id, "executor-02");
    assert.equal(reloaded.engines[0].executor_shard_id, "executor-02");
    assert.equal(reloaded.engines[0].status, "INACTIVE");
    const promotion = { ...scope, trading_engine_id: row.trading_engine_id, symbol: row.symbol,
      hard_cap_quote: row.hard_cap_quote, account_cap_quote: row.account_cap_quote, max_order_quote: row.max_order_quote };
    await assert.rejects(promoteRegistryEngine(emptyRegistry(), directory,
      { ...promotion, executor_shard_id: "executor-01" }), /SHARD_SCOPE_DENIED/);
    assert.equal((await promoteRegistryEngine(emptyRegistry(), directory, promotion)).status, "ACTIVE");
    assert.equal((await promoteRegistryEngine(emptyRegistry(), directory, promotion)).replayed, true);
    const active = await loadCombinedRegistry(emptyRegistry(), directory), key = "fixture-new-engine-read";
    const input = { executor_shard_id: "executor-02", operator_id: OPERATOR, exchange_account_id: ACCOUNT_B,
      trading_engine_id: row.trading_engine_id, environment: "REAL", symbol: "SOLBRL", quote_asset: "BRL",
      decision_id: key, idempotency_key: key };
    assert.equal(resolveExecutorContext(active, input, key, {}, { path: "/v1/state" }).vault, true);
    assert.throws(() => resolveExecutorContext(active, { ...input, executor_shard_id: "executor-01" },
      key, {}, { path: "/v1/state" }), /SHARD_SCOPE_DENIED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("adding shard transport metadata preserves old financial claims across restart and uncertain recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coinops-shard-claim-"));
  try {
    for (const legacy of [false, true]) {
      const engine = engineFixture("SOLBRL", legacy ? ACCOUNT_A : ACCOUNT_B, 11, legacy);
      const input = { symbol: "SOLBRL", side: "BUY", quantity: "0.02", price: "601.5" };
      const key = `fixture-claim-${legacy}`, claim = durableIntent(engine, input, key, sha256(JSON.stringify(input)));
      const routed = { ...input, executor_shard_id: "executor-01" };
      const nextClaim = durableIntent(engine, routed, key, sha256(JSON.stringify(routed)));
      assert.deepEqual(nextClaim, claim);
      let writes = 0;
      await assert.rejects(withWriteIdempotency({ directory, ...claim,
        recover: async () => null, execute: async () => { writes++; throw new Error("LOST_ACK"); } }), /LOST_ACK/);
      const recovered = await withWriteIdempotency({ directory, ...nextClaim,
        recover: async () => ({ orderId: 123 }), execute: async () => { writes++; } });
      assert.equal(recovered.replayed, true); assert.equal(writes, 1);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Testnet forwarding needs own-shard signature and locally bound account credential", async () => {
  const calls = [], running = await serve({ fetcher: async (url, init) => {
    calls.push({ url, method: init?.method });
    if (url.endsWith("/time")) return Response.json({ serverTime: NOW });
    if (url.includes("/account?")) return Response.json({ canTrade: true, balances: [] });
    throw new Error("UNEXPECTED_TESTNET_URL");
  } });
  try {
    const scope = { operator_id: OPERATOR, exchange_account_id: ACCOUNT_B,
      credential_ref: `account_${ACCOUNT_B.replaceAll("-", "")}`, environment: "TESTNET" };
    await saveCredential({ directory: join(running.stateDirectory, "credentials"), masterSecret: SECRET,
      scope, apiKey: "A".repeat(64), apiSecret: "B".repeat(64), observation: {
        status: "PASS", uidHash: "fixture-account", validatedAt: new Date(NOW).toISOString() } });
    const payload = { ...scope, executor_shard_id: "executor-02", request_id: randomUUID(),
      trading_engine_id: "10000000-0000-4000-8000-000000000007", symbol: "SOLUSDT",
      method: "GET", path: "/api/v3/account", params: {} };
    const valid = await post(running.url, "/v1/testnet/transport", payload, `TESTNET:${payload.request_id}`);
    assert.equal(valid.status, 200); assert.equal((await valid.json()).executor_shard_id, "executor-02");
    assert.equal(calls.length, 2);
    const other = { ...payload, exchange_account_id: ACCOUNT_A, credential_ref: `account_${ACCOUNT_A.replaceAll("-", "")}` };
    const denied = await post(running.url, "/v1/testnet/transport", other, `TESTNET:${other.request_id}`);
    assert.equal(denied.status, 503); assert.equal((await denied.json()).error, "EXECUTOR_BINANCE_CREDENTIALS_MISSING");
    assert.equal(calls.length, 2);
  } finally { await running.close(); await rm(running.stateDirectory, { recursive: true, force: true }); }
});

test("one shard network failure and restart do not invalidate another shard's health or telemetry", async () => {
  const first = await serve({ shardId: "executor-03", registry: { ...emptyRegistry(), executor_shard_id: "executor-03" } });
  const second = await serve({ fetcher: marketFetcher([], () => true) });
  let restarted;
  try {
    assert.equal((await fetch(second.url + "/health")).status, 503);
    assert.equal((await fetch(first.url + "/health")).status, 200);
    await second.close();
    restarted = await serve({ stateDirectory: second.stateDirectory });
    assert.equal((await fetch(restarted.url + "/health")).status, 200);
    assert.equal((await fetch(first.url + "/health")).status, 200);
  } finally {
    await first.close(); if (restarted) await restarted.close(); else await second.close();
    await rm(first.stateDirectory, { recursive: true, force: true });
    await rm(second.stateDirectory, { recursive: true, force: true });
  }
});
