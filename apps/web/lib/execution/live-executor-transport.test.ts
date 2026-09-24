import assert from "node:assert/strict";
import test from "node:test";

import { readLiveExecutorState } from "./live-executor-transport.ts";

const state = {
  symbol: "BTCBRL", balances: [],
  filters: { symbol: "BTCBRL", baseAsset: "BTC", quoteAsset: "BRL",
    minQuantity: 0.00001, maxQuantity: 9000, quantityStep: 0.00001,
    minNotional: 10, priceTick: 1 },
  price: { symbol: "BTCBRL", price: 430000, observedAt: "2026-09-24T10:00:00Z" },
  bnb_brl_price: null, open_orders: [], observed_at: "2026-09-24T10:00:00Z",
};

test("LIVE state retries an invalid successful GET once, without any exchange write", async () => {
  const previous = { ip: process.env.LIVE_EXECUTOR_EGRESS_IP,
    base: process.env.LIVE_EXECUTOR_BASE_URL, secret: process.env.COINOPS_EXECUTOR_HMAC_SECRET };
  process.env.LIVE_EXECUTOR_EGRESS_IP = "46.101.104.48";
  process.env.LIVE_EXECUTOR_BASE_URL = "https://46.101.104.48";
  process.env.COINOPS_EXECUTOR_HMAC_SECRET = "x".repeat(32);
  try {
    const requests: Array<{ url: string; method: string | undefined }> = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method });
      return Response.json(requests.length === 1 ? {} : state);
    }) as typeof fetch;
    assert.deepEqual(await readLiveExecutorState("BTCBRL", fetcher), state);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.method === "POST"
      && request.url.endsWith("/v1/state")));

    let rejected = 0;
    const denied = (async () => { rejected++; return Response.json({ error: "EXECUTOR_SYMBOL_DENIED" },
      { status: 403 }); }) as typeof fetch;
    await assert.rejects(readLiveExecutorState("BTCBRL", denied), /EXECUTOR_SYMBOL_DENIED/);
    assert.equal(rejected, 1);
  } finally {
    if (previous.ip === undefined) delete process.env.LIVE_EXECUTOR_EGRESS_IP;
    else process.env.LIVE_EXECUTOR_EGRESS_IP = previous.ip;
    if (previous.base === undefined) delete process.env.LIVE_EXECUTOR_BASE_URL;
    else process.env.LIVE_EXECUTOR_BASE_URL = previous.base;
    if (previous.secret === undefined) delete process.env.COINOPS_EXECUTOR_HMAC_SECRET;
    else process.env.COINOPS_EXECUTOR_HMAC_SECRET = previous.secret;
  }
});
