import assert from "node:assert/strict";
import test from "node:test";
import { liveEngineExposure } from "./engine-exposure.ts";

const engines = [{ id: "A", asset: "SOL" as const, cap: 100 }, { id: "B", asset: "SOL" as const, cap: 200 },
  { id: "C", asset: "BTC" as const, cap: 100 }];
const positions = [{ engineId: "A", committed: 90 }, { engineId: "B", committed: 20 }, { engineId: "C", committed: 10 }];
const orders = [{ engineId: "A", side: "BUY", status: "NEW", reserved: 10, executedQuote: 0 },
  { engineId: "B", side: "BUY", status: "PARTIALLY_FILLED", reserved: 30, executedQuote: 20 },
  { engineId: "C", side: "SELL", status: "NEW", reserved: 10, executedQuote: 0 }];

test("same-symbol engines have distinct hard caps but one native account cap across shards", () => {
  assert.deepEqual(liveEngineExposure("A", engines, positions, orders, 400), { BTC: 0, SOL: 100, global: 140 });
  assert.deepEqual(liveEngineExposure("B", engines, positions, orders, 400), { BTC: 0, SOL: 30, global: 140 });
  assert.deepEqual(liveEngineExposure("C", engines, positions, orders, 400), { BTC: 10, SOL: 0, global: 140 });
  assert.throws(() => liveEngineExposure("B", engines, positions, orders, 139), /HARD_CAP_BREACHED/);
});

test("a sibling-local cap breach never changes the selected engine cap", () => {
  const breached = [{ ...positions[0], committed: 110 }, ...positions.slice(1)];
  assert.throws(() => liveEngineExposure("A", engines, breached, orders, 400), /HARD_CAP_BREACHED/);
  assert.equal(liveEngineExposure("B", engines, breached, orders, 400).SOL, 30);
});

test("N-engine identity and corrupted/unknown exposure fail closed without partial account totals", () => {
  for (const invalid of [[{ engineId: "foreign", committed: 1 }], [{ engineId: "A", committed: NaN }],
    [{ engineId: "A", committed: -1 }]])
    assert.throws(() => liveEngineExposure("A", engines, invalid, orders, 400), /EXPOSURE_INVALID/);
  assert.throws(() => liveEngineExposure("A", [...engines, engines[0]], positions, orders, 400), /EXPOSURE_INVALID/);
  const many = Array.from({ length: 100 }, (_, n) => ({ id: String(n), asset: "SOL" as const, cap: 10 }));
  assert.equal(liveEngineExposure("99", many, many.map((engine) => ({ engineId: engine.id, committed: 1 })), [], 1000).SOL, 1);
});
