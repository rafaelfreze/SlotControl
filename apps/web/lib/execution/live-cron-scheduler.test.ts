import assert from "node:assert/strict";
import test from "node:test";

import { fairPoolOffset, runFairPool } from "./live-cron-scheduler.ts";

test("100 engines run once, retain results and never exceed six active jobs", async () => {
  const items = Array.from({ length: 100 }, (_, index) => index);
  const seen = new Set<number>();
  let active = 0, peak = 0;
  const results = await runFairPool(items, 6, 19, async (item) => {
    assert.ok(!seen.has(item));
    seen.add(item);
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, item % 3));
    active--;
    return item * 2;
  });
  assert.equal(peak, 6);
  assert.equal(seen.size, 100);
  assert.deepEqual(results, items.map((item) => item * 2));
});

test("1, 5 or a whole account failing does not prevent healthy jobs", async () => {
  const items = Array.from({ length: 200 }, (_, index) => index);
  for (const failed of [new Set([0]), new Set([0, 1, 2, 3, 4]), new Set([0, 1])]) {
    const results = await runFairPool(items, 6, 197, async (item) =>
      failed.has(item) ? { status: "FAILED", item } : { status: "OK", item });
    assert.equal(results.length, 200);
    assert.equal(results.filter((result) => result.status === "FAILED").length, failed.size);
    assert.equal(results.filter((result) => result.status === "OK").length, 200 - failed.size);
  }
});

test("rotation prevents the same engine from always starting last", async () => {
  const items = Array.from({ length: 100 }, (_, index) => index);
  const first = [];
  for (const offset of [0, 1, 99]) {
    const order: number[] = [];
    await runFairPool(items, 1, offset, async (item) => { order.push(item); return item; });
    first.push(order[0]);
    assert.equal(new Set(order).size, 100);
  }
  assert.deepEqual(first, [0, 1, 99]);
});

test("partial cron deadlines do not starve the same engines for dozens of minutes", () => {
  for (const [engines, served, maximumMisses] of [[100, 80, 1], [200, 80, 2], [200, 120, 2]]) {
    const missed = Array<number>(engines).fill(0);
    let worst = 0;
    for (let minute = 0; minute < engines * 2; minute++) {
      const first = fairPoolOffset(engines, minute);
      for (let engine = 0; engine < engines; engine++) {
        const rank = (engine - first + engines) % engines;
        missed[engine] = rank < served ? 0 : missed[engine] + 1;
        worst = Math.max(worst, missed[engine]);
      }
    }
    assert.ok(worst <= maximumMisses, `${engines} engines: ${worst} missed rounds`);
  }
  assert.equal(fairPoolOffset(0, 100), 0);
  assert.throws(() => fairPoolOffset(100, -1), /COINOPS_LIVE_POOL_CONFIG_INVALID/);
});
