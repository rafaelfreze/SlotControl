import assert from "node:assert/strict";
import test from "node:test";
import { summarizeTestnetResults, type TestnetResultOrder, type TestnetResultSlot } from "./testnet-results.ts";

const slot: TestnetResultSlot = { slot_number: 1, entry_state: "OPEN", target_buy_price: 100, balance_usdc: 10, gain_count: 0, net_profit_usdc: 0, missed_at: null };
const order: TestnetResultOrder = { slot_number: 1, side: "BUY", purpose: "INITIAL", revision: 1, client_order_id: "owned-buy", exchange_order_id: "1", status: "FILLED", requested_quantity: 0.1, price: null, executed_quantity: 0.1, cumulative_quote: 10, created_at: "2026-09-22T12:00:00Z", updated_at: "2026-09-22T12:00:01Z", fee_base: 0, fee_quote: 0, fee_other: [] };

test("Testnet result uses persisted slot compounding and separates completed operations from gains", () => {
  const result = summarizeTestnetResults([{ ...slot, entry_state: "CLOSED", balance_usdc: 10.05, gain_count: 1, net_profit_usdc: .05 }, { ...slot, slot_number: 2, entry_state: "PLANNED" }], [order, { ...order, side: "SELL", purpose: "TP", client_order_id: "owned-tp", price: 100.5, cumulative_quote: 10.05 }], 102, 10);
  assert.equal(result.capital, 20.05);
  assert.equal(result.initialCapital, 20);
  assert.equal(result.gains, 1);
  assert.equal(result.completedOperations, 1);
  assert.equal(result.realizedProfit, .05);
  assert.equal(result.openPnl, 0);
  assert.equal(result.rows[1].takeProfitPrice, null);
});
test("Testnet partial fills keep remaining position and entry quote fees in open PnL", () => {
  const result = summarizeTestnetResults([slot], [{ ...order, fee_base: .001, fee_quote: .01 }, { ...order, side: "SELL", purpose: "TP", status: "PARTIALLY_FILLED", client_order_id: "tp", price: 105, executed_quantity: .04, cumulative_quote: 4.2 }], 110, 10);
  assert.ok(Math.abs(result.rows[0].remainingQuantity - .059) < 1e-10);
  assert.ok(Math.abs(result.committedCapital - 10.01 * .059 / .099) < 1e-10);
  assert.equal(result.openSlots, 1);
  assert.equal(result.completedOperations, 0);
  assert.equal(result.realizedProfit, 0);
});
test("Testnet unknown market/fee valuation is explicit and canceled replacements are not operations", () => {
  const result = summarizeTestnetResults([slot], [{ ...order, fee_other: [{ asset: "BNB" }] }, { ...order, status: "CANCELED", executed_quantity: 0, cumulative_quote: 0, revision: 2 }], 101, null);
  assert.equal(result.openPnl, null);
  assert.equal(result.completedOperations, 0);
  assert.equal(result.initialCapital, null);
  assert.equal(summarizeTestnetResults([slot], [order], null, 10).openPnl, null);
});

test("Testnet committed capital includes only unfilled resident BUY reservations without counting fills twice", () => {
  const slots = [slot, { ...slot, slot_number: 2, entry_state: "ARMED" }];
  const partialBuy = { ...order, status: "PARTIALLY_FILLED", requested_quantity: .1, executed_quantity: .04, cumulative_quote: 4, price: 100 };
  const localIntent = { ...order, slot_number: 2, purpose: "ENTRY", status: "PREPARED", exchange_order_id: null, executed_quantity: 0, cumulative_quote: 0, price: 100 };
  const canceled = { ...order, status: "CANCELED", executed_quantity: 0, cumulative_quote: 0, price: 100, revision: 2 };
  const residentTp = { ...order, side: "SELL", purpose: "TP", status: "NEW", requested_quantity: .04, executed_quantity: 0, cumulative_quote: 0, price: 105 };
  const result = summarizeTestnetResults(slots, [partialBuy, localIntent, canceled, residentTp], 105, 10);
  assert.ok(Math.abs(result.rows[0].positionCapital - 4) < 1e-10);
  assert.ok(Math.abs(result.reservedBuyCapital - 6) < 1e-10);
  assert.ok(Math.abs(result.committedCapital - 10) < 1e-10);
  assert.ok(Math.abs(result.freeCapital - 10) < 1e-10);
  assert.equal(result.rows[1].reservedBuyCapital, 0);
  assert.equal(result.capital, 20); // Ledger capital is not marked up by open PnL.
  const placed = summarizeTestnetResults(slots, [partialBuy, { ...localIntent, status: "NEW", exchange_order_id: "2" }], 105, 10);
  assert.ok(Math.abs(placed.reservedBuyCapital - 16) < 1e-10);
  assert.ok(Math.abs(placed.committedCapital - 20) < 1e-10);
  assert.equal(placed.freeCapital, 0);
});
