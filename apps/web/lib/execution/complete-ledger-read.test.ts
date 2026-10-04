import assert from "node:assert/strict";
import test from "node:test";
import { completeLedgerRead } from "./complete-ledger-read.ts";

test("complete financial read covers 1000+ rows and a short final page", async () => {
  const rows = Array.from({ length: 1203 }, (_, n) => ({ id: String(n), amount: 1 }));
  const pages: number[] = [];
  const result = await completeLedgerRead(async (start, end) => {
    pages.push(start); return { data: rows.slice(start, end + 1), error: null };
  }, "READ_FAILED");
  assert.equal(result.reduce((sum, row) => sum + row.amount, 0), 1203);
  assert.deepEqual(pages, [0, 500, 1000]);
});

test("later-page failure, missing data or overlapping pages never returns a partial total", async () => {
  const first = Array.from({ length: 500 }, (_, n) => ({ id: String(n) }));
  for (const second of [{ data: null, error: "unavailable" }, { data: null, error: null },
    { data: [first[0]], error: null }])
    await assert.rejects(completeLedgerRead(async (start) => start ? second : { data: first, error: null }, "READ_FAILED"), /READ_FAILED/);
});
