import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildPostAthQueue } from "../execution/ath-regime.ts";
import { monthlyPeriodKey, rankMonthlySlots, type MonthlySlotInput } from "../execution/monthly-slot-policy.ts";
import { planStrategyNextEntry, planStrategyPostAthNextEntry, type StrategyCandidate } from "../execution/strategy-engine.ts";

const at = "2026-10-26T12:10:40.563Z";
const context = { asset: "BTC" as const, cycleId: "fixture-rafael-btc", observedAt: at, quoteAsset: "BRL" };
function rafael() {
  const counts: Record<number, [number, number]> = { 1: [3, 1], 2: [6, 2], 3: [4, 2], 4: [2, 2],
    6: [3, 3], 7: [4, 4], 8: [2, 2], 9: [2, 2], 10: [7, 7], 11: [7, 7], 12: [7, 7], 13: [1, 1], 14: [2, 2] };
  const inputs: MonthlySlotInput[] = Array.from({ length: 25 }, (_, i) => {
    const n = i + 1, [lifetimeGainCount, monthlyGainCount] = counts[n] ?? [0, 0];
    return { physicalSlotNumber: n, physicalSlotId: `fixture:${n}`, lifetimeGainCount, monthlyGainCount,
      balanceUsdc: 18, entryState: n <= 5 ? "OPEN" : n === 6 ? "ARMED" : "PLANNED" };
  });
  const statuses = rankMonthlySlots("BTC", at, inputs);
  const candidates: StrategyCandidate[] = statuses.map(s => ({ id: s.physicalSlotId, slotNumber: s.physicalSlotNumber,
    operationSequence: s.physicalSlotNumber === 6 ? 4 : 1,
    buyPrice: s.physicalSlotNumber === 6 ? 432279 : s.physicalSlotNumber === 7 ? 427956
      : s.physicalSlotNumber === 8 ? 423676 : 400000 - 1000 * s.physicalSlotNumber,
    balanceQuote: s.balanceUsdc, operationalRank: s.operationalRank, monthlyTargetReached: s.monthlyTargetReached,
    monthlyEntryEligible: s.eligibleForNewEntry, state: s.entryState as StrategyCandidate["state"], entryOrigin: "REENTRY" }));
  return { inputs, statuses, candidates };
}

test("Rafael BTC: #7 rank3 and 4/7 do not displace higher resident #6 rank5 and 3/7", () => {
  const { statuses, candidates } = rafael(), before = structuredClone(candidates);
  assert.deepEqual([7, 6, 8].map(n => statuses.find(s => s.physicalSlotNumber === n)!.operationalRank), [3, 5, 7]);
  const result = planStrategyNextEntry(context, candidates, 438237,
    { candidateId: "fixture:6", executedQuantity: 0 });
  assert.equal(result.nextCandidateId, "fixture:6");
  assert.equal(result.decision.action_type, "WAIT");
  assert.equal(result.decision.reason, "HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT");
  candidates.find(s => s.slotNumber === 6)!.state = "OPEN";
  assert.equal(planStrategyNextEntry(context, candidates, 438237).nextCandidateId, "fixture:7");
  assert.deepEqual(before, rafael().candidates);
});

test("4/7 wins over 3/7 and 2/7 at the same price; OPEN, missed and monthly hold cannot win", () => {
  const ranks = rankMonthlySlots("BTC", at, [4, 3, 2].map((g, i) => ({ physicalSlotNumber: i + 6,
    physicalSlotId: `equal:${i + 6}`, lifetimeGainCount: g, monthlyGainCount: g, balanceUsdc: 22, entryState: "PLANNED" })));
  const candidates: StrategyCandidate[] = ranks.map(s => ({ id: s.physicalSlotId, slotNumber: s.physicalSlotNumber,
    operationSequence: 1, buyPrice: 420000, balanceQuote: 22, operationalRank: s.operationalRank,
    monthlyEntryEligible: true, state: "PLANNED" }));
  assert.equal(planStrategyNextEntry(context, candidates, 430000).nextCandidateId, "equal:6");
  for (const patch of [{ state: "OPEN" }, { state: "MISSED" }, { monthlyEntryEligible: false }]) {
    const changed = structuredClone(candidates); Object.assign(changed[0]!, patch);
    assert.equal(planStrategyNextEntry(context, changed, 430000).nextCandidateId, "equal:7");
  }
  candidates[1]!.operationalRank = candidates[0]!.operationalRank;
  assert.equal(planStrategyNextEntry(context, [...candidates].reverse(), 430000).nextCandidateId, "equal:6");
});

test("post-gain reentry uses preserved price, not a stale gain rank; partial/crossed resident stays protected", () => {
  const { candidates } = rafael();
  candidates.find(s => s.slotNumber === 6)!.state = "PLANNED";
  candidates.find(s => s.slotNumber === 7)!.state = "ARMED";
  const result = planStrategyNextEntry(context, candidates, 438237,
    { candidateId: "fixture:7", executedQuantity: 0 });
  assert.equal(result.nextCandidateId, "fixture:6");
  assert.equal(result.decision.action_type, "CANCEL_REPLACE_NEXT_BUY");
  assert.equal(result.decision.reason, "HIGHER_VALID_ENTRY_HAS_PRIORITY");
  assert.equal(result.decision.target_price, 432279);
  const partial = planStrategyNextEntry(context, candidates, 438237,
    { candidateId: "fixture:7", executedQuantity: .000001 });
  assert.equal(partial.decision.reason, "RESIDENT_BUY_PARTIAL_FILL_PROTECTED");
  assert.equal(partial.nextCandidateId, "fixture:7");
  assert.equal(planStrategyNextEntry(context, candidates, 427000,
    { candidateId: "fixture:7", executedQuantity: 0 }).decision.reason, "RESIDENT_BUY_REQUIRES_RECONCILIATION");
});

test("monthly eligibility and lifetime rank are distinct, with calendar/year rollover and OPEN preserved", () => {
  const input: MonthlySlotInput[] = [{ physicalSlotNumber: 1, physicalSlotId: "a:1", lifetimeGainCount: 20,
    monthlyGainCount: 1, balanceUsdc: 22, entryState: "OPEN" },
  { physicalSlotNumber: 2, physicalSlotId: "a:2", lifetimeGainCount: 4,
    monthlyGainCount: 4, balanceUsdc: 22, entryState: "PLANNED" }];
  const original = structuredClone(input), before = rankMonthlySlots("BTC", "2026-12-31T23:59:59-04:00", input);
  assert.equal(before[0]!.operationalRank, 1, "documented lifetime policy, not a new monthly comparator");
  const next = rankMonthlySlots("BTC", "2027-01-01T00:00:00-04:00", input.map(s => ({ ...s, monthlyGainCount: 0 })));
  assert.equal(monthlyPeriodKey("2027-01-01T03:59:59Z"), "2026-12");
  assert.equal(next[0]!.periodKey, "2027-01"); assert.equal(next[0]!.entryState, "OPEN");
  assert.equal(next[0]!.lifetimeGainCount, 20); assert.deepEqual(input, original);
});

test("BTC/SOL 25/50/100: all monthly goals allow continued operation; post-ATH remains top15/remaining", () => {
  for (const asset of ["BTC", "SOL"] as const) for (const count of [25, 50, 100]) {
    const target = asset === "BTC" ? 7 : 2;
    const inputs: MonthlySlotInput[] = Array.from({ length: count }, (_, i) => ({
      physicalSlotId: `${asset}:${i + 1}`, physicalSlotNumber: i + 1,
      lifetimeGainCount: target + i, monthlyGainCount: target, balanceUsdc: 22, entryState: "PLANNED" }));
    assert.equal(rankMonthlySlots(asset, at, inputs, target, count).filter(s => s.eligibleForNewEntry).length, count);
    const queue = buildPostAthQueue(asset, inputs, target, count);
    const primary = queue.filter(s => s.postAthGroup === "PRIMARY").sort((a, b) => a.operationalRank! - b.operationalRank!);
    const reserve = queue.filter(s => s.postAthGroup === "RESERVE").sort((a, b) => a.operationalRank! - b.operationalRank!);
    assert.equal(primary.length, 15); assert.equal(reserve.length, count - 15);
    assert.deepEqual(primary.map(s => s.lifetimeGainCount), primary.map(s => s.lifetimeGainCount).sort((a, b) => a - b));
    assert.deepEqual(reserve.map(s => s.lifetimeGainCount), reserve.map(s => s.lifetimeGainCount).sort((a, b) => b - a));
  }
});

test("post-ATH primary gate still admits a priced reentry/resident; reruns do not invent a second intent", () => {
  const a: StrategyCandidate[] = [{ id: "A:6", slotNumber: 6, operationSequence: 4, buyPrice: 432279,
    balanceQuote: 22, operationalRank: 20, postAthGroup: "RESERVE", entryOrigin: "REENTRY", state: "PLANNED" },
  { id: "A:7", slotNumber: 7, operationSequence: 5, buyPrice: 427956, balanceQuote: 22,
    operationalRank: 1, postAthGroup: "PRIMARY", entryOrigin: "GRID", state: "ARMED" }];
  const resident = { candidateId: "A:7", executedQuantity: 0 }, original = structuredClone(a);
  const result = planStrategyPostAthNextEntry(context, a, 438237, resident);
  for (let retry = 0; retry < 5; retry++) assert.deepEqual(planStrategyPostAthNextEntry(context, a, 438237, resident), result);
  assert.equal(result.nextCandidateId, "A:6"); assert.deepEqual(a, original);
  const b = a.map(s => ({ ...s, id: s.id.replace("A:", "B:") }));
  const other = planStrategyPostAthNextEntry({ ...context, cycleId: "fixture-other-engine" }, b, 438237,
    { candidateId: "B:7", executedQuantity: 0 });
  assert.equal(other.nextCandidateId, "B:6"); assert.notEqual(other.decision.decision_id, result.decision.decision_id);
});

test("UI explains rank/price/residency without introducing a second ranking or entry implementation", () => {
  const source = readFileSync(new URL("../../app/automacao/premium-automation.tsx", import.meta.url), "utf8");
  const note = source.slice(source.indexOf('data-testid="slot-priority-explanation"'), source.indexOf("</details>", source.indexOf('data-testid="slot-priority-explanation"')));
  for (const text of ["gains do mês", "gains totais (lifetime)", "PRIMARY", "RESERVE", "maior preço válido", "fill parcial"])
    assert.ok(note.includes(text), text);
  assert.doesNotMatch(note, /onClick=|onSubmit=|fetch\(|planStrategy/);
  assert.ok(source.includes("Rank não é fila de compra"));
});
