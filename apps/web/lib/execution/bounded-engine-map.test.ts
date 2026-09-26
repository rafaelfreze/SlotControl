import assert from "node:assert/strict";
import test from "node:test";

import { boundedEngineMap } from "./bounded-engine-map.ts";

test("bounds concurrent engines and preserves ordered, isolated outcomes", async () => {
  let active = 0;
  let peak = 0;
  const seen: number[] = [];
  const result = await boundedEngineMap([0, 1, 2, 3, 4, 5, 6], 2, async (engine) => {
    active++;
    peak = Math.max(peak, active);
    seen.push(engine);
    await new Promise((resolve) => setTimeout(resolve, engine === 0 ? 20 : 1));
    active--;
    return engine === 3 ? { engine, status: "FAILED" } : { engine, status: "OK" };
  });
  assert.equal(peak, 2);
  assert.deepEqual(result.map((item) => item.engine), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(result[3].status, "FAILED");
  assert.ok(seen.indexOf(2) < seen.indexOf(0) + 3, "other engine progressed while one was slow");
});

test("rejects unsafe concurrency and handles no engines", async () => {
  await assert.rejects(boundedEngineMap([1], 0, async () => 1),
    /COINOPS_LIVE_CRON_CONCURRENCY_INVALID/);
  assert.deepEqual(await boundedEngineMap([], 2, async () => 1), []);
});
