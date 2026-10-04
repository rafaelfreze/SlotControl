import assert from "node:assert/strict";
import test from "node:test";
import { adjustmentEngineInventory } from "./adjustment-engine-inventory.ts";
test("active same-symbol engines remain adjustable with a staged sibling; full inventory retains its cap and shard", () => {
  const rows = [{ id: "A", status: "ACTIVE", executor_shard_id: "executor-02", symbol: "SOLBRL", cap: 100 },
    { id: "B", status: "INACTIVE", executor_shard_id: "executor-03", symbol: "SOLBRL", cap: 100 },
    { id: "C", status: "ACTIVE", executor_shard_id: "executor-03", symbol: "SOLBRL", cap: 100 }];
  const before = structuredClone(rows), result = adjustmentEngineInventory(rows);
  assert.deepEqual(result.active.map(row => row.id), ["A", "C"]);
  assert.deepEqual(result.all, before); assert.deepEqual(rows, before);
  assert.equal(result.all.reduce((sum, row) => sum + row.cap, 0), 300);
});
test("missing/duplicate engine or unknown shard never receives an adjustment", () => {
  const A = { id: "A", status: "ACTIVE", executor_shard_id: "executor-02" };
  for (const rows of [[], [A, A], [{ ...A, status: "INACTIVE" }], [{ ...A, executor_shard_id: "" }]])
    assert.throws(() => adjustmentEngineInventory(rows), /ACCOUNT_UNAVAILABLE/);
});
