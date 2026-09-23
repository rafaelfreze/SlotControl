import assert from "node:assert/strict";
import test from "node:test";

import { readBinanceHistoricalAth } from "../execution/ath-market-source.ts";

const day = 86_400_000;
const candle = (index: number, high: number) => [index * day, "1", String(high), "1", "1", "1", (index + 1) * day - 1];
const reply = (rows: unknown) => new Response(JSON.stringify(rows), { status: 200 });

test("historical ATH scans all pages and ignores the open daily candle", async () => {
  const first = Array.from({ length: 1000 }, (_, index) => candle(index, index === 200 ? 110 : 90));
  const second = [candle(1000, 105), candle(1001, 999)];
  const calls: string[] = [];
  const result = await readBinanceHistoricalAth("BTC", async (url) => {
    calls.push(url); return reply(calls.length === 1 ? first : second);
  }, 1001 * day + day / 2);
  assert.equal(result.price, 110);
  assert.equal(result.candleCount, 1001);
  assert.equal(result.fresh, true);
  assert.equal(result.source, "BINANCE_SPOT_BTCUSDC_CONFIRMED_1D_FULL_HISTORY");
  assert.equal(new URL(calls[1]!).searchParams.get("startTime"), String(999 * day + 1));
});

test("stale or malformed historical evidence cannot confirm an ATH", async () => {
  const stale = await readBinanceHistoricalAth("SOL", async () => reply([candle(1, 200)]), 100 * day);
  assert.equal(stale.fresh, false);
  await assert.rejects(readBinanceHistoricalAth("BTC", async () => reply([[1, 2, 3]]), 10 * day),
    /COINOPS_ATH_MARKET_RESPONSE_INVALID/);
  await assert.rejects(readBinanceHistoricalAth("BTC", async () => reply([candle(10, 100), candle(9, 101)]), 12 * day),
    /COINOPS_ATH_MARKET_RESPONSE_INVALID/);
});
