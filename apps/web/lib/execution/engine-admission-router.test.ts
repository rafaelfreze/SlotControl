import assert from "node:assert/strict";
import test from "node:test";
import { discoverEngineAdmissionOptions } from "./engine-admission-router.ts";
const shards = ["executor-02", "executor-03", "executor-04"].map((id, index) => ({ id, ip: `203.0.113.${index + 2}` }));
test("N-engine router considers every certified decision and cannot move existing engines or fabricate capacity", async () => {
  const queried: Array<[string, number]> = [];
  const options = await discoverEngineAdmissionOptions(shards, 4, {
    preview: async (id, count) => { queried.push([id, count]);
      return { code: id === "executor-02" ? "CAPACITY_REQUIRED" : "CAPACITY_OK", projected_percent: id === "executor-03" ? 60 : 45 }; },
    validatedConnection: async (shard) => shard.id === "executor-03",
  });
  assert.equal(options[0].shardId, "executor-03");
  assert.equal(options[1].shardId, "executor-04");
  assert.equal(options[1].credential, "VALIDATION_REQUIRED");
  assert.deepEqual(queried.sort(), shards.map((shard) => [shard.id, 4]));
  assert.equal(shards[0].id, "executor-02");
});
test("failed, malformed and missing decision of one shard never authorizes it or blocks another", async () => {
  const options = await discoverEngineAdmissionOptions(shards, 1, {
    preview: async (id) => { if (id === "executor-02") throw new Error("offline");
      return { code: id === "executor-04" ? "fake-PASS" : "CAPACITY_OK", projected_percent: null }; },
    validatedConnection: async (shard) => { if (shard.id === "executor-04") throw new Error("missing proof"); return true; },
  });
  assert.equal(options[0].shardId, "executor-03");
  assert.deepEqual(options.slice(1).map((option) => option.capacityCode), ["CAPACITY_UNKNOWN", "CAPACITY_UNKNOWN"]);
  assert.ok(options.every((option) => option.projectedPercent === null));
  await assert.rejects(discoverEngineAdmissionOptions(shards, 0, { preview: async () => ({ code: "CAPACITY_OK" }), validatedConnection: async () => true }), /SCOPE_DENIED/);
});
