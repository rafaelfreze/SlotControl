import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutorHandler } from "../src/server.mjs";
import { assertNoExchangeOpenOrders, inspectBinanceCredential, loadCredential, saveCredential } from "../src/credential-vault.mjs";
import { requestSignature, sha256 } from "../src/security.mjs";
import { loadCombinedRegistry, resolveExecutorContext, saveInactiveRegistryAccount, validateExecutorRegistry } from "../src/account-registry.mjs";
import { ACCOUNT_A, engineFixture, registryFixture, credentialEnvironment, intentContext } from "./registry-fixture.mjs";

const masterSecret = "fictional-HMAC-secret-for-vault-unit-tests-1234";
const now = Date.parse("2026-09-24T18:00:00Z");
const apiKey = "A".repeat(64), apiSecret = "B".repeat(64);
const operator_id = randomUUID(), exchange_account_id = randomUUID();
const scope = { operator_id, exchange_account_id, credential_ref: `account_${exchange_account_id.replaceAll("-", "")}`,
  environment: "REAL" };
const restrictions = { ipRestrict: true, enableReading: true, enableSpotAndMarginTrading: true,
  enableWithdrawals: false, enableInternalTransfer: false, permitsUniversalTransfer: false,
  enableMargin: false, enableFutures: false, enableVanillaOptions: false, enableFixApiTrade: false,
  enablePortfolioMarginTrading: false };
function binanceFixture(overrides = {}, orders = []) {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? "GET" });
    const path = new URL(url).pathname;
    const value = path === "/api/v3/time" ? { serverTime: now }
      : path === "/api/v3/account" ? { canTrade: true, balances: [{ asset: "USDT", free: "403.49", locked: "0" }] }
      : path === "/sapi/v1/account/apiRestrictions" ? { ...restrictions, ...overrides }
      : path === "/api/v3/openOrders" ? orders
      : path === "/" ? { ip: "203.0.113.10" } : null;
    return { ok: value !== null, json: async () => value };
  };
  return { fetcher, calls };
}

test("credential validation is GET-only and fails closed on unknown or dangerous grants", async () => {
  const fixture = binanceFixture();
  const safe = await inspectBinanceCredential({ apiKey, apiSecret, environment: "REAL",
    expectedEgressIp: "203.0.113.10", fetcher: fixture.fetcher, now: () => now });
  assert.equal(safe.status, "PASS");
  assert.equal(safe.permission.withdrawals, false);
  assert.ok(fixture.calls.every((call) => call.method === "GET"));
  assert.ok(!JSON.stringify(safe).includes(apiKey)); assert.ok(!JSON.stringify(safe).includes(apiSecret));
  for (const changed of [{ enableWithdrawals: true }, { enableInternalTransfer: true },
    { enablePortfolioMarginTrading: true }, { enableMargin: undefined }]) {
    const unsafe = await inspectBinanceCredential({ apiKey, apiSecret, environment: "REAL",
      expectedEgressIp: "203.0.113.10", fetcher: binanceFixture(changed).fetcher, now: () => now });
    assert.equal(unsafe.status, "WARNING");
  }
  await assert.rejects(inspectBinanceCredential({ apiKey: "invalid", apiSecret,
    environment: "REAL", expectedEgressIp: "203.0.113.10", fetcher: fixture.fetcher }), /FORMAT_INVALID/);
});

test("new inactive account is isolated from Rafael and cannot authorize an order", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "coinops-registry-test-"));
  const staticRegistry = validateExecutorRegistry(registryFixture([engineFixture("BTCBRL", ACCOUNT_A, 1, true)]));
  const row = { ...engineFixture("BTCUSDT", exchange_account_id, 9, false), operator_id,
    credential_ref: scope.credential_ref, status: "INACTIVE", execution_allowed: false,
    kill_switch: true, account_kill_switch: true, global_kill_switch: true,
    is_legacy_default: false, legacy_ownership: false,
    hard_cap_quote: 200, account_cap_quote: 400, max_order_quote: 8 };
  try {
    await saveInactiveRegistryAccount(staticRegistry, stateDirectory, scope, [row]);
    const combined = await loadCombinedRegistry(staticRegistry, stateDirectory);
    assert.equal(combined.engines.length, 2);
    assert.equal(resolveExecutorContext(combined, intentContext(staticRegistry.engines[0]),
      "fixture-read-key-1", credentialEnvironment).apiKey, "fictional-key-A");
    assert.throws(() => resolveExecutorContext(combined, intentContext(row),
      "fixture-read-key-1", credentialEnvironment), /ENGINE_INACTIVE/);
    await assert.rejects(saveInactiveRegistryAccount(staticRegistry, stateDirectory,
      { ...scope, operator_id: randomUUID() }, [row]), /REGISTRY_SYNC_DENIED/);
    await assert.rejects(saveInactiveRegistryAccount(staticRegistry, stateDirectory,
      scope, [{ ...row, execution_allowed: true }]), /REGISTRY_SYNC_DENIED/);
    await writeFile(join(stateDirectory, "dynamic-registry.json"), "{invalid", { mode: 0o600 });
    const errors = [];
    const isolated = await loadCombinedRegistry(staticRegistry, stateDirectory, (error) => errors.push(error));
    assert.equal(isolated.engines.length, 1);
    assert.equal(errors.length, 1);
    assert.equal(resolveExecutorContext(isolated, intentContext(staticRegistry.engines[0]),
      "fixture-read-key-1", credentialEnvironment).apiKey, "fictional-key-A");
  } finally { await rm(stateDirectory, { recursive: true, force: true }); }
});

test("signed admin route encrypts at rest, binds operator/account, rejects replay and never logs secrets", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "coinops-vault-test-"));
  const fixture = binanceFixture(), logs = [];
  const server = createServer(createExecutorHandler({ secret: masterSecret, stateDirectory,
    expectedEgressIp: "203.0.113.10", registry: { credentials: {} },
    fetcher: fixture.fetcher, now: () => now, logger: (entry) => logs.push(entry) }));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/admin/credentials`;
  const requestId = randomUUID(), key = `CREDENTIAL:${requestId}`;
  const input = { ...scope, request_id: requestId, operation: "CONNECT", apiKey, apiSecret };
  const body = JSON.stringify(input), nonce = randomUUID().replaceAll("-", "");
  const headers = { "content-type": "application/json", "x-coinops-timestamp": String(now),
    "x-coinops-nonce": nonce, "x-coinops-body-sha256": sha256(body),
    "x-coinops-signature": requestSignature(masterSecret, "POST", "/v1/admin/credentials", now, nonce, body),
    "x-coinops-idempotency-key": key };
  try {
    const first = await fetch(endpoint, { method: "POST", headers, body });
    assert.equal(first.status, 200);
    const result = await first.text();
    assert.ok(!result.includes(apiKey)); assert.ok(!result.includes(apiSecret));
    const stored = await readFile(join(stateDirectory, "credentials", `${exchange_account_id}.json`), "utf8");
    assert.ok(!stored.includes(apiKey)); assert.ok(!stored.includes(apiSecret));
    const decrypted = await loadCredential(join(stateDirectory, "credentials"), masterSecret, scope);
    assert.deepEqual(decrypted, { apiKey, apiSecret });
    await assert.rejects(assertNoExchangeOpenOrders({ directory: join(stateDirectory, "credentials"),
      masterSecret, scope, fetcher: binanceFixture({}, [{ symbol: "BTCUSDT" }]).fetcher, now: () => now }),
    /OPEN_ORDERS_PRESENT/);
    const secondAccount = randomUUID();
    await assert.rejects(saveCredential({ directory: join(stateDirectory, "credentials"), masterSecret,
      scope: { ...scope, exchange_account_id: secondAccount,
        credential_ref: `account_${secondAccount.replaceAll("-", "")}` },
      apiKey, apiSecret, observation: { status: "PASS", uidHash: null, validatedAt: new Date(now).toISOString() } }),
    /ALREADY_BOUND/);
    await assert.rejects(saveCredential({ directory: join(stateDirectory, "credentials"), masterSecret,
      scope, apiKey: "C".repeat(64), apiSecret: "D".repeat(64), replace: true,
      observation: { status: "PASS", uidHash: null, validatedAt: new Date(now).toISOString() } }),
    /ACCOUNT_IDENTITY_MISMATCH/);
    assert.equal((await fetch(endpoint, { method: "POST", headers, body })).status, 409);
    assert.equal(fixture.calls.filter((call) => call.url.includes("binance.com")).length, 3);
    assert.ok(!JSON.stringify(logs).includes(apiKey)); assert.ok(!JSON.stringify(logs).includes(apiSecret));
    await assert.rejects(loadCredential(join(stateDirectory, "credentials"), masterSecret,
      { ...scope, operator_id: randomUUID() }), /(?:SCOPE_INVALID|CREDENTIALS_MISSING)/);
  } finally {
    await new Promise((done) => server.close(done));
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
