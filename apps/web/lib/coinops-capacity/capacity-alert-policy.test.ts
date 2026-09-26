import assert from "node:assert/strict";
import test from "node:test";
import { capacityAlertMessage } from "./capacity-alert-policy.ts";
test("capacity push identifies shard, timestamp and exact infrastructure anchor", () => {
  const alert = { id: "incident", shard_id: "executor-02", code: "EXECUTOR_OFFLINE", first_seen_at: "2026-09-26T19:30:00Z" };
  const first = capacityAlertMessage(alert);
  assert.match(first.body, /^Executor 02 .*15:30$/);
  assert.equal(first.url, "/automacao?view=live#infra-executor-02");
  assert.deepEqual(capacityAlertMessage(alert), first);
  assert.notEqual(capacityAlertMessage({ ...alert, first_seen_at: "2026-09-26T20:00:00Z" }).tag, first.tag);
  assert.throws(() => capacityAlertMessage({ ...alert, shard_id: "https://foreign.invalid" }));
});
