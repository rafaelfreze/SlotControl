import assert from "node:assert/strict";
import test from "node:test";
import { assessShardCapacity, assertUniquePrimaryShard, calculateAdmissionCapacity, decideShardAdmission,
  type ShardMetrics } from "./capacity-manager.ts";

const now = Date.parse("2026-09-26T17:00:00Z");
const metrics = (changes: Partial<ShardMetrics> = {}): ShardMetrics => ({
  shardId: "executor-01", observedAt: new Date(now - 10_000).toISOString(),
  heartbeatAt: new Date(now - 10_000).toISOString(),
  weightObservedAt: new Date(now - 10_000).toISOString(), weightSampleCount: 4,
  registryMatch: true,
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
  assert.equal(result.binancePercent, 60.23);
  assert.equal(result.accountCount, 4);
  assert.equal(result.engineCount, 7);
  assert.equal(decideShardAdmission(metrics(), null, undefined, now).reason,
    "NEW_ACCOUNT_COST_UNMEASURED");
});
test("admission preserves recovery reserve and fails closed on stale metrics", () => {
  assert.equal(decideShardAdmission(metrics(), 200, undefined, now).allowed, true);
  assert.equal(decideShardAdmission(metrics(), 300, undefined, now).allowed, false);
  assert.equal(assessShardCapacity(metrics({ binanceWeightPeak: 4500 }), undefined, now).state,
    "OBSERVE");
  assert.equal(decideShardAdmission(metrics({ observedAt: new Date(now - 121_000).toISOString() }),
    1, undefined, now).allowed, false);
  assert.equal(decideShardAdmission(null, 1, undefined, now).allowed, false);
  assert.equal(decideShardAdmission(metrics({ weightObservedAt: new Date(now - 121_000).toISOString() }),
    1, undefined, now).allowed, false);
  assert.equal(decideShardAdmission(metrics({ registryMatch: false }), 1, undefined, now).allowed, false);
  assert.equal(decideShardAdmission(metrics({ weightObservedAt: "not-a-date" }), 1, undefined, now).allowed, false);
});
test("weight, resources, backlog and heartbeat suggest distinct actions", () => {
  assert.equal(assessShardCapacity(metrics({ binanceWeightAverage: 4000 }), undefined, now).action,
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

test("Diogo one-engine admission uses 15-minute pressure, not the latest counter alone", () => {
  const observed = metrics({ binanceWeightCurrent: 3018, binanceWeightAverage: 3027,
    binanceWeightPeak: 5139 });
  assert.equal(observed.binanceWeightCurrent / 6000 * 100, 50.3);
  assert.equal(assessShardCapacity(observed, undefined, now).binancePercent, 50.45);
  assert.equal(decideShardAdmission(observed, 900, undefined, now).allowed, false);
  // Exactly one engine, unchanged 65% admission ceiling and 35% recovery reserve.
  const normal = metrics({ binanceWeightCurrent: 2257, binanceWeightAverage: 2600,
    binanceWeightPeak: 3000 });
  assert.equal(decideShardAdmission(normal, 900, undefined, now).allowed, true);
  assert.equal(decideShardAdmission({ ...normal, binanceWeightPeak: 5000 }, 900, undefined, now).allowed, true);
  assert.equal(decideShardAdmission(normal, 1800, undefined, now).allowed, false);
});

test("each fixed-IP shard derives admission independently and keeps one recovery reserve", () => {
  const loaded = metrics({ shardId: "executor-01", binanceWeightCurrent: 2860,
    binanceWeightAverage: 4000, binanceWeightPeak: 4448 });
  const available = metrics({ shardId: "executor-02", accountIds: ["a", "b", "c", "d"],
    engineIds: ["a", "b", "c", "d"], binanceWeightCurrent: 1583,
    binanceWeightAverage: 1500, binanceWeightPeak: 2565 });
  assert.equal(assessShardCapacity(loaded, undefined, now).state, "WARNING");
  assert.equal(calculateAdmissionCapacity(loaded, 900, 0, undefined, now).safeAdditionalEngines, 0);
  assert.equal(assessShardCapacity(available, undefined, now).state, "HEALTHY");
  assert.equal(calculateAdmissionCapacity(available, 900, 0, undefined, now).safeAdditionalEngines, 2);
  assert.equal(decideShardAdmission(available, 900, undefined, now).allowed, true);
  assert.equal(decideShardAdmission(available, 1800, undefined, now).allowed, true);
});

test("a pending reservation is counted once and a reflected engine is not reserved again", () => {
  const shard = metrics({ shardId: "executor-02", binanceWeightCurrent: 1583,
    binanceWeightAverage: 2400, binanceWeightPeak: 2565 });
  assert.equal(calculateAdmissionCapacity(shard, 900, 900, undefined, now).safeAdditionalEngines, 0,
    "an actually pending engine consumes the remaining admission budget");
  assert.equal(calculateAdmissionCapacity(shard, 900, 0, undefined, now).safeAdditionalEngines, 1,
    "after telemetry reflects the engine, only the next engine is projected");
});
