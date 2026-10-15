import test from "node:test";
import assert from "node:assert/strict";
import { provisioningDiagnostic, reportProvisioningFailure } from "./diagnostics.ts";
import type { ProvisioningStage } from "./diagnostics.ts";
const requestId = "312d8ae5-8760-4665-b2c4-22770219b177";

test("provider diagnostic contains only stage, allowlisted code/status and request UUID", () => {
  const result = provisioningDiagnostic("identity_create", { code: "unexpected_failure", status: 500,
    message: "private@example.test password secret", stack: "private stack", details: { phone: "11999990000", token: "private-token" } }, requestId);
  assert.deepEqual(result, { event: "COINOPS_ACCOUNT_PROVISION_FAILED", stage: "identity_create", request_id: requestId, code: "unexpected_failure", provider_status: 500 });
  for (const forbidden of ["private@example.test", "password", "secret", "stack", "11999990000", "private-token", "details"]) assert.equal(JSON.stringify(result).includes(forbidden), false);
});

test("untrusted codes, stage and request identifiers never become log content", () => {
  const result = provisioningDiagnostic("private@example.test" as ProvisioningStage, { code: "customer_private_value", status: "500", message: "private-message" }, "invalid-private-request");
  assert.deepEqual(result, { event: "COINOPS_ACCOUNT_PROVISION_FAILED", stage: "unknown", code: "unclassified" });
  for (const status of [200, 399, 600, Infinity, NaN]) assert.equal("provider_status" in provisioningDiagnostic("identity_create", { status }), false);
});

test("fixed application and PostgREST error codes remain useful without raw messages", () => {
  assert.equal(provisioningDiagnostic("actor_resolution", Error("provisioning_actor_unavailable"), requestId).code, "provisioning_actor_unavailable");
  assert.equal(provisioningDiagnostic("existing_access_read", { code: "PGRST116", message: "raw-private-details" }, requestId).code, "PGRST116");
  assert.equal(provisioningDiagnostic("identity_create", Error("raw-private-details"), requestId).code, "unclassified");
});

test("logger emits only the sanitized record and never serializes the provider object", () => {
  const original = console.error, calls: unknown[][] = [];
  try {
    console.error = (...values: unknown[]) => { calls.push(values); };
    reportProvisioningFailure("actor_auth_read", { code: "bad_jwt", status: 401, token: "do-not-log", toJSON() { throw Error("provider serialization forbidden"); } }, requestId);
  } finally { console.error = original; }
  assert.equal(calls.length, 1); assert.equal(calls[0].length, 1);
  assert.deepEqual(JSON.parse(calls[0][0] as string), { event: "COINOPS_ACCOUNT_PROVISION_FAILED", stage: "actor_auth_read", request_id: requestId, code: "bad_jwt", provider_status: 401 });
});
