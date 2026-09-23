import assert from "node:assert/strict";
import test from "node:test";

import { STRATEGY_VERSION, isStrategyDecisionProven, planStrategyClosedSlot, planStrategyInitialEntry, planStrategyNextEntry, planStrategyTakeProfit,
  strategyOperationId, wasStrategyOrderResidentAt, type StrategyCandidate, type StrategyContext } from "../execution/strategy-engine.ts";
import type { ExchangeSymbolInfo } from "../execution/types.ts";

const context: StrategyContext = { asset: "SOL", cycleId: "cycle-sol", observedAt: "2026-09-23T12:30:00.000Z" };
const candidate = (slotNumber: number, buyPrice: number, overrides: Partial<StrategyCandidate> = {}): StrategyCandidate => ({
  id: `physical-${slotNumber}`, slotNumber, operationSequence: 1, buyPrice, balanceUsdc: 10, state: "PLANNED", ...overrides
});
const ladder = () => Array.from({ length: 25 }, (_, index) => candidate(index + 1, Number((120 * .99 ** index).toFixed(2))));
const filters: ExchangeSymbolInfo = { symbol: "SOLUSDC", baseAsset: "SOL", quoteAsset: "USDC", priceTick: .01, quantityStep: .001,
  minQuantity: .001, maxQuantity: 900000, minNotional: 5 };

test("initial MARKET is confined to the first operation of Slot 1; recovery never duplicates it", () => {
  const initial = planStrategyInitialEntry(context, candidate(1, 120));
  assert.equal(initial.action_type, "OPEN_INITIAL_MARKET");
  assert.equal(initial.strategy_version, "4.1.0");
  assert.equal(initial.target_notional, 10);
  assert.equal(planStrategyInitialEntry(context, candidate(1, 120, { state: "OPEN" })).action_type, "WAIT");
  assert.equal(planStrategyInitialEntry(context, candidate(1, 120, { state: "ARMED" })).action_type, "WAIT");
  assert.throws(() => planStrategyInitialEntry(context, candidate(2, 118.8)), /INITIAL_SLOT_INVALID/);
  assert.throws(() => planStrategyInitialEntry(context, candidate(1, 120, { operationSequence: 2 })), /INITIAL_SLOT_INVALID/);
});

test("SOL regression: 118.97 local reentry replaces resident 116.60 ahead of 117.78", () => {
  const slots = [candidate(1, 118.97, { operationSequence: 2, balanceUsdc: 10.049 }), candidate(2, 117.78), candidate(3, 116.60, { state: "ARMED" })];
  const result = planStrategyNextEntry(context, slots, 119.56, { candidateId: "physical-3", executedQuantity: 0 });
  assert.equal(result.decision.action_type, "CANCEL_REPLACE_NEXT_BUY");
  assert.equal(result.nextCandidateId, "physical-1");
  assert.equal(result.decision.target_price, 118.97);
  assert.equal(result.decision.target_notional, 10.049);
  assert.deepEqual(result.missedCandidateIds, []);
  assert.deepEqual(result, planStrategyNextEntry(context, [...slots].reverse(), 119.56, { candidateId: "physical-3", executedQuantity: 0 }));
});

test("crossed unarmed reentry is missed, not MARKET or a fabricated fill", () => {
  const result = planStrategyNextEntry(context, [candidate(1, 118.97), candidate(2, 117.78), candidate(3, 116.60)], 117);
  assert.deepEqual(result.missedCandidateIds, ["physical-1", "physical-2"]);
  assert.equal(result.decision.action_type, "ARM_NEXT_BUY");
  assert.equal(result.decision.target_price, 116.60);
  const exhausted = planStrategyNextEntry(context, [candidate(1, 118.97), candidate(2, 117.78)], 116);
  assert.equal(exhausted.decision.action_type, "WAIT");
  assert.equal(exhausted.nextCandidateId, null);
});

test("partial fill and crossed resident orders wait for reconciliation before any replacement", () => {
  const slots = [candidate(1, 118.97), candidate(2, 117.78, { state: "ARMED" })];
  const partial = planStrategyNextEntry(context, slots, 119.56, { candidateId: "physical-2", executedQuantity: .01 });
  assert.equal(partial.decision.reason, "RESIDENT_BUY_PARTIAL_FILL_PROTECTED");
  assert.equal(partial.decision.action_type, "WAIT");
  assert.equal(partial.nextCandidateId, "physical-2");
  const crossed = planStrategyNextEntry(context, slots, 117, { candidateId: "physical-2", executedQuantity: 0 });
  assert.equal(crossed.decision.reason, "RESIDENT_BUY_REQUIRES_RECONCILIATION");
  assert.equal(crossed.decision.action_type, "WAIT");
  assert.deepEqual(crossed.missedCandidateIds, ["physical-1"]);
});

test("single active entry fails closed for duplicate slots, multiple BUYs, and wrong resident identity", () => {
  assert.throws(() => planStrategyNextEntry(context, [candidate(1, 118), candidate(1, 117, { id: "duplicate" })], 120), /CANDIDATE_INVALID/);
  assert.throws(() => planStrategyNextEntry(context, [candidate(1, 118, { state: "ARMED" }), candidate(2, 117, { state: "ARMED" })], 120), /MULTIPLE_ARMED_BUYS/);
  assert.throws(() => planStrategyNextEntry(context, [candidate(1, 118)], 120, { candidateId: "foreign", executedQuantity: 0 }), /RESIDENT_BUY_INVALID/);
});

test("local close preserves price and compounds only its physical slot; no initial MARKET reentry", () => {
  const slots = ladder();
  slots[0] = candidate(1, 118.97, { state: "CLOSED", balanceUsdc: 10.049 });
  slots[1]!.state = "OPEN";
  const original = structuredClone(slots);
  const plan = planStrategyClosedSlot(context, slots, "physical-1");
  assert.equal(plan.mode, "LOCAL_REENTRY");
  assert.equal(plan.otherOpenPositions, 1);
  assert.equal(plan.decisions.length, 1);
  assert.equal(plan.decisions[0]!.action_type, "PLAN_LOCAL_REENTRY");
  assert.equal(plan.decisions[0]!.target_price, 118.97);
  assert.equal(plan.decisions[0]!.target_notional, 10.049);
  assert.equal(plan.decisions[0]!.operation_id, strategyOperationId(context, { ...slots[0]!, operationSequence: 2 }));
  assert.deepEqual(slots, original);
});

test("only the final open position permits global reanchor; partially filled BUY prevents reset", () => {
  const slots = ladder();
  slots[0]!.state = "CLOSED";
  slots[0]!.balanceUsdc = 10.05;
  slots[1]!.state = "ARMED";
  const terminal = planStrategyClosedSlot(context, slots, "physical-1");
  assert.equal(terminal.mode, "GLOBAL_RESET");
  assert.deepEqual(terminal.decisions.map((value) => value.action_type), ["COMPLETE_CYCLE", "REANCHOR"]);
  assert.equal(terminal.decisions[1]!.reason, "REBUILD_AFTER_OWNED_PENDING_BUY_CANCELLATION");
  assert.equal(terminal.decisions[1]!.target_notional, 250.05);
  slots[1]!.state = "PARTIALLY_FILLED";
  assert.equal(planStrategyClosedSlot(context, slots, "physical-1").mode, "LOCAL_REENTRY");
  assert.throws(() => planStrategyClosedSlot(context, slots.slice(0, 24), "physical-1"), /SLOT_COUNT_INVALID/);
});

test("TP uses confirmed average fill and frozen gain; existing TP and partial BUY do not duplicate protection", () => {
  const slot = candidate(1, 118.97, { state: "OPEN" });
  const parameters = { gainRate: .005, entrySpacing: .01 };
  const plan = planStrategyTakeProfit(context, slot, 118.97, filters, parameters);
  assert.equal(plan.action_type, "CREATE_TP");
  assert.equal(plan.target_price, 119.57);
  assert.equal(planStrategyTakeProfit(context, slot, 118.97, filters, parameters, true).action_type, "WAIT");
  assert.equal(planStrategyTakeProfit(context, { ...slot, state: "PARTIALLY_FILLED" }, 118.97, filters, parameters).action_type, "WAIT");
  assert.throws(() => planStrategyTakeProfit({ ...context, asset: "BTC" }, slot, 118.97, filters, parameters), /SYMBOL_MISMATCH/);
});

test("decision replay is idempotent across worker delivery times and scoped by asset, cycle and operation", () => {
  const slot = candidate(1, 120);
  const first = planStrategyInitialEntry(context, slot);
  const repeated = planStrategyInitialEntry({ ...context, observedAt: "2026-09-23T12:31:00Z" }, slot);
  assert.equal(first.decision_id, repeated.decision_id);
  assert.equal(first.operation_id, repeated.operation_id);
  assert.notEqual(first.created_at, repeated.created_at);
  assert.notEqual(first.decision_id, planStrategyInitialEntry({ ...context, asset: "BTC" }, slot).decision_id);
  assert.notEqual(first.operation_id, planStrategyInitialEntry({ ...context, cycleId: "new-cycle" }, slot).operation_id);
  assert.notEqual(first.operation_id, strategyOperationId(context, { ...slot, operationSequence: 2 }));
  const coverageRevision = planStrategyInitialEntry({ ...context, transitionKey: "coverage-2" }, slot);
  assert.notEqual(first.decision_id, coverageRevision.decision_id);
  assert.equal(first.operation_id, coverageRevision.operation_id);
});

test("a candle never fills an order armed during it, including crash recovery of a newly created TP", () => {
  const started = "2026-09-23T04:23:00Z";
  assert.equal(wasStrategyOrderResidentAt("2026-09-23T04:22:59.999Z", started), true);
  assert.equal(wasStrategyOrderResidentAt(started, started), true);
  assert.equal(wasStrategyOrderResidentAt("2026-09-23T04:23:36.439Z", started), false);
  assert.equal(wasStrategyOrderResidentAt("2026-09-23T04:23:59.999Z", started), false);
  assert.equal(wasStrategyOrderResidentAt(null, started), false);
  assert.equal(wasStrategyOrderResidentAt("invalid", started), false);
  assert.equal(wasStrategyOrderResidentAt("2026-09-23T04:23:59.999Z", "2026-09-23T04:24:00Z"), true);
});

test("TP candle low applies only to old candidates; a new local reentry is armed from the close", () => {
  const slots = [candidate(1, 118.97, { state: "CLOSED" }), candidate(2, 117.78, { state: "OPEN" }), candidate(3, 116.60)];
  const oldQueue = planStrategyNextEntry(context, slots, 118.20);
  assert.deepEqual(oldQueue.missedCandidateIds, []);
  assert.equal(oldQueue.nextCandidateId, "physical-3");
  slots[2]!.state = "ARMED";
  slots[0] = { ...slots[0]!, state: "PLANNED", operationSequence: 2 };
  const afterTp = planStrategyNextEntry(context, slots, 119.70, { candidateId: "physical-3", executedQuantity: 0 });
  assert.equal(afterTp.decision.action_type, "CANCEL_REPLACE_NEXT_BUY");
  assert.equal(afterTp.decision.target_price, 118.97);
  assert.deepEqual(afterTp.missedCandidateIds, []);
});

test("recovery proves initial and TP CAS effects without new dispatch or assuming missing evidence", () => {
  const slot = { operationSequence: 1, state: "OPEN", entryState: "NONE", buyPrice: 118.97, executedQuantity: .084,
    buyFilledAt: "2026-09-23T04:23:36.439Z", takeProfitPrice: null, sellOrderId: null };
  assert.equal(isStrategyDecisionProven("OPEN_INITIAL_MARKET", 118.97, 1, { slot }), true);
  assert.equal(isStrategyDecisionProven("OPEN_INITIAL_MARKET", 118.97, 1, { slot: { ...slot, executedQuantity: 0 } }), false);
  assert.equal(isStrategyDecisionProven("CREATE_TP", 119.57, 1, { slot }), false);
  const protectedSlot = { ...slot, state: "TP_ACTIVE", takeProfitPrice: 119.57, sellOrderId: "owned-tp" };
  assert.equal(isStrategyDecisionProven("CREATE_TP", 119.57, 1, { slot: protectedSlot }), true);
  assert.equal(isStrategyDecisionProven("CREATE_TP", 119.58, 1, { slot: protectedSlot }), false);
  assert.equal(isStrategyDecisionProven("CREATE_TP", 119.57, 2, { slot: protectedSlot }), false);
});

test("local recovery requires exact next operation; global recovery requires actual successor initial fill", () => {
  const slot = { operationSequence: 2, state: "PENDING", entryState: "PLANNED", buyPrice: 118.97, executedQuantity: 0,
    buyFilledAt: null, takeProfitPrice: null, sellOrderId: null };
  assert.equal(isStrategyDecisionProven("PLAN_LOCAL_REENTRY", 118.97, 2, { slot }), true);
  assert.equal(isStrategyDecisionProven("PLAN_LOCAL_REENTRY", 118.97, 3, { slot }), false);
  assert.equal(isStrategyDecisionProven("ARM_NEXT_BUY", 118.97, 2, { slot }), false);
  assert.equal(isStrategyDecisionProven("ARM_NEXT_BUY", 118.97, 2, { slot: { ...slot, entryState: "ARMED" } }), true);
  assert.equal(isStrategyDecisionProven("COMPLETE_CYCLE", null, null, { cycleCompleted: true }), true);
  assert.equal(isStrategyDecisionProven("REANCHOR", null, null, { cycleCompleted: true }), false);
  assert.equal(isStrategyDecisionProven("REANCHOR", null, null, { cycleCompleted: true, successorInitialFilled: true }), true);
});

test("Shadow and Testnet representations produce identical initial/TP/local/priority/reset decisions for BTC and SOL", () => {
  for (const asset of ["BTC", "SOL"] as const) {
    const runContext = { ...context, asset, cycleId: `parity-${asset}` };
    const scale = asset === "BTC" ? 500 : 1;
    const slots = ladder().map((slot) => ({ ...slot, buyPrice: slot.buyPrice * scale }));
    const shadowRows = slots.map((slot) => ({ physical_slot_id: slot.id, slot_number: slot.slotNumber, operation_sequence: slot.operationSequence,
      buy_price: slot.buyPrice, balance_usdc: slot.balanceUsdc, status: slot.state }));
    const testnetRows = slots.map((slot) => ({ slot_id: slot.id, number: slot.slotNumber, revision: slot.operationSequence,
      target: String(slot.buyPrice), balance: String(slot.balanceUsdc), state: slot.state }));
    const shadow = shadowRows.map((row): StrategyCandidate => ({ id: row.physical_slot_id, slotNumber: row.slot_number, operationSequence: row.operation_sequence,
      buyPrice: row.buy_price, balanceUsdc: row.balance_usdc, state: row.status }));
    const testnet = testnetRows.map((row): StrategyCandidate => ({ id: row.slot_id, slotNumber: row.number, operationSequence: row.revision,
      buyPrice: Number(row.target), balanceUsdc: Number(row.balance), state: row.state }));
    assert.deepEqual(planStrategyInitialEntry(runContext, shadow[0]!), planStrategyInitialEntry(runContext, testnet[0]!));
    for (const adapterSlots of [shadow, testnet]) {
      adapterSlots[0]!.state = "OPEN";
      adapterSlots[1]!.state = "ARMED";
    }
    const assetFilters = { ...filters, symbol: `${asset}USDC`, baseAsset: asset };
    assert.deepEqual(planStrategyTakeProfit(runContext, shadow[0]!, 120 * scale, assetFilters, { gainRate: .005, entrySpacing: .01 }),
      planStrategyTakeProfit(runContext, testnet[0]!, 120 * scale, assetFilters, { gainRate: .005, entrySpacing: .01 }));
    for (const adapterSlots of [shadow, testnet]) { adapterSlots[0]!.state = "CLOSED"; adapterSlots[2]!.state = "OPEN"; }
    assert.deepEqual(planStrategyClosedSlot(runContext, shadow, "physical-1"), planStrategyClosedSlot(runContext, testnet, "physical-1"));
    for (const adapterSlots of [shadow, testnet]) { adapterSlots[0]!.state = "PLANNED"; adapterSlots[0]!.operationSequence = 2; }
    assert.deepEqual(planStrategyNextEntry(runContext, shadow, 121 * scale), planStrategyNextEntry(runContext, testnet, 121 * scale));
    for (const adapterSlots of [shadow, testnet]) { adapterSlots[0]!.state = "CLOSED"; adapterSlots[2]!.state = "CLOSED"; }
    assert.deepEqual(planStrategyClosedSlot(runContext, shadow, "physical-1"), planStrategyClosedSlot(runContext, testnet, "physical-1"));
    assert.equal(STRATEGY_VERSION, "4.1.0");
  }
});
