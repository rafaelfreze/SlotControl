import assert from "node:assert/strict";
import test from "node:test";
import { assertRetiredRegistry, reassignStagedAccount } from "./staged-shard-reassignment.ts";

test("staged reassignment previews, retires only its source, then revalidates atomically", async () => {
  const calls: string[] = [];
  const result = await reassignStagedAccount({
    check: async (preview, retired) => { calls.push(`${preview}:${retired}`);
      return { code: preview ? "READY_TO_REASSIGN" : "REASSIGNED", shardId: "executor-02" }; },
    retire: async () => { calls.push("retire"); },
  });
  assert.equal(result.code, "REASSIGNED");
  assert.deepEqual(calls, ["true:false", "retire", "false:true"]);
});
test("a committed replay never retires old registry, even after the account becomes ACTIVE", async () => {
  const result = await reassignStagedAccount({ check: async () => ({ code: "REASSIGNED", shardId: "executor-02", replayed: true }),
    retire: async () => { assert.fail("Replay must not contact the source executor"); } });
  assert.equal(result.replayed, true);
});
test("denied preview and uncertain source retirement never change primary ownership", async () => {
  await assert.rejects(reassignStagedAccount({ check: async () => ({ code: "CAPACITY_UNKNOWN", shardId: "executor-02" }),
    retire: async () => { assert.fail("Denied preview must not retire source"); } }), /REASSIGNMENT_DENIED/);
  let checks = 0;
  await assert.rejects(reassignStagedAccount({ check: async () => { checks++;
    return { code: "READY_TO_REASSIGN", shardId: "executor-02" }; },
    retire: async () => { throw new Error("TIMEOUT"); } }), /TIMEOUT/);
  assert.equal(checks, 1);
});
test("source retirement validates tenant, account, shard and explicitly zero inactive engines", () => {
  const good = { operator_id: "op", exchange_account_id: "acct", environment: "REAL",
    status: "INACTIVE", trading_enabled: false, registered_engines: 0 };
  assert.doesNotThrow(() => assertRetiredRegistry(good, "op", "acct", "executor-01"));
  assert.doesNotThrow(() => assertRetiredRegistry({ ...good, executor_shard_id: "executor-02" }, "op", "acct", "executor-02"));
  for (const patch of [{ operator_id: "other" }, { exchange_account_id: "other" },
    { status: "ACTIVE" }, { trading_enabled: true }, { registered_engines: 1 },
    { environment: "TESTNET" }, { executor_shard_id: "executor-02" }])
    assert.throws(() => assertRetiredRegistry({ ...good, ...patch }, "op", "acct", "executor-01"), /RETIREMENT_FAILED/);
  assert.throws(() => assertRetiredRegistry(good, "op", "acct", "executor-02"), /RETIREMENT_FAILED/);
});
