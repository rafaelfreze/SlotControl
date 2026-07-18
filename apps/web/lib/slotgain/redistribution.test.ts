import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGainRedistributionPreview,
  isClosedSlot,
  isOpenSlot,
  selectSlotsForGainRedistribution,
  type RedistributionAsset,
  type RedistributionSlot
} from "./redistribution.ts";

function slots(asset: RedistributionAsset, openCount: number, closedCount: number, gains: number[] = [], closedStatus: "gain" | "zerado" = "gain") {
  return Array.from({ length: openCount + closedCount }, (_, index): RedistributionSlot => ({
    id: `${asset}-${String(index + 1).padStart(2, "0")}`,
    slotNumber: index + 1,
    sortOrder: index + 1,
    status: index < openCount ? (index % 2 === 0 ? "aberto" : "hold") : closedStatus,
    gainsDistribuidos: gains[index] ?? 0,
    gains: 1000 + index,
    baseValue: 10,
    reinvestedProfit: 0,
    operationalSlotValue: 10
  }));
}

function previewOk(preview: ReturnType<typeof buildGainRedistributionPreview>) {
  assert.equal(preview.ok, true);
  if (!preview.ok) throw new Error("Previa deveria estar valida.");
  return preview;
}

function expectPreserved(preview: ReturnType<typeof buildGainRedistributionPreview>) {
  const result = previewOk(preview);
  assert.equal(result.totalGainsBefore, result.totalGainsAfter);
  assert.equal(
    result.closedSlots.filter((slot) => slot.role === "ZEROED").every((slot) => slot.gainsAfter === 0),
    true
  );
  const recipientValues = result.closedSlots.filter((slot) => slot.role === "RECIPIENT").map((slot) => slot.gainsAfter);
  assert.ok(Math.max(...recipientValues) - Math.min(...recipientValues) <= 1);
}

test("classifica gain e zerado como fechados, e aberto e hold como expostos", () => {
  assert.equal(isClosedSlot("gain"), true);
  assert.equal(isClosedSlot("zerado"), true);
  assert.equal(isClosedSlot("aberto"), false);
  assert.equal(isOpenSlot("aberto"), true);
  assert.equal(isOpenSlot("hold"), true);
  assert.equal(isOpenSlot("gain"), false);
});

test("BTC ignora 3 abertos, usa os 22 fechados e zera 7 excedentes", () => {
  const source = slots("BTC", 3, 22, [99, 98, 97, ...Array.from({ length: 22 }, (_, index) => index)]);
  const preview = previewOk(buildGainRedistributionPreview("BTC", source));
  assert.equal(preview.ignoredOpenSlotCount, 3);
  assert.equal(preview.closedSlotCount, 22);
  assert.equal(preview.recipientSlotCount, 15);
  assert.equal(preview.zeroedSlotCount, 7);
  assert.equal(preview.closedSlots.filter((slot) => slot.role === "RECIPIENT")[0]?.slotNumber, 25);
  assert.deepEqual(source.slice(0, 3).map((slot) => slot.gainsDistribuidos), [99, 98, 97]);
  expectPreserved(preview);
});

test("SOL usa todos os fechados no pool e seleciona exatamente 6 destinatarios", () => {
  const preview = previewOk(buildGainRedistributionPreview("SOL", slots("SOL", 2, 8, [88, 77, 1, 9, 2, 8, 3, 7, 4, 6])));
  assert.equal(preview.ignoredOpenSlotCount, 2);
  assert.equal(preview.closedSlotCount, 8);
  assert.equal(preview.recipientSlotCount, 6);
  assert.equal(preview.zeroedSlotCount, 2);
  assert.deepEqual(preview.closedSlots.filter((slot) => slot.role === "RECIPIENT").map((slot) => slot.slotNumber), [4, 6, 8, 10, 9, 7]);
  expectPreserved(preview);
});

test("seleciona os maiores gains e desempata pelo menor numero do slot", () => {
  const source = slots("SOL", 0, 8, [4, 9, 9, 3, 9, 1, 8, 2]);
  assert.deepEqual(selectSlotsForGainRedistribution("SOL", source).map((slot) => slot.slotNumber), [2, 3, 5, 7, 1, 4]);
});

test("mantem total divisivel exatamente", () => {
  const preview = previewOk(buildGainRedistributionPreview("SOL", slots("SOL", 0, 6, [0, 1, 2, 3, 4, 8])));
  assert.equal(preview.baseGain, 3);
  assert.equal(preview.remainderGain, 0);
  assert.deepEqual(preview.closedSlots.map((slot) => slot.gainsAfter), Array(6).fill(3));
});

test("distribui sobra aos primeiros destinatarios pela ordem de maior gain anterior", () => {
  const preview = previewOk(buildGainRedistributionPreview("BTC", slots("BTC", 0, 22, [6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 4, 4, 4, 4, 4, 0, 0, 0, 0, 0, 0, 0])));
  assert.equal(preview.totalGainsBefore, 80);
  assert.equal(preview.baseGain, 5);
  assert.equal(preview.remainderGain, 5);
  assert.deepEqual(preview.closedSlots.filter((slot) => slot.role === "RECIPIENT").slice(0, 5).map((slot) => slot.gainsAfter), Array(5).fill(6));
  expectPreserved(preview);
});

test("menos fechados que a meta usa todos os slots fechados", () => {
  const preview = previewOk(buildGainRedistributionPreview("BTC", slots("BTC", 4, 3, [20, 19, 18, 17, 4, 5, 6])));
  assert.equal(preview.recipientSlotCount, 3);
  assert.equal(preview.zeroedSlotCount, 0);
  assert.equal(preview.baseGain, 5);
  expectPreserved(preview);
});

test("bloqueia quando nao ha slots fechados", () => {
  const preview = buildGainRedistributionPreview("SOL", slots("SOL", 4, 0, [1, 2, 3, 4]));
  assert.equal(preview.ok, false);
  if (!preview.ok) assert.equal(preview.code, "NO_CLOSED_SLOTS");
});

test("slots abertos e gains financeiros ficam inalterados no calculo", () => {
  const source = slots("SOL", 2, 8, [99, 88, 1, 2, 3, 4, 5, 6, 7, 8]);
  const beforeFinancial = source.map((slot) => slot.gains);
  const preview = previewOk(buildGainRedistributionPreview("SOL", source));
  assert.deepEqual(preview.ignoredOpenSlots.map((slot) => slot.gainsDistribuidos), [99, 88]);
  assert.deepEqual(source.map((slot) => slot.gains), beforeFinancial);
  expectPreserved(preview);
});

test("todos os zero gains continuam zero", () => {
  const preview = previewOk(buildGainRedistributionPreview("BTC", slots("BTC", 3, 22)));
  assert.deepEqual(preview.closedSlots.map((slot) => slot.gainsAfter), Array(22).fill(0));
  expectPreserved(preview);
});

test("suporta numeros altos sem criar ou perder gains", () => {
  const preview = previewOk(buildGainRedistributionPreview("SOL", slots("SOL", 0, 6, [2_000_000_000, 2_000_000_001, 2_000_000_002, 2_000_000_003, 2_000_000_004, 2_000_000_005])));
  assert.equal(preview.totalGainsBefore, 12_000_000_015);
  expectPreserved(preview);
});

test("rejeita dados invalidos em slots fechados", () => {
  const invalid = slots("SOL", 0, 6);
  invalid[0].gainsDistribuidos = -1;
  const preview = buildGainRedistributionPreview("SOL", invalid);
  assert.equal(preview.ok, false);
  if (!preview.ok) assert.equal(preview.code, "INVALID_SLOT");
});

test("a selecao e deterministica independentemente da ordem de entrada", () => {
  const source = slots("BTC", 3, 20, [100, 99, 98, ...Array.from({ length: 20 }, (_, index) => index % 4)]);
  const first = buildGainRedistributionPreview("BTC", source);
  const second = buildGainRedistributionPreview("BTC", [...source].reverse());
  assert.deepEqual(first, second);
});

test("redistribui o lucro reinvestido dos fechados sem tocar no capital-base ou nos abertos", () => {
  const source = slots("BTC", 3, 22, [99, 98, 97, ...Array.from({ length: 22 }, (_, index) => index)]);
  source.forEach((slot, index) => {
    slot.baseValue = 10 + index;
    slot.reinvestedProfit = index < 3 ? 7 : (index - 2) / 100;
    slot.operationalSlotValue = slot.baseValue + slot.reinvestedProfit;
  });

  const preview = previewOk(buildGainRedistributionPreview("BTC", source));
  const recipients = preview.closedSlots.filter((slot) => slot.role === "RECIPIENT");
  const zeroed = preview.closedSlots.filter((slot) => slot.role === "ZEROED");
  const before = source.slice(3).reduce((sum, slot) => sum + Number(slot.reinvestedProfit), 0);
  const after = preview.closedSlots.reduce((sum, slot) => sum + slot.reinvestedProfitAfter, 0);

  assert.equal(preview.totalReinvestedBefore, Number(before.toFixed(8)));
  assert.equal(preview.totalReinvestedAfter, Number(after.toFixed(8)));
  assert.equal(zeroed.every((slot) => slot.reinvestedProfitAfter === 0), true);
  assert.equal(recipients.every((slot) => slot.operationalSlotValueAfter === Number(slot.baseValue || 0) + slot.reinvestedProfitAfter), true);
  assert.deepEqual(source.slice(0, 3).map((slot) => slot.reinvestedProfit), [7, 7, 7]);
});

test("reparte unidades monetarias residuais de forma deterministica", () => {
  const source = slots("SOL", 0, 6, [6, 5, 4, 3, 2, 1]);
  source.forEach((slot) => {
    slot.baseValue = 10;
    slot.reinvestedProfit = 0.00000001;
    slot.operationalSlotValue = 10.00000001;
  });
  const preview = previewOk(buildGainRedistributionPreview("SOL", source));
  assert.equal(preview.baseReinvested, 0.00000001);
  assert.equal(preview.remainderReinvestedUnits, 0);
  assert.equal(preview.closedSlots.every((slot) => slot.reinvestedProfitAfter === 0.00000001), true);
});
