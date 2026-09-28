import assert from "node:assert/strict";
import test from "node:test";

import { canRestoreUnfilledEntry, planLiveEntryCapitalRefresh } from "../execution/live-entry-capital-refresh.ts";
import { planStrategyNextEntry, planStrategyPostAthNextEntry,
  type StrategyCandidate, type StrategyContext, type StrategyResidentBuy } from "../execution/strategy-engine.ts";

const input = (overrides: Partial<Parameters<typeof planLiveEntryCapitalRefresh>[0]> = {}) => ({
  order: { side: "BUY", purpose: "ENTRY", status: "NEW", requested_quantity: 0.139,
    executed_quantity: 0, cumulative_quote: 0 },
  slotState: "ARMED", positionQuantity: 0, balance: 59.76, price: 119.79,
  quantityStep: 0.001, minQuantity: 0.001, maxQuantity: 900000, minNotional: 5,
  spendable: 59.76, freeQuoteAfterCancel: 100, engineCap: 634, accountCap: 1053,
  maxOrder: 634, supportsUnfilledCancel: true,
  executorCaps: { engine: 634, account: 1053, max_order: 634 }, ...overrides,
});

test("applied SOLUSDT contribution resizes 0.139 to 0.498 at the unchanged 119.79 limit", () => {
  const source = input(), before = structuredClone(source);
  assert.deepEqual(planLiveEntryCapitalRefresh(source), {
    status: "REPLACE", quantity: 0.498, notional: 59.65542,
  });
  assert.deepEqual(source, before, "preflight must not mutate ledger or orders");
});

test("applied SOLBRL contribution resizes 0.018 to 0.034 using 21 BRL at 610.2", () => {
  assert.deepEqual(planLiveEntryCapitalRefresh(input({ balance: 21, spendable: 21,
    price: 610.2, minNotional: 10, order: { ...input().order, requested_quantity: 0.018 } })), {
    status: "REPLACE", quantity: 0.034, notional: 20.7468,
  });
});

test("already reflected contribution and rounding remainder never churn the resident BUY", () => {
  for (const balance of [59.76, 59.77]) {
    const result = planLiveEntryCapitalRefresh(input({ balance, spendable: balance,
      order: { ...input().order, requested_quantity: 0.498 } }));
    assert.deepEqual(result, { status: "KEEP", reason: "CAPITAL_ALREADY_REFLECTED_IN_BUY" });
  }
});

test("an OPEN slot keeps its pending contribution and SELL unchanged", () => {
  const open = input({ slotState: "OPEN", positionQuantity: 0.142,
    order: { ...input().order, side: "SELL", purpose: "TP" } });
  const before = structuredClone(open);
  assert.deepEqual(planLiveEntryCapitalRefresh(open), {
    status: "KEEP", reason: "POSITION_OR_ORDER_NOT_UNFILLED",
  });
  assert.deepEqual(open, before);
  assert.equal(planLiveEntryCapitalRefresh(input({ slotState: "OPEN" })).status, "KEEP");
});

test("partial, filled, prepared and unknown BUYs cannot enter capital cancellation", () => {
  for (const order of [
    { ...input().order, status: "PARTIALLY_FILLED", executed_quantity: 0.001, cumulative_quote: 0.11979 },
    { ...input().order, status: "FILLED", executed_quantity: 0.139, cumulative_quote: 16.65081 },
    { ...input().order, status: "PREPARED" },
    { ...input().order, status: "UNKNOWN" },
    { ...input().order, executed_quantity: 0.001 },
    { ...input().order, cumulative_quote: 0.01 },
    { ...input().order, purpose: "INITIAL" },
  ]) assert.equal(planLiveEntryCapitalRefresh(input({ order })).status, "KEEP");
});

test("old executor and unsynchronized engine/account/order caps leave the resident untouched", () => {
  for (const overrides of [
    { supportsUnfilledCancel: undefined }, { supportsUnfilledCancel: false },
    { executorCaps: undefined },
    { executorCaps: { engine: 419, account: 1053, max_order: 634 } },
    { executorCaps: { engine: 634, account: 838, max_order: 634 } },
    { executorCaps: { engine: 634, account: 1053, max_order: 419 } },
    { executorCaps: { engine: NaN, account: 1053, max_order: 634 } },
  ]) assert.deepEqual(planLiveEntryCapitalRefresh(input(overrides)), {
    status: "KEEP", reason: "CAPITAL_REFRESH_EXECUTOR_SYNC_PENDING",
  });
});

test("quantity follows exchange steps and keeps the old BUY until full required headroom is available", () => {
  const headroom = planLiveEntryCapitalRefresh(input({ spendable: 30 }));
  assert.deepEqual(headroom, { status: "KEEP", reason: "CAPITAL_REFRESH_HEADROOM_HOLD" });
  const exactStep = planLiveEntryCapitalRefresh(input({ balance: 59.895, spendable: 59.895 }));
  assert.deepEqual(exactStep, { status: "REPLACE", quantity: 0.5, notional: 59.895 });
  const belowStep = planLiveEntryCapitalRefresh(input({ balance: 59.8949, spendable: 59.8949 }));
  assert.equal(belowStep.status === "REPLACE" && belowStep.quantity, 0.499);
});

test("insufficient free funds and exchange filters preserve the old resident BUY", () => {
  for (const overrides of [
    { freeQuoteAfterCancel: 50 }, { maxQuantity: 0.49 }, { minQuantity: 0.5 }, { minNotional: 60 },
  ]) assert.deepEqual(planLiveEntryCapitalRefresh(input(overrides)), {
    status: "KEEP", reason: "CAPITAL_REFRESH_FUNDS_OR_FILTER_HOLD",
  });
});

test("missing or nonfinite sizing evidence never authorizes a cancel", () => {
  for (const overrides of [{ quantityStep: 0 }, { balance: NaN }, { price: Infinity },
    { freeQuoteAfterCancel: 0 }, { spendable: -1 }, { order: { ...input().order, requested_quantity: null } }]) {
    assert.deepEqual(planLiveEntryCapitalRefresh(input(overrides)), {
      status: "KEEP", reason: "CAPITAL_REFRESH_EVIDENCE_INCOMPLETE",
    });
  }
});

const orphan = { entry_state: "ARMED", position_quantity: 0 };
const canceled = { side: "BUY", purpose: "ENTRY", status: "CANCELED", executed_quantity: 0,
  cumulative_quote: 0, trades_reconciled: true };

test("crash after proven zero-fill cancel can restore only its orphan ARMED slot", () => {
  assert.equal(canRestoreUnfilledEntry(orphan, [canceled]), true);
  assert.equal(canRestoreUnfilledEntry(orphan, [canceled, { ...canceled, status: "REJECTED" }]), true);
  assert.equal(canRestoreUnfilledEntry({ ...orphan, position_quantity: "0" }, [canceled]), true);
});

test("orphan recovery rejects absent, active, unknown, filled and unreconciled evidence", () => {
  for (const orders of [[], [{ ...canceled, status: "NEW" }], [{ ...canceled, status: "PREPARED" }],
    [{ ...canceled, status: "UNKNOWN" }], [{ ...canceled, status: "FILLED" }],
    [{ ...canceled, executed_quantity: 0.001 }], [{ ...canceled, cumulative_quote: 0.1 }],
    [{ ...canceled, trades_reconciled: false }], [{ ...canceled, side: "SELL", purpose: "TP" }],
    [canceled, { ...canceled, status: "NEW" }], [{ ...canceled, status: "EXPIRED" }],
  ]) assert.equal(canRestoreUnfilledEntry(orphan, orders), false);
  assert.equal(canRestoreUnfilledEntry({ ...orphan, position_quantity: 0.001 }, [canceled]), false);
  assert.equal(canRestoreUnfilledEntry({ ...orphan, entry_state: "OPEN" }, [canceled]), false);
});

const context: StrategyContext = { asset: "SOL", quoteAsset: "USDT", cycleId: "cycle",
  observedAt: "2026-09-28T02:00:00.000Z", transitionKey: "QUEUE:2" };
const slot: StrategyCandidate = { id: "slot2", slotNumber: 2, operationSequence: 1,
  buyPrice: 119.79, balanceQuote: 59.76, operationalRank: 2, state: "ARMED" };
const resident: StrategyResidentBuy = { candidateId: slot.id, executedQuantity: 0,
  capitalRefresh: { quantityBefore: 0.139, quantityAfter: 0.498, notional: 59.65542 } };

test("Strategy Engine approves capital-only replacement on same slot and keeps retry decision stable", () => {
  const first = planStrategyNextEntry(context, [slot], 121.2, resident);
  assert.equal(first.decision.action_type, "CANCEL_REPLACE_NEXT_BUY");
  assert.equal(first.decision.reason, "APPLIED_CONTRIBUTION_UPDATES_RESIDENT_BUY");
  assert.equal(first.decision.target_price, slot.buyPrice);
  assert.equal(first.decision.target_notional, 59.65542);
  assert.equal(first.nextCandidateId, slot.id);
  const retry = planStrategyNextEntry({ ...context, observedAt: "2026-09-28T02:01:00.000Z" }, [slot], 121.1, resident);
  assert.equal(retry.decision.decision_id, first.decision.decision_id);
});

test("capital refresh cannot override crossed price or partial-fill priority", () => {
  assert.equal(planStrategyNextEntry(context, [slot], 119.79, resident).decision.reason,
    "RESIDENT_BUY_REQUIRES_RECONCILIATION");
  assert.equal(planStrategyNextEntry(context, [slot], 119, resident).decision.action_type, "WAIT");
  assert.equal(planStrategyNextEntry(context, [slot], 121.2, { ...resident, executedQuantity: 0.001 }).decision.reason,
    "RESIDENT_BUY_PARTIAL_FILL_PROTECTED");
});

test("higher valid strategy entry retains priority over capital refresh of a lower slot", () => {
  const higher: StrategyCandidate = { ...slot, id: "slot1", slotNumber: 1, operationalRank: 1,
    state: "PLANNED", buyPrice: 120, balanceQuote: 20 };
  const planned = planStrategyNextEntry(context, [slot, higher], 121.2, resident);
  assert.equal(planned.nextCandidateId, higher.id);
  assert.equal(planned.decision.reason, "HIGHER_VALID_ENTRY_HAS_PRIORITY");
  assert.equal(planned.decision.target_notional, 20);
});

test("monthly goal prevents capital refresh from re-enabling an ineligible slot", () => {
  const planned = planStrategyNextEntry(context, [{ ...slot, monthlyTargetReached: true }], 121.2, resident);
  assert.equal(planned.decision.action_type, "WAIT");
  assert.equal(planned.nextCandidateId, null);
});

test("POST_ATH resident reserve slot receives only the already-preflighted refresh", () => {
  const planned = planStrategyPostAthNextEntry(context, [{ ...slot, postAthGroup: "RESERVE" }], 121.2, resident);
  assert.equal(planned.decision.action_type, "CANCEL_REPLACE_NEXT_BUY");
  assert.equal(planned.nextCandidateId, slot.id);
  assert.equal(planned.decision.target_price, slot.buyPrice);
});

test("invalid capital proof cannot alter order size or price via Strategy Engine", () => {
  for (const capitalRefresh of [
    { quantityBefore: 0.498, quantityAfter: 0.498, notional: 59.65542 },
    { quantityBefore: 0.139, quantityAfter: 0.6, notional: 71.874 },
    { quantityBefore: 0.139, quantityAfter: 0.498, notional: 58 },
    { quantityBefore: NaN, quantityAfter: 0.498, notional: 59.65542 },
  ]) assert.throws(() => planStrategyNextEntry(context, [slot], 121.2, { ...resident, capitalRefresh }),
    /COINOPS_STRATEGY_CAPITAL_REFRESH_INVALID/);
});
