import assert from "node:assert/strict";
import test from "node:test";
import { capacityWarningMuted } from "./capacity-warning-mute.ts";

test("mute is scoped to one operator and shard and never suppresses critical alerts", () => {
  const muted = new Set(["admin-a:executor-01"]);
  const capacity = { shard_id: "executor-01", severity: "WARNING" as const, code: "BINANCE_WEIGHT_WARNING" };
  assert.equal(capacityWarningMuted(capacity, "admin-a", muted), true);
  assert.equal(capacityWarningMuted({ ...capacity, shard_id: "executor-02" }, "admin-a", muted), false);
  assert.equal(capacityWarningMuted(capacity, "admin-b", muted), false);
  assert.equal(capacityWarningMuted({ ...capacity, severity: "CRITICAL" }, "admin-a", muted), false);
  assert.equal(capacityWarningMuted({ ...capacity, code: "SCHEDULER_BACKLOG_WARNING" }, "admin-a", muted), false);
  assert.equal(capacityWarningMuted({ ...capacity, code: "EXECUTOR_RESOURCE_WARNING" }, "admin-a", muted), false);
});
