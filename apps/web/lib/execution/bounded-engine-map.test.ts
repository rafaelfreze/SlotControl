import assert from "node:assert/strict";
import test from "node:test";

import { boundedEngineMap, fairPoolOffset } from "./bounded-engine-map.ts";

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

test("four Production accounts and seven engines keep Pedro isolated", async () => {
  const engines = ["Rafael/BTCBRL", "Rafael/SOLBRL", "Thyely/BTCUSDT",
    "Thyely/SOLUSDT", "Caixeta/BTCBRL", "Caixeta/SOLBRL", "Pedro/SOLBRL"];
  for (const failed of [new Set(["Pedro/SOLBRL"]),
    new Set(engines.slice(0, 5)), new Set(["Caixeta/BTCBRL", "Caixeta/SOLBRL"])]) {
    const result = await boundedEngineMap(engines, 4, async (engine) => ({
      engine, status: failed.has(engine) ? "FAILED" : "OK",
    }));
    assert.deepEqual(result.map((item) => item.engine), engines);
    assert.deepEqual(result.filter((item) => item.status === "FAILED").map((item) => item.engine),
      engines.filter((engine) => failed.has(engine)));
    assert.deepEqual(result.filter((item) => item.status === "OK").map((item) => item.engine),
      engines.filter((engine) => !failed.has(engine)));
  }
});

test("rotation changes start order without changing any of seven outcomes", async () => {
  const items = Array.from({ length: 7 }, (_, index) => index);
  const starts: number[] = [];
  for (let minute = 0; minute < 7; minute++) {
    const seen: number[] = [];
    const output = await boundedEngineMap(items, 4, async (item) => {
      seen.push(item);
      return item * 2;
    }, fairPoolOffset(items.length, minute));
    starts.push(seen[0]);
    assert.equal(new Set(seen).size, 7);
    assert.deepEqual(output, items.map((item) => item * 2));
  }
  assert.equal(new Set(starts).size, 7);
});

test("100 and 200 synthetic engines retain bounded concurrency and failure scope", async () => {
  for (const size of [100, 200]) {
    const engines = Array.from({ length: size }, (_, index) => index);
    for (const failed of [new Set([0]), new Set([0, 1, 2, 3, 4]), new Set([0, 1])]) {
      let active = 0, peak = 0;
      const seen = new Set<number>();
      const reports = await boundedEngineMap(engines, 4, async (engine) => {
        assert.ok(!seen.has(engine));
        seen.add(engine);
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, engine % 3));
        active--;
        return { engine, status: failed.has(engine) ? "FAILED" : "OK" };
      }, fairPoolOffset(size, 197));
      assert.ok(peak <= 4);
      assert.equal(seen.size, size);
      assert.deepEqual(reports.map((item) => item.engine), engines);
      assert.equal(reports.filter((item) => item.status === "FAILED").length, failed.size);
    }
  }
});

test("coprime rotation avoids repeated starvation under partial deadlines", () => {
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
  assert.throws(() => fairPoolOffset(100, -1), /COINOPS_LIVE_CRON_CONCURRENCY_INVALID/);
  assert.equal(fairPoolOffset(7, Number.MAX_SAFE_INTEGER),
    Number((BigInt(Number.MAX_SAFE_INTEGER) * BigInt(3)) % BigInt(7)));
});
