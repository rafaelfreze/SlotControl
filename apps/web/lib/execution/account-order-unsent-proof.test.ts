import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { signAccountOrderUnsentProof, verifyAccountOrderUnsentProof } from "./account-order-unsent-proof.ts";
const secret = "fictional-no-POST-proof-shard-key-1234567890", now = 1791122400000;
const scope = { operator_id: "00000000-0000-4000-8000-000000000001", exchange_account_id: "00000000-0000-4000-8000-000000000002",
  trading_engine_id: "00000000-0000-4000-8000-000000000003", executor_shard_id: "executor-03", environment: "REAL",
  symbol: "SOLBRL", clientOrderId: "C2-fixture-1-B-0123456789abcd", decision_id: "fictional-decision",
  request_nonce: "fictional-nonce-123456789" };
test("unsent receipt binds invocation nonce, body, owner, engine, shard and decision; stale/forged proof cannot release a later attempt", () => {
  const body = JSON.stringify(scope), digest = createHash("sha256").update(body).digest("hex");
  const proof = signAccountOrderUnsentProof(secret, scope, digest, now);
  assert.equal(verifyAccountOrderUnsentProof(secret, proof, scope, body, now).outcome, "NOT_SUBMITTED");
  for (const patch of [{ request_nonce: "a-different-invocation-nonce" }, { trading_engine_id: scope.operator_id },
    { executor_shard_id: "executor-02" }, { decision_id: "another-decision" }, { clientOrderId: "another-client-id" }])
    assert.throws(() => verifyAccountOrderUnsentProof(secret, proof, { ...scope, ...patch }, body, now), /PROOF_INVALID/);
  assert.throws(() => verifyAccountOrderUnsentProof(secret, proof, scope, body + " ", now), /PROOF_INVALID/);
  assert.throws(() => verifyAccountOrderUnsentProof(secret, proof, scope, body, now + 60_000), /PROOF_INVALID/);
  assert.throws(() => verifyAccountOrderUnsentProof(secret, { ...proof, signature: "0".repeat(64) }, scope, body, now), /PROOF_INVALID/);
  assert.throws(() => verifyAccountOrderUnsentProof(secret, { outcome: "NOT_SUBMITTED" }, scope, body, now), /PROOF_INVALID/);
});
