import assert from "node:assert/strict";
import test from "node:test";
import { accountConnectionProof } from "./account-connection-proof.ts";
const now = Date.parse("2026-10-04T15:00:00Z");
const target = { shardId: "executor-03", ip: "203.0.113.33", credentialRef: "account_fixture" };
const result = { operator_id: "operator", exchange_account_id: "account", environment: "REAL",
  executor_shard_id: target.shardId, executorIp: target.ip, credential_ref: target.credentialRef,
  status: "PASS", whitelistAccepted: true, validatedAt: new Date(now).toISOString(),
  uidHash: "not-public", credentialHash: "not-public", permission: { read: true, spotTrading: true,
    withdrawals: false, internalTransfer: false, universalTransfer: false, margin: false, futures: false,
    options: false, fixTrading: false, portfolioMargin: false } };
test("connection proof is IP/account/REAL scoped and never returns keys or UID hashes", () => {
  const proof = accountConnectionProof(result, target, "operator", "account", now);
  assert.equal(proof.executor_ip, target.ip);
  assert.doesNotMatch(JSON.stringify(proof), /not-public|uidHash|credentialHash/);
  for (const patch of [{ operator_id: "other" }, { exchange_account_id: "other" }, { environment: "TESTNET" },
    { executor_shard_id: "executor-02" }, { executorIp: "203.0.113.22" }, { status: "WARNING" },
    { whitelistAccepted: false }, { credential_ref: "foreign" }, { validatedAt: "bad" },
    { validatedAt: new Date(now - 31_000).toISOString() }, { validatedAt: new Date(now + 3000).toISOString() },
    { apiKey: "must-not-be-returned" }, { apiSecret: "must-not-be-returned" }])
    assert.throws(() => accountConnectionProof({ ...result, ...patch }, target, "operator", "account", now), /VALIDATION_REQUIRED/);
  for (const name of Object.keys(result.permission))
    assert.throws(() => accountConnectionProof({ ...result, permission: { ...result.permission, [name]: null } },
      target, "operator", "account", now), /VALIDATION_REQUIRED/);
});
