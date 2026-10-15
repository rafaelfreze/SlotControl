import test from "node:test";
import assert from "node:assert/strict";
import type * as Contract from "./accounts-contract";
const contractPath = "./accounts-contract.ts";
const { ACCOUNTS_PATH, AccountError, accountMarker, accountSignature, assertAccountMarker, parseAccountInput, receiveAccountRequest, verifyAccountRequest } = await import(contractPath) as typeof Contract;

const secret = "unit-test-only-provision-key-32-bytes", product = "servnexx", now = Date.parse("2026-10-15T14:00:00Z");
const nonce = "a1111111-1111-4111-8111-111111111111";
const input = { request_id: "b1111111-1111-4111-8111-111111111111", product_key: product, company_name: "Empresa teste", owner_name: "Responsável teste", email: "qa@example.test", password: "Test-only-123", whatsapp: "67999990000", plan: { code: "premium", name: "Premium", amount_cents: 10000, trial_days: 30, capabilities: { landing_page: true } }, consent: false };
function signed(value: unknown = input, options: { pathname?: string; product?: string; at?: number; key?: string; nonce?: string } = {}) {
  const body = JSON.stringify(value), timestamp = new Date(options.at ?? now).toISOString(), n = options.nonce ?? nonce;
  return new Request("https://product.example" + (options.pathname ?? ACCOUNTS_PATH), { method: "POST", body, headers: { "content-type": "application/json", "x-onplay-product": options.product ?? product, "x-onplay-timestamp": timestamp, "x-onplay-nonce": n, "x-onplay-signature": accountSignature(options.key ?? secret, product, body, timestamp, n) } });
}
function parsed(value: unknown = input) { const result = parseAccountInput(JSON.stringify(value), product); assert.equal(result.operation, "create"); if (result.operation !== "create") throw Error(); return result; }
test("signed create accepts only the dedicated product, path and fresh nonce", async () => {
  const request = signed(); assert.equal(verifyAccountRequest(request, await request.text(), product, secret, now), nonce);
  for (const options of [{ pathname: ACCOUNTS_PATH + "?x=1" }, { pathname: "/api/integrations/onplay-billing/tenants" }, { product: "onfood" }, { at: now - 300001 }, { key: "a-different-key-never-authorized---" }, { nonce: "invalid" }]) { const r = signed(input, options); assert.throws(() => verifyAccountRequest(r, JSON.stringify(input), product, secret, now), AccountError); }
});
test("altered body and inventory key cannot authorize account creation", () => {
  const request = signed(); assert.throws(() => verifyAccountRequest(request, JSON.stringify({ ...input, email: "other@example.test" }), product, secret, now));
  assert.throws(() => verifyAccountRequest(request, JSON.stringify(input), product, undefined, now));
});
test("normalizes the five fields, preserves password bytes, rejects extras and invalid plans", () => {
  const v = parsed({ ...input, email: " QA@EXAMPLE.TEST ", password: "  secret value  " });
  assert.equal(v.email, "qa@example.test"); assert.equal(v.whatsapp, "+5567999990000"); assert.equal(v.password, "  secret value  ");
  for (const bad of [{ ...input, role: "master" }, { ...input, password: "short" }, { ...input, request_id: "bad" }, { ...input, actor_id: "bad" }, { ...input, consent: "true" }, { ...input, whatsapp: "123" }, { ...input, plan: { ...input.plan, amount_cents: 1.2 } }, { ...input, plan: { ...input.plan, trial_days: 90 } }, { ...input, plan: { ...input.plan, secret: "bad" } }]) assert.throws(() => parsed(bad));
});
test("catalog cannot carry credentials, actor or hidden mutations", () => {
  assert.deepEqual(parseAccountInput(JSON.stringify({ operation: "catalog", product_key: product }), product), { operation: "catalog" });
  assert.throws(() => parseAccountInput(JSON.stringify({ operation: "catalog", product_key: product, password: "forbidden" }), product));
});
test("replay marker excludes password and central actor, but binds all account and plan fields", () => {
  const v = parsed(), marker = accountMarker(v);
  assert.equal(JSON.stringify(marker).includes(input.password), false);
  assert.deepEqual(marker, accountMarker({ ...v, password: "another-password", actor_id: nonce }));
  assert.doesNotThrow(() => assertAccountMarker(marker, marker));
  for (const changed of [{ ...v, request_id: nonce }, { ...v, company_name: "Other" }, { ...v, whatsapp: "+5567999991111" }, { ...v, plan: { ...v.plan, code: "other" } }, { ...v, consent: true }]) assert.throws(() => assertAccountMarker(marker, accountMarker(changed)));
  assert.throws(() => assertAccountMarker(undefined, marker));
});
test("authentication failure never consumes nonce or calls privileged creator", async () => {
  let called = 0; const source = { consume: async () => { called++; return { data: true, error: null }; }, catalog: async () => { called++; return []; }, create: async () => { called++; return {}; } };
  const response = await receiveAccountRequest(signed(input, { key: "foreign-key-000000000000000000000000" }), product, source, secret, now);
  assert.equal(response.status, 401); assert.equal(called, 0);
});
test("nonce duplicate fails closed before creation; same request with fresh nonce can reconcile", async () => {
  let calls = 0; const source = { consume: async () => ({ data: false, error: { code: "23505" } }), catalog: async () => [], create: async () => { calls++; return {}; } };
  const response = await receiveAccountRequest(signed(), product, source, secret, now); assert.equal(response.status, 409); assert.equal(calls, 0);
  const retried = await receiveAccountRequest(signed(input, { nonce: input.request_id }), product, { ...source, consume: async () => ({ data: true, error: null }), create: async v => { assert.equal(v.request_id, input.request_id); calls++; return { account: { external_tenant_id: nonce }, resumed: true }; } }, secret, now);
  assert.equal(retried.status, 200); assert.equal((await retried.json()).resumed, true); assert.equal(calls, 1);
});
test("catalog is read only and never runs create", async () => {
  let created = false; const response = await receiveAccountRequest(signed({ operation: "catalog", product_key: product }), product, { consume: async () => ({ data: true, error: null }), catalog: async () => [input.plan], create: async () => { created = true; return {}; } }, secret, now);
  assert.equal(response.status, 200); assert.equal(created, false); assert.equal((await response.json()).plans[0].code, "premium");
});
test("false or null nonce claim never reaches catalog or create even without an error", async () => {
  for (const data of [false, null]) for (const value of [input, { operation: "catalog", product_key: product }]) {
    let called = false;
    const response = await receiveAccountRequest(signed(value), product, { consume: async () => ({ data: data as unknown as boolean, error: null }), catalog: async () => { called = true; return []; }, create: async () => { called = true; return {}; } }, secret, now);
    assert.equal(response.status, 409); assert.equal(called, false);
  }
});
test("provider errors are sanitized; no password or backend detail enters response", async () => {
  const response = await receiveAccountRequest(signed(), product, { consume: async () => ({ data: true, error: null }), catalog: async () => [], create: async () => { throw Error("provider failure " + input.password); } }, secret, now);
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { ok: false, error: "provisioning_unavailable" });
});
test("oversized payload is rejected before authentication or any database call", async () => {
  let called = false; const response = await receiveAccountRequest(signed({ ...input, password: "a".repeat(65536) }), product, { consume: async () => { called = true; return { data: true, error: null }; }, catalog: async () => [], create: async () => ({}) }, secret, now);
  assert.equal(response.status, 413); assert.equal(called, false);
});
