import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateExecutorRegistry, resolveExecutorContext, assertEngineOrder, engineOrderPrefix,
  durableIntent, saveInactiveRegistryAccount, promotePreparedRegistryAccount, promoteRegistryEngine,
  changeRegistryCapital,
  loadCombinedRegistry, mergeDynamicRegistry, canReadDynamicRegistry } from "../src/account-registry.mjs";
import { sha256, requestSignature, withWriteIdempotency } from "../src/security.mjs";
import { createExecutorHandler } from "../src/server.mjs";
import { liveClientOrderId } from "../../web/lib/execution/robot-v1-live-cycle.ts";
import { buildExecutorDryRun } from "../src/preparation.mjs";
import { STRATEGY_VERSION } from "../../web/lib/execution/strategy-engine.ts";
import { ACCOUNT_A, ACCOUNT_B, engineFixture, registryFixture, credentialEnvironment, intentContext } from "./registry-fixture.mjs";

const markets = ["BTCBRL", "SOLBRL", "BTCUSDT", "SOLUSDT"];
const engines = [ACCOUNT_A, ACCOUNT_B].flatMap((account, accountIndex) => markets.map((symbol, i) =>
  engineFixture(symbol, account, accountIndex * 10 + i + 1, account === ACCOUNT_A && symbol.endsWith("BRL"))));
const registry = validateExecutorRegistry(registryFixture(engines));
const NOW = Date.parse("2026-09-24T10:00:00Z"), SECRET = "fictional-test-HMAC-secret-never-production";

test("promoted registry is readable only by root or its dedicated read-only group", () => {
  const promoted = { uid: 0, gid: 988, mode: 0o100640 };
  assert.equal(canReadDynamicRegistry(promoted, 999, 988), true);
  assert.equal(canReadDynamicRegistry(promoted, 999, 987), false);
  assert.equal(canReadDynamicRegistry(promoted, 0, 0), true);
  assert.equal(canReadDynamicRegistry({ ...promoted, mode: 0o100660 }, 999, 988), false);
  assert.equal(canReadDynamicRegistry({ ...promoted, mode: 0o100644 }, 999, 988), false);
  assert.equal(canReadDynamicRegistry({ uid: 999, gid: 988, mode: 0o100600 }, 999, 988), true);
});

test("A/B and four native markets resolve exact credentials, never fallback", () => {
  for (const engine of engines) {
    const resolved = resolveExecutorContext(registry, intentContext(engine), "fixture-read-key-1", credentialEnvironment);
    assert.equal(resolved.engine.symbol, engine.symbol);
    assert.equal(resolved.apiKey, engine.exchange_account_id === ACCOUNT_A ? "fictional-key-A" : "fictional-key-B");
    const another = engines.find((row) => row.exchange_account_id !== engine.exchange_account_id && row.symbol === engine.symbol);
    assert.throws(() => resolveExecutorContext(registry, { ...intentContext(engine), exchange_account_id: another.exchange_account_id },
      "fixture-read-key-1", credentialEnvironment), /SCOPE_DENIED/);
    assert.throws(() => resolveExecutorContext(registry, { ...intentContext(engine), symbol: "ETHBRL" },
      "fixture-read-key-1", credentialEnvironment), /SCOPE_DENIED/);
    assert.throws(() => resolveExecutorContext(registry, { ...intentContext(engine), credential_ref: another.credential_ref },
      "fixture-read-key-1", credentialEnvironment), /CREDENTIAL_INPUT_DENIED/);
  }
  assert.throws(() => resolveExecutorContext(registry, intentContext(engines[4]), "fixture-read-key-1",
    { FIXTURE_A_KEY: "fallback-not-allowed", FIXTURE_A_SECRET: "fallback-not-allowed" }), /CREDENTIALS_MISSING/);
  assert.throws(() => resolveExecutorContext(registry, { symbol: "BTCBRL" }, "fixture-read-key-1", credentialEnvironment), /CONTEXT_REQUIRED/);
  assert.throws(() => resolveExecutorContext(registry, intentContext(engines[0]), "different-key", credentialEnvironment), /CONTEXT_REQUIRED/);
  const unsafe = structuredClone(registry);
  unsafe.engines[4].credential_ref = "legacy-binance-production";
  assert.throws(() => validateExecutorRegistry(unsafe), /CREDENTIAL_ACCOUNT_MISMATCH/);
});

test("invalid dynamic accounts stay isolated at 10/30/50/100-account scale", async () => {
  const staticRegistry = validateExecutorRegistry(registryFixture(engines.slice(0, 2)));
  const dynamic = { version: 1, engines: [], credentials: {} };
  for (let index = 1; index <= 100; index++) {
    const accountId = `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`;
    const credentialRef = `account_${accountId.replaceAll("-", "")}`;
    dynamic.credentials[credentialRef] = { vault: true };
    for (const [offset, symbol] of ["BTCUSDT", "SOLUSDT"].entries()) {
      dynamic.engines.push({ ...engineFixture(symbol, accountId, 1000 + index * 2 + offset, false),
        credential_ref: credentialRef, is_legacy_default: false, legacy_ownership: false,
        hard_cap_quote: 419, account_cap_quote: 838, max_order_quote: 419 });
    }
  }
  const badAccount = dynamic.engines[0].exchange_account_id;
  delete dynamic.credentials[`account_${badAccount.replaceAll("-", "")}`];
  for (const accountCount of [10, 30, 50, 100]) {
    const scoped = { ...dynamic, engines: dynamic.engines.slice(0, accountCount * 2) };
    const failures = [];
    const merged = mergeDynamicRegistry(staticRegistry, scoped, (code) => failures.push(code));
    assert.equal(scoped.engines.length * 25, accountCount * 50);
    assert.equal(merged.engines.length, 2 + (accountCount - 1) * 2);
    assert.equal(merged.engines.filter((row) => row.exchange_account_id === badAccount).length, 0);
    assert.deepEqual(failures, ["EXECUTOR_DYNAMIC_ACCOUNT_REJECTED"]);
    const healthy = merged.engines.at(-1);
    assert.equal(resolveExecutorContext(merged, intentContext(healthy), "fixture-read-key-1",
      {}, { path: "/v1/state" }).engine.trading_engine_id, healthy.trading_engine_id);
  }
  const fiveBroken = structuredClone(dynamic);
  const brokenAccounts = new Set(fiveBroken.engines.slice(0, 10).map((row) => row.exchange_account_id));
  for (const accountId of brokenAccounts)
    delete fiveBroken.credentials[`account_${accountId.replaceAll("-", "")}`];
  const fiveFailures = [];
  const withFiveBroken = mergeDynamicRegistry(staticRegistry, fiveBroken,
    (code) => fiveFailures.push(code));
  assert.equal(brokenAccounts.size, 5);
  assert.equal(fiveFailures.length, 5);
  assert.equal(withFiveBroken.engines.length, 2 + 95 * 2);
  assert.equal(withFiveBroken.engines.filter((row) => brokenAccounts.has(row.exchange_account_id)).length, 0);
  assert.equal(withFiveBroken.engines.at(-1).trading_engine_id, dynamic.engines.at(-1).trading_engine_id);
  const directory = await mkdtemp(join(tmpdir(), "coinops-scale-registry-"));
  try {
    await writeFile(join(directory, "dynamic-registry.json"), JSON.stringify(dynamic), { mode: 0o600 });
    const loaded = await loadCombinedRegistry(staticRegistry, directory);
    assert.equal(loaded.engines.length, 200);
    assert.equal(loaded.engines.some((row) => row.exchange_account_id === badAccount), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inactive killed account permits only preparation reads", () => {
  const inactive = structuredClone(registry);
  const row = inactive.engines[4];
  Object.assign(row, { status: "INACTIVE", execution_allowed: false,
    kill_switch: true, account_kill_switch: true, global_kill_switch: true });
  for (const path of ["/v1/health", "/v1/state", "/v1/dry-run"])
    assert.equal(resolveExecutorContext(inactive, intentContext(row), "fixture-read-key-1",
      credentialEnvironment, { path }).engine.trading_engine_id, row.trading_engine_id);
  for (const path of ["/v1/create-order", "/v1/cancel-order", "/v1/query-order", "/v1/trades"])
    assert.throws(() => resolveExecutorContext(inactive, intentContext(row), "fixture-read-key-1",
      credentialEnvironment, { path }), /ENGINE_INACTIVE/);
  row.kill_switch = false;
  assert.throws(() => resolveExecutorContext(inactive, intentContext(row), "fixture-read-key-1",
    credentialEnvironment, { path: "/v1/state" }), /ENGINE_INACTIVE/);
});

test("root promotion releases only the exact staged Thyely pair and is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coinops-thyely-promotion-"));
  const staticRegistry = validateExecutorRegistry(registryFixture([engines[0]]));
  const accountId = ACCOUNT_B, scope = { operator_id: engines[4].operator_id,
    exchange_account_id: accountId, credential_ref: `account_${accountId.replaceAll("-", "")}` };
  const staged = ["BTCUSDT", "SOLUSDT"].map((symbol, index) => ({
    ...engineFixture(symbol, accountId, 20 + index, false),
    credential_ref: scope.credential_ref, status: "INACTIVE", execution_allowed: false,
    kill_switch: true, account_kill_switch: true, global_kill_switch: true,
    hard_cap_quote: 419, account_cap_quote: 838, max_order_quote: 419,
  }));
  const expected = staged.map((row) => ({ trading_engine_id: row.trading_engine_id,
    symbol: row.symbol, hard_cap_quote: 419, max_order_quote: 419 }));
  try {
    await saveInactiveRegistryAccount(staticRegistry, directory, scope, staged);
    await assert.rejects(promotePreparedRegistryAccount(staticRegistry, directory, scope,
      [{ ...expected[0], hard_cap_quote: 420 }, expected[1]]), /PROMOTION_DENIED/);
    const promoted = await promotePreparedRegistryAccount(staticRegistry, directory, scope, expected);
    assert.deepEqual(promoted, { status: "ACTIVE", promoted_engines: 2, replayed: false });
    assert.deepEqual(await promotePreparedRegistryAccount(staticRegistry, directory, scope, expected),
      { status: "ACTIVE", promoted_engines: 2, replayed: true });
    const combined = await loadCombinedRegistry(staticRegistry, directory);
    assert.equal(combined.engines.find((row) => row.symbol === "BTCBRL").status, "ACTIVE");
    assert.equal(combined.engines.filter((row) => row.exchange_account_id === accountId
      && row.status === "ACTIVE" && row.execution_allowed && !row.kill_switch).length, 2);
    await assert.rejects(saveInactiveRegistryAccount(staticRegistry, directory, scope, staged), /SYNC_DENIED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("panel promotion activates only the selected staged engine and preserves siblings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coinops-panel-promotion-"));
  const staticRegistry = validateExecutorRegistry(registryFixture([engines[0]]));
  const accountId = ACCOUNT_B, scope = { operator_id: engines[4].operator_id,
    exchange_account_id: accountId, credential_ref: `account_${accountId.replaceAll("-", "")}`,
    environment: "REAL" };
  const staged = ["BTCBRL", "SOLBRL"].map((symbol, index) => ({
    ...engineFixture(symbol, accountId, 30 + index, false), credential_ref: scope.credential_ref,
    status: "INACTIVE", execution_allowed: false, kill_switch: true,
    account_kill_switch: true, global_kill_switch: true,
    hard_cap_quote: index === 0 ? 450 : 275, account_cap_quote: 725,
    max_order_quote: index === 0 ? 450 : 275,
  }));
  try {
    await saveInactiveRegistryAccount(staticRegistry, directory, scope, staged);
    const first = staged[0], second = staged[1];
    await assert.rejects(promoteRegistryEngine(staticRegistry, directory,
      { ...scope, ...first, hard_cap_quote: 451 }), /PROMOTION_DENIED/);
    const activated = await promoteRegistryEngine(staticRegistry, directory, { ...scope, ...first });
    assert.equal(activated.status, "ACTIVE"); assert.equal(activated.replayed, false);
    assert.equal((await promoteRegistryEngine(staticRegistry, directory, { ...scope, ...first })).replayed, true);
    const midpoint = await loadCombinedRegistry(staticRegistry, directory);
    assert.equal(midpoint.engines.find((row) => row.trading_engine_id === first.trading_engine_id).status, "ACTIVE");
    assert.equal(midpoint.engines.find((row) => row.trading_engine_id === second.trading_engine_id).status, "INACTIVE");
    await promoteRegistryEngine(staticRegistry, directory, { ...scope, ...second });
    const complete = await loadCombinedRegistry(staticRegistry, directory);
    assert.equal(complete.engines.filter((row) => row.exchange_account_id === accountId && row.status === "ACTIVE").length, 2);
    assert.equal(complete.engines.find((row) => row.trading_engine_id === engines[0].trading_engine_id).status, "ACTIVE");
    const over = structuredClone(complete); over.engines.find((row) => row.trading_engine_id === second.trading_engine_id).hard_cap_quote = 276;
    assert.throws(() => validateExecutorRegistry(over), /ACCOUNT_CAP_EXCEEDED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native-quote capital update is exact, replayable and cannot alter Rafael or a sibling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coinops-cap-change-"));
  const accountId = randomUUID(), operatorId = randomUUID();
  const scope = { operator_id: operatorId, exchange_account_id: accountId,
    credential_ref: `account_${accountId.replaceAll("-", "")}`, environment: "REAL" };
  const staticRegistry = registryFixture(engines.filter((row) => row.exchange_account_id === ACCOUNT_A));
  const staged = ["BTCUSDT", "SOLUSDT"].map((symbol, index) => ({
    ...engineFixture(symbol, accountId, index + 20), ...scope, status: "INACTIVE",
    account_cap_quote: 838, hard_cap_quote: 419, max_order_quote: 419,
    execution_allowed: false, kill_switch: true, account_kill_switch: true,
    global_kill_switch: true, is_legacy_default: false, legacy_ownership: false,
  }));
  try {
    await saveInactiveRegistryAccount(staticRegistry, directory, scope, staged);
    for (const row of staged) await promoteRegistryEngine(staticRegistry, directory, { ...scope, ...row });
    const request = { ...scope, quote_asset: "USDT", expected_account_cap_quote: 838,
      target_account_cap_quote: 1038,
      engines: staged.map((row) => ({ trading_engine_id: row.trading_engine_id, symbol: row.symbol,
        expected_hard_cap_quote: 419, target_hard_cap_quote: 519 })) };
    await assert.rejects(changeRegistryCapital(staticRegistry, directory,
      { ...request, engines: request.engines.map((row) => ({ ...row, target_hard_cap_quote: 620 })) }), /CAP_CHANGE_STALE/);
    assert.equal((await changeRegistryCapital(staticRegistry, directory, request)).replayed, false);
    assert.equal((await changeRegistryCapital(staticRegistry, directory, request)).replayed, true);
    const after = await loadCombinedRegistry(staticRegistry, directory);
    assert.equal(after.engines.filter((row) => row.exchange_account_id === accountId)
      .reduce((sum, row) => sum + row.hard_cap_quote, 0), 1038);
    assert.equal(after.engines.find((row) => row.trading_engine_id === engines[0].trading_engine_id).hard_cap_quote,
      engines[0].hard_cap_quote);
    await assert.rejects(changeRegistryCapital(staticRegistry, directory,
      { ...request, exchange_account_id: ACCOUNT_A }), /CAP_CHANGE_DENIED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rolling upgrade bridge is explicit, Rafael-pinned and never repairs a partial/tampered context", () => {
  const pinned = validateExecutorRegistry({ ...registry, legacy_account_id: ACCOUNT_A });
  const options = { allowLegacy: true, path: "/v1/state" };
  const old = resolveExecutorContext(pinned, { symbol: "BTCBRL" }, "legacy-read-key", credentialEnvironment, options);
  assert.equal(old.engine.exchange_account_id, ACCOUNT_A); assert.equal(old.legacyClient, true);
  assert.equal(old.input.trading_engine_id, engines[0].trading_engine_id);
  assert.throws(() => resolveExecutorContext(pinned, { symbol: "BTCBRL" }, "legacy-read-key", credentialEnvironment), /CONTEXT_REQUIRED/);
  assert.throws(() => resolveExecutorContext(registry, { symbol: "BTCBRL" }, "legacy-read-key", credentialEnvironment, options), /LEGACY_SCOPE_DENIED/);
  for (const patch of [{ exchange_account_id: ACCOUNT_B }, { trading_engine_id: engines[4].trading_engine_id },
    { operator_id: engines[0].operator_id }, { quote_asset: "BRL" }, { idempotency_key: "legacy-read-key" }])
    assert.throws(() => resolveExecutorContext(pinned, { symbol: "BTCBRL", ...patch }, "legacy-read-key", credentialEnvironment, options), /CONTEXT_REQUIRED/);
  assert.throws(() => resolveExecutorContext(pinned, { symbol: "BTCUSDT" }, "legacy-read-key", credentialEnvironment, options), /LEGACY_SCOPE_DENIED/);
  const reconciliation = resolveExecutorContext(pinned, { scope: "COINOPS_SHADOW_READ_ONLY" }, "legacy-read-key", credentialEnvironment,
    { allowLegacy: true, path: "/v1/reconciliation" });
  assert.equal(reconciliation.engine.exchange_account_id, ACCOUNT_A);
  assert.equal(reconciliation.engine.symbol, "BTCBRL");
});

test("client IDs preserve Rafael COR1 and isolate account/engine/market/operation", () => {
  const run = "20000000-0000-4000-8000-000000000001";
  const ids = new Set();
  for (const engine of engines) {
    const context = { ...engine, legacy_compatible: engine.legacy_ownership };
    const id = liveClientOrderId(run, engine.base_asset, 1, 2, "BUY", 1, context);
    assert.ok(id.length <= 36);
    assert.ok(id.startsWith(engineOrderPrefix(engine)));
    assert.equal(assertEngineOrder(engine, engine.symbol, id, "BUY").slot, "1");
    if (engine.legacy_ownership) assert.equal(id, liveClientOrderId(run, engine.base_asset, 1, 2, "BUY", 1));
    assert.notEqual(id, liveClientOrderId(run, engine.base_asset, 1, 3, "BUY", 1, context));
    for (const other of engines.filter((row) => row.trading_engine_id !== engine.trading_engine_id))
      assert.throws(() => assertEngineOrder(other, other.symbol, id, "BUY"), /ORDER_NOT_OWNED/);
    assert.throws(() => assertEngineOrder(engine, engine.symbol, id, "SELL"), /ORDER_NOT_OWNED/);
    assert.ok(!ids.has(id)); ids.add(id);
  }
});

test("dry-runs for A/B four markets use native quote and exactly the configured shared strategy", () => {
  for (const engine of engines) {
    const price = engine.base_asset === "BTC" ? 430000 : 500;
    const raw = { symbol: engine.symbol, baseAsset: engine.base_asset, quoteAsset: engine.quote_asset,
      status: "TRADING", baseAssetPrecision: 8, quoteAssetPrecision: 8, quoteOrderQtyMarketAllowed: true,
      orderTypes: ["MARKET", "LIMIT"], filters: [
        { filterType: "PRICE_FILTER", minPrice: ".01", maxPrice: "10000000", tickSize: ".01" },
        { filterType: "LOT_SIZE", minQty: ".00000001", maxQty: "100000", stepSize: ".00000001" },
        { filterType: "MARKET_LOT_SIZE", minQty: "0", maxQty: "100000", stepSize: "0" },
        { filterType: "NOTIONAL", minNotional: "5", maxNotional: "1000000", applyMinToMarket: true },
      ] };
    const gain = .017, spacing = .013;
    const input = { ...intentContext(engine), action: "DRY_RUN", asset: engine.base_asset,
      strategy_version: STRATEGY_VERSION, portfolio_caps_brl: { BTC: 450, SOL: 275 }, global_cap_brl: 725,
      config: { asset: engine.base_asset, symbol: engine.symbol, quote_asset: engine.quote_asset, slot_count: 25,
        gain_rate: gain, normal_spacing_rate: spacing, post_ath_spacing_rate: .08, regime: "NORMAL",
        monthly_target: engine.base_asset === "BTC" ? 7 : 2, configured_live_capital_brl: engine.hard_cap_quote,
        max_order_notional_brl: engine.max_order_quote, max_total_exposure_brl: engine.hard_cap_quote,
        config_version: 3, live_enabled: false, updated_at: new Date(NOW).toISOString() } };
    const result = buildExecutorDryRun(input, { raw, priceBrl: price, observedAt: new Date(NOW).toISOString() }, NOW, engine);
    assert.equal(result.quote_asset, engine.quote_asset); assert.equal(result.symbol, engine.symbol);
    assert.equal(result.valid_slots, 25); assert.equal(result.status, "NO_WRITE");
    assert.equal(result.initial.action_type, "OPEN_INITIAL_MARKET");
    assert.equal(result.trading_enabled, false); assert.equal(result.kill_switch, true);
    assert.equal(result.caps.account_quote, 725);
    assert.ok(JSON.stringify(result.take_profit).includes(String(Math.ceil(price * (1 + gain) * 100) / 100)));
    assert.throws(() => buildExecutorDryRun({ ...input, global_cap_brl: 726 },
      { raw, priceBrl: price, observedAt: new Date(NOW).toISOString() }, NOW, engine), /HARD_CAP_DENIED/);
  }
});

test("legacy completed and uncertain claims survive scope migration and restart without redispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coinops-legacy-claims-"));
  const legacy = { symbol: "BTCBRL", clientOrderId: "COR1-BTC-1-1-BUY-0123456789abcd", side: "BUY", quoteOrderQty: "18" };
  const engine = engines[0], key = legacy.clientOrderId, bodyHash = sha256(JSON.stringify(legacy));
  const scoped = { ...legacy, ...intentContext(engine, key) };
  const migrated = durableIntent(engine, scoped, key, sha256(JSON.stringify(scoped)), "CREATE_ORDER");
  assert.deepEqual(migrated, { key, bodyHash });
  let dispatches = 0;
  await assert.rejects(withWriteIdempotency({ directory, key, bodyHash, recover: async () => null,
    execute: async () => { dispatches++; throw Error("LOST_ACK"); } }), /LOST_ACK/);
  await assert.rejects(withWriteIdempotency({ directory, ...migrated, recover: async () => null,
    execute: async () => { dispatches++; } }), /OUTCOME_UNKNOWN/);
  const recovered = await withWriteIdempotency({ directory, ...migrated, recover: async () => ({ orderId: "1" }),
    execute: async () => { dispatches++; } });
  assert.equal(recovered.replayed, true);
  const restarted = await withWriteIdempotency({ directory, ...migrated, recover: async () => null,
    execute: async () => { dispatches++; } });
  assert.deepEqual(restarted, recovered); assert.equal(dispatches, 1);
  assert.notEqual(durableIntent(engines[4], { ...legacy, ...intentContext(engines[4], key) }, key, bodyHash, "CREATE_ORDER").key, key);
});

test("signed executor observes only selected account and rejects cross-account replay before Binance", async () => {
  const calls = [];
  let rejectAccountA = false;
  const legacyKey = "A".repeat(64), legacySecret = "S".repeat(64);
  const legacyCredentialEnvironment = { ...credentialEnvironment,
    FIXTURE_ADMIN_LEGACY_KEY: legacyKey, FIXTURE_ADMIN_LEGACY_SECRET: legacySecret };
  const stateDirectory = await mkdtemp(join(tmpdir(), "coinops-account-http-"));
  const fetcher = async (url, init = {}) => {
    const parsed = new URL(url), key = init.headers?.["X-MBX-APIKEY"];
    calls.push({ path: parsed.pathname, method: init.method, key });
    const symbol = parsed.searchParams.get("symbol") ?? "BTCBRL";
    if (parsed.pathname === "/api/v3/time") return Response.json({ serverTime: NOW });
    if (parsed.pathname === "/sapi/v1/account/apiRestrictions") return Response.json({ ipRestrict: !(rejectAccountA && key === legacyKey), enableReading: true,
      enableSpotAndMarginTrading: true, enableWithdrawals: false, enableInternalTransfer: false, permitsUniversalTransfer: false,
      enableMargin: false, enableFutures: false, enableVanillaOptions: false, enablePortfolioMarginTrading: false, enableFixApiTrade: false });
    if (parsed.pathname === "/api/v3/account") return Response.json({ canTrade: true, balances: [{ asset: "BRL", free: key === legacyKey ? "725" : "123", locked: "0" },
      { asset: "USDT", free: key === legacyKey ? "111" : "222", locked: "0" }] });
    if (parsed.pathname === "/api/v3/exchangeInfo") return Response.json({ symbols: (parsed.searchParams.has("symbols")
      ? JSON.parse(parsed.searchParams.get("symbols")) : [symbol]).map((requested) => ({ symbol: requested,
      status: "TRADING", baseAsset: requested.slice(0, 3), quoteAsset: requested.slice(3),
      filters: [{ filterType: "LOT_SIZE", minQty: ".00001", maxQty: "100", stepSize: ".00001" },
        { filterType: "PRICE_FILTER", tickSize: ".01" }, { filterType: "NOTIONAL", minNotional: "10" }] })) });
    if (parsed.pathname === "/api/v3/ticker/price") return Response.json(parsed.searchParams.has("symbols")
      ? JSON.parse(parsed.searchParams.get("symbols")).map((requested) => ({ symbol: requested, price: "100" })) : { symbol, price: "100" });
    if (parsed.pathname === "/api/v3/openOrders") return Response.json([]);
    if (parsed.pathname === "/api/v3/order") return Response.json({ code: -2013 }, { status: 400 });
    if (parsed.hostname === "api.ipify.org") return Response.json({ ip: "203.0.113.10" });
    throw Error("UNEXPECTED_FAKE_REQUEST");
  };
  const pinnedRegistry = { ...registry, legacy_account_id: ACCOUNT_A,
    credentials: { ...registry.credentials,
      "legacy-binance-production": { api_key_env: "FIXTURE_ADMIN_LEGACY_KEY",
        api_secret_env: "FIXTURE_ADMIN_LEGACY_SECRET" } } };
  const server = createServer(createExecutorHandler({ secret: SECRET, stateDirectory, registry: pinnedRegistry,
    credentialEnvironment: legacyCredentialEnvironment,
    allowLegacyClients: true, legacyVersion: "old-contract-version", version: "new-runtime-version",
    expectedEgressIp: "203.0.113.10", fetcher, now: () => NOW, logger: () => {} }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const send = (input, path = "/v1/state") => {
    const body = JSON.stringify(input), nonce = randomUUID().replaceAll("-", "");
    return fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST", body, headers: {
      "content-type": "application/json", "x-coinops-timestamp": String(NOW), "x-coinops-nonce": nonce,
      "x-coinops-body-sha256": sha256(body), "x-coinops-signature": requestSignature(SECRET, "POST", path, NOW, nonce, body),
      "x-coinops-idempotency-key": input.idempotency_key ?? "legacy-read-key" } });
  };
  try {
    for (const engine of engines) {
      const before = calls.length, response = await send(intentContext(engine));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.exchange_account_id, engine.exchange_account_id); assert.equal(body.symbol, engine.symbol);
      assert.ok(calls.slice(before).filter((call) => call.key).every((call) => call.key ===
        (engine.exchange_account_id === ACCOUNT_A ? legacyKey : "fictional-key-B")));
    }
    const before = calls.length;
    assert.equal((await send({ ...intentContext(engines[0]), exchange_account_id: ACCOUNT_B })).status, 403);
    assert.equal(calls.length, before);
    const snapshotId = randomUUID();
    const legacySnapshot = await send({ operator_id: engines[0].operator_id,
      exchange_account_id: ACCOUNT_A, credential_ref: "legacy-binance-production",
      environment: "REAL", quote_asset: "BRL", symbols: ["BTCBRL"],
      request_id: snapshotId, idempotency_key: `SNAPSHOT:${snapshotId}` }, "/v1/admin/snapshot");
    assert.equal(legacySnapshot.status, 200, await legacySnapshot.clone().text());
    const legacyResult = await legacySnapshot.json();
    assert.equal(legacyResult.exchange_account_id, ACCOUNT_A);
    assert.equal(legacyResult.markets[0].symbol, "BTCBRL");
    assert.ok(!JSON.stringify(legacyResult).includes("fictional-secret"));
    assert.ok(calls.length > before);
    const afterLegitimateSnapshot = calls.length;
    const tampered = await send({ operator_id: engines[0].operator_id,
      exchange_account_id: ACCOUNT_B, credential_ref: "legacy-binance-production",
      environment: "REAL", quote_asset: "BRL", symbols: ["BTCBRL"],
      request_id: randomUUID(), idempotency_key: "SNAPSHOT:another-account" }, "/v1/admin/snapshot");
    assert.equal(tampered.status, 403);
    const wrongOwned = { ...intentContext(engines[4]), clientOrderId: "COR1-BTC-1-1-BUY-0123456789abcd" };
    assert.equal((await send(wrongOwned, "/v1/query-order")).status, 403);
    assert.equal(calls.length, afterLegitimateSnapshot);
    assert.equal((await send({ symbol: "BTCBRL" })).status, 200);
    const publicHealth = await (await fetch(`http://127.0.0.1:${server.address().port}/health`)).json();
    assert.equal(publicHealth.version, "old-contract-version");
    assert.equal(publicHealth.actual_executor_version, "new-runtime-version");
    assert.equal(publicHealth.legacy_contract_version, "old-contract-version");
    assert.equal(publicHealth.legacy_compatibility_enabled, true);
    rejectAccountA = true;
    assert.equal((await send(intentContext(engines[0]), "/v1/health")).status, 503);
    const unaffected = await send(intentContext(engines[4]), "/v1/health");
    assert.equal(unaffected.status, 200);
    assert.equal((await unaffected.json()).version, "new-runtime-version");
    assert.ok(calls.every((call) => call.method === "GET"));
  } finally { await new Promise((resolve) => server.close(resolve)); }
  const strict = createServer(createExecutorHandler({ secret: SECRET, stateDirectory, registry: pinnedRegistry,
    credentialEnvironment: legacyCredentialEnvironment,
    version: "new-runtime-version", expectedEgressIp: "203.0.113.10", fetcher, now: () => NOW, logger: () => {} }));
  await new Promise((resolve) => strict.listen(0, "127.0.0.1", resolve));
  try {
    const body = JSON.stringify({ symbol: "BTCBRL" }), nonce = randomUUID().replaceAll("-", "");
    const base = `http://127.0.0.1:${strict.address().port}`, before = calls.length;
    const retired = await fetch(`${base}/v1/state`, { method: "POST", body, headers: {
      "content-type": "application/json", "x-coinops-timestamp": String(NOW), "x-coinops-nonce": nonce,
      "x-coinops-body-sha256": sha256(body), "x-coinops-signature": requestSignature(SECRET, "POST", "/v1/state", NOW, nonce, body),
      "x-coinops-idempotency-key": "legacy-read-key" } });
    assert.equal(retired.status, 403); assert.equal((await retired.json()).error, "EXECUTOR_CONTEXT_REQUIRED");
    assert.equal(calls.length, before);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.version, "new-runtime-version"); assert.equal(health.actual_executor_version, "new-runtime-version");
    assert.equal(health.legacy_contract_version, null); assert.equal(health.legacy_compatibility_enabled, false);
  } finally { await new Promise((resolve) => strict.close(resolve)); }
});
