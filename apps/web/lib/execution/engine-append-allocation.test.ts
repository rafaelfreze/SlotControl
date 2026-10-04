import assert from "node:assert/strict";
import test from "node:test";
import { engineAppendAvailableCapital, engineAppendPreviewHash } from "./engine-append-allocation.ts";
const engines = [{ id: "a", cap: 245, shard: "executor-02" }, { id: "b", cap: 245, shard: "executor-03" }];
test("same physical wallet reserves both engine allocations across IPs, positions/holds are counted only once", () => {
  assert.equal(engineAppendAvailableCapital(490, 490, engines, []).availableCapital, 0);
  const used = [{ engineId: "a", position: 10, confirmedBuyHold: 10 }, { engineId: "b", position: 5, confirmedBuyHold: 10 }];
  assert.equal(engineAppendAvailableCapital(455, 490, engines, used).availableCapital, 0);
  assert.equal(engineAppendAvailableCapital(705, 490, engines, used).availableCapital, 250);
  assert.equal(engineAppendAvailableCapital(705, 515, engines, used).availableCapital, 225);
  assert.equal(engineAppendAvailableCapital(489.999999, 490, engines, []).availableCapital, 0);
});
test("unknown ownership, stale/breached caps and nonfinite values fail; inventory/hash distinguishes engine and shard", () => {
  for (const input of [() => engineAppendAvailableCapital(NaN, 490, engines, []),
    () => engineAppendAvailableCapital(490, 489, engines, []),
    () => engineAppendAvailableCapital(490, 490, engines, [{ engineId: "foreign", position: 1, confirmedBuyHold: 0 }]),
    () => engineAppendAvailableCapital(490, 490, engines, [{ engineId: "a", position: 246, confirmedBuyHold: 0 }])]) assert.throws(input, /ALLOCATION_UNKNOWN/);
  const input = { account: "same", symbol: "SOLBRL" }, hash = engineAppendPreviewHash(input, 490, engines);
  assert.equal(engineAppendPreviewHash(input, 490, [...engines].reverse()), hash);
  assert.notEqual(engineAppendPreviewHash(input, 491, engines), hash);
  assert.notEqual(engineAppendPreviewHash(input, 490, engines.map((engine) => ({ ...engine, shard: "executor-04" }))), hash);
});
