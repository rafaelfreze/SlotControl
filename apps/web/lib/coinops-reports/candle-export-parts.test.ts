import assert from "node:assert/strict";
import test from "node:test";
import { CANDLE_EXPORT_MAX_DAYS, partitionCandleExports } from "./candle-export-parts.ts";

test("candles até sete dias permanecem em um único download inclusivo", () => {
  assert.deepEqual(partitionCandleExports("2026-09-22", "2026-09-22"), [{ number: 1, start: "2026-09-22", end: "2026-09-22", days: 1 }]);
  assert.deepEqual(partitionCandleExports("2026-09-16", "2026-09-22"), [{ number: 1, start: "2026-09-16", end: "2026-09-22", days: 7 }]);
});

test("partes cobrem mês e ano sem lacuna nem sobreposição", () => {
  const parts = partitionCandleExports("2026-12-27", "2027-01-11");
  assert.deepEqual(parts, [
    { number: 1, start: "2026-12-27", end: "2027-01-02", days: 7 },
    { number: 2, start: "2027-01-03", end: "2027-01-09", days: 7 },
    { number: 3, start: "2027-01-10", end: "2027-01-11", days: 2 },
  ]);
  assert.equal(parts.reduce((sum, part) => sum + part.days, 0), 16);
});

test("29 de fevereiro é preservado em período bissexto", () => {
  assert.deepEqual(partitionCandleExports("2024-02-26", "2024-03-04"), [
    { number: 1, start: "2024-02-26", end: "2024-03-03", days: 7 },
    { number: 2, start: "2024-03-04", end: "2024-03-04", days: 1 },
  ]);
});

test("máximo de 366 dias produz 53 partes acessíveis e nenhuma perde datas", () => {
  const parts = partitionCandleExports("2024-01-01", "2024-12-31");
  assert.equal(parts.length, 53);
  assert.equal(parts.reduce((sum, part) => sum + part.days, 0), 366);
  assert.equal(parts[0].start, "2024-01-01");
  assert.equal(parts.at(-1)?.end, "2024-12-31");
  assert.ok(parts.every((part) => part.days >= 1 && part.days <= CANDLE_EXPORT_MAX_DAYS));
  for (let index = 1; index < parts.length; index++) assert.equal(Date.parse(parts[index].start) - Date.parse(parts[index - 1].end), 86_400_000);
});

test("datas inválidas ou período invertido não geram download truncado", () => {
  for (const [start, end] of [["2026-02-29", "2026-03-01"], ["2026-99-01", "2026-99-02"], ["2026-09-23", "2026-09-22"], ["2024-01-01", "2025-01-01"], ["", "2026-09-22"]]) assert.deepEqual(partitionCandleExports(start, end), []);
});
