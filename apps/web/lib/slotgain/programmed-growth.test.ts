import assert from "node:assert/strict";
import test from "node:test";

import { buildProgrammedGrowthPlan, getGrowthMonthNumber, selectGrowthLeader, type GrowthPlanSlot } from "./programmed-growth.ts";

function slot(overrides: Partial<GrowthPlanSlot>): GrowthPlanSlot {
  return {
    id: "slot-1",
    slotNumber: 1,
    sortOrder: 1,
    status: "gain",
    gains: 0,
    ...overrides
  };
}

test("a meta acumulada nunca reinicia", () => {
  assert.equal(getGrowthMonthNumber(new Date("2026-01-15T12:00:00Z"), new Date("2026-04-01T12:00:00Z")), 4);
  const plan = buildProgrammedGrowthPlan(7, new Date("2026-01-15T12:00:00Z"), [], new Date("2026-03-31T12:00:00Z"));
  assert.equal(plan.monthNumber, 3);
  assert.equal(plan.cumulativeGoal, 21);
});

test("slot aberto nunca é escolhido para aporte", () => {
  const leader = selectGrowthLeader([
    slot({ id: "open", slotNumber: 1, status: "aberto", gains: 99 }),
    slot({ id: "closed", slotNumber: 2, status: "gain", gains: 18 })
  ]);
  assert.equal(leader?.id, "closed");
});

test("escolhe o slot fechado com mais gains e desempata pelo menor slot", () => {
  const leader = selectGrowthLeader([
    slot({ id: "three", slotNumber: 3, gains: 20 }),
    slot({ id: "two", slotNumber: 2, gains: 20 }),
    slot({ id: "one", slotNumber: 1, gains: 19 })
  ]);
  assert.equal(leader?.id, "two");
});

test("plano informa os gains faltantes para ajuste manual", () => {
  const plan = buildProgrammedGrowthPlan(7, new Date("2026-01-15T12:00:00Z"), [slot({ gains: 18 })], new Date("2026-03-31T12:00:00Z"));
  assert.equal(plan.cumulativeGoal, 21);
  assert.equal(plan.missingGains, 3);
});
