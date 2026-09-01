import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  rankOpenSlotIds,
  rankSlotIds,
  sortOpenSlotsByOldestPosition,
  sortSlotsByGains,
  sortSlotsForOperationalList
} from "./slot-ranking.ts";

const slots = [
  { id: "one", gains: 2, slot_number: 1, sort_order: 1 },
  { id: "two", gains: 5, slot_number: 2, sort_order: 2 },
  { id: "three", gains: 5, slot_number: 1, sort_order: 3 }
];
const slotsPageSource = readFileSync(new URL("../../app/slots/page.tsx", import.meta.url), "utf8");

test("slots são ordenados por gains e desempate estável", () => {
  assert.deepEqual(sortSlotsByGains(slots).map((slot) => slot.id), ["three", "two", "one"]);
});

test("rankings independentes recomeçam em um para cada grupo", () => {
  assert.deepEqual(rankSlotIds(slots), { three: 1, two: 2, one: 3 });
  assert.deepEqual(rankSlotIds([slots[0]]), { one: 1 });
});

const openSlots = [
  { id: "oldest", status: "aberto", gains: 4, operational_gains: 4, slot_number: 3, sort_order: 3, position_opened_at: "2026-08-25T02:18:20.032Z" },
  { id: "newest-high-gains", status: "aberto", gains: 21, operational_gains: 21, slot_number: 10, sort_order: 10, position_opened_at: "2026-09-01T18:28:18.580Z" },
  { id: "middle", status: "aberto", gains: 6, operational_gains: 6, slot_number: 8, sort_order: 8, position_opened_at: "2026-08-30T13:04:57.835Z" }
];

test("slots abertos são ordenados da entrada mais antiga para a mais recente", () => {
  assert.deepEqual(
    sortOpenSlotsByOldestPosition(openSlots).map((slot) => slot.id),
    ["oldest", "middle", "newest-high-gains"]
  );
  assert.deepEqual(rankOpenSlotIds(openSlots), { oldest: 1, middle: 2, "newest-high-gains": 3 });
});

test("slot aberto sem timestamp fica por último sem usar atualização como abertura", () => {
  const missingTimestamp = {
    id: "missing",
    status: "aberto",
    gains: 99,
    operational_gains: 99,
    slot_number: 2,
    sort_order: 2,
    position_opened_at: null,
    updated_at: "2020-01-01T00:00:00.000Z"
  };

  assert.deepEqual(
    sortOpenSlotsByOldestPosition([missingTimestamp, ...openSlots]).map((slot) => slot.id),
    ["oldest", "middle", "newest-high-gains", "missing"]
  );
});

test("lista operacional mantém abertos em FIFO e fechados por gains decrescentes", () => {
  const closedSlots = [
    { id: "closed-low", status: "gain", gains: 4, operational_gains: 4, slot_number: 4, sort_order: 4, position_opened_at: null },
    { id: "closed-high", status: "gain", gains: 21, operational_gains: 21, slot_number: 12, sort_order: 12, position_opened_at: null }
  ];

  assert.deepEqual(
    sortSlotsForOperationalList([closedSlots[0], openSlots[1], closedSlots[1], openSlots[0], openSlots[2]]).map((slot) => slot.id),
    ["oldest", "middle", "newest-high-gains", "closed-high", "closed-low"]
  );
});

test("consulta da página carrega o timestamp autoritativo de abertura", () => {
  assert.match(slotsPageSource, /position_gain_unit_usdt,position_opened_at,accounting_version/);
});
