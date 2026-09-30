import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { executorNeedsAttention } from "./capacity-card-presentation.ts";

const now = Date.parse("2026-09-30T18:00:00Z");
const healthy = { state: "HEALTHY", observedAt: new Date(now).toISOString(),
  heartbeatAt: new Date(now - 30_000).toISOString(), alerts: [] };

test("API health never inherits admission certification or warmup failure", () => {
  const route = readFileSync("app/api/coinops-capacity/route.ts", "utf8");
  assert.match(route, /state: assessment\.state/);
  assert.match(route, /action: assessment\.action/);
  assert.doesNotMatch(route, /state: admission\?\.executor_state/);
  assert.match(route, /canAddEngine: admission\?\.code === "CAPACITY_OK"/);
  assert.match(route, /canAddTwoEngineAccount: dualEngineAdmission\?\.code === "CAPACITY_OK"/);
});

test("healthy and transient OBSERVE are hidden without changing admission", () => {
  assert.equal(executorNeedsAttention(healthy, now), false);
  assert.equal(executorNeedsAttention({ ...healthy, state: "OBSERVE" }, now), false);
});
test("faults and alerts remain visible, including muted capacity limit", () => {
  for (const state of ["WARNING", "CAPACITY_LIMIT", "OFFLINE", "CAPACITY_UNKNOWN"])
    assert.equal(executorNeedsAttention({ ...healthy, state }, now), true);
  assert.equal(executorNeedsAttention({ ...healthy, alerts: [{ code: "FAULT" }] }, now), true);
});
test("missing, expired, invalid and future observations cannot hide an executor", () => {
  for (const value of [null, "invalid", new Date(now - 120_001).toISOString(), new Date(now + 1).toISOString()]) {
    assert.equal(executorNeedsAttention({ ...healthy, observedAt: value }, now), true);
    assert.equal(executorNeedsAttention({ ...healthy, heartbeatAt: value }, now), true);
  }
  assert.equal(executorNeedsAttention(healthy, now + 120_001), true);
});
