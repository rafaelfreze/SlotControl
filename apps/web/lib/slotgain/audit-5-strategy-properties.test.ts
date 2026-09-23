import assert from "node:assert/strict";
import test from "node:test";

import { buildPostAthQueue, orderedPostAthSlots } from "../execution/ath-regime.ts";
import { planAthLadder } from "../execution/ath-ladder.ts";
import { simulateAth } from "../execution/ath-simulator.ts";
import { MONTHLY_SLOT_TARGET, rankMonthlySlots } from "../execution/monthly-slot-policy.ts";
import { planStrategyNextEntry, planStrategyPostAthNextEntry, type StrategyCandidate } from "../execution/strategy-engine.ts";

function rng(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}

for (const [asset, seed] of [["BTC", 0x50b7c], ["SOL", 0x50501]] as const) {
  test(`audit 5 properties: ${asset} seed ${seed}, 3000 ranked/price/ATH/retry snapshots`, () => {
    const random = rng(seed);
    const target = MONTHLY_SLOT_TARGET[asset];
    const context = { asset, cycleId: `audit-seed-${seed}`, observedAt: "2026-10-01T04:00:00Z" };
    for (let event = 0; event < 3000; event++) {
      const inputs = Array.from({ length: 25 }, (_, i) => {
        const lifetimeGainCount = Math.floor(random() * 1_000_000);
        const monthlyGainCount = random() < .03 ? null : Math.min(lifetimeGainCount, Math.floor(random() * (target + 3)));
        return { physicalSlotNumber: i + 1, physicalSlotId: `${asset}:${i + 1}`, lifetimeGainCount,
          monthlyGainCount, balanceUsdc: 10 + Math.floor(random() * 10000) / 100,
          entryState: random() < .2 ? "OPEN" : "PLANNED" };
      });
      const before = structuredClone(inputs);
      const ranks = rankMonthlySlots(asset, context.observedAt, inputs);
      const ath = buildPostAthQueue(asset, inputs);
      const athById = new Map(ath.map((slot) => [slot.physicalSlotId, slot]));
      const post = event % 2 === 0;
      const rows: StrategyCandidate[] = ranks.map((slot) => ({ id: slot.physicalSlotId,
        slotNumber: slot.physicalSlotNumber, operationSequence: random() < .3 ? 2 : 1,
        buyPrice: 70 + Math.floor(random() * 3500) / 100, balanceUsdc: slot.balanceUsdc,
        operationalRank: post ? athById.get(slot.physicalSlotId)!.operationalRank : slot.operationalRank,
        monthlyTargetReached: slot.monthlyTargetReached, postAthGroup: athById.get(slot.physicalSlotId)!.postAthGroup,
        entryOrigin: random() < .3 ? "REENTRY" : "GRID", state: slot.entryState === "OPEN" ? "OPEN" : "PLANNED" }));
      const residentIndex = Math.floor(random() * 26);
      if (residentIndex < 25) rows[residentIndex]!.state = event % 5 === 0 ? "PARTIALLY_FILLED" : "ARMED";
      const beforeRows = structuredClone(rows);
      const resident = residentIndex < 25 ? { candidateId: rows[residentIndex]!.id,
        executedQuantity: rows[residentIndex]!.state === "PARTIALLY_FILLED" ? .001 : 0 } : null;
      const decide = post ? planStrategyPostAthNextEntry : planStrategyNextEntry;
      const decision = decide(context, rows, 100, resident);
      const permuted = [...rows].sort((a, b) => ((a.slotNumber * 17 + event) % 29) - ((b.slotNumber * 17 + event) % 29));
      assert.deepEqual(decision, decide(context, permuted, 100, resident), `${asset}:${seed}:${event}:permutation`);
      const retry = decide({ ...context, observedAt: "2026-10-01T04:01:00Z" }, rows, 100, resident);
      assert.equal(decision.decision.decision_id, retry.decision.decision_id, `${asset}:${seed}:${event}:retry`);
      if (resident && rows[residentIndex]!.state === "PARTIALLY_FILLED") {
        assert.equal(decision.nextCandidateId, resident.candidateId);
        assert.equal(decision.decision.reason, "RESIDENT_BUY_PARTIAL_FILL_PROTECTED");
      }
      if (["ARM_NEXT_BUY", "CANCEL_REPLACE_NEXT_BUY"].includes(decision.decision.action_type)) {
        const selected = rows.find((row) => row.id === decision.nextCandidateId)!;
        assert.equal(selected.monthlyTargetReached, false);
        assert.notEqual(selected.operationalRank, null);
        assert.ok(selected.buyPrice < 100);
        const primaryAvailable = post && rows.some((row) => row.postAthGroup === "PRIMARY"
          && !row.monthlyTargetReached && row.operationalRank !== null && ["PLANNED", "ARMED", "PARTIALLY_FILLED"].includes(row.state));
        const competing = rows.filter((row) => !row.monthlyTargetReached && row.operationalRank !== null
          && ["PLANNED", "ARMED"].includes(row.state) && row.buyPrice < 100
          && (!primaryAvailable || row.postAthGroup === "PRIMARY" || row.entryOrigin === "REENTRY"
            || row.id === resident?.candidateId));
        assert.equal(selected.buyPrice, Math.max(...competing.map((row) => row.buyPrice)), `${asset}:${seed}:${event}:price`);
        assert.ok(competing.filter((row) => row.buyPrice === selected.buyPrice).every((row) =>
          row.operationalRank! >= selected.operationalRank!));
      }
      const eligibleAth = ath.filter((slot) => slot.eligible);
      assert.equal(ath.filter((slot) => slot.postAthGroup === "PRIMARY").length, Math.min(15, eligibleAth.length));
      assert.equal(ath.filter((slot) => slot.postAthGroup === "RESERVE").length, Math.max(0, eligibleAth.length - 15));
      assert.ok(eligibleAth.every((slot) => slot.monthlyGainCount !== null && slot.monthlyGainCount < target
        && slot.entryState !== "OPEN"));
      const order = orderedPostAthSlots(ath);
      assert.deepEqual(order.map((slot) => slot.operationalRank), Array.from({ length: order.length }, (_, i) => i + 1));
      assert.equal(new Set(ath.map((slot) => slot.physicalSlotId)).size, 25);
      assert.deepEqual(inputs, before);
      assert.deepEqual(rows, beforeRows);
    }
  });

  test(`audit 5 long replay: ${asset} seed ${seed}, 2000 candles with TP ledger reconstruction`, (t) => {
    const random = rng(seed);
    let price = 100;
    const prices = Array.from({ length: 2000 }, (_, i) => {
      price = Math.max(50, Math.min(150, price * (1 + (random() - .49) * .04)));
      // Repeated high/low episodes exercise regime/floor, reentry and resets.
      if (i % 400 === 0) price = 110 + i / 100;
      if (i % 400 === 200) price = 80;
      return Number(price.toFixed(4));
    });
    const input = { asset, initialPrice: 100, previousAth: 105, floorReference: 85,
      parameters: { gainRate: .005, normalSpacing: .01, postAthSpacing: .02 },
      lifetimeGains: Array.from({ length: 25 }, (_, i) => i + 1), monthlyGains: Array(25).fill(0), prices };
    const before = structuredClone(input);
    const result = simulateAth(input);
    assert.deepEqual(result, simulateAth(input));
    assert.deepEqual(input, before);
    assert.equal(result.slots.length, 25);
    assert.equal(new Set(result.slots.map((slot) => slot.physicalSlotId)).size, 25);
    assert.ok(result.slots.filter((slot) => slot.entryState === "ARMED").length <= 1);
    const balances = Array(25).fill(10) as number[];
    const gains = Array(25).fill(0) as number[];
    const positions = new Map<number, { entry: number; tp: number | null; principal: number; operationId: string | null }>();
    const closedOperations = new Set<string>();
    for (const step of result.steps) {
      if (step.slot === null) continue;
      const index = step.slot - 1;
      if (["INITIAL_MARKET_FILLED", "BUY_FILLED"].includes(step.event)) {
        assert.equal(positions.has(step.slot), false, `duplicate OPEN ${step.slot}`);
        assert.ok(gains[index]! < MONTHLY_SLOT_TARGET[asset], `entry after target ${step.slot}`);
        assert.equal(step.balanceUsdc, balances[index]);
        positions.set(step.slot, { entry: step.price, tp: null, principal: balances[index]!, operationId: step.operationId });
      }
      if (step.event === "TP_RESIDENT") {
        const open = positions.get(step.slot)!;
        assert.ok(open, `TP without OPEN ${step.slot}`);
        assert.ok(step.targetPrice! >= open.entry * 1.005 - 1e-9);
        assert.ok(Math.abs(step.targetPrice! / .01 - Math.round(step.targetPrice! / .01)) < 1e-6);
        open.tp = step.targetPrice; open.operationId = step.operationId;
      }
      if (step.event === "TP_FILLED_COMPOUNDED") {
        const open = positions.get(step.slot)!;
        assert.ok(open?.tp && open.operationId, `missing fill evidence ${step.slot}`);
        assert.equal(closedOperations.has(open.operationId), false, `duplicate credit ${step.slot}`);
        closedOperations.add(open.operationId);
        balances[index] = Number((open.principal + open.principal * (open.tp / open.entry - 1)).toFixed(8));
        assert.equal(step.balanceUsdc, balances[index], `ledger mismatch ${step.slot}`);
        gains[index]!++;
        assert.equal(step.monthlyGains, gains[index]);
        assert.equal(step.lifetimeGains, input.lifetimeGains[index]! + gains[index]!);
        positions.delete(step.slot);
      }
    }
    assert.ok(closedOperations.size >= 10, "replay must exercise actual gains");
    for (const slot of result.slots) {
      assert.equal(slot.balanceUsdc, balances[slot.physicalSlotNumber - 1]);
      assert.equal(slot.monthlyGainCount, gains[slot.physicalSlotNumber - 1]);
      assert.equal(slot.entryState === "OPEN", positions.has(slot.physicalSlotNumber));
    }
    t.diagnostic(JSON.stringify({ asset, seed, candles: prices.length, traceEvents: result.steps.length,
      realizedOperations: closedOperations.size, cycles: result.cycleNumber, physicalSlots: result.slots.length,
      ledgerReconciles: true, uniqueCreditedOperations: true }));
  });
}

test("audit 5: manual gain/reversal reranks Top15, contribution alone does not; OPEN/reentry stay frozen", () => {
  const input = Array.from({ length: 25 }, (_, i) => ({ physicalSlotId: `physical-${i + 1}`,
    physicalSlotNumber: i + 1, lifetimeGainCount: i + 1, monthlyGainCount: 0,
    entryState: i === 0 ? "OPEN" : "PLANNED", status: i === 0 ? "TP_ACTIVE" : "PENDING",
    buyPrice: 100 - i, entryOrigin: i === 1 ? "REENTRY" as const : "GRID" as const, operationSequence: i === 1 ? 2 : 1 }));
  const initial = buildPostAthQueue("BTC", input);
  assert.equal(initial[1]!.postAthGroup, "RESERVE");
  const manual = input.map((slot, i) => i === 1 ? { ...slot, lifetimeGainCount: slot.lifetimeGainCount + 100,
    monthlyGainCount: 1 } : slot);
  assert.equal(buildPostAthQueue("BTC", manual)[1]!.postAthGroup, "PRIMARY");
  const reversed = manual.map((slot, i) => i === 1 ? { ...slot, lifetimeGainCount: slot.lifetimeGainCount - 100,
    monthlyGainCount: 0 } : slot);
  assert.deepEqual(buildPostAthQueue("BTC", reversed), initial);
  const contribution = input.map((slot, i) => ({ ...slot, balanceUsdc: 10 + i * 100 }));
  assert.deepEqual(buildPostAthQueue("BTC", contribution).map((slot) => [slot.physicalSlotId, slot.postAthGroup, slot.operationalRank]),
    initial.map((slot) => [slot.physicalSlotId, slot.postAthGroup, slot.operationalRank]));
  for (const regime of ["NORMAL", "POST_ATH"] as const) {
    const plan = planAthLadder("BTC", regime, 150, { gainRate: .012, normalSpacing: .01, postAthSpacing: .05 }, .01, manual);
    assert.equal(plan[0]!.nextBuyPrice, input[0]!.buyPrice);
    assert.equal(plan[0]!.frozenReason, "OPEN_OR_TP");
    assert.equal(plan[1]!.nextBuyPrice, input[1]!.buyPrice);
    assert.equal(plan[1]!.frozenReason, "LOCAL_REENTRY");
  }
});
