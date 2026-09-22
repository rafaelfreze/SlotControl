import assert from "node:assert/strict";
import test from "node:test";

import { reconcileShadowWithExchange } from "../execution/reconciliation.ts";

const intent = { id: "intent-1", idempotencyKey: "deterministic-key", symbol: "BTCUSDT", side: "BUY" as const, quantity: 0.001, observedMarketPrice: 60000, status: "SHADOW_RECORDED" };
const order = { id: "order-1", symbol: "BTCUSDT", side: "BUY" as const, status: "FILLED", executedQuantity: 0.001, price: 60000, clientOrderId: "deterministic-key", updateTime: "2026-09-21T00:00:00.000Z" };

test("reconciliation only matches deterministic client ids and never guesses historic trades", () => {
  const result = reconcileShadowWithExchange({ intents: [intent], orders: [{ ...order, clientOrderId: "old-binance-order" }], trades: [{ id: "trade-old", orderId: "order-old", symbol: "BTCUSDT", side: "BUY", quantity: 0.001, price: 60000, quoteQuantity: 60, time: null, isMaker: false }], balances: [] });
  assert.equal(result.summary.EXPECTED_ONLY, 1);
  assert.equal(result.summary.EXCHANGE_ONLY, 2);
  assert.equal(result.items.some((item) => item.classification === "MATCH"), false);
});

test("reconciliation classifies match, partial, quantity and price differences without changing a slot", () => {
  const match = reconcileShadowWithExchange({ intents: [intent], orders: [order], trades: [], balances: [] });
  assert.equal(match.summary.MATCH, 1);
  const partial = reconcileShadowWithExchange({ intents: [intent], orders: [{ ...order, status: "PARTIALLY_FILLED", executedQuantity: 0.0005 }], trades: [], balances: [] });
  assert.equal(partial.summary.STATUS_MISMATCH, 1);
  const quantity = reconcileShadowWithExchange({ intents: [intent], orders: [{ ...order, executedQuantity: 0.002 }], trades: [], balances: [] });
  assert.equal(quantity.summary.QUANTITY_MISMATCH, 1);
  const price = reconcileShadowWithExchange({ intents: [intent], orders: [{ ...order, price: 61000 }], trades: [], balances: [] });
  assert.equal(price.summary.PRICE_MISMATCH, 1);
});

test("reconciliation snapshots BTC, SOL and USDT balances as unknown financial facts", () => {
  const result = reconcileShadowWithExchange({ intents: [], orders: [], trades: [], balances: [{ asset: "USDT", free: 10, locked: 2, total: 12 }, { asset: "ETH", free: 1, locked: 0, total: 1 }] });
  assert.equal(result.summary.UNKNOWN, 1);
  assert.equal(result.items[0]?.exchangeReference, "USDT");
});
