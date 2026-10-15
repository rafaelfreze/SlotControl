import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createPasswordViewerIdentity } from "./password-user.ts";
import { provisioningDiagnostic } from "../../../lib/billing-provisioning/diagnostics.ts";
const input = { email: " CLIENT@example.com ", password: "12345678", companyName: "Empresa", ownerName: "Cliente", whatsapp: "67999990000", requestId: "request" };
test("chosen password creates confirmed VIEWER access without messages or reset", async () => {
  let received: Record<string, unknown> = {};
  const service = { auth: { admin: { createUser: async (payload: Record<string, unknown>) => { received = payload; return { data: { user: { id: "new" } }, error: null }; } } } } as unknown as SupabaseClient;
  assert.equal((await createPasswordViewerIdentity(service, input, "actor", "operator")).id, "new");
  assert.equal(received.email, "client@example.com"); assert.equal(received.password, input.password); assert.equal(received.email_confirm, true);
  assert.equal((received.app_metadata as { coinops_role: string }).coinops_role, "VIEWER");
  assert.ok(!JSON.stringify(received.app_metadata).includes(input.password));
});
test("existing shared Auth user never gets a new password or account binding", async () => {
  const service = { auth: { admin: { createUser: async () => ({ data: { user: null }, error: { code: "email_exists" } }),
    listUsers: async () => ({ data: { users: [{ email: "client@example.com", app_metadata: { coinops_role: "ADMIN" } }] }, error: null }) } } } as unknown as SupabaseClient;
  await assert.rejects(createPasswordViewerIdentity(service, input, "actor", "operator"), /EMAIL_ALREADY_REGISTERED/);
});
test("lost response recovers only exact actor, request and operator", async () => {
  let operatorId = "operator";
  const service = { auth: { admin: { createUser: async () => ({ data: { user: null }, error: { code: "email_exists" } }),
    listUsers: async () => ({ data: { users: [{ id: "same", email: "client@example.com", app_metadata: { coinops_role: "VIEWER", coinops_provision: { actor_id: "actor", request_id: "request", operator_id: operatorId } } }] }, error: null }) } } } as unknown as SupabaseClient;
  assert.equal((await createPasswordViewerIdentity(service, input, "actor", "operator")).id, "same"); operatorId = "other";
  await assert.rejects(createPasswordViewerIdentity(service, input, "actor", "operator"), /EMAIL_ALREADY_REGISTERED/);
});


test("QA is server-owned metadata and omits billing, analytics and publication", async () => {
  let received: Record<string, unknown> = {};
  const service = { auth: { admin: { createUser: async (payload: Record<string, unknown>) => { received = payload; return { data: { user: { id: "qa" } }, error: null }; } } } } as unknown as SupabaseClient;
  await createPasswordViewerIdentity(service, { ...input, email: "onplay-qa-coinops@example.test", companyName: "QA ONPLAY CoinOps" }, "actor", "operator");
  assert.deepEqual((received.app_metadata as Record<string, unknown>).onplay_qa, { product: "coinops", run_id: "20261014-signup", exclude_billing: true, exclude_analytics: true, allow_publication: false });
  assert.equal((received.user_metadata as Record<string, unknown>).whatsapp, "+5567999990000");
  assert.equal((received.user_metadata as Record<string, unknown>).coinops_role, undefined);
  await createPasswordViewerIdentity(service, { ...input, email: "onplay-qa-coinops@example.test" }, "actor", "operator");
  assert.equal((received.app_metadata as Record<string, unknown>).onplay_qa, undefined);
});

test("uncertain create never retries or exposes provider secrets", async () => {
  let calls = 0;
  const service = { auth: { admin: { createUser: async () => { calls++; return { data: { user: null }, error: { code: "timeout", message: input.password } }; } } } } as unknown as SupabaseClient;
  await assert.rejects(createPasswordViewerIdentity(service, input, "actor", "operator"), /^Error: COINOPS_VIEWER_CREATE_UNCONFIRMED$/);
  assert.equal(calls, 1);
});

test("failed Auth create reports native code safely without retrying or changing its public error", async () => {
  let calls = 0;
  const records: unknown[] = [];
  const service = { auth: { admin: { createUser: async () => { calls++; return { data: { user: null }, error: { code: "unexpected_failure", status: 500, message: input.password, stack: "private-stack" } }; } } } } as unknown as SupabaseClient;
  await assert.rejects(createPasswordViewerIdentity(service, input, "actor", "operator", undefined, (stage, error) => records.push(provisioningDiagnostic(stage, error))), /^Error: COINOPS_VIEWER_CREATE_UNCONFIRMED$/);
  assert.equal(calls, 1);
  assert.deepEqual(records, [{ event: "COINOPS_ACCOUNT_PROVISION_FAILED", stage: "identity_create", code: "unexpected_failure", provider_status: 500 }]);
});

test("only native weak_password marks the typed password rejection and never retries Auth", async () => {
  let calls = 0;
  const service = { auth: { admin: { createUser: async () => { calls++; return { data: { user: null }, error: { code: "weak_password", status: 422, message: "private-provider-message" } }; } } } } as unknown as SupabaseClient;
  await assert.rejects(createPasswordViewerIdentity(service, input, "actor", "operator"), { message: "COINOPS_VIEWER_PASSWORD_INVALID", code: "weak_password" });
  assert.equal(calls, 1);
});

test("idempotent existing identity recovery does not log an expected duplicate as failure", async () => {
  const records: unknown[] = [];
  const service = { auth: { admin: { createUser: async () => ({ data: { user: null }, error: { code: "email_exists", status: 422 } }),
    listUsers: async () => ({ data: { users: [{ id: "same", email: "client@example.com", app_metadata: { coinops_role: "VIEWER", coinops_provision: { actor_id: "actor", request_id: "request", operator_id: "operator" } } }] }, error: null }) } } } as unknown as SupabaseClient;
  assert.equal((await createPasswordViewerIdentity(service, input, "actor", "operator", undefined, (stage, error) => records.push(provisioningDiagnostic(stage, error)))).id, "same");
  assert.deepEqual(records, []);
});
