import assert from "node:assert/strict";
import test from "node:test";
import { assessShardCapacity, assertUniquePrimaryShard, decideShardAdmission,
  type ShardMetrics } from "./capacity-manager.ts";

const now = Date.parse("2026-09-26T17:00:00Z");
const metrics = (changes: Partial<ShardMetrics> = {}): ShardMetrics => ({
  shardId: "executor-01", observedAt: new Date(now - 10_000).toISOString(),
  heartbeatAt: new Date(now - 10_000).toISOString(),
  accountIds: ["rafael", "thyely", "caixeta", "pedro"],
  engineIds: Array.from({ length: 7 }, (_, i) => `engine-${i}`),
  binanceWeightCurrent: 2258, binanceWeightAverage: 3614, binanceWeightPeak: 3628,
  cpuPercent: 4.9, ramUsedMb: 147, ramLimitMb: 961,
  reconciliationP95Ms: 10_000, schedulerBacklog: 0,
  errorsLast5m: 0, retriesLast5m: 0, ...changes,
});
test("observed seven engines are OBSERVE, not fabricated 50-account headroom", () => {
  const result = assessShardCapacity(metrics(), undefined, now);
  assert.equal(result.state, "OBSERVE");
  assert.equal(result.binancePercent, 60.47);
  assert.equal(result.accountCount, 4);
  assert.equal(result.engineCount, 7);
  assert.equal(decideShardAdmission(metrics(), null, undefined, now).reason,
    "NEW_ACCOUNT_COST_UNMEASURED");
});
test("admission preserves recovery reserve and fails closed on stale metrics", () => {
  assert.equal(decideShardAdmission(metrics(), 200, undefined, now).allowed, true);
  assert.equal(decideShardAdmission(metrics(), 300, undefined, now).allowed, false);
  assert.equal(assessShardCapacity(metrics({ binanceWeightPeak: 4500 }), undefined, now).state,
    "CAPACITY_LIMIT");
  assert.equal(decideShardAdmission(metrics({ observedAt: new Date(now - 121_000).toISOString() }),
    1, undefined, now).allowed, false);
  assert.equal(decideShardAdmission(null, 1, undefined, now).allowed, false);
});
test("weight, resources, backlog and heartbeat suggest distinct actions", () => {
  assert.equal(assessShardCapacity(metrics({ binanceWeightPeak: 4000 }), undefined, now).action,
    "SCALE_OUT");
  assert.equal(assessShardCapacity(metrics({ cpuPercent: 86 }), undefined, now).action, "SCALE_UP");
  assert.equal(assessShardCapacity(metrics({ schedulerBacklog: 1 }), undefined, now).action,
    "INVESTIGATE");
  assert.equal(assessShardCapacity(metrics({ heartbeatAt: new Date(now - 121_000).toISOString() }),
    undefined, now).state, "OFFLINE");
});
test("one account cannot have two primary shards", () => {
  assert.equal(assertUniquePrimaryShard([{ accountId: "rafael", shardId: "01" },
    { accountId: "rafael", shardId: "01" }]).size, 1);
  assert.throws(() => assertUniquePrimaryShard([{ accountId: "rafael", shardId: "01" },
    { accountId: "rafael", shardId: "02" }]), /COINOPS_ACCOUNT_MULTIPLE_PRIMARY_SHARDS/);
});
