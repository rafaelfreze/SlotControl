import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { accountBudgetPermitHeaders, verifyAccountBudgetPermit } from "./account-order-budget-permit.ts";
const now = Date.parse("2026-10-04T15:00:01Z"), secret = "fictional-account-global-permit-secret-1234567890";
const scope = { operator_id: "00000000-0000-4000-8000-000000000001", exchange_account_id: "00000000-0000-4000-8000-000000000002",
  trading_engine_id: "00000000-0000-4000-8000-000000000003", environment: "REAL", executor_shard_id: "executor-03",
  symbol: "SOLBRL", side: "BUY", clientOrderId: "C2-fixture-1-B-0123456789abcd" };
const reservation = { code: "PASS", operatorId: scope.operator_id, accountId: scope.exchange_account_id,
  engineId: scope.trading_engine_id, shardId: scope.executor_shard_id, clientOrderId: scope.clientOrderId, expiresAt: now + 8999 };
const body = JSON.stringify(scope), hash = createHash("sha256").update(body).digest("hex");
test("serialized account reserve is bound by HMAC to exact engine/shard/side/body without changing durable request bytes", () => {
  const headers = accountBudgetPermitHeaders(secret, reservation, scope, body, now);
  const verify = (candidate = scope, digest = hash, clock = now, key = secret) => verifyAccountBudgetPermit(key,
    headers["x-coinops-account-order-budget"], headers["x-coinops-account-order-budget-signature"], candidate, digest, clock);
  verify();
  assert.equal(JSON.stringify(scope), body);
  for (const patch of [{ executor_shard_id: "executor-02" }, { exchange_account_id: scope.operator_id },
    { trading_engine_id: scope.operator_id }, { operator_id: scope.exchange_account_id }, { side: "SELL" },
    { clientOrderId: "another-order" }, { environment: "TESTNET" }, { symbol: "BTCBRL" }])
    assert.throws(() => verify({ ...scope, ...patch }), /PERMIT_DENIED/);
  assert.throws(() => verify(scope, "0".repeat(64)), /PERMIT_DENIED/);
  assert.throws(() => verify(scope, hash, now + 8999), /PERMIT_DENIED/);
  assert.throws(() => verify(scope, hash, now, "different-per-shard-HMAC-secret-12345"), /PERMIT_DENIED/);
  assert.ok(!headers["x-coinops-account-order-budget"].includes(secret));
});
test("browser-forged PASS, future/unbounded permission and missing HMAC cannot authorize dispatch", () => {
  for (const patch of [{ code: "CAPACITY_OK" }, { expiresAt: now }, { expiresAt: now + 30001 },
    { expiresAt: NaN }, { engineId: "foreign" }])
    assert.throws(() => accountBudgetPermitHeaders(secret, { ...reservation, ...patch }, scope, body, now), /PERMIT_DENIED/);
  assert.throws(() => verifyAccountBudgetPermit(secret, Buffer.from(JSON.stringify({ code: "PASS" })).toString("base64url"),
    "0".repeat(64), scope, hash, now), /PERMIT_DENIED/);
  assert.throws(() => verifyAccountBudgetPermit(secret, null, null, scope, hash, now), /PERMIT_DENIED/);
});
