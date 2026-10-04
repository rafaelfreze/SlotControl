import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountOrderPolicyEnabled, enableAccountOrderPolicy } from "../src/account-order-policy.mjs";
import { withWriteIdempotency, ExecutorPreDispatchRejection } from "../src/security.mjs";
import { OPERATOR, ACCOUNT_A, ACCOUNT_B } from "./registry-fixture.mjs";
const scope = { operator_id: OPERATOR, exchange_account_id: ACCOUNT_A, environment: "REAL" };
test("account-global policy survives restart without copying registry, flags or credentials; corruption is scoped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coinops-order-policy-"));
  try {
    assert.equal(await accountOrderPolicyEnabled(directory, scope, "executor-02"), false);
    assert.equal((await enableAccountOrderPolicy(directory, scope, "executor-02")).enabled, true);
    assert.equal((await enableAccountOrderPolicy(directory, scope, "executor-02")).replayed, true);
    assert.equal(await accountOrderPolicyEnabled(directory, scope, "executor-02"), true);
    const sibling = { ...scope, exchange_account_id: ACCOUNT_B };
    assert.equal(await accountOrderPolicyEnabled(directory, sibling, "executor-02"), false);
    await assert.rejects(accountOrderPolicyEnabled(directory, scope, "executor-03"), /POLICY_INVALID/);
    await assert.rejects(accountOrderPolicyEnabled(directory, { ...scope, operator_id: ACCOUNT_B }, "executor-02"), /POLICY_INVALID/);
    await assert.rejects(enableAccountOrderPolicy(directory, { ...scope, environment: "TESTNET" }, "executor-02"), /SCOPE_DENIED/);
    assert.deepEqual(await readdir(directory), ["account-order-policies"]);
    await writeFile(join(directory, "account-order-policies", `${ACCOUNT_A}.json`), "{corrupt");
    await assert.rejects(accountOrderPolicyEnabled(directory, scope, "executor-02"), /POLICY_INVALID/);
    assert.equal(await accountOrderPolicyEnabled(directory, sibling, "executor-02"), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("permit expiry before POST releases only the provably unsent claim; unknown outcomes never lose their claim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coinops-order-permit-claim-"));
  const common = { directory, key: "C2-identical-request", bodyHash: "original-unchanged-body", recover: async () => null };
  try {
    await assert.rejects(withWriteIdempotency({ ...common, beforeClaim: () => {
      throw new ExecutorPreDispatchRejection("EXPIRED"); }, execute: async () => assert.fail("must not dispatch") }), /EXPIRED/);
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(withWriteIdempotency({ ...common, provablyUnsent: () => true,
      execute: async () => { throw new ExecutorPreDispatchRejection("EXPIRED_AFTER_READS"); } }), /EXPIRED_AFTER_READS/);
    assert.deepEqual(await readdir(directory), []);
    let posts = 0;
    assert.equal((await withWriteIdempotency({ ...common, execute: async () => { posts++; return { orderId: "1" }; } })).replayed, false);
    assert.equal((await withWriteIdempotency({ ...common, beforeClaim: () => assert.fail("no new permit needed for old receipt"),
      execute: async () => assert.fail("no duplicate POST") })).replayed, true);
    assert.equal(posts, 1);
    const unknown = { ...common, key: "C2-network-outcome-unknown" };
    await assert.rejects(withWriteIdempotency({ ...unknown, provablyUnsent: () => false,
      execute: async () => { posts++; throw new ExecutorPreDispatchRejection("NETWORK_NOT_A_PREWRITE_PROOF"); } }), /NETWORK_NOT/);
    await assert.rejects(withWriteIdempotency({ ...unknown, beforeClaim: () => assert.fail("pending recovery first"),
      execute: async () => assert.fail("no retry POST") }), /WRITE_OUTCOME_UNKNOWN/);
    assert.equal(posts, 2);
    assert.equal((await withWriteIdempotency({ ...unknown, recover: async () => ({ orderId: "2" }),
      execute: async () => assert.fail("GET ownership recovery only") })).replayed, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
