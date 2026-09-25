import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateSlotGains } from "./gain-estimate.ts";

test("simulator compounds each physical slot at the configured rate", () => {
  const btc = estimateSlotGains(Array(25).fill(16.76), 0.012, 10);
  assert.ok(btc);
  assert.ok(Math.abs(btc.averageSlotProjected - 16.76 * 1.012 ** 10) < 1e-9);
  assert.ok(Math.abs(btc.projected - 419 * 1.012 ** 10) < 1e-9);
  const mixed = estimateSlotGains([11, 14], 0.05, 2);
  assert.ok(mixed);
  assert.ok(Math.abs(mixed.projected - 25 * 1.05 ** 2) < 1e-9);
  assert.ok(Math.abs(mixed.profit - mixed.initial * (1.05 ** 2 - 1)) < 1e-9);
});

test("500 reinvested gains match the user's single-slot calculator example", () => {
  const estimate = estimateSlotGains([11], 0.05, 500);
  assert.ok(estimate);
  assert.ok(Math.abs(estimate.projected - 432_555_880_099.4) < 0.02);
  assert.equal(estimateSlotGains([11], 0.05, 0)?.projected, 11);
});

test("simulator never invents capital when configuration is missing", () => {
  assert.equal(estimateSlotGains([], 0.012, 10), null);
  assert.equal(estimateSlotGains([0], 0.012, 10), null);
  assert.equal(estimateSlotGains([11, -1], 0.012, 10), null);
  assert.equal(estimateSlotGains([11], 0, 10), null);
  assert.equal(estimateSlotGains([11], 0.012, -1), null);
  assert.equal(estimateSlotGains([11], 0.012, 0.5), null);
});
