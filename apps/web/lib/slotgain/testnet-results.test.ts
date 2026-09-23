import assert from "node:assert/strict";
import test from "node:test";
import { summarizeTestnetResults, testnetDiagnosticIssue, testnetPresentationHealth, type TestnetResultOrder, type TestnetResultSlot } from "./testnet-results.ts";

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

test("Testnet current row ignores completed orders from earlier operation sequences", () => {
  const recycled = { ...slot, entry_state: "ARMED", operation_sequence: 2, entry_origin: "REENTRY", entry_reference_price: 100, last_take_profit_price: 100.5, balance_usdc: 10.05, gain_count: 1, net_profit_usdc: .05 };
  const previousBuy = { ...order, operation_sequence: 1, client_order_id: "old-buy" };
  const previousTp = { ...order, operation_sequence: 1, side: "SELL", purpose: "TP", client_order_id: "old-tp", price: 100.5, cumulative_quote: 10.05 };
  const currentBuy = { ...order, operation_sequence: 2, purpose: "ENTRY", client_order_id: "reentry-buy", exchange_order_id: "3", status: "NEW", executed_quantity: 0, cumulative_quote: 0, requested_quantity: .100, price: 100 };
  const result = summarizeTestnetResults([recycled], [previousBuy, previousTp, currentBuy], 101, 10);
  assert.equal(result.rows[0].orders.length, 1);
  assert.equal(result.rows[0].buy?.client_order_id, "reentry-buy");
  assert.equal(result.rows[0].takeProfitPrice, null);
  assert.equal(result.rows[0].remainingQuantity, 0);
  assert.equal(result.rows[0].reservedBuyCapital, 10);
  assert.equal(result.realizedProfit, .05);
});

const temporalNow = Date.parse("2026-09-23T16:00:00Z");
const healthyRun = { status: "ACTIVE", last_error: null, last_reconciled_at: "2026-09-23T15:59:30Z" };
function temporalFixture(asset: "BTC" | "SOL") {
  const cycleId = `cycle-${asset}`;
  const target = asset === "BTC" ? 85480.48 : 118.97;
  const slots = Array.from({ length: 25 }, (_, index): TestnetResultSlot => ({
    ...slot, slot_number: index + 1, entry_state: "PLANNED", target_buy_price: target * .99 ** index, operation_sequence: 1
  }));
  slots[0] = { ...slots[0]!, entry_state: "MISSED", entry_origin: "REENTRY", operation_sequence: 2, missed_at: "2026-09-23T15:00:00Z" };
  slots[1]!.entry_state = "OPEN";
  slots[2]!.entry_state = "ARMED";
  const orders: TestnetResultOrder[] = [
    { ...order, slot_number: 2, operation_sequence: 1, client_order_id: "current-open-buy" },
    { ...order, slot_number: 2, operation_sequence: 1, side: "SELL", purpose: "TP", status: "NEW", client_order_id: "resident-tp", exchange_order_id: "2", price: target, executed_quantity: 0, cumulative_quote: 0 },
    { ...order, slot_number: 3, operation_sequence: 1, purpose: "ENTRY", status: "NEW", client_order_id: "resident-next-buy", exchange_order_id: "3", price: target * .99 ** 2, executed_quantity: 0, cumulative_quote: 0 }
  ];
  const events = [
    { id: "original-missed", run_id: cycleId, slot_number: 1, event_type: "MISSED_LEVEL", observed_at: "2026-09-23T15:00:00Z", created_at: "2026-09-23T15:00:01Z",
      details: { operation_sequence: 2, target_price: target } },
    { id: "diagnosis", run_id: cycleId, slot_number: 1, event_type: "MISSED_LEVEL_DIAGNOSED", observed_at: "2026-09-23T15:05:00Z",
      details: { original_event_id: "original-missed", first_cross_at: "2026-09-23T13:00:00Z", detected_at: "2026-09-23T15:00:00Z",
        root_cause: "STALE_CACHED_RUN_DISCOVERY", resolved_at: "2026-09-23T14:40:00Z", resolved_by_version: "4.1.0", evidence_source: "exchange-fill-and-strategy-checkpoint" } }
  ];
  return { slots, orders, context: { asset, cycleId, events } };
}

test("BTC and SOL historical missed keep 25 exclusive current states and a green evidenced motor", () => {
  for (const asset of ["BTC", "SOL"] as const) {
    const input = temporalFixture(asset);
    const before = structuredClone(input);
    const result = summarizeTestnetResults(input.slots, input.orders, 120, 10, input.context);
    assert.equal(result.rows[0]!.operationalState, "REENTRY_WAITING");
    assert.equal(result.rows[0]!.persisted_entry_state, "MISSED");
    assert.equal(result.temporalSummary.historicalCount, 1);
    assert.equal(result.temporalSummary.currentVersionCount, 0);
    assert.equal(result.temporalSummary.activeIssueCount, 0);
    assert.deepEqual([result.openSlots, result.armedSlots, result.reentryWaitingSlots, result.plannedSlots, result.activeErrorSlots], [1, 1, 1, 22, 0]);
    assert.equal(result.openSlots + result.armedSlots + result.reentryWaitingSlots + result.plannedSlots + result.activeErrorSlots, 25);
    const health = testnetPresentationHealth(result, healthyRun, temporalNow);
    assert.equal(health.tone, "ok");
    assert.equal(health.label, "Motor OK — ocorrências históricas preservadas");
    assert.deepEqual(input, before);
  }
});

test("historical missed can coexist with a current OPEN, NEXT BUY or PLANNED without overriding it", () => {
  const input = temporalFixture("SOL");
  input.slots[0] = { ...input.slots[0]!, entry_state: "OPEN", operation_sequence: 3 };
  input.orders.push({ ...order, slot_number: 1, operation_sequence: 3, client_order_id: "new-operation-buy" });
  let result = summarizeTestnetResults(input.slots, input.orders, 120, 10, input.context);
  assert.equal(result.rows[0]!.operationalState, "OPEN");
  assert.equal(result.rows[0]!.historicalOccurrences.length, 1);
  input.orders.pop();
  input.slots[0]!.entry_state = "ARMED";
  result = summarizeTestnetResults(input.slots, input.orders, 120, 10, input.context);
  assert.equal(result.rows[0]!.operationalState, "NEXT_BUY");
  input.slots[0] = { ...input.slots[0]!, entry_state: "PLANNED", entry_origin: "GRID", operation_sequence: 1 };
  result = summarizeTestnetResults(input.slots, input.orders, 120, 10, input.context);
  assert.equal(result.rows[0]!.operationalState, "PLANNED");
});

test("post-version regression is a red current failure, while missing evidence stays yellow", () => {
  const input = temporalFixture("BTC");
  const regressionEvents = [{ ...input.context.events[0]!, details: { operation_sequence: 2, first_cross_at: "2026-09-23T15:00:00Z", root_cause: "ENGINE_PRIORITY_VIOLATION" } }];
  let result = summarizeTestnetResults(input.slots, input.orders, 85000, 10, { ...input.context, events: regressionEvents });
  assert.equal(result.rows[0]!.operationalState, "ACTIVE_ERROR");
  assert.equal(result.temporalSummary.historicalCount, 0);
  assert.equal(result.temporalSummary.currentVersionCount, 1);
  assert.equal(testnetPresentationHealth(result, healthyRun, temporalNow).tone, "error");
  result = summarizeTestnetResults(input.slots, input.orders, 85000, 10, { ...input.context, events: [] });
  assert.equal(result.temporalSummary.unresolvedCount, 1);
  assert.equal(result.activeErrorSlots, 1);
  assert.equal(testnetPresentationHealth(result, healthyRun, temporalNow).tone, "attention");
});

test("resolved history never masks stale reconciliation, missing TP, duplicate BUY or runtime failure", () => {
  const input = temporalFixture("SOL");
  let result = summarizeTestnetResults(input.slots, input.orders, 120, 10, input.context);
  assert.equal(testnetPresentationHealth(result, { ...healthyRun, last_reconciled_at: "2026-09-23T15:50:00Z" }, temporalNow).tone, "attention");
  assert.equal(testnetPresentationHealth(result, { ...healthyRun, last_error: "COINOPS_TESTNET_RECOVERY_FAILED" }, temporalNow).tone, "error");
  result = summarizeTestnetResults(input.slots, input.orders.filter((item) => item.purpose !== "TP"), 120, 10, input.context);
  assert.equal(testnetPresentationHealth(result, healthyRun, temporalNow).tone, "error");
  result = summarizeTestnetResults(input.slots, [...input.orders, { ...input.orders[2]!, slot_number: 4, client_order_id: "duplicate-resident" }], 120, 10, input.context);
  assert.equal(testnetPresentationHealth(result, healthyRun, temporalNow).tone, "error");
  result = summarizeTestnetResults(input.slots.slice(1), input.orders, 120, 10, input.context);
  assert.equal(testnetPresentationHealth(result, healthyRun, temporalNow).tone, "error");
});

test("a partial BUY is one OPEN physical slot, never counted twice as NEXT BUY", () => {
  const partial = { ...order, status: "PARTIALLY_FILLED", executed_quantity: .04, cumulative_quote: 4 };
  const result = summarizeTestnetResults([{ ...slot, entry_state: "ARMED" }], [partial], 101, 10);
  assert.equal(result.openSlots, 1);
  assert.equal(result.armedSlots, 0);
  assert.equal(result.rows[0]!.operationalState, "OPEN");
});

test("explicit Testnet permission denials stay yellow even with an otherwise healthy reconciled ledger", () => {
  const input = temporalFixture("SOL");
  const result = summarizeTestnetResults(input.slots, input.orders, 120, 10, input.context);
  const permitted = { ok: true, account: { canTrade: true }, tradePermission: { ok: true }, userStreamPermission: { ok: true } };
  for (const snapshot of [null, undefined, permitted]) {
    assert.equal(testnetDiagnosticIssue(snapshot), null);
    assert.equal(testnetPresentationHealth(result, healthyRun, temporalNow, testnetDiagnosticIssue(snapshot)).tone, "ok");
  }
  for (const snapshot of [
    { ...permitted, tradePermission: { ok: false } },
    { ...permitted, userStreamPermission: { ok: false } },
    { ...permitted, account: { canTrade: false } },
    { ok: false, error: "COINOPS_TESTNET_DIAGNOSTIC_FAILED" },
    { ok: false }
  ]) {
    const issue = testnetDiagnosticIssue(snapshot);
    assert.ok(issue);
    assert.equal(testnetPresentationHealth(result, healthyRun, temporalNow, issue).tone, "attention");
    assert.equal(testnetPresentationHealth(result, { ...healthyRun, last_error: "ENGINE_FAILURE" }, temporalNow, issue).tone, "error");
  }
  assert.equal(testnetDiagnosticIssue(permitted, "COINOPS_TESTNET_START_FAILED"), "COINOPS_TESTNET_START_FAILED");
  assert.equal(testnetDiagnosticIssue(null, "COINOPS_TESTNET_START_FAILED"), "COINOPS_TESTNET_START_FAILED");
});
