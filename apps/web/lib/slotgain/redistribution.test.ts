import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGainRedistributionPreview,
  selectSlotsForGainRedistribution,
  type RedistributionAsset,
  type RedistributionSlot
} from "./redistribution.ts";

function slots(asset: RedistributionAsset, openCount: number, closedCount: number, gains: number[] = []) {
  return Array.from({ length: openCount + closedCount }, (_, index): RedistributionSlot => ({
    id: `${asset}-${String(index + 1).padStart(2, "0")}`,
    slotNumber: index + 1,
    sortOrder: index + 1,
    status: index < openCount ? "aberto" : "gain",
    gains: gains[index] ?? 0
  }));
}

function expectBalanced(preview: ReturnType<typeof buildGainRedistributionPreview>) {
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  const values = preview.selectedSlots.map((slot) => slot.gainsAfter);
  assert.equal(preview.totalGainsBefore, preview.totalGainsAfter);
  assert.ok(Math.max(...values) - Math.min(...values) <= 1);
}

test("BTC seleciona 3 abertos e completa 12 fechados", () => {
  const preview = buildGainRedistributionPreview("BTC", slots("BTC", 3, 22, [10, 6, 1, ...Array(22).fill(0)]));
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.equal(preview.targetSlotCount, 15);
  assert.equal(preview.openSlotCount, 3);
  assert.equal(preview.closedSlotCount, 12);
  expectBalanced(preview);
});

test("SOL seleciona 2 abertos e completa 4 fechados", () => {
  const preview = buildGainRedistributionPreview("SOL", slots("SOL", 2, 8, [5, 1, 0, 0, 1, 2, 3, 4, 5, 6]));
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.equal(preview.targetSlotCount, 6);
  assert.equal(preview.openSlotCount, 2);
  assert.equal(preview.closedSlotCount, 4);
  expectBalanced(preview);
});

test("mantem total divisivel exatamente", () => {
  const preview = buildGainRedistributionPreview("SOL", slots("SOL", 0, 6, [0, 1, 2, 3, 4, 8]));
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.equal(preview.baseGain, 3);
  assert.equal(preview.remainderGain, 0);
  assert.deepEqual(preview.selectedSlots.map((slot) => slot.gainsAfter), Array(6).fill(3));
});

test("distribui a sobra entre os menores gains anteriores", () => {
  const preview = buildGainRedistributionPreview("SOL", slots("SOL", 0, 6, [0, 0, 1, 1, 1, 2]));
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.equal(preview.baseGain, 0);
  assert.equal(preview.remainderGain, 5);
  assert.equal(preview.selectedSlots.find((slot) => slot.slotNumber === 6)?.gainsAfter, 0);
  expectBalanced(preview);
});

test("desempata gains pela ordem natural do slot", () => {
  const preview = buildGainRedistributionPreview("SOL", slots("SOL", 0, 6, [0, 0, 0, 1, 1, 1]));
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.deepEqual(preview.selectedSlots.slice(0, 3).map((slot) => slot.gainsAfter), [1, 1, 1]);
});

test("fecha a selecao usando fechados de menor gain", () => {
  const selected = selectSlotsForGainRedistribution("SOL", slots("SOL", 2, 8, [4, 3, 9, 0, 4, 1, 2, 5, 3, 6]));
  assert.deepEqual(selected.map(({ slot }) => slot.slotNumber), [1, 2, 4, 6, 7, 9]);
});

test("quando ha mais abertos que a meta, usa os abertos com menor gain", () => {
  const selected = selectSlotsForGainRedistribution("SOL", slots("SOL", 8, 2, [5, 0, 1, 0, 3, 2, 4, 1, 0, 0]));
  assert.equal(selected.length, 6);
  assert.ok(selected.every(({ slot }) => slot.status === "aberto"));
  assert.deepEqual(selected.map(({ slot }) => slot.slotNumber), [2, 4, 3, 8, 6, 5]);
});

test("bloqueia quantidade insuficiente", () => {
  const preview = buildGainRedistributionPreview("BTC", slots("BTC", 3, 11));
  assert.equal(preview.ok, false);
  if (!preview.ok) assert.equal(preview.code, "INSUFFICIENT_SLOTS");
});

test("preserva a soma dos gains selecionados", () => {
  const preview = buildGainRedistributionPreview("BTC", slots("BTC", 4, 20, Array.from({ length: 24 }, (_, index) => index * 7)));
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.equal(preview.totalGainsBefore, preview.totalGainsAfter);
});

test("limita a diferenca final entre gains a um", () => {
  expectBalanced(buildGainRedistributionPreview("BTC", slots("BTC", 4, 20, Array.from({ length: 24 }, (_, index) => index * 7))));
});

test("redistribui zero gains sem criar gains", () => {
  const preview = buildGainRedistributionPreview("BTC", slots("BTC", 1, 14));
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.deepEqual(preview.selectedSlots.map((slot) => slot.gainsAfter), Array(15).fill(0));
});

test("suporta numeros altos de gains", () => {
  const preview = buildGainRedistributionPreview("SOL", slots("SOL", 0, 6, [2_000_000_000, 2_000_000_001, 2_000_000_002, 2_000_000_003, 2_000_000_004, 2_000_000_005]));
  expectBalanced(preview);
});

test("rejeita dados invalidos selecionados", () => {
  const invalid = slots("SOL", 0, 6);
  invalid[0].gains = -1;
  const preview = buildGainRedistributionPreview("SOL", invalid);
  assert.equal(preview.ok, false);
  if (!preview.ok) assert.equal(preview.code, "INVALID_SLOT");
});

test("a selecao e deterministica", () => {
  const source = slots("BTC", 3, 20, [4, 1, 3, ...Array.from({ length: 20 }, (_, index) => index % 4)]);
  const first = buildGainRedistributionPreview("BTC", source);
  const second = buildGainRedistributionPreview("BTC", [...source].reverse());
  assert.deepEqual(first, second);
});
