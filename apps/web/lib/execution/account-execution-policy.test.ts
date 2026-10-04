import assert from "node:assert/strict";
import test from "node:test";
import { advanceAccountExecutionPolicy, ENGINE_ISOLATION_CONTRACT, type PolicyDependencies, type PolicyShardProof } from "./account-execution-policy.ts";
const NOW = Date.parse("2026-10-04T16:00:00Z"), VERSION = "a".repeat(40), REQUEST = "00000000-0000-4000-8000-000000000001";
const ids = ["executor-02", "executor-03"];
const proof = (shardId: string): PolicyShardProof => ({ shardId, ip: `203.0.113.${shardId.endsWith("02") ? 2 : 3}`,
  version: VERSION, observedAt: NOW, healthy: true, credentialValidated: true, protocol: 1, contract: ENGINE_ISOLATION_CONTRACT });
function fixture() {
  const calls: string[] = [], recorded = new Set<string>();
  const policy = { request_id: REQUEST, executor_version: VERSION, required_shards: ids, status: "PREPARING" as "PREPARING" | "ACTIVE" };
  const dependencies: PolicyDependencies = { now: () => NOW,
    inspect: async (id) => { calls.push(`inspect:${id}`); return proof(id); },
    stage: async () => { calls.push("stage"); return { ...policy }; },
    enable: async (p) => { calls.push(`enable:${p.shardId}`); return { ...p, enabled: true }; },
    record: async (p) => { calls.push(`record:${p.shardId}`); recorded.add(p.shardId);
      policy.status = recorded.size === ids.length ? "ACTIVE" : "PREPARING"; return { ...policy }; } };
  return { dependencies, calls, policy };
}
test("all hosting shards are preflighted before PREPARING; sequential marker plus proof converges on ACTIVE", async () => {
  const f = fixture(); assert.equal((await advanceAccountExecutionPolicy(ids, f.dependencies)).status, "ACTIVE");
  assert.deepEqual(f.calls, ["inspect:executor-02", "inspect:executor-03", "stage", "enable:executor-02", "record:executor-02", "enable:executor-03", "record:executor-03"]);
  assert.equal((await advanceAccountExecutionPolicy(ids, f.dependencies)).request_id, REQUEST);
});
test("absent credential, old protocol, unhealthy host, jitter/old proof and mixed runtime cannot stage", async () => {
  for (const change of [{ credentialValidated: false }, { protocol: 0 }, { healthy: false },
    { observedAt: NOW - 30_001 }, { observedAt: NOW + 2001 }, { version: "b".repeat(40) }]) {
    const f = fixture(); f.dependencies.inspect = async (id) => ({ ...proof(id), ...(id === ids[1] ? change : {}) });
    await assert.rejects(advanceAccountExecutionPolicy(ids, f.dependencies), /PREFLIGHT_REQUIRED|PARITY_REQUIRED/);
    assert.deepEqual(f.calls, []);
  }
});
test("partial marker rollout stays PREPARING and resumes the same request; no downgrade or financial action", async () => {
  const f = fixture(), enable = f.dependencies.enable;
  f.dependencies.enable = async (p, request) => { if (p.shardId === ids[1]) throw new Error("offline"); return enable(p, request); };
  await assert.rejects(advanceAccountExecutionPolicy(ids, f.dependencies), /offline/);
  assert.equal(f.policy.status, "PREPARING");
  f.dependencies.enable = enable;
  assert.equal((await advanceAccountExecutionPolicy(ids, f.dependencies)).status, "ACTIVE");
  assert.ok(f.calls.every((call) => !/order|move|cancel|pause|credential-write/.test(call)));
});
test("wrong marker scope, changed inventory and elapsed preflight cannot be recorded", async () => {
  const wrong = fixture(); wrong.dependencies.enable = async (p) => ({ ...p, shardId: "executor-04", enabled: true });
  await assert.rejects(advanceAccountExecutionPolicy(ids, wrong.dependencies), /PROOF_DENIED/);
  assert.ok(!wrong.calls.some((call) => call.startsWith("record:")));
  const changed = fixture(); changed.dependencies.stage = async () => ({ ...changed.policy, required_shards: [...ids, "executor-04"] });
  await assert.rejects(advanceAccountExecutionPolicy(ids, changed.dependencies), /REPLAY_MISMATCH/);
  const stale = fixture(); let now = NOW;
  stale.dependencies.now = () => now; stale.dependencies.stage = async () => { now += 30_001; return stale.policy; };
  await assert.rejects(advanceAccountExecutionPolicy(ids, stale.dependencies), /PREFLIGHT_REQUIRED/);
  assert.ok(!stale.calls.some((call) => call.startsWith("enable:")));
});
