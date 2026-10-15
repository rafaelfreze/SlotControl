import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type * as Contract from "./accounts-contract";
const contractPath = "./accounts-contract.ts";
const contract = await import(contractPath) as typeof Contract;

// Execute the real server helper with only server-only's import marker replaced;
// privileged provider effects are represented by the explicit Supabase boundary.
const require = createRequire(import.meta.url), ts = require("typescript");
const compiled = ts.transpileModule(readFileSync(new URL("./accounts-support.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const compiledModule = { exports: {} as Record<string, (...args: unknown[]) => Promise<unknown>> };
new Function("require", "module", "exports", compiled)((id: string) => { if (id === "server-only") return {}; if (id === "./accounts-contract") return contract; throw Error("Unexpected test import"); }, compiledModule, compiledModule.exports);
const support = compiledModule.exports;
const actor = "a1111111-1111-4111-8111-111111111111";
function fakeDb(rows: Record<string, Record<string, unknown>[]>, identity: Record<string, unknown> = { id: actor, email: "qa@example.test", app_metadata: {} }) {
  const reads: string[] = [], calls: string[] = [];
  return { reads, calls, from(table: string) { reads.push(table); let selected = rows[table] ?? [];
    const q = { select() { return q; }, eq(key: string, value: unknown) { selected = selected.filter(r => r[key] === value); return q; }, in(key: string, values: unknown[]) { selected = selected.filter(r => values.includes(r[key])); return q; }, order() { return q; }, limit() { return q; }, async maybeSingle() { return { data: selected[0] ?? null, error: null }; }, then(resolve: (v: unknown) => void) { return Promise.resolve(resolve({ data: selected, error: null })); } }; return q;
  }, auth: { admin: { async getUserById(id: string) { calls.push(id); return { data: { user: identity }, error: null }; } } } };
}
test("local Master is resolved from product role; no foreign actor enters authorization", async () => {
  for (const product of ["zelyvara", "onplay_finance", "onfood", "nexxfitpro", "onplay_ads"]) {
    const row = product === "onplay_ads" ? { id: actor, platform_role: "master", is_active: true, must_change_password: false } : { id: actor, role: product === "nexxfitpro" ? "super_admin" : "master", status: "active" };
    const db = fakeDb({ [product === "onfood" ? "platform_users" : "profiles"]: [row] });
    const result = await support.localProvisionActor(db, product) as { id: string };
    assert.equal(result.id, actor); assert.deepEqual(db.calls, [actor]);
  }
});
test("inactive or absent Master and banned Auth identity fail closed", async () => {
  for (const db of [fakeDb({ profiles: [{ id: actor, role: "master", status: "inactive" }] }), fakeDb({}), fakeDb({ profiles: [{ id: actor, role: "master", status: "active" }] }, { id: actor, banned_until: "2099-01-01T00:00:00Z" })]) await assert.rejects(support.localProvisionActor(db, "zelyvara"));
});
test("ServNexx requires active allowed assignment plus active product profile", async () => {
  const db = fakeDb({ platform_roles: [{ id: "role", key: "super_admin", status: "active" }], platform_user_roles: [{ user_id: actor, role_id: "role", status: "active" }], profiles: [{ id: actor, status: "active" }] });
  assert.equal((await support.localProvisionActor(db, "servnexx") as { id: string }).id, actor);
  const denied = fakeDb({ platform_roles: [{ id: "role", key: "auditor", status: "active" }] }); await assert.rejects(support.localProvisionActor(denied, "servnexx")); assert.equal(denied.calls.length, 0);
});
test("CoinOps actor is confined to configured service tenant and excludes viewer", async () => {
  const db = fakeDb({ operators: [{ id: "operator", tenant_id: "own", user_id: actor, status: "ACTIVE" }] });
  assert.equal((await support.localProvisionActor(db, "coinops", "own") as { id: string }).id, actor);
  await assert.rejects(support.localProvisionActor(db, "coinops", "other"));
  await assert.rejects(support.localProvisionActor(db, "coinops", null));
  const viewer = fakeDb({ operators: [{ id: "operator", tenant_id: "own", user_id: actor, status: "ACTIVE" }] }, { id: actor, app_metadata: { coinops_role: "VIEWER" } }); await assert.rejects(support.localProvisionActor(viewer, "coinops", "own"));
  assert.equal(db.reads.some(t => /exchange|ledger|engine|order/.test(t)), false);
});
test("reconciliation requires the exact trusted account marker and never updates a password", async () => {
  const marker = { request_id: actor, product_key: "onfood", fingerprint: "abc" };
  const db = fakeDb({}, { id: actor, app_metadata: { onplay_billing_provision: marker } });
  await support.assertProvisionUser(db, actor, marker);
  await assert.rejects(support.assertProvisionUser(db, actor, { ...marker, fingerprint: "changed" }));
  await assert.rejects(support.assertProvisionUser(fakeDb({}), actor, marker));
  assert.deepEqual(Object.keys(db.auth.admin), ["getUserById"]);
});
test("catalog price changed cannot pass signed creation snapshot", () => {
  const plan = { code: "paid", amount_cents: 100, trial_days: 30 };
  assert.doesNotThrow(() => support.validateLocalPlan(plan, plan));
  assert.throws(() => support.validateLocalPlan(plan, { ...plan, amount_cents: 1 }));
});
test("central trial keeps the initial Auth creation time across retry and charges after expiry", () => {
  const payload = support.centralTrialPayload({ plan: { code: "central" } }, "Company", "company", "2026-10-01T14:00:00Z") as unknown as { trial_ends_at: string; billing_start_on: string };
  assert.equal(payload.trial_ends_at, "2026-10-31T14:00:00.000Z"); assert.equal(payload.billing_start_on, "2026-11-01");
});

test("CoinOps actor Auth failure can be observed without changing access or exposing it to the caller", async () => {
  const db = fakeDb({ operators: [{ id: "operator", tenant_id: "own", user_id: actor, status: "ACTIVE" }] });
  const nativeError = { code: "bad_jwt", status: 401, message: "private-provider-message" }, reports: { stage: string; error: unknown }[] = [];
  Object.assign(db.auth.admin, { getUserById: async () => ({ data: { user: null }, error: nativeError }) });
  await assert.rejects(support.localProvisionActor(db, "coinops", "own", (stage: string, error: unknown) => reports.push({ stage, error })), /^Error: account_access_unavailable$/);
  assert.deepEqual(reports, [{ stage: "actor_auth_read", error: nativeError }]);
  assert.deepEqual(Object.keys(db.auth.admin), ["getUserById"]);
});
