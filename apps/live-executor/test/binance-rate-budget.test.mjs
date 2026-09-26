import assert from "node:assert/strict";
import test from "node:test";

import { createBinanceReadBudgetFetcher } from "../src/binance-rate-budget.mjs";

const accountUrl = "https://api.binance.com/api/v3/account?timestamp=1";

test("reported IP weight blocks further reads but resets at next minute", async () => {
  let clock = 60_001, calls = 0;
  const fetcher = createBinanceReadBudgetFetcher(async () => {
    calls++;
    return Response.json({}, { headers: { "x-mbx-used-weight-1m": "4790" } });
  }, () => clock, () => 0);
  assert.equal((await fetcher(accountUrl, { method: "GET" })).status, 200);
  assert.equal((await fetcher(accountUrl, { method: "GET" })).status, 429);
  assert.equal(calls, 1);
  clock = 120_001;
  assert.equal((await fetcher(accountUrl, { method: "GET" })).status, 200);
  assert.equal(calls, 2);
});

test("Binance 429 Retry-After applies to other accounts on the same IP", async () => {
  let clock = 1_000, calls = 0;
  const fetcher = createBinanceReadBudgetFetcher(async () => {
    calls++;
    return calls === 1 ? Response.json({}, { status: 429, headers: { "retry-after": "2" } })
      : Response.json({ ok: true });
  }, () => clock, () => 0);
  assert.equal((await fetcher(accountUrl, { method: "GET" })).status, 429);
  assert.equal((await fetcher(`${accountUrl}&account=B`, { method: "GET" })).status, 429);
  assert.equal(calls, 1);
  clock = 3_001;
  assert.equal((await fetcher(accountUrl, { method: "GET" })).status, 200);
  assert.equal(calls, 2);
});

test("reported shared-IP usage includes outstanding reads from other accounts", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const fetcher = createBinanceReadBudgetFetcher(async (url) => {
    calls++;
    if (url.includes("slow=")) {
      await pending;
      return Response.json({});
    }
    return Response.json({}, { headers: { "x-mbx-used-weight-1m": "4500" } });
  }, () => 60_001, () => 0);
  const slow = Array.from({ length: 30 }, (_, index) =>
    fetcher(`${accountUrl}&slow=${index}`, { method: "GET" }));
  assert.equal((await fetcher(accountUrl, { method: "GET" })).status, 200);
  assert.equal((await fetcher(`${accountUrl}&account=another`, { method: "GET" })).status, 429);
  assert.equal(calls, 31);
  release();
  assert.equal((await Promise.all(slow)).every((response) => response.status === 200), true);
});

test("write requests are never replayed, queued or synthesized by read budget", async () => {
  let calls = 0;
  const fetcher = createBinanceReadBudgetFetcher(async (_url, init) => {
    calls++;
    return Response.json({ method: init.method });
  }, () => 0, () => 0);
  for (let index = 0; index < 240; index++) await fetcher(accountUrl, { method: "GET" });
  const beforeWrite = calls;
  assert.equal((await (await fetcher("https://api.binance.com/api/v3/order", { method: "POST" })).json()).method, "POST");
  assert.equal(calls, beforeWrite + 1);
});
