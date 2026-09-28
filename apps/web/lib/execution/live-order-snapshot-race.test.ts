import test from "node:test";
import assert from "node:assert/strict";
import { isConfirmedFilledSnapshotRace } from "./live-order-snapshot-race.ts";

const expected = { client_order_id: "COR1-BTC-3-1-SELL-a18a83508f069e",
  exchange_order_id: "2337953825", side: "SELL" as const };
const order = { orderId: expected.exchange_order_id, clientOrderId: expected.client_order_id,
  symbol: "BTCBRL", side: "SELL" as const, status: "FILLED", executedQuantity: 0.00004,
  cumulativeQuoteQuantity: 17.46468, price: 436617 };
const trades = [{ id: "64932843", quantity: 0.00004, quoteQuantity: 17.46468,
  commission: 0.026, commissionAsset: "BRL", isBuyer: false,
  filledAt: "2026-09-28T13:30:12.956Z" }];

test("exact trade-backed TP fill is a retryable openOrders snapshot race", () => {
  assert.equal(isConfirmedFilledSnapshotRace(expected, "BTCBRL", order, order, trades), true);
});

test("a missing, canceled, foreign or unproven order remains fail-closed", () => {
  assert.equal(isConfirmedFilledSnapshotRace(expected, "BTCBRL", null, null, null), false);
  assert.equal(isConfirmedFilledSnapshotRace(expected, "BTCBRL", { ...order, status: "CANCELED" }, order, trades), false);
  assert.equal(isConfirmedFilledSnapshotRace(expected, "BTCBRL", { ...order, orderId: "other" }, order, trades), false);
  assert.equal(isConfirmedFilledSnapshotRace(expected, "BTCBRL", order, order, []), false);
  assert.equal(isConfirmedFilledSnapshotRace(expected, "BTCBRL", order, order,
    [{ ...trades[0], isBuyer: true }]), false);
});
