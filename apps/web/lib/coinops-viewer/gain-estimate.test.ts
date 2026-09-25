import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateSlotGains } from "./gain-estimate.ts";

test("simulator uses per-slot capital and the actual configured rate", () => {
  assert.ok(Math.abs((estimateSlotGains(419, 25, 0.012, 10) ?? 0) - 2.0112) < 1e-9);
  assert.ok(Math.abs((estimateSlotGains(419, 20, 0.055, 2) ?? 0) - 2.3045) < 1e-9);
});

test("simulator never invents capital when configuration is missing", () => {
  assert.equal(estimateSlotGains(0, 25, 0.012, 10), null);
  assert.equal(estimateSlotGains(419, 0, 0.012, 10), null);
  assert.equal(estimateSlotGains(419, 25, 0, 10), null);
  assert.equal(estimateSlotGains(419, 25, 0.012, -1), null);
});
