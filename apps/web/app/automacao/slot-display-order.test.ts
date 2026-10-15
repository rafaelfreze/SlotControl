import assert from "node:assert/strict";
import test from "node:test";
import { orderSlotDisplayRows, type SlotDisplayKey } from "./slot-display-order.ts";

type Row = SlotDisplayKey & {
  rank?: number | null;
  gains?: number;
  monthlyGains?: number;
  operationSequence?: number;
  created_at?: string;
  updated_at?: string;
};
const numbers = (rows: readonly Row[]) => rows.map((row) => row.physicalSlotNumber);
const ordered = (rows: readonly Row[]) => orderSlotDisplayRows(rows, (row) => row);

test("OPEN display keeps physical entry-list order, independent of gains and engine ranks", () => {
  const rows: Row[] = [
    { physicalSlotNumber: 5, entryState: "OPEN", rank: 2, gains: 3, monthlyGains: 3 },
    { physicalSlotNumber: 2, entryState: "OPEN", rank: 3, gains: 1, monthlyGains: 1 },
    { physicalSlotNumber: 1, entryState: "OPEN", rank: 4, gains: 0, monthlyGains: 0 },
    { physicalSlotNumber: 3, entryState: "OPEN", rank: 5, gains: 0, monthlyGains: 0 },
  ];
  assert.deepEqual(numbers(ordered(rows)), [1, 2, 3, 5]);
  const changed = rows.map((row) => ({ ...row, rank: 26 - row.physicalSlotNumber,
    gains: row.physicalSlotNumber * 50, monthlyGains: row.physicalSlotNumber }));
  assert.deepEqual(numbers(ordered(changed)), [1, 2, 3, 5]);
});

test("OPEN variants precede NEXT BUY, while future-entry ordering remains untouched", () => {
  const rows: Row[] = [
    { physicalSlotNumber: 25, entryState: "PLANNED", rank: 1 },
    { physicalSlotNumber: 8, entryState: "ARMED", rank: 4 },
    { physicalSlotNumber: 3, entryState: "TP_ACTIVE", rank: 2 },
    { physicalSlotNumber: 16, entryState: "PLANNED", rank: 2 },
    { physicalSlotNumber: 2, entryState: "PARTIALLY_FILLED", rank: 3 },
    { physicalSlotNumber: 1, entryState: "OPEN", rank: 5 },
    { physicalSlotNumber: 9, entryState: "NEXT_BUY", rank: 3 },
    { physicalSlotNumber: 4, entryState: "REENTRY_WAITING", rank: 3 },
    { physicalSlotNumber: 7, entryState: "TARGET_REACHED", rank: null },
  ];
  assert.deepEqual(numbers(ordered(rows)), [1, 2, 3, 8, 9, 25, 16, 4, 7]);
});

test("physical order never borrows creation/update times or per-slot sequence", () => {
  const rows: Row[] = [
    { physicalSlotNumber: 5, entryState: "OPEN", operationSequence: 1,
      created_at: "2020-01-01T00:00:00Z", updated_at: "2020-01-01T00:00:00Z" },
    { physicalSlotNumber: 2, entryState: "OPEN", operationSequence: 8,
      created_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-15T00:00:00Z" },
    { physicalSlotNumber: 1, entryState: "OPEN", operationSequence: 2 },
    { physicalSlotNumber: 3, entryState: "OPEN" },
  ];
  assert.deepEqual(numbers(ordered(rows)), [1, 2, 3, 5]);
});

test("display ordering copies the collection without mutating strategy records", () => {
  const rows = Object.freeze([
    Object.freeze({ physicalSlotNumber: 5, entryState: "OPEN", rank: 1, gains: 9 }),
    Object.freeze({ physicalSlotNumber: 1, entryState: "OPEN", rank: 2, gains: 0 }),
    Object.freeze({ physicalSlotNumber: 3, entryState: "NEXT_BUY", rank: 3, gains: 0 }),
  ]);
  const before = structuredClone(rows), result = ordered(rows);
  assert.notEqual(result, rows);
  assert.deepEqual(rows, before);
  assert.deepEqual(result.map((row) => row.rank), [2, 1, 3]);
  assert.equal(result[0], rows[1]);
});
