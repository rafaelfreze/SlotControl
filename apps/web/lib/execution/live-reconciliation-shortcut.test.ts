import assert from "node:assert/strict";
import test from "node:test";

import { unchangedUnfilledOpenOrder, unchangedUnfilledResidentOrder } from "./live-reconciliation-shortcut.ts";

const ledger = { status: "NEW", side: "BUY" as const, purpose: "ENTRY",
  client_order_id: "C2-account-engine-1-B", exchange_order_id: "1001",
  submission_guarded_at: "2026-09-26T12:00:00Z", trades_reconciled: false, price: "42000.01",
  executed_quantity: "0", cumulative_quote: "0" };
const exchange = { status: "NEW", symbol: "BTCUSDT", side: "BUY" as const,
  clientOrderId: "C2-account-engine-1-B", orderId: "1001", price: 42000.01,
  executedQuantity: 0, cumulativeQuoteQuantity: 0 };

test("unchanged unfilled resident BUY or TP needs no trade-history read", () => {
  assert.equal(unchangedUnfilledResidentOrder(ledger, exchange, "BTCUSDT"), true);
  assert.equal(unchangedUnfilledResidentOrder({ ...ledger, side: "SELL", purpose: "TP" },
    { ...exchange, side: "SELL" }, "BTCUSDT"), true);
});

test("every fill, terminal status, uncertain claim or identity/price change requires full reconciliation", () => {
  const cases = [
    [ledger, { ...exchange, status: "FILLED" }],
    [ledger, { ...exchange, executedQuantity: 0.00001 }],
    [ledger, { ...exchange, cumulativeQuoteQuantity: 1 }],
    [{ ...ledger, executed_quantity: "0.00001" }, exchange],
    [{ ...ledger, cumulative_quote: "1" }, exchange],
    [{ ...ledger, status: "PARTIALLY_FILLED" }, exchange],
    [{ ...ledger, submission_guarded_at: null }, exchange],
    [{ ...ledger, exchange_order_id: null }, exchange],
    [ledger, { ...exchange, orderId: "1002" }],
    [ledger, { ...exchange, clientOrderId: "other-account" }],
    [ledger, { ...exchange, symbol: "SOLUSDT" }],
    [ledger, { ...exchange, side: "SELL" }],
    [ledger, { ...exchange, price: 42000.02 }],
  ] as const;
  for (const [stored, observed] of cases)
    assert.equal(unchangedUnfilledResidentOrder(stored, observed, "BTCUSDT"), false);
});

test("fresh open-orders snapshot skips individual query only for an exact unfilled resident", () => {
  const now = Date.parse("2026-09-26T14:00:00.000Z");
  const observedAt = "2026-09-26T13:59:59.000Z";
  const open = { id: "1001", symbol: "BTCUSDT", side: "BUY", status: "NEW",
    clientOrderId: ledger.client_order_id, executedQuantity: 0, price: 42000.01 };
  assert.equal(unchangedUnfilledOpenOrder(ledger, open, "BTCUSDT", observedAt, now), true);
  for (const changed of [
    { ...open, id: "1002" }, { ...open, clientOrderId: "other" },
    { ...open, symbol: "SOLUSDT" }, { ...open, side: "SELL" },
    { ...open, status: "PARTIALLY_FILLED" }, { ...open, executedQuantity: 0.00001 },
    { ...open, price: 42000.02 },
  ]) assert.equal(unchangedUnfilledOpenOrder(ledger, changed, "BTCUSDT", observedAt, now), false);
  assert.equal(unchangedUnfilledOpenOrder({ ...ledger, cumulative_quote: "1" }, open,
    "BTCUSDT", observedAt, now), false);
  assert.equal(unchangedUnfilledOpenOrder({ ...ledger, submission_guarded_at: null }, open,
    "BTCUSDT", observedAt, now), false);
  assert.equal(unchangedUnfilledOpenOrder(ledger, open, "BTCUSDT",
    "2026-09-26T13:59:29.000Z", now), false);
  assert.equal(unchangedUnfilledOpenOrder(ledger, open, "BTCUSDT",
    "2026-09-26T14:00:01.000Z", now), false);
});
