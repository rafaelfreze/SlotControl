import assert from "node:assert/strict";
import test from "node:test";
import { parseMarketTicker, validMarketSymbols } from "./use-automation-market-prices.ts";

test("market stream parses only positive prices and subscribed symbols", () => {
  const symbols = validMarketSymbols(["BTCBRL", "SOLUSDT", "BTCBRL", "../../bad"]);
  assert.deepEqual(symbols, ["BTCBRL", "BTCUSDT", "SOLUSDT"]);
  const allowed = new Set(symbols);
  assert.deepEqual(parseMarketTicker({ stream: "btcbrl@miniTicker", data: { s: "BTCBRL", c: "440000.00" } }, allowed),
    { symbol: "BTCBRL", price: 440000 });
  assert.equal(parseMarketTicker({ data: { s: "ETHUSDT", c: "3000" } }, allowed), null);
  assert.equal(parseMarketTicker({ data: { s: "BTCBRL", c: "0" } }, allowed), null);
  assert.equal(parseMarketTicker({ data: { s: "BTCBRL", c: "oops" } }, allowed), null);
});
