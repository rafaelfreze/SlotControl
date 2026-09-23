import assert from "node:assert/strict";
import test from "node:test";

import { orderMonthlySlotRows } from "../../app/automacao/monthly-slot-order.ts";
import { rankMonthlySlots } from "../execution/monthly-slot-policy.ts";

test("a única lista mantém 25 slots físicos e prioriza OPEN, próxima BUY e rank", () => {
  const slots = Array.from({ length: 25 }, (_, index) => ({ slot_number: index + 1 }));
  const statuses = rankMonthlySlots("SOL", "2026-09-23T18:00:00Z", slots.map((slot) => ({
    physicalSlotNumber: slot.slot_number,
    physicalSlotId: `SOL:${slot.slot_number}`,
    lifetimeGainCount: slot.slot_number === 5 ? 2 : slot.slot_number === 9 ? 1 : 0,
    monthlyGainCount: slot.slot_number === 5 ? 2 : 0,
    balanceUsdc: 10,
    entryState: slot.slot_number === 5 ? "OPEN" : slot.slot_number === 9 ? "ARMED" : "PLANNED",
  })));
  const ordered = orderMonthlySlotRows(slots, statuses, (slot) => slot.slot_number, "operational");
  assert.equal(ordered.length, 25);
  assert.deepEqual(ordered.slice(0, 3).map((slot) => slot.slot_number), [5, 9, 1]);
  assert.deepEqual(slots.slice(0, 3).map((slot) => slot.slot_number), [1, 2, 3]);
  assert.deepEqual(orderMonthlySlotRows(slots, statuses, (slot) => slot.slot_number, "reached").map((slot) => slot.slot_number), [5]);
  assert.deepEqual(orderMonthlySlotRows(slots, statuses, (slot) => slot.slot_number, "open").map((slot) => slot.slot_number), [5]);
  assert.deepEqual(orderMonthlySlotRows(slots, statuses, (slot) => slot.slot_number, "physical").slice(0, 3).map((slot) => slot.slot_number), [1, 2, 3]);
});
