import assert from "node:assert/strict";
import test from "node:test";
import { liveCronLog } from "./live-cron-log-policy.ts";
const tick = (minute: number) => Date.parse(`2026-10-06T00:${String(minute).padStart(2, "0")}:10Z`);
test("routine execution is sampled twice/hour without financial payload or extra persistence", () => {
  const reports = [{ status: "OK", run_id: "run", next: { price: 450000 }, secret: "never-log" }];
  assert.equal(liveCronLog("EXECUTION", "COMPLETED", reports, "sha", tick(1)), null);
  const sample = liveCronLog("EXECUTION", "COMPLETED", reports, "sha", tick(30));
  assert.equal(sample?.engine_count, 1);
  assert.deepEqual(sample?.counts, { OK: 1 });
  assert.deepEqual(sample?.reports, []);
  assert.ok(!JSON.stringify(sample).includes("never-log"));
  assert.ok(!JSON.stringify(sample).includes("450000"));
});
test("retry, cycle transition, recovery and failures are never sampled away", () => {
  for (const status of ["RETRY", "RESTARTED", "RECOVERED", "FAILED", "CRITICAL"]) {
    const sample = liveCronLog("EXECUTION", status === "FAILED" ? "PARTIAL_FAILURE" : "COMPLETED",
      [{ status, code: "COINOPS_FIXTURE", trading_engine_id: "engine", executor_shard_id: "executor-02" }],
      "sha", tick(7));
    assert.equal(sample?.reports[0].status, status);
    assert.equal(sample?.reports[0].trading_engine_id, "engine");
  }
});
test("periodic deep monitor still emits one compact summary", () => {
  assert.ok(liveCronLog("MONITOR", "COMPLETED", [{ status: "PASS" }], "sha", tick(17)));
});
