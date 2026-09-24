import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateExecutorRegistry, resolveExecutorContext, assertEngineOrder, engineOrderPrefix,
  durableIntent } from "../src/account-registry.mjs";
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
  const stateDirectory = await mkdtemp(join(tmpdir(), "coinops-account-http-"));
  const fetcher = async (url, init = {}) => {
    const parsed = new URL(url), key = init.headers?.["X-MBX-APIKEY"];
    calls.push({ path: parsed.pathname, method: init.method, key });
    const symbol = parsed.searchParams.get("symbol") ?? "BTCBRL";
    if (parsed.pathname === "/api/v3/time") return Response.json({ serverTime: NOW });
    if (parsed.pathname === "/sapi/v1/account/apiRestrictions") return Response.json({ ipRestrict: !(rejectAccountA && key === "fictional-key-A"), enableReading: true,
      enableSpotAndMarginTrading: true, enableWithdrawals: false, enableInternalTransfer: false, permitsUniversalTransfer: false,
      enableMargin: false, enableFutures: false, enableVanillaOptions: false, enablePortfolioMarginTrading: false, enableFixApiTrade: false });
    if (parsed.pathname === "/api/v3/account") return Response.json({ canTrade: true, balances: [{ asset: "BRL", free: key === "fictional-key-A" ? "725" : "123", locked: "0" },
      { asset: "USDT", free: key === "fictional-key-A" ? "111" : "222", locked: "0" }] });
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
  const pinnedRegistry = { ...registry, legacy_account_id: ACCOUNT_A };
  const server = createServer(createExecutorHandler({ secret: SECRET, stateDirectory, registry: pinnedRegistry, credentialEnvironment,
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
        (engine.exchange_account_id === ACCOUNT_A ? "fictional-key-A" : "fictional-key-B")));
    }
    const before = calls.length;
    assert.equal((await send({ ...intentContext(engines[0]), exchange_account_id: ACCOUNT_B })).status, 403);
    assert.equal(calls.length, before);
    const wrongOwned = { ...intentContext(engines[4]), clientOrderId: "COR1-BTC-1-1-BUY-0123456789abcd" };
    assert.equal((await send(wrongOwned, "/v1/query-order")).status, 403);
    assert.equal(calls.length, before);
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
  const strict = createServer(createExecutorHandler({ secret: SECRET, stateDirectory, registry: pinnedRegistry, credentialEnvironment,
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
