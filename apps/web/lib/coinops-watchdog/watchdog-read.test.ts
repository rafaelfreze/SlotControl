import test from "node:test";
import assert from "node:assert/strict";
import { completeWatchdogRows } from "./watchdog-read.ts";

test("watchdog observation pages a complete ledger and shares one bounded deadline", async () => {
  const fixture = Array.from({ length: 501 }, (_, id) => ({ id }));
  const calls: Array<[number, number, AbortSignal]> = [];
  const rows = await completeWatchdogRows<{ id: number }>((start, end, signal) => {
    calls.push([start, end, signal]);
    return Promise.resolve({ data: fixture.slice(start, end + 1), error: null, count: fixture.length });
  });
  assert.deepEqual(rows, fixture);
  assert.deepEqual(calls.map(([start, end]) => [start, end]), [[0, 499], [500, 999]]);
  assert.equal(calls[0][2], calls[1][2]);
});

test("watchdog incomplete/provider-failed/unstable observation never certifies pause", async () => {
  for (const result of [
    { data: [], error: null, count: 1 },
    { data: [], error: null, count: null },
    { data: null, error: null, count: 0 },
    { data: [{ id: 1 }], error: null, count: 0 },
    { data: [], error: { code: "57014" }, count: 0 },
  ]) await assert.rejects(completeWatchdogRows(() => Promise.resolve(result)),
    /COINOPS_WATCHDOG_LEDGER_READ_FAILED/);
  await assert.rejects(completeWatchdogRows((start) => Promise.resolve({
    data: Array.from({ length: 500 }, (_, id) => ({ id })), error: null, count: start ? 1001 : 1000 })),
  /COINOPS_WATCHDOG_LEDGER_READ_FAILED/);
});
