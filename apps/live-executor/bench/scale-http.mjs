import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";

import { createExecutorHandler } from "../src/server.mjs";
import { validateExecutorRegistry } from "../src/account-registry.mjs";
import { requestSignature, sha256 } from "../src/security.mjs";
import { engineFixture, intentContext } from "../test/registry-fixture.mjs";
import { runFairPool } from "../../web/lib/execution/live-cron-scheduler.ts";

const SECRET = "fictional-scale-HMAC-secret-never-production";
const SYMBOLS = ["BTCUSDT", "SOLUSDT"];
const WAIT_MS = Number(process.env.COINOPS_SCALE_FAKE_LATENCY_MS ?? 5);
const CONCURRENCY = Number(process.env.COINOPS_SCALE_CONCURRENCY ?? 12);
if (!Number.isInteger(WAIT_MS) || WAIT_MS < 0 || WAIT_MS > 1000)
  throw new Error("COINOPS_SCALE_FAKE_LATENCY_INVALID");
if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1 || CONCURRENCY > 200)
  throw new Error("COINOPS_SCALE_CONCURRENCY_INVALID");

const percentile = (values, percent) => {
  const ordered = [...values].sort((a, b) => a - b);
  return Number(ordered[Math.ceil(ordered.length * percent / 100) - 1]?.toFixed(2) ?? 0);
};
const accountId = (index) => `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`;

function fixture(accountCount) {
  const engines = [], credentials = {}, env = {};
  for (let account = 1; account <= accountCount; account++) {
    const id = accountId(account), reference = `fixture-${id}`;
    const suffix = String(account).padStart(3, "0");
    credentials[reference] = { api_key_env: `SCALE_${suffix}_KEY`, api_secret_env: `SCALE_${suffix}_SECRET` };
    env[`SCALE_${suffix}_KEY`] = `fictional-account-${suffix}`;
    env[`SCALE_${suffix}_SECRET`] = `fictional-secret-${suffix}`;
    for (const [offset, symbol] of SYMBOLS.entries()) {
      engines.push({ ...engineFixture(symbol, id, account * 2 + offset, false),
        credential_ref: reference, is_legacy_default: false, legacy_ownership: false,
        hard_cap_quote: 419, account_cap_quote: 838, max_order_quote: 20 });
    }
  }
  return { registry: validateExecutorRegistry({ version: 1, engines, credentials }), env, engines };
}

function fakeBinance(failures) {
  let inFlight = 0, maxInFlight = 0, calls = 0;
  const endpoints = {};
  const fetcher = async (url, init = {}) => {
    const parsed = new URL(url), key = init.headers?.["X-MBX-APIKEY"] ?? "";
    const symbol = parsed.searchParams.get("symbol") ?? "BTCUSDT";
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls++;
    endpoints[parsed.pathname] = (endpoints[parsed.pathname] ?? 0) + 1;
    try {
      if (WAIT_MS) await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
      if (failures.credential.has(key) && parsed.pathname === "/sapi/v1/account/apiRestrictions")
        return Response.json({ code: -2015 }, { status: 401 });
      if (failures.engine.has(`${key}|${symbol}`) && parsed.pathname === "/api/v3/openOrders")
        return Response.json({ code: -1000 }, { status: 503 });
      if (parsed.pathname === "/api/v3/time") return Response.json({ serverTime: Date.now() });
      if (parsed.pathname === "/sapi/v1/account/apiRestrictions") return Response.json({
        ipRestrict: true, enableReading: true, enableSpotAndMarginTrading: true,
        enableWithdrawals: false, enableInternalTransfer: false, permitsUniversalTransfer: false,
        enableMargin: false, enableFutures: false, enableVanillaOptions: false,
        enablePortfolioMarginTrading: false, enableFixApiTrade: false,
      });
      if (parsed.pathname === "/api/v3/account") return Response.json({ canTrade: true,
        balances: [{ asset: "USDT", free: "838", locked: "0" },
          { asset: "BNB", free: "1", locked: "0" }] });
      if (parsed.pathname === "/api/v3/exchangeInfo") return Response.json({ symbols: [{
        symbol, status: "TRADING", baseAsset: symbol.slice(0, 3), quoteAsset: "USDT",
        filters: [{ filterType: "LOT_SIZE", minQty: "0.00001", maxQty: "100", stepSize: "0.00001" },
          { filterType: "PRICE_FILTER", tickSize: "0.01" },
          { filterType: "NOTIONAL", minNotional: "10" }],
      }] });
      if (parsed.pathname === "/api/v3/ticker/price") return Response.json({ symbol, price: "100" });
      if (parsed.pathname === "/api/v3/openOrders") return Response.json([]);
      throw new Error(`UNEXPECTED_FAKE_REQUEST:${parsed.pathname}`);
    } finally { inFlight--; }
  };
  return { fetcher, stats: () => ({ calls, maxInFlight, endpoints }) };
}

async function run(accountCount, fault) {
  const { registry, env, engines } = fixture(accountCount);
  const credential = new Set(), engine = new Set();
  if (fault === "ONE_ENGINE" || fault === "FIVE_ENGINES") {
    for (const row of engines.slice(0, fault === "ONE_ENGINE" ? 1 : 5)) {
      const index = Number(row.exchange_account_id.slice(-12)) - 100;
      engine.add(`fictional-account-${String(index).padStart(3, "0")}|${row.symbol}`);
    }
  }
  if (fault === "ONE_CREDENTIAL") credential.add("fictional-account-001");
  const binance = fakeBinance({ credential, engine });
  const directory = await mkdtemp(join(tmpdir(), "coinops-scale-http-"));
  const server = createServer(createExecutorHandler({ secret: SECRET, stateDirectory: directory,
    registry, credentialEnvironment: env, fetcher: binance.fetcher, now: Date.now,
    logger: () => {}, tradingEnabled: false, killSwitch: true }));
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const cpuBefore = process.cpuUsage(), rssBefore = process.memoryUsage().rss;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const started = performance.now();
  try {
    const results = await runFairPool(engines.map((row, index) => ({ row, index })),
      CONCURRENCY, 0, async ({ row, index }) => {
      const key = `scale-read-${String(index).padStart(8, "0")}`;
      const input = intentContext(row, key), body = JSON.stringify(input);
      const now = Date.now(), nonce = randomUUID().replaceAll("-", "");
      const requestStart = performance.now();
      const response = await fetch(`${base}/v1/state`, { method: "POST", body, headers: {
        "content-type": "application/json", "x-coinops-timestamp": String(now),
        "x-coinops-nonce": nonce, "x-coinops-body-sha256": sha256(body),
        "x-coinops-signature": requestSignature(SECRET, "POST", "/v1/state", now, nonce, body),
        "x-coinops-idempotency-key": key,
      } });
      const payload = await response.json();
      if (response.status === 200) {
        assert.equal(payload.exchange_account_id, row.exchange_account_id);
        assert.equal(payload.trading_engine_id, row.trading_engine_id);
        assert.equal(payload.symbol, row.symbol);
      }
      return { status: response.status, latencyMs: performance.now() - requestStart,
        id: row.trading_engine_id, account: row.exchange_account_id };
    });
    const affected = new Set(fault === "ONE_CREDENTIAL" ? engines.slice(0, 2).map((row) => row.trading_engine_id)
      : fault === "ONE_ENGINE" ? [engines[0].trading_engine_id]
        : fault === "FIVE_ENGINES" ? engines.slice(0, 5).map((row) => row.trading_engine_id) : []);
    for (const result of results)
      assert.equal(result.status === 200, !affected.has(result.id), `${fault} ${result.id} HTTP ${result.status}`);
    const cpu = process.cpuUsage(cpuBefore);
    return { accounts: accountCount, engines: engines.length, slotsLogical: engines.length * 25,
      schedulerConcurrency: CONCURRENCY,
      fault, healthyEngines: engines.length - affected.size, affectedEngines: affected.size,
      wallMs: Number((performance.now() - started).toFixed(2)),
      latencyMs: { p50: percentile(results.map((item) => item.latencyMs), 50),
        p95: percentile(results.map((item) => item.latencyMs), 95),
        p99: percentile(results.map((item) => item.latencyMs), 99) },
      cpuMs: Number(((cpu.user + cpu.system) / 1000).toFixed(2)),
      rssBeforeMb: Number((rssBefore / 1048576).toFixed(2)),
      rssAfterMb: Number((process.memoryUsage().rss / 1048576).toFixed(2)),
      eventLoopP99Ms: Number((loop.percentile(99) / 1e6).toFixed(2)),
      ...binance.stats() };
  } finally {
    loop.disable();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

for (const accounts of [10, 30, 50, 100])
  console.log(JSON.stringify(await run(accounts, "NONE")));
for (const fault of ["ONE_ENGINE", "FIVE_ENGINES", "ONE_CREDENTIAL"])
  console.log(JSON.stringify(await run(50, fault)));
