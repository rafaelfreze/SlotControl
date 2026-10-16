import assert from "node:assert/strict";
import test from "node:test";
import { configuredEngineSlotCount, hasCompletePhysicalSlotSet, validateEngineSlotCount } from "./engine-slot-topology.ts";

test("topology preserves legacy 25 and validates independent 2/25/50/75/100 engines", () => {
  assert.equal(configuredEngineSlotCount({}), 25);
  for (const count of [2, 25, 50, 75, 100]) {
    assert.equal(validateEngineSlotCount(count), count);
    assert.equal(configuredEngineSlotCount({ slot_count: count, config: { slot_count: count } }), count);
    assert.equal(hasCompletePhysicalSlotSet(Array.from({ length: count }, (_, i) => i + 1), count), true);
  }
});

test("malformed, conflicting or partial topology is never interpreted as a smaller engine", () => {
  for (const count of [null, "100", 0, 1, 101, 25.5, NaN, Infinity])
    assert.throws(() => validateEngineSlotCount(count), /SLOT_COUNT_INVALID/);
  assert.throws(() => configuredEngineSlotCount({ slot_count: 25, config: { slot_count: 100 } }), /MISMATCH/);
  assert.equal(hasCompletePhysicalSlotSet(Array.from({ length: 25 }, (_, i) => i + 1), 100), false);
  assert.equal(hasCompletePhysicalSlotSet([1, 1], 2), false);
  assert.equal(hasCompletePhysicalSlotSet([1, 3], 2), false);
});
