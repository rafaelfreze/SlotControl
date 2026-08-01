import assert from "node:assert/strict";
import test from "node:test";

import { rankSlotIds, sortSlotsByGains } from "./slot-ranking.ts";

const slots = [
  { id: "one", gains: 2, slot_number: 1, sort_order: 1 },
  { id: "two", gains: 5, slot_number: 2, sort_order: 2 },
  { id: "three", gains: 5, slot_number: 1, sort_order: 3 }
];

test("slots são ordenados por gains e desempate estável", () => {
  assert.deepEqual(sortSlotsByGains(slots).map((slot) => slot.id), ["three", "two", "one"]);
});

test("rankings independentes recomeçam em um para cada grupo", () => {
  assert.deepEqual(rankSlotIds(slots), { three: 1, two: 2, one: 3 });
  assert.deepEqual(rankSlotIds([slots[0]]), { one: 1 });
});
