import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createPasswordViewerIdentity } from "./password-user.ts";
const input = { email: " CLIENT@example.com ", password: "12345678", accountId: "account", requestId: "request" };
test("chosen password creates confirmed VIEWER access without messages or reset", async () => {
  let received: Record<string, unknown> = {};
  const service = { auth: { admin: { createUser: async (payload: Record<string, unknown>) => { received = payload; return { data: { user: { id: "new" } }, error: null }; } } } } as unknown as SupabaseClient;
  assert.equal((await createPasswordViewerIdentity(service, input, "actor")).id, "new");
  assert.equal(received.email, "client@example.com"); assert.equal(received.password, input.password); assert.equal(received.email_confirm, true);
  assert.equal((received.app_metadata as { coinops_role: string }).coinops_role, "VIEWER");
  assert.ok(!JSON.stringify(received.app_metadata).includes(input.password));
});
test("existing shared Auth user never gets a new password or account binding", async () => {
  const service = { auth: { admin: { createUser: async () => ({ data: { user: null }, error: { code: "email_exists" } }),
    listUsers: async () => ({ data: { users: [{ email: "client@example.com", app_metadata: { coinops_role: "ADMIN" } }] }, error: null }) } } } as unknown as SupabaseClient;
  await assert.rejects(createPasswordViewerIdentity(service, input, "actor"), /EMAIL_ALREADY_REGISTERED/);
});
test("lost response recovers only exact actor, request and account", async () => {
  let accountId = "account";
  const service = { auth: { admin: { createUser: async () => ({ data: { user: null }, error: { code: "email_exists" } }),
    listUsers: async () => ({ data: { users: [{ id: "same", email: "client@example.com", app_metadata: { coinops_role: "VIEWER", coinops_provision: { actor_id: "actor", request_id: "request", account_id: accountId } } }] }, error: null }) } } } as unknown as SupabaseClient;
  assert.equal((await createPasswordViewerIdentity(service, input, "actor")).id, "same"); accountId = "other";
  await assert.rejects(createPasswordViewerIdentity(service, input, "actor"), /EMAIL_ALREADY_REGISTERED/);
});
