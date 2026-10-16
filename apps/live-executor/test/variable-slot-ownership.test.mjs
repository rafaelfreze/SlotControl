import test from "node:test";
import assert from "node:assert/strict";
import { assertEngineOrder, validateExecutorRegistry } from "../src/account-registry.mjs";
import { liveClientOrderId } from "../../web/lib/execution/robot-v1-live-cycle.ts";
import { engineFixture, registryFixture, ACCOUNT_B } from "./registry-fixture.mjs";

test("100 logical opportunities retain exact engine namespace; sibling25 cannot adopt slot100", () => {
  const a = { ...engineFixture("SOLBRL", ACCOUNT_B, 101, false), slot_count: 100, hard_cap_quote: 1100,
    account_cap_quote: 1375, executor_shard_id: "executor-03" };
  const b = { ...engineFixture("SOLBRL", ACCOUNT_B, 102, false), slot_count: 25,
    account_cap_quote: 1375, executor_shard_id: "executor-03" };
  validateExecutorRegistry({ ...registryFixture([a, b]), executor_shard_id: "executor-03" });
  const run = "00000000-0000-4000-8000-000000000050";
  const ctx = row => ({ ...row, base_asset: "SOL", legacy_compatible: false });
  for (const side of ["BUY", "SELL"]) {
    const id = liveClientOrderId(run, "SOL", 100, 1, side, 1, ctx(a));
    assert.equal(assertEngineOrder(a, "SOLBRL", id, side).slot, "100");
    assert.throws(() => assertEngineOrder(b, "SOLBRL", id, side), /EXECUTOR_ORDER_NOT_OWNED/);
    assert.throws(() => assertEngineOrder({ ...a, slot_count: 25 }, "SOLBRL", id, side), /EXECUTOR_ORDER_NOT_OWNED/);
    assert.ok(id.length <= 36);
  }
  assert.throws(() => validateExecutorRegistry({ ...registryFixture([{ ...a, slot_count: 101 }]),
    executor_shard_id: "executor-03" }), /EXECUTOR_REGISTRY_INVALID/);
});
