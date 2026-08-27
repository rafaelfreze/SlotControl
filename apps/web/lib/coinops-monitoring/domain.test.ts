import assert from "node:assert/strict";
import test from "node:test";
import {
  allNormalTargetsMet, calculateCycleProgress, getCycleEnd, getEntrySpacing, isInsideCycle,
  poolForSlotNumber, rankDefensiveCandidates, rankNormalCandidates, reduceOfficialRegime, type QueueSlot
} from "./domain.ts";

const initial = { mode: "NORMAL_GROWTH" as const, officialAth: 100, defensiveAnchorAth: null, modeStartedAt: "2026-08-27T04:00:00.000Z" };

test("novo ATH ativa defensivo uma vez e atualiza apenas o pico", () => {
  const entered = reduceOfficialRegime(initial, 101, "2026-09-01T00:00:00.000Z");
  assert.equal(entered.event, "NEW_ATH");
  assert.equal(entered.state.mode, "DEFENSIVE_POST_ATH");
  assert.equal(reduceOfficialRegime(entered.state, 100, "2026-09-02T00:00:00.000Z").event, "NONE");
  const peak = reduceOfficialRegime(entered.state, 105, "2026-09-03T00:00:00.000Z");
  assert.equal(peak.event, "DEFENSIVE_PEAK_UPDATED");
  assert.equal(peak.state.defensiveAnchorAth, 105);
});

test("queda de 40 por cento retorna ao normal e recuperacao nao reativa", () => {
  const defensive = reduceOfficialRegime(initial, 100.01, "2026-09-01T00:00:00.000Z").state;
  const bottom = reduceOfficialRegime(defensive, 60.006, "2026-10-01T00:00:00.000Z");
  assert.equal(bottom.event, "STRONG_BOTTOM_REACHED");
  assert.equal(bottom.startNormalCycle, true);
  assert.equal(reduceOfficialRegime(bottom.state, 90, "2026-10-02T00:00:00.000Z").event, "NONE");
});

test("ciclo usa janela exata de trinta dias", () => {
  const start = "2026-08-27T12:00:00.000Z";
  assert.equal(getCycleEnd(start).toISOString(), "2026-09-26T12:00:00.000Z");
  assert.equal(isInsideCycle("2026-09-26T11:59:59.999Z", start), true);
  assert.equal(isInsideCycle("2026-09-26T12:00:00.000Z", start), false);
});

test("progresso do ciclo usa somente eventos do ciclo", () => {
  assert.equal(calculateCycleProgress({ real: 4, redistributionIn: 2, redistributionOut: 1, externalEquivalent: 0.5 }), 5.5);
});

const slot = (overrides: Partial<QueueSlot>): QueueSlot => ({
  id: String(overrides.slotNumber || 1), slotNumber: 1, pool: "MAIN", enabled: true, funded: true,
  activeFromCycleNumber: 1, operationalGains: 0, operationalValue: 10, cycleProgress: 0,
  lastOperatedAt: null, ...overrides
});

test("normal prioriza menor progresso e exclui meta batida", () => {
  const ranked = rankNormalCandidates([
    slot({ slotNumber: 1, cycleProgress: 7 }),
    slot({ slotNumber: 2, cycleProgress: 2, operationalGains: 8 }),
    slot({ slotNumber: 3, cycleProgress: 1, operationalGains: 20 })
  ], 7, 1);
  assert.deepEqual(ranked.map((item) => item.slotNumber), [3, 2]);
  assert.equal(allNormalTargetsMet([slot({ cycleProgress: 7 })], 7, 1), true);
});

test("defensivo prioriza zerados e depois menor nivel", () => {
  const ranked = rankDefensiveCandidates([
    slot({ slotNumber: 1, operationalGains: 2, operationalValue: 11 }),
    slot({ slotNumber: 2, operationalGains: 0, operationalValue: 25 }),
    slot({ slotNumber: 3, operationalGains: 1, operationalValue: 10 })
  ], 1);
  assert.deepEqual(ranked.map((item) => item.slotNumber), [2, 3, 1]);
});

test("reserva e ativacao futura nao entram automaticamente", () => {
  const reserve = slot({ slotNumber: 26, pool: "RESERVE" });
  const future = slot({ slotNumber: 4, activeFromCycleNumber: 2 });
  assert.equal(rankNormalCandidates([reserve, future], 7, 1).length, 0);
  assert.equal(rankNormalCandidates([reserve], 7, 1, true).length, 1);
  assert.equal(poolForSlotNumber(25), "MAIN");
  assert.equal(poolForSlotNumber(26), "RESERVE");
});

test("espacamentos oficiais sao separados por modo e ativo", () => {
  assert.equal(getEntrySpacing("BTC", "NORMAL_GROWTH"), 2);
  assert.equal(getEntrySpacing("SOL", "NORMAL_GROWTH"), 3);
  assert.equal(getEntrySpacing("BTC", "DEFENSIVE_POST_ATH"), 5);
  assert.equal(getEntrySpacing("SOL", "DEFENSIVE_POST_ATH"), 8);
});
