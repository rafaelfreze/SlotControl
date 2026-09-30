import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { executorNeedsAttention, selectOverviewExecutors } from "./capacity-card-presentation.ts";

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

test("healthy and transient OBSERVE do not imply a fault", () => {
  assert.equal(executorNeedsAttention(healthy, now), false);
  assert.equal(executorNeedsAttention({ ...healthy, state: "OBSERVE" }, now), false);
});

const shard = (id: string, canAddEngine = true, state = "HEALTHY") => ({ ...healthy, id, canAddEngine, state });
test("home keeps faults first, then only executors with persisted space", () => {
  const input = [shard("executor-01", false), shard("executor-02"), shard("executor-03", false, "OFFLINE"), shard("executor-04", true, "OBSERVE")];
  assert.deepEqual(selectOverviewExecutors(input, now).map((item) => item.id), ["executor-03", "executor-02", "executor-04"]);
  assert.equal(input[0].id, "executor-01");
  assert.equal(input[0].canAddEngine, false);
});
test("without usable capacity all executors remain eligible; stale evidence comes first", () => {
  const stale = { ...shard("executor-03"), heartbeatAt: null };
  assert.deepEqual(selectOverviewExecutors([shard("executor-01", false), shard("executor-02", false), stale], now)
    .map((item) => item.id), ["executor-03", "executor-01", "executor-02"]);
});
test("home caps five, faults precede available shards including future executors", () => {
  const input = Array.from({ length: 8 }, (_, index) => shard(`executor-0${index + 1}`));
  input[7].state = "WARNING";
  assert.deepEqual(selectOverviewExecutors(input, now).map((item) => item.id), ["executor-08", "executor-01", "executor-02", "executor-03", "executor-04"]);
  assert.deepEqual(selectOverviewExecutors([], now), []);
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
