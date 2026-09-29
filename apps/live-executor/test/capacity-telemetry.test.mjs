import assert from "node:assert/strict";
import test from "node:test";

import { createCapacityTelemetry } from "../src/capacity-telemetry.mjs";

test("isolated peak expires after exactly the rolling window without restart or stale-warning latch",()=>{
  let at=Date.parse("2026-09-29T20:00:00Z");
  const t=createCapacityTelemetry({now:()=>at});
  const observe=(weight)=>t.observe("https://api.binance.com/api/v3/account",new Response("",{headers:{"x-mbx-used-weight-1m":String(weight)}}));
  observe(4903);at+=60_000;observe(2600);
  at+=14*60_000;observe(2500);assert.equal(t.snapshot().binance_weight_peak,4903);
  at+=1;assert.equal(t.snapshot().binance_weight_peak,2600);
});

test("IP-wide Binance headers form a rolling minute peak without altering responses", async () => {
  let at = Date.parse("2026-09-26T18:00:00Z"), calls = 0;
  const telemetry = createCapacityTelemetry({ now: () => at, shardId: "executor-01",
    cpuUsage: () => ({ user: 1_000_000, system: 0 }), rss: () => 147 * 1024 * 1024,
    memoryLimit: () => 961 * 1024 * 1024,
    fetcher: async () => new Response("ok", { headers: { "x-mbx-used-weight-1m": String(++calls * 1200) } }) });
  const first = await telemetry.trackedFetch("https://api.binance.com/api/v3/time");
  assert.equal(await first.text(), "ok");
  at += 60_000;
  await telemetry.trackedFetch("https://api.binance.com/api/v3/account");
  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.binance_weight_current, 2400);
  assert.equal(snapshot.binance_weight_average, 1800);
  assert.equal(snapshot.binance_weight_peak, 2400);
  assert.equal(snapshot.binance_weight_samples, 2);
  assert.equal(snapshot.ram_used_mb, 147);
  at += 16 * 60_000;
  assert.equal(telemetry.snapshot().binance_weight_current, null);
});

test("public/third-party headers cannot impersonate Binance IP weight", async () => {
  const telemetry = createCapacityTelemetry({ fetcher: async () => new Response("ok", {
    headers: { "x-mbx-used-weight-1m": "5999" } }) });
  await telemetry.trackedFetch("https://data-api.binance.vision/api/v3/ticker/price");
  await telemetry.trackedFetch("https://example.com/test");
  assert.equal(telemetry.snapshot().binance_weight_current, null);
});

test("Binance failure and probable retry pressure are observed without changing fetch outcomes", async () => {
  let at = 1_000_000, calls = 0;
  const telemetry = createCapacityTelemetry({ now: () => at,
    fetcher: async () => ++calls === 1
      ? new Response("temporary", { status: 503 }) : new Response("ok") });
  assert.equal((await telemetry.trackedFetch("https://api.binance.com/api/v3/account")).status, 503);
  at += 1000;
  assert.equal((await telemetry.trackedFetch("https://api.binance.com/api/v3/account")).status, 200);
  assert.equal(telemetry.snapshot().request_errors_last_5m, 1);
  assert.equal(telemetry.snapshot().probable_retries_last_5m, 1);
  at += 301_000;
  assert.equal(telemetry.snapshot().request_errors_last_5m, 0);
  assert.equal(telemetry.snapshot().probable_retries_last_5m, 0);
});

test("Production and Testnet IP-weight, errors, retries and bounded probes are independent", async () => {
  let at = Date.parse("2026-09-26T18:00:00Z");
  const calls = [], fetcher = async (url) => {
    calls.push(String(url));
    const testnet = new URL(url).hostname === "testnet.binance.vision";
    return Response.json({ serverTime: at }, { status: testnet ? 429 : 200,
      headers: { "x-mbx-used-weight-1m": testnet ? "5900" : "1200" } });
  };
  const testnet = createCapacityTelemetry({ now: () => at, fetcher, environment: "TESTNET" });
  const live = createCapacityTelemetry({ now: () => at, fetcher: testnet.trackedFetch });
  await live.trackedFetch("https://api.binance.com/api/v3/account");
  await live.trackedFetch("https://testnet.binance.vision/api/v3/account");
  assert.equal(live.snapshot().binance_weight_current, 1200);
  assert.equal(live.snapshot().request_errors_last_5m, 0);
  assert.equal(testnet.snapshot().binance_weight_current, 5900);
  assert.equal(testnet.snapshot().request_errors_last_5m, 1);
  at += 60_000;
  await Promise.allSettled(Array.from({ length: 5 }, () => Promise.all([live.sampleIfIdle(), testnet.sampleIfIdle()])));
  assert.equal(calls.filter((url) => url === "https://api.binance.com/api/v3/time").length, 1);
  assert.equal(calls.filter((url) => url === "https://testnet.binance.vision/api/v3/time").length, 1);
  assert.equal(live.snapshot().binance_weight_peak, 1200);
  assert.equal(testnet.snapshot().binance_weight_peak, 5900);
  assert.throws(() => createCapacityTelemetry({ environment: "OTHER" }), /ENVIRONMENT_INVALID/);
});
