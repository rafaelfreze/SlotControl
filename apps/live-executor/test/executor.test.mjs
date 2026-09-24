import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { buildLiveSizing, parseLiveRules } from "../../web/lib/execution/live-preparation.ts";
import { STRATEGY_VERSION } from "../../web/lib/execution/strategy-engine.ts";
import { buildExecutorDryRun, validateDryRunIntent } from "../src/preparation.mjs";
import { createExecutorHandler, startExecutor } from "../src/server.mjs";
import { requestSignature, sha256, verifySignedRequest, withDryRunIdempotency } from "../src/security.mjs";

const SECRET = "test-only-long-hmac-secret-with-entropy-placeholder";
const FIXED_NOW = Date.parse("2026-09-24T01:00:00.000Z");

function raw(asset) {
  return { symbol: `${asset}BRL`, status: "TRADING", baseAsset: asset, quoteAsset: "BRL",
    baseAssetPrecision: 8, quoteAssetPrecision: 8, quoteOrderQtyMarketAllowed: true,
    orderTypes: ["LIMIT", "MARKET"], filters: [
      { filterType: "PRICE_FILTER", minPrice: asset === "BTC" ? "1" : "0.1", maxPrice: "10000000",
        tickSize: asset === "BTC" ? "1" : "0.1" },
      { filterType: "LOT_SIZE", minQty: asset === "BTC" ? "0.00001" : "0.001", maxQty: "9000",
        stepSize: asset === "BTC" ? "0.00001" : "0.001" },
      { filterType: "MARKET_LOT_SIZE", minQty: "0", maxQty: "0.7", stepSize: "0" },
      { filterType: "NOTIONAL", minNotional: "10", maxNotional: "9000000", applyMinToMarket: true,
        avgPriceMins: 5 },
    ] };
}

function config(asset) {
  return { asset, symbol: `${asset}BRL`, slot_count: 25,
    gain_rate: asset === "BTC" ? .012 : .055,
    normal_spacing_rate: asset === "BTC" ? .01 : .015,
    post_ath_spacing_rate: asset === "BTC" ? .05 : .08,
    regime: "NORMAL", monthly_target: asset === "BTC" ? 7 : 2,
    configured_live_capital_brl: asset === "BTC" ? 450 : 275,
    max_order_notional_brl: asset === "BTC" ? 18 : 11,
    max_total_exposure_brl: asset === "BTC" ? 450 : 275,
    config_version: 2, live_enabled: false, updated_at: new Date(FIXED_NOW).toISOString() };
}

function intent(asset) {
  return { action: "DRY_RUN", environment: "REAL", asset, symbol: `${asset}BRL`,
    decision_id: `COINOPS:REAL:${asset}:preview`, strategy_version: STRATEGY_VERSION,
    config: config(asset), portfolio_caps_brl: { BTC: 450, SOL: 275 }, global_cap_brl: 725 };
}

function signedHeaders(body, nonce = randomUUID().replaceAll("-", ""), timestamp = FIXED_NOW) {
  return new Headers({ "content-type": "application/json", "x-coinops-timestamp": String(timestamp),
    "x-coinops-nonce": nonce, "x-coinops-body-sha256": sha256(body),
    "x-coinops-signature": requestSignature(SECRET, "POST", "/v1/dry-run", timestamp, nonce, body),
    "x-coinops-idempotency-key": "COINOPS:REAL:BTC:preview:v2" });
}

test("HMAC rejects tamper, stale timestamp and nonce replay across store instances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coinops-exec-nonce-"));
  const body = JSON.stringify(intent("BTC"));
  const headers = signedHeaders(body);
  const verify = (value, supplied = headers) => verifySignedRequest({ headers: supplied,
    method: "POST", path: "/v1/dry-run", body: value, secret: SECRET,
    nonceDirectory: directory, now: FIXED_NOW });
  await assert.rejects(verify(`${body} `), /EXECUTOR_SIGNATURE_INVALID/);
  await verify(body);
  await assert.rejects(verify(body), /EXECUTOR_NONCE_REPLAY/);
  await assert.rejects(verify(body, signedHeaders(body, randomUUID().replaceAll("-", ""), FIXED_NOW - 31_000)),
    /EXECUTOR_TIMESTAMP_STALE/);
  const wrong = signedHeaders(body);
  wrong.set("x-coinops-signature", "0".repeat(64));
  await assert.rejects(verify(body, wrong), /EXECUTOR_SIGNATURE_INVALID/);
});

test("disk idempotency caches lost responses, denies changed bodies and concurrent claims", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coinops-exec-idem-"));
  let calls = 0;
  const args = { directory, key: "COINOPS:REAL:BTC:preview:v2", bodyHash: sha256("body"),
    execute: async () => { calls++; return { okay: true }; } };
  assert.equal((await withDryRunIdempotency(args)).replayed, false);
  assert.deepEqual(await withDryRunIdempotency(args), { result: { okay: true }, replayed: true });
  assert.equal(calls, 1);
  await assert.rejects(withDryRunIdempotency({ ...args, bodyHash: sha256("changed") }), /IDEMPOTENCY_CONFLICT/);
  const otherKey = "COINOPS:REAL:SOL:preview:v2";
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const first = withDryRunIdempotency({ ...args, key: otherKey, execute: async () => { await blocked; return 1; } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(withDryRunIdempotency({ ...args, key: otherKey }), /IDEMPOTENCY_IN_PROGRESS/);
  release();
  assert.equal((await first).result, 1);
});

test("BTC/SOL dry-run uses the exact shared Strategy Engine and rejects symbol/cap bypass", () => {
  for (const asset of ["BTC", "SOL"]) {
    const price = asset === "BTC" ? 437457 : 597.7;
    const market = { raw: raw(asset), priceBrl: price, observedAt: new Date(FIXED_NOW).toISOString() };
    const result = buildExecutorDryRun(intent(asset), market, FIXED_NOW);
    const shared = buildLiveSizing(parseLiveRules(market.raw), price, config(asset), 725,
      market.observedAt, FIXED_NOW);
    assert.equal(result.strategy_version, STRATEGY_VERSION);
    assert.equal(result.valid_slots, 25);
    assert.deepEqual(result.initial, shared.dryRun.initial);
    assert.deepEqual(result.take_profit, shared.dryRun.takeProfit);
    assert.deepEqual(result.next_buy, shared.dryRun.nextBuy);
    assert.equal(result.local_reentry.action_type, "PLAN_LOCAL_REENTRY");
    assert.equal(result.monthly_hold.reason, "MONTHLY_TARGET_REACHED");
    assert.deepEqual(result.global_reset.map((row) => row.action_type), ["COMPLETE_CYCLE", "REANCHOR"]);
    assert.equal(result.trading_enabled, false);
    assert.equal(result.kill_switch, true);
  }
  assert.throws(() => validateDryRunIntent({ ...intent("BTC"), symbol: "BTCUSDT" }), /INTENT_INVALID/);
  assert.throws(() => validateDryRunIntent({ ...intent("SOL"), config: { ...config("SOL"), max_order_notional_brl: 12 } }), /HARD_CAP_DENIED/);
  assert.throws(() => validateDryRunIntent({ ...intent("BTC"), portfolio_caps_brl: { BTC: 451, SOL: 275 } }), /HARD_CAP_DENIED/);
  assert.throws(() => validateDryRunIntent({ ...intent("BTC"), action: "CREATE_ORDER" }), /INTENT_INVALID/);
});

test("server blocks create/cancel before Binance and accepts only signed no-write dry-run", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "coinops-exec-http-"));
  const events = [];
  const observedUrls = [];
  const fetcher = async (url, init) => {
    observedUrls.push({ url, method: init?.method });
    if (url.includes("exchangeInfo")) return Response.json({ symbols: [raw("BTC"), raw("SOL")] });
    if (url.includes("ticker/price")) return Response.json([
      { symbol: "BTCBRL", price: "437457" }, { symbol: "SOLBRL", price: "597.7" }]);
    if (url.endsWith("/api/v3/time")) return Response.json({ serverTime: FIXED_NOW });
    if (url.includes("ipify")) return Response.json({ ip: "203.0.113.10" });
    throw new Error("Unexpected URL");
  };
  const server = createServer(createExecutorHandler({ secret: SECRET, stateDirectory,
    expectedEgressIp: "203.0.113.10", fetcher, now: () => FIXED_NOW,
    logger: (event) => events.push(event) }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    for (const path of ["/v1/create-order", "/v1/cancel-order", "/v1/cancel-all-orders"]) {
      const response = await fetch(`${url}${path}`, { method: "POST" });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, "EXECUTOR_TRADING_DISABLED");
    }
    assert.equal(observedUrls.length, 0);
    const body = JSON.stringify(intent("BTC"));
    const headers = signedHeaders(body);
    const response = await fetch(`${url}/v1/dry-run`, { method: "POST", headers, body });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "NO_WRITE");
    assert.ok(observedUrls.every((item) => item.method === "GET"));
    const retry = await fetch(`${url}/v1/dry-run`, { method: "POST", headers: signedHeaders(body), body });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).replayed, true);
    assert.ok(events.every((event) => !JSON.stringify(event).includes(SECRET)));
    assert.ok(events.every((event) => !JSON.stringify(event).includes(headers.get("x-coinops-signature"))));
    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.trading_enabled, false);
    assert.equal(health.kill_switch, true);
    assert.equal(health.egress_ipv4_verified, true);
    assert.equal(health.account_permission, "UNVERIFIED");
    assert.equal(health.healthy, false); // Signed GET must also be validated on the VPS.
  } finally { await new Promise((resolve) => server.close(resolve)); }
  const nonceFiles = await readFile(join(stateDirectory, "dry-run", sha256("COINOPS:REAL:BTC:preview:v2") + ".json"), "utf8");
  assert.match(nonceFiles, /NO_WRITE/);
});

test("unsafe deployment flags fail closed before listening", async () => {
  await assert.rejects(startExecutor({ TRADING_ENABLED: "true", KILL_SWITCH: "ON" }), /SAFETY_FLAGS_REQUIRED/);
  await assert.rejects(startExecutor({ TRADING_ENABLED: "false", KILL_SWITCH: "OFF" }), /SAFETY_FLAGS_REQUIRED/);
});
