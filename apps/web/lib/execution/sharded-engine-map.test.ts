import assert from "node:assert/strict";
import test from "node:test";
import { shardedEngineMap } from "./sharded-engine-map.ts";
import { boundedEngineMap, fairPoolOffset } from "./bounded-engine-map.ts";

test("offline02 consumes none of01 workers; all7 existing engines complete before02 recovers", async () => {
  const rows = Array.from({ length: 5 }, (_, id) => ({ id, shard: "executor-02" }))
    .concat(Array.from({ length: 7 }, (_, id) => ({ id: id + 5, shard: "executor-01" })));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const completed: number[] = [], active = new Map<string, number>(), peak = new Map<string, number>();
  const running = shardedEngineMap(rows, (row) => row.shard, 4, async (row) => {
    active.set(row.shard, (active.get(row.shard) ?? 0) + 1);
    peak.set(row.shard, Math.max(peak.get(row.shard) ?? 0, active.get(row.shard)!));
    if (row.shard === "executor-02") await blocked;
    else await Promise.resolve();
    completed.push(row.id); active.set(row.shard, active.get(row.shard)! - 1);
    return row.id;
  }, 2);
  for (let index = 0; index < 20; index++) await Promise.resolve();
  assert.equal(completed.length, 7); assert.ok(completed.every((id) => id >= 5));
  release();
  assert.deepEqual(await running, rows.map((row) => row.id));
  assert.equal(peak.get("executor-01"), 4); assert.equal(peak.get("executor-02"), 4);
});

test("single-shard scheduling exactly preserves current fairness, order and concurrency", async () => {
  const rows = Array.from({ length: 7 }, (_, id) => id);
  for (const minute of [0, 1, 2, 97]) {
    const old: number[] = [], next: number[] = [];
    await boundedEngineMap(rows, 4, async (row) => { old.push(row); }, fairPoolOffset(rows.length, minute));
    await shardedEngineMap(rows, () => "executor-01", 4, async (row) => { next.push(row); }, minute);
    assert.deepEqual(next, old);
  }
});
