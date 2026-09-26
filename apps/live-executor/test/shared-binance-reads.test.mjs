import assert from "node:assert/strict";
import test from "node:test";

import { createSharedPublicFetcher, sharedAccountRead } from "../src/shared-binance-reads.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("concurrent public GETs share one request but never cache a completed response", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetcher = createSharedPublicFetcher(async () => {
    calls++;
    await gate;
    return Response.json({ call: calls });
  });
  const url = "https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCBRL";
  const first = fetcher(url, { method: "GET" });
  const second = fetcher(url, { method: "GET" });
  await tick();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await (await first).json(), { call: 1 });
  assert.deepEqual(await (await second).json(), { call: 1 });
  assert.deepEqual(await (await fetcher(url, { method: "GET" })).json(), { call: 2 });
});

test("exchange filters share only a one-second successful public snapshot", async () => {
  let clock = 10_000, calls = 0;
  const fetcher = createSharedPublicFetcher(async () => Response.json({ revision: ++calls }), () => clock);
  const url = "https://data-api.binance.vision/api/v3/exchangeInfo?symbol=BTCUSDT";
  assert.deepEqual(await (await fetcher(url, { method: "GET" })).json(), { revision: 1 });
  assert.deepEqual(await (await fetcher(url, { method: "GET" })).json(), { revision: 1 });
  assert.equal(calls, 1);
  clock += 1_001;
  assert.deepEqual(await (await fetcher(url, { method: "GET" })).json(), { revision: 2 });
  assert.equal(calls, 2);
});

test("failed exchange filters are never cached", async () => {
  let calls = 0;
  const fetcher = createSharedPublicFetcher(async () => Response.json({ revision: ++calls },
    { status: calls === 1 ? 503 : 200 }));
  const url = "https://data-api.binance.vision/api/v3/exchangeInfo?symbol=SOLUSDT";
  assert.equal((await fetcher(url, { method: "GET" })).status, 503);
  assert.equal((await fetcher(url, { method: "GET" })).status, 200);
  assert.equal(calls, 2);
});

test("private, different-symbol and write requests are never shared", async () => {
  const calls = [];
  const fetcher = createSharedPublicFetcher(async (url, init) => {
    calls.push({ url, method: init.method });
    return Response.json({ ok: true });
  });
  const base = "https://data-api.binance.vision/api/v3/ticker/price?symbol=";
  await Promise.all([
    fetcher(`${base}BTCBRL`, { method: "GET", headers: { "X-MBX-APIKEY": "key" } }),
    fetcher(`${base}BTCBRL`, { method: "GET", headers: { "X-MBX-APIKEY": "key" } }),
    fetcher(`${base}BTCBRL`, { method: "POST" }),
    fetcher(`${base}BTCBRL`, { method: "POST" }),
    fetcher(`${base}SOLBRL`, { method: "GET" }),
    fetcher(`${base}BTCBRL`, { method: "GET" }),
  ]);
  assert.equal(calls.length, 6);
  assert.equal(calls.filter((call) => call.method === "POST").length, 2);
});

test("failed public request is removed so a later GET can retry", async () => {
  let calls = 0;
  const fetcher = createSharedPublicFetcher(async () => {
    if (++calls === 1) throw new Error("transient");
    return Response.json({ ok: true });
  });
  const url = "https://api.binance.com/api/v3/time";
  const results = await Promise.allSettled([
    fetcher(url, { method: "GET" }), fetcher(url, { method: "GET" }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
  assert.equal((await (await fetcher(url, { method: "GET" })).json()).ok, true);
  assert.equal(calls, 2);
});

test("account reads share only the same account and credential while pending", async () => {
  const pending = new Map();
  const counts = new Map();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const read = (key) => async () => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    await gate;
    return { key };
  };
  const reads = [
    sharedAccountRead(pending, "A", "key-1", read("A1")),
    sharedAccountRead(pending, "A", "key-1", read("duplicate")),
    sharedAccountRead(pending, "B", "key-1", read("B1")),
    sharedAccountRead(pending, "A", "key-2", read("A2")),
  ];
  await tick();
  assert.equal(counts.size, 3);
  release();
  assert.deepEqual(await Promise.all(reads), [
    { key: "A1" }, { key: "A1" }, { key: "B1" }, { key: "A2" },
  ]);
  await sharedAccountRead(pending, "A", "key-1", read("fresh"));
  assert.equal(counts.get("fresh"), 1);
});
