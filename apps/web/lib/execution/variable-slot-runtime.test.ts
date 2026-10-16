import test from "node:test";
import assert from "node:assert/strict";
import { planAthLadder } from "./ath-ladder.ts";
import { buildPostAthQueue } from "./ath-regime.ts";
import { distributeLiveCapital } from "./live-capital-distribution.ts";
import { assertPhysicalLedger } from "./live-ledger-read.ts";
import { monthlyGoalsComplete, rankMonthlySlots, physicalSlotIdentity } from "./monthly-slot-policy.ts";
import { planStrategyClosedSlot, planStrategyNextEntry, planStrategyTakeProfit, STRATEGY_VERSION } from "./strategy-engine.ts";
import { assertStrategyBuyPrice } from "./strategy-price-invariant.ts";
import { liveClientOrderId } from "./robot-v1-live-cycle.ts";
import { evaluateFastRun } from "../coinops-watchdog/watchdog-policy.ts";

const instant = "2026-10-16T10:00:00Z";
const params = { gainRate: .03, normalSpacing: .01, postAthSpacing: .02 };
const engine = { exchange_account_id: "00000000-0000-4000-8000-000000000001",
  trading_engine_id: "00000000-0000-4000-8000-000000000002", base_asset: "SOL", legacy_compatible: false, slot_count: 100 };
const make = (count: number) => Array.from({ length: count }, (_, index) => ({ physicalSlotId: `engine:${index + 1}`,
  physicalSlotNumber: index + 1, lifetimeGainCount: index, monthlyGainCount: 0,
  entryState: "PLANNED", buyPrice: 530, entryOrigin: "GRID" as const, operationSequence: 1, status: "PENDING" }));

for (const count of [25, 50, 75, 100]) test(`${count} slots preserve cent capital, PRIMARY15 and physical identities`, () => {
  const slots = make(count), before = JSON.stringify(slots);
  const normal = planAthLadder("SOL", "NORMAL", 530, params, .1, slots, 3, count);
  const post = buildPostAthQueue("SOL", slots, 3, count);
  assert.equal(normal.length, count);
  assert.equal(post.filter(slot => slot.postAthGroup === "PRIMARY").length, 15);
  assert.equal(post.filter(slot => slot.postAthGroup === "RESERVE").length, count - 15);
  assert.deepEqual(post.filter(slot => slot.postAthGroup === "PRIMARY").sort((a,b) => a.operationalRank! - b.operationalRank!)
    .map(slot => slot.lifetimeGainCount), Array.from({ length: 15 }, (_, index) => count - 15 + index));
  assert.equal(distributeLiveCapital(count * 11, count).reduce((sum, value) => sum + Math.round(value * 100), 0), count * 1100);
  assert.equal(JSON.stringify(slots), before);
  assertPhysicalLedger(slots.map(slot => ({ slot_number: slot.physicalSlotNumber })), count);
  assert.throws(() => assertPhysicalLedger(slots.slice(1).map(slot => ({ slot_number: slot.physicalSlotNumber })), count));
  assert.throws(() => planAthLadder("SOL", "NORMAL", 530, params, .1, slots.slice(1), 3, count));
  assert.throws(() => assertPhysicalLedger(slots.map(() => ({ slot_number: 1 })), count));
  for (const level of normal) assertStrategyBuyPrice({ price: level.nextBuyPrice, referencePrice: level.nextBuyPrice,
    anchorPrice: 530, spacing: .01, tick: .1, entryOrigin: "GRID", slotCount: count });
});

for (const count of [25, 50, 100]) test(`${count} monthly floor and gain/reentry keep one BUY and immutable TP`, () => {
  const slots = make(count);
  const reached = slots.map(slot => ({ ...slot, monthlyGainCount: 3, lifetimeGainCount: 3, balanceUsdc: 11 }));
  assert.equal(monthlyGoalsComplete("SOL", reached, 3, count), true);
  assert.equal(monthlyGoalsComplete("SOL", reached.slice(1), 3, count), false);
  const monthly = rankMonthlySlots("SOL", instant, reached, 3, count);
  assert.equal(monthly.filter(slot => slot.eligibleForNewEntry).length, count);
  const context = { asset: "SOL" as const, cycleId: "run-independent", observedAt: instant, quoteAsset: "BRL", slotCount: count };
  const candidates = slots.map((slot, i) => ({ id: slot.physicalSlotId, slotNumber: i + 1, operationSequence: 1,
    buyPrice: 530 * .99 ** i, balanceQuote: 11, operationalRank: i + 1, monthlyTargetReached: false,
    state: "PLANNED" as "PLANNED" | "OPEN" | "CLOSED" }));
  candidates[0].state = "CLOSED"; candidates[1].state = "OPEN";
  const replay = planStrategyClosedSlot(context, candidates, candidates[0].id);
  assert.equal(replay.mode, "LOCAL_REENTRY");
  assert.deepEqual(replay, planStrategyClosedSlot({ ...context, observedAt: "2026-10-16T10:00:00Z" }, candidates, candidates[0].id));
  const next = planStrategyNextEntry(context, candidates, 529);
  assert.equal(next.decision.action_type, "ARM_NEXT_BUY");
  const tp = planStrategyTakeProfit(context, { ...candidates[count - 1], state: "OPEN" }, 530,
    { symbol: "SOLBRL", baseAsset: "SOL", quoteAsset: "BRL", minQuantity: .001, maxQuantity: 1000,
      minNotional: 10, quantityStep: .001, priceTick: .1 }, { gainRate: .03, entrySpacing: .01 });
  assert.equal(tp.action_type, "CREATE_TP"); assert.equal(tp.target_price, 545.9);
  assert.equal(STRATEGY_VERSION, "4.3.1");
});

test("slot100 order namespace is deterministic and foreign engine cannot share it", () => {
  const run = "00000000-0000-4000-8000-000000000003";
  const id = liveClientOrderId(run, "SOL", 100, 1, "SELL", 1, engine);
  assert.equal(id, liveClientOrderId(run, "SOL", 100, 1, "SELL", 1, engine));
  assert.ok(id.length <= 36);
  assert.notEqual(id, liveClientOrderId(run, "SOL", 100, 1, "SELL", 1, { ...engine,
    trading_engine_id: "00000000-0000-4000-8000-000000000004" }));
  assert.throws(() => liveClientOrderId(run, "SOL", 100, 1, "SELL", 1, { ...engine, slot_count: 25 }));
  const scope = { productId: "product", tenantId: "tenant", userId: "user", asset: "SOL" as const,
    tradingEngineId: engine.trading_engine_id, legacyCompatible: false, slotCount: 100 };
  assert.equal(physicalSlotIdentity("REAL", scope, 100), `REAL:${engine.trading_engine_id}:100`);
});

test("Watchdog100 is count-bound and an engine25 sibling is not reinterpreted as100", () => {
  const now = Date.parse(instant);
  const run = { id: "run", trading_engine_id: "engine", exchange_account_id: "account", slot_count: 100,
    status: "ACTIVE", symbol: "SOLBRL", last_reconciled_at: instant, last_error: null, lease_until: null };
  const e = { id: "engine", exchange_account_id: "account", symbol: "SOLBRL", slot_count: 100,
    status: "ACTIVE", kill_switch: false, executor_shard_id: "executor-03" };
  const account = { id: "account", executor_shard_id: "executor-03", status: "ACTIVE", kill_switch: false };
  const slots = make(100).map(slot => ({ run_id: "run", id: slot.physicalSlotId, slot_number: slot.physicalSlotNumber,
    entry_state: "PLANNED", position_quantity: 0, updated_at: instant }));
  const input = { run, engine: e, account, shardId: "executor-03", slots, orders: [], now };
  assert.equal(evaluateFastRun(input).state, "HEALTHY");
  assert.equal(evaluateFastRun({ ...input, engine: { ...e, slot_count: 25 } }).state, "BLOCKED");
  assert.equal(evaluateFastRun({ ...input, slots: slots.slice(1) }).state, "BLOCKED");
  assert.equal(evaluateFastRun({ ...input, slots: slots.map(slot => ({ ...slot, slot_number: 1 })) }).state, "BLOCKED");
});
