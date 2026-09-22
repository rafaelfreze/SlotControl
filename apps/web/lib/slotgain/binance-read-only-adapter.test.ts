import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { BinanceReadOnlyError, BinanceSpotAdapter, normalizePriceToTick, normalizeToStep } from "../execution/binance-spot-adapter.ts";

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

test("Binance read-only adapter signs GET account calls and normalizes free plus locked balances", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const queue = [
    response({ serverTime: 1_000_500 }),
    response({ canTrade: true, canWithdraw: false, canDeposit: true, updateTime: 1_000_500, balances: [{ asset: "BTC", free: "0.1", locked: "0.02" }, { asset: "USDT", free: "10", locked: "2" }] })
  ];
  const adapter = new BinanceSpotAdapter({ apiKey: "public-key-for-test", apiSecret: "secret-for-test" }, {
    now: () => 1_000_000,
    maxReadRetries: 0,
    fetcher: async (url, init) => { requests.push({ url, init }); return queue.shift()!; }
  });
  const account = await adapter.getAccount();
  assert.equal(account.balances[0]?.total, 0.12);
  assert.equal(requests.every(({ init }) => init?.method === "GET"), true);
  const signed = new URL(requests[1]!.url).searchParams;
  const payload = new URLSearchParams({ recvWindow: signed.get("recvWindow")!, timestamp: signed.get("timestamp")! }).toString();
  assert.equal(signed.get("signature"), createHmac("sha256", "secret-for-test").update(payload).digest("hex"));
  assert.equal(new Headers(requests[1]!.init?.headers).get("X-MBX-APIKEY"), "public-key-for-test");
});

test("Binance read-only adapter handles capabilities, precision, rate limits and invalid credentials without writes", async () => {
  let calls = 0;
  let priceAttempts = 0;
  const adapter = new BinanceSpotAdapter({ apiKey: "key", apiSecret: "secret" }, {
    now: () => 1_000,
    sleep: async () => undefined,
    fetcher: async (url) => {
      calls += 1;
      if (url.includes("/api/v3/time")) return response({ serverTime: 1_100 });
      if (url.includes("ticker/price")) {
        priceAttempts += 1;
        return priceAttempts === 1 ? response({ code: -1003 }, 429) : response({ symbol: "BTCUSDT", price: "65000" });
      }
      if (url.includes("apiRestrictions")) return response({ enableReading: true, enableSpotAndMarginTrading: true, enableWithdrawals: false, ipRestrict: true });
      throw new Error(`unexpected ${url}`);
    }
  });
  const capabilities = await adapter.getCapabilities();
  assert.deepEqual(capabilities, { readEnabled: true, tradingEnabled: true, withdrawalsEnabled: false, ipRestricted: true });
  assert.equal((await adapter.getMarketPrice("BTCUSDT")).price, 65000);
  assert.equal(priceAttempts, 2);
  assert.equal(normalizeToStep(0.123456, 0.001), 0.123);
  assert.equal(normalizePriceToTick(60000.123, 0.01), 60000.12);
  assert.equal(BinanceSpotAdapter.maskApiKey("123456789"), "••••6789");

  const invalid = new BinanceSpotAdapter({ apiKey: "key", apiSecret: "secret" }, {
    maxReadRetries: 0,
    fetcher: async (url) => url.includes("/time") ? response({ serverTime: 1_000 }) : response({ code: -2015 }, 401)
  });
  await assert.rejects(invalid.getAccount(), (error: unknown) => error instanceof BinanceReadOnlyError && error.code === "BINANCE_INVALID_CREDENTIALS");
});

test("Binance symbol filters and all read history representations remain GET-only", async () => {
  const methods: string[] = [];
  const adapter = new BinanceSpotAdapter({ apiKey: "key", apiSecret: "secret" }, {
    maxReadRetries: 0,
    fetcher: async (url, init) => {
      methods.push(init?.method || "");
      if (url.includes("/time")) return response({ serverTime: Date.now() });
      if (url.includes("exchangeInfo")) return response({ symbols: [{ symbol: "SOLUSDT", baseAsset: "SOL", quoteAsset: "USDT", filters: [{ filterType: "LOT_SIZE", minQty: "0.01", maxQty: "100000", stepSize: "0.001" }, { filterType: "MARKET_LOT_SIZE", minQty: "0.02", maxQty: "50000", stepSize: "0.01" }, { filterType: "PRICE_FILTER", tickSize: "0.01" }, { filterType: "NOTIONAL", minNotional: "5" }] }] });
      if (url.includes("openOrders")) return response([{ orderId: 1, symbol: "SOLUSDT", side: "BUY", status: "NEW", executedQty: "0", price: "100", clientOrderId: "external", updateTime: 1 }]);
      if (url.includes("myTrades")) return response([{ id: 2, orderId: 1, symbol: "SOLUSDT", qty: "0.2", price: "100", quoteQty: "20", time: 2, isBuyer: true, isMaker: false }]);
      throw new Error(`unexpected ${url}`);
    }
  });
  assert.deepEqual(await adapter.getSymbolInfo("SOLUSDT"), { symbol: "SOLUSDT", baseAsset: "SOL", quoteAsset: "USDT", minQuantity: 0.02, maxQuantity: 50000, minNotional: 5, quantityStep: 0.01, priceTick: 0.01 });
  assert.equal((await adapter.getOpenOrders("SOLUSDT"))[0]?.status, "NEW");
  assert.equal((await adapter.getTrades("SOLUSDT"))[0]?.side, "BUY");
  await assert.rejects(adapter.createOrder({ symbol: "SOLUSDT", side: "BUY", quantity: 1, clientOrderId: "blocked" }), /LIVE_EXECUTION_BLOCKED/);
  await assert.rejects(adapter.cancelOrder("SOLUSDT", "1"), /LIVE_EXECUTION_BLOCKED/);
  assert.equal(methods.every((method) => method === "GET"), true);
});

test("Binance public market data uses the dedicated official endpoint while private reads retain the authenticated endpoint", async () => {
  const urls: string[] = [];
  const adapter = new BinanceSpotAdapter(null, {
    maxReadRetries: 0,
    baseUrl: "https://private.example",
    marketDataBaseUrl: "https://market.example",
    fetcher: async (url) => {
      urls.push(url);
      if (url.includes("ticker/price")) return response({ symbol: "BTCUSDC", price: "65000" });
      return response({ symbols: [{ symbol: "BTCUSDC", baseAsset: "BTC", quoteAsset: "USDC", filters: [{ filterType: "LOT_SIZE", minQty: "0.00001", maxQty: "9000", stepSize: "0.00001" }, { filterType: "PRICE_FILTER", tickSize: "0.01" }, { filterType: "NOTIONAL", minNotional: "5" }] }] });
    }
  });
  await adapter.getMarketPrice("BTCUSDC");
  await adapter.getSymbolInfo("BTCUSDC");
  assert.equal(urls.every((url) => url.startsWith("https://market.example")), true);
});

test("Binance symbol filters fall back to LOT_SIZE when MARKET_LOT_SIZE is disabled", async () => {
  const adapter = new BinanceSpotAdapter(null, {
    maxReadRetries: 0,
    fetcher: async () => response({
      symbols: [{
        symbol: "BTCUSDT",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        filters: [
          { filterType: "LOT_SIZE", minQty: "0.00001", maxQty: "9000", stepSize: "0.00001" },
          { filterType: "MARKET_LOT_SIZE", minQty: "0", maxQty: "104.35988283", stepSize: "0" },
          { filterType: "PRICE_FILTER", tickSize: "0.01" },
          { filterType: "NOTIONAL", minNotional: "5" }
        ]
      }]
    })
  });

  assert.deepEqual(await adapter.getSymbolInfo("BTCUSDT"), {
    symbol: "BTCUSDT",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    minQuantity: 0.00001,
    maxQuantity: 9000,
    minNotional: 5,
    quantityStep: 0.00001,
    priceTick: 0.01
  });
});

test("Binance signed reads resync clock once after a safe clock-drift response", async () => {
  let timeCalls = 0;
  const adapter = new BinanceSpotAdapter({ apiKey: "key", apiSecret: "secret" }, {
    now: () => 1_000,
    maxReadRetries: 0,
    fetcher: async (url) => {
      if (url.includes("/time")) { timeCalls += 1; return response({ serverTime: 1_000 + timeCalls * 100 }); }
      if (timeCalls === 1) return response({ code: -1021 }, 400);
      return response({ canTrade: false, canWithdraw: false, canDeposit: true, balances: [] });
    }
  });
  assert.equal((await adapter.getAccount()).canTrade, false);
  assert.equal(timeCalls, 2);
});
