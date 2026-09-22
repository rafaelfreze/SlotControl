import assert from "node:assert/strict";
import test from "node:test";

import { BINANCE_SPOT_TESTNET_BASE_URL, BinanceSpotTestnetAdapter } from "../execution/binance-spot-testnet-adapter.ts";

test("testnet writer is isolated from Production and rejects manual pairs before transport", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = BinanceSpotTestnetAdapter.forTest("test-key", "test-secret", async (url, init) => {
    calls.push({ url, init });
    if (init?.method === "GET") return new Response(JSON.stringify({ code: -2013 }), { status: 400 });
    return new Response(JSON.stringify({ orderId: 1, clientOrderId: "COV1-BTC-1-BUY-test", status: "NEW", executedQty: "0" }));
  }, () => 1000);
  await adapter.createLimitOrder({ symbol: "BTCUSDC", side: "BUY", quantity: 0.001, price: 60000, clientOrderId: "COV1-BTC-1-BUY-test" });
  assert.equal(calls[0]?.url.startsWith(BINANCE_SPOT_TESTNET_BASE_URL), true);
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(calls[1]?.init?.method, "POST");
  await assert.rejects(adapter.createLimitOrder({ symbol: "BTCUSDT" as never, side: "BUY", quantity: 1, price: 1, clientOrderId: "COV1-BTC-1-BUY-test" }), /SYMBOL_NOT_ALLOWED/);
  assert.equal(calls.length, 2);
});
