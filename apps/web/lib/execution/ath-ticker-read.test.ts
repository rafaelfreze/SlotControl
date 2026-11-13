import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { readAthTickerPrice, athTickerReadPath } from "./ath-ticker-read.ts";
import { LiveMarketReadFailed, LiveReadUnavailable, liveFailureEvidence } from "./live-read-error.ts";
import { isAthTickerReadRecovery, mayRecoverReadOutage, verifiedReadRecoveryAlert } from "./live-read-recovery.ts";

const quote = (symbol = "BTCUSDT") => Response.json({ symbol, price: "68920.31" });
const typed = { stage: "ATH_TRANSITION", root_code: "COINOPS_LIVE_ATH_PRICE_TIMEOUT",
  read_path: athTickerReadPath("BTCUSDT"), read_attempts: 2, http_status: null };
const stale = "COINOPS_LIVE_EXECUTOR_READ_STALE";

test("configured BTC/SOL ATH symbol is preserved; public GET has no cache, fallback or trading", async () => {
  for (const symbol of ["BTCUSDT", "BTCUSDC", "SOLUSDT", "SOLUSDC"]) {
    let calls = 0;
    const result = await readAthTickerPrice(symbol, async (url, init) => {
      calls++; assert.equal(url, `https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`);
      assert.equal(init?.method, "GET"); assert.equal(init.cache, "no-store");
      assert.equal(init.redirect, "error"); assert.ok(init.signal); assert.equal(init.body, undefined);
      return quote(symbol);
    });
    assert.equal(calls, 1); assert.equal(result.price, 68920.31); assert.equal(result.symbol, symbol);
    assert.ok(Date.now() - Date.parse(result.observedAt) < 1_000);
  }
  for (const symbol of ["", "BTCUSDT&x=1", "ETHUSDT", "BTC/BRL"])
    await assert.rejects(readAthTickerPrice(symbol, async () => assert.fail("invalid symbol must not fetch")));
});

test("timeout, connection failure and 503 retry the GET once with a fresh signal", async () => {
  for (const failure of [new DOMException("private host", "TimeoutError"), new TypeError("private URL"),
    Response.json({ code: -1001, msg: "private message" }, { status: 503 })]) {
    const signals: unknown[] = [];
    const result = await readAthTickerPrice("BTCUSDT", async (_url, init) => {
      signals.push(init?.signal);
      if (signals.length === 1) { if (failure instanceof Error) throw failure; return failure; }
      return quote();
    });
    assert.equal(result.price, 68920.31); assert.equal(signals.length, 2); assert.notEqual(signals[0], signals[1]);
  }
});

test("exhaustion preserves exact typed evidence rather than generic ATH transition failure", async () => {
  for (const [failure, root, status, provider] of [
    [new DOMException("sensitive", "TimeoutError"), "COINOPS_LIVE_ATH_PRICE_TIMEOUT", null, null],
    [new TypeError("sensitive"), "COINOPS_LIVE_ATH_PRICE_NETWORK", null, null],
    [503, "COINOPS_LIVE_ATH_PRICE_UNAVAILABLE", 503, "-1001"],
  ] as const) {
    let calls = 0;
    await assert.rejects(readAthTickerPrice("BTCUSDT", async () => {
      calls++; if (failure instanceof Error) throw failure;
      return Response.json({ code: -1001, msg: "sensitive" }, { status: failure });
    }), (e: unknown) => {
      assert.ok(e instanceof LiveReadUnavailable);
      assert.deepEqual(liveFailureEvidence(e, "ATH_TRANSITION", "LIVE_CRON"), {
        stage: "ATH_TRANSITION", source: "ENGINE", root_code: root,
        read_path: typed.read_path, read_attempts: 2, http_status: status,
        ...(provider ? { provider_code: provider } : {}),
      }); return true;
    });
    assert.equal(calls, 2);
  }
});

test("HTTP denials, bans, malformed data and wrong symbol are hard failures, without retry", async () => {
  const responses = [401, 403, 404, 418, 429, 451, 500].map(status => () => Response.json({ code: -2015 }, { status }));
  responses.push(() => Response.json({ code: -2015 }, { status: 503 }),
    () => Response.json({ code: "-2015" }, { status: 503 }),
    () => new Response("broken JSON", { status: 200 }));
  for (const body of [null, [], { symbol: "BTCUSDC", price: "1" }, { symbol: "BTCUSDT", price: "NaN" },
    { symbol: "BTCUSDT", price: "0" }, { symbol: "BTCUSDT", price: null }, { symbol: "BTCUSDT", price: " 12 " }])
    responses.push(() => Response.json(body));
  for (const response of responses) {
    let calls = 0;
    await assert.rejects(readAthTickerPrice("BTCUSDT", async () => { calls++; return response(); }), LiveMarketReadFailed);
    assert.equal(calls, 1);
  }
  const e = new LiveMarketReadFailed(typed.read_path, 1, 403, "-2015");
  assert.equal(liveFailureEvidence(e, "ATH_TRANSITION", "LIVE_CRON").provider_code, "-2015");
  assert.equal(liveFailureEvidence(e, "ATH_TRANSITION", "LIVE_CRON").http_status, 403);
});

test("body timeout can retry a successful GET but cannot mask a real permission denial", async () => {
  let calls = 0;
  const bodyTimeout = (status: number) => {
    const response = new Response(null, { status });
    response.json = async () => { throw new DOMException("sensitive", "TimeoutError"); };
    return response;
  };
  await readAthTickerPrice("BTCUSDT", async () => ++calls === 1 ? bodyTimeout(200) : quote());
  assert.equal(calls, 2); calls = 0;
  await assert.rejects(readAthTickerPrice("BTCUSDT", async () => { calls++; return bodyTimeout(401); }),
    (e: unknown) => e instanceof LiveMarketReadFailed && e.httpStatus === 401);
  assert.equal(calls, 1);
});

test("automatic recovery accepts only typed ATH GET evidence, never generic legacy/write/invalid causes", () => {
  assert.equal(isAthTickerReadRecovery(stale, typed), true);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", stale, typed), true);
  const incident = { code: stale, alert_key: "LIVE_RUN:r:CRITICAL", last_seen_at: new Date().toISOString(), details: typed };
  assert.equal(verifiedReadRecoveryAlert("ACTIVE", "r", [incident]), incident);
  for (const change of [{ read_path: "ledger/orders" }, { stage: "ARM_ENTRY" }, { http_status: 403 },
    { read_attempts: 3 }, { read_attempts: undefined }, { provider_code: "-2015" }, { root_code: "UNCLASSIFIED_FAILURE" },
    { read_path: "market/ath_ticker/ETHUSDT" }, { read_path: "market/ath_ticker/BTCUSDT/extra" }]) {
    assert.equal(isAthTickerReadRecovery(stale, { ...typed, ...change }), false);
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", stale, { ...typed, ...change }), false);
  }
  assert.equal(mayRecoverReadOutage("PAUSED", "OK", stale, typed), false);
  assert.equal(mayRecoverReadOutage("ACTIVE", "RETRY", stale, typed), false);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", "COINOPS_LIVE_ATH_TRANSITION_FAILED",
    { stage: "ATH_TRANSITION", root_code: "UNCLASSIFIED_FAILURE" }), false);
  assert.equal(isAthTickerReadRecovery(stale, { ...typed, root_code: "COINOPS_LIVE_ATH_PRICE_UNAVAILABLE",
    http_status: 503, provider_code: "-1001" }), true);
  assert.equal(isAthTickerReadRecovery(stale, { ...typed, root_code: "COINOPS_LIVE_ATH_PRICE_UNAVAILABLE",
    http_status: 503, provider_code: "-2015" }), false);
  assert.equal(isAthTickerReadRecovery(stale, { ...typed, root_code: "COINOPS_LIVE_ATH_PRICE_UNAVAILABLE",
    http_status: "503" }), false);
});

test("worker retries only the public quote; a healthy result refreshes the original profile once", async () => {
  let requests = 0, profileWrites = 0;
  const deps: Record<string, unknown> = { "./ath-ticker-read": {
    readAthTickerPrice: (symbol: string) => readAthTickerPrice(symbol, async () => {
      requests++; if (requests % 2 === 1) throw new DOMException("timeout", "TimeoutError"); return quote("BTCUSDC");
    }) }, "./ath-profile-server": { refreshAthProfile: async (_service: unknown, _scope: unknown,
      environment: string, asset: string, market: { symbol: string }) => {
      profileWrites++; assert.equal(environment, "REAL"); assert.equal(asset, "BTC");
      assert.equal(market.symbol, "BTCUSDC"); return "original-profile";
    } } };
  const compiled = ts.transpileModule(readFileSync(new URL("./robot-v1-live-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled + ";exports.testRead=refreshRealAthProfile;")(
    (name: string) => deps[name] ?? {}, exports);
  const refresh = exports.testRead as (...args: unknown[]) => Promise<unknown>;
  assert.equal(await refresh({}, { asset: "BTC", engine: { ath_reference_symbol: "BTCUSDC" } }), "original-profile");
  assert.equal(requests, 2); assert.equal(profileWrites, 1);
});
