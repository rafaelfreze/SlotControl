import assert from "node:assert/strict";
import test from "node:test";
import { getPremiumMarketCandles } from "./premium-market.ts";

test("USDT history uses its exact public Binance symbol without account credentials", async () => {
  const originalFetch = globalThis.fetch;
  let requested = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requested = String(input);
    assert.equal(init?.method, undefined);
    assert.equal(init?.headers, undefined);
    return new Response(JSON.stringify([[1_780_000_000_000, "100", "110", "95", "108"]]), { status: 200 });
  }) as typeof fetch;
  try {
    const candles = await getPremiumMarketCandles("BTCUSDT");
    assert.match(requested, /symbol=BTCUSDT&interval=1d/);
    assert.equal(candles[0]?.symbol, "BTCUSDT");
    assert.equal(candles[0]?.close_price, 108);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
