import assert from "node:assert/strict";
import test from "node:test";

import { fetchOfficialReferencePrices } from "./official-reference-prices.ts";

const response = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload
}) as Response;

test("usa Binance quando os dois preços são válidos", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    return response({ price: url.includes("BTCUSDT") ? "123.45" : "67.89" });
  }) as typeof fetch;

  const prices = await fetchOfficialReferencePrices(fetcher);

  assert.deepEqual(prices, { BTC: 123.45, SOL: 67.89, source: "BINANCE" });
  assert.equal(calls.length, 2);
});

test("usa CoinGecko quando Binance está indisponível", async () => {
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("binance.com")) return response({}, 451);
    return response({ market_data: { current_price: { usd: url.includes("bitcoin") ? 125_000 : 190 } } });
  }) as typeof fetch;

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    assert.deepEqual(
      await fetchOfficialReferencePrices(fetcher),
      { BTC: 125_000, SOL: 190, source: "COINGECKO" }
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("falha de forma fechada quando nenhum provedor entrega preços válidos", async () => {
  const fetcher = (async () => response({ market_data: { current_price: { usd: 0 } } })) as typeof fetch;

  await assert.rejects(
    fetchOfficialReferencePrices(fetcher),
    /COINOPS_BASELINE_PRICE_FEED_UNAVAILABLE/
  );
});
