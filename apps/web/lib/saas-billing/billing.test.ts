import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { parseProjection, BILLING_PRODUCT, BillingError, UUID } from "./contract.ts";
const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";
export const projection = (id = a, version = 1) => ({ billing_subscription_id: "33333333-3333-4333-8333-333333333333", product_key: BILLING_PRODUCT,
  external_tenant_id: id, tenant_name: "Cliente", tenant_slug: id, plan_code: "contract_existing", plan_name: "Contrato real", amount_cents: 4950,
  status: "active", version, trial_ends_at: null, billing_start_on: "2026-10-11", due_day: 15, next_due_date: "2026-11-15", grace_until: null,
  last_paid_at: null, paused_at: null, canceled_at: null, manual_pause: false, registration_pending: false, capabilities: {}, installment_id: null,
  balance_cents: null, contract_id: "44444444-4444-4444-8444-444444444444", updated_at: "2026-10-11T12:00:00Z" });
function compile(path: string, deps: Record<string, unknown>) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", js)((key: string) => { assert.ok(key in deps, `unexpected dependency ${key}`); return deps[key]; }, exports);
  return exports;
}
const contract = { parseProjection, BILLING_PRODUCT, BillingError, UUID };
const signature = compile("./signature.ts", { "node:crypto": await import("node:crypto"), "./contract": contract }) as {
  signBillingRequest: (secret: string, path: string, timestamp: string, nonce: string, body: string) => string;
  verifyBillingRequest: (r: Request, body: string, now: number, env: Record<string, string>) => string;
  readBillingBody: (r: Request) => Promise<string>;
};
test("projection uses an explicit whitelist and rejects wrong products, malformed dates and amounts", () => {
  const p = projection();
  assert.deepEqual(parseProjection({ ...p, checkout_url: "https://private.invalid/token", contact: "private", token: "private" }), p);
  for (const bad of [{ ...p, product_key: "onfood" }, { ...p, external_tenant_id: "not-a-user" }, { ...p, amount_cents: 1.2 },
    { ...p, due_day: 0 }, { ...p, version: 0 }, { ...p, billing_start_on: "2026-02-30" }, { ...p, status: "invented" }]) assert.throws(() => parseProjection(bad));
});
test("signed body, product, path, timestamp, nonce and bounded rotation are enforced", async () => {
  const secret = "s".repeat(40), path = "/api/integrations/onplay-billing/events", timestamp = "2026-10-11T12:00:00Z", nonce = randomUUID(), body = "{}", now = Date.parse(timestamp);
  const request = (overrides: Record<string, string> = {}, url = path) => new Request("https://cripto-flax.vercel.app" + url, { method: "POST", headers: {
    "x-onplay-product": "coinops", "x-onplay-timestamp": timestamp, "x-onplay-nonce": nonce, "x-onplay-signature": signature.signBillingRequest(secret, path, timestamp, nonce, body), ...overrides }, body });
  assert.equal(signature.verifyBillingRequest(request(), body, now, { ONPLAY_BILLING_SECRET: secret }), nonce);
  for (const altered of [request({ "x-onplay-product": "onfood" }), request({ "x-onplay-nonce": "invalid" }), request({}, "/api/other")]) assert.throws(() => signature.verifyBillingRequest(altered, body, now, { ONPLAY_BILLING_SECRET: secret }));
  assert.throws(() => signature.verifyBillingRequest(request(), "{\"tampered\":true}", now, { ONPLAY_BILLING_SECRET: secret }));
  assert.throws(() => signature.verifyBillingRequest(request(), body, now + 300001, { ONPLAY_BILLING_SECRET: secret }));
  const rotation = { ONPLAY_BILLING_SECRET: "n".repeat(40), ONPLAY_BILLING_PREVIOUS_SECRET: secret, ONPLAY_BILLING_PREVIOUS_VALID_UNTIL: "2026-10-11T12:01:00Z" };
  assert.equal(signature.verifyBillingRequest(request(), body, now, rotation), nonce);
  assert.throws(() => signature.verifyBillingRequest(request(), body, now + 60001, rotation));
  await assert.rejects(signature.readBillingBody(new Request("https://example.invalid", { method: "POST", body: "a".repeat(65537) })));
});
test("owner checkout cannot switch user identity or persist its temporary payment URL", async () => {
  let result: Record<string, unknown> = { ok: true, subscription: { ...projection(), checkout_url: "https://www.onplaymkt.com.br/pagamento/cobranca?token=fixture" } };
  const calls: Array<Record<string, unknown>> = [], filters: unknown[] = [];
  const db = { from: () => ({ select: () => ({ eq: (_: string, id: string) => { filters.push(id); return { maybeSingle: async () => ({ data: { projection: projection() }, error: null }) }; } }) }),
    rpc: async (_: string, data: Record<string, unknown>) => { calls.push(data); return { data: true, error: null }; } };
  const previous = { schema: process.env.SUPABASE_DATA_SCHEMA, url: process.env.NEXT_PUBLIC_SUPABASE_URL, secret: process.env.ONPLAY_BILLING_SECRET };
  process.env.SUPABASE_DATA_SCHEMA = "coinops"; process.env.NEXT_PUBLIC_SUPABASE_URL = "https://otdfpmsegjxpqrzisfmi.supabase.co"; process.env.ONPLAY_BILLING_SECRET = "s".repeat(40);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { const command = JSON.parse(String(init?.body)); assert.equal(command.external_tenant_id, a); assert.equal(command.actor_id, a); assert.equal(command.action, "checkout"); return Response.json(result); };
  try {
    const server = compile("./server.ts", { "server-only": {}, "node:crypto": await import("node:crypto"),
      "@/lib/supabase/server": { createClient: () => ({}) }, "@/lib/supabase/service-role": { createServiceRoleClient: () => db },
      "@/lib/supabase/env": { getSupabaseDataSchema: () => process.env.SUPABASE_DATA_SCHEMA }, "./contract": contract, "./signature": signature }) as { checkoutBillingIdentity: (id: string) => Promise<string>; billingService: () => unknown };
    assert.match(await server.checkoutBillingIdentity(a), /token=fixture/);
    assert.deepEqual(filters, [a]); assert.equal((calls[0].p_projection as Record<string, unknown>).checkout_url, undefined);
    result = { ok: true, subscription: { ...projection(b), checkout_url: "https://www.onplaymkt.com.br/pagamento/cobranca?token=fixture" } };
    await assert.rejects(server.checkoutBillingIdentity(a), /billing_identity_mismatch/);
    result = { ok: true, subscription: { ...projection(), checkout_url: "https://external.invalid/pay" } };
    await assert.rejects(server.checkoutBillingIdentity(a), /billing_checkout_invalid/);
    process.env.SUPABASE_DATA_SCHEMA = "public"; assert.throws(server.billingService, /billing_backend_mismatch/);
  } finally { globalThis.fetch = oldFetch; for (const [key, value] of Object.entries({ SUPABASE_DATA_SCHEMA: previous.schema, NEXT_PUBLIC_SUPABASE_URL: previous.url, ONPLAY_BILLING_SECRET: previous.secret })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
test("new commercial SQL changes no execution policies or tables", () => {
  const sql = readFileSync(new URL("../../../../supabase/migrations/20261011223915_coinops_commercial_billing.sql", import.meta.url), "utf8");
  assert.doesNotMatch(sql, /(?:update|insert into|alter table|delete from)\s+coinops\.(?:operators|exchange_accounts|trading_engines|robot_|account_)/i);
  assert.doesNotMatch(sql, /create.*policy.*(?:operator_context|operator_owned|execution)/i);
});

test("recovery claims the signed nonce before ACK and never reports accepted work as synced", async () => {
  const secret = "s".repeat(40), path = "/api/integrations/onplay-billing/reconcile";
  const previous = process.env.ONPLAY_BILLING_SECRET; process.env.ONPLAY_BILLING_SECRET = secret;
  let claims = 0, workers = 0, busy = false; const background: Promise<unknown>[] = [];
  const route = compile("../../app/api/integrations/onplay-billing/reconcile/route.ts", {
    "next/server": { NextResponse: { json: Response.json } }, "@vercel/functions": { waitUntil: (p: Promise<unknown>) => background.push(p) },
    "@/lib/saas-billing/contract": contract, "@/lib/saas-billing/signature": signature,
    "@/lib/saas-billing/server": { claimBillingSync: async () => { claims++; return busy ? null : { token: randomUUID(), cursor: null }; }, reconcileBilling: async (_: unknown, limit: number) => { workers++; assert.equal(limit, 20); } }
  }) as { POST: (request: Request) => Promise<Response> };
  const request = (body = '{"limit":20}', signatureOverride?: string) => { const timestamp = new Date().toISOString(), nonce = randomUUID(); return new Request("https://cripto-flax.vercel.app" + path, { method: "POST", body, headers: {
    "x-onplay-product": "coinops", "x-onplay-timestamp": timestamp, "x-onplay-nonce": nonce,
    "x-onplay-signature": signatureOverride ?? signature.signBillingRequest(secret, path, timestamp, nonce, body) } }); };
  try {
    const accepted = await route.POST(request()); assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { ok: true, accepted: true, synced: false, busy: false });
    assert.equal(claims, 1); assert.equal(background.length, 1); await Promise.all(background); assert.equal(workers, 1);
    busy = true; const occupied = await route.POST(request()); assert.equal((await occupied.json()).busy, true); assert.equal(workers, 1);
    assert.equal((await route.POST(request('{"limit":21}'))).status, 400);
    assert.equal((await route.POST(request('{"limit":20,"tenant_id":"other"}'))).status, 400);
    assert.equal((await route.POST(request('{"limit":20}', "x".repeat(43)))).status, 401);
    assert.equal(claims, 2);
  } finally { if (previous === undefined) delete process.env.ONPLAY_BILLING_SECRET; else process.env.ONPLAY_BILLING_SECRET = previous; }
});

test("a partial reconciliation preserves the previous cursor and releases only its own lease", async () => {
  const previous = { schema: process.env.SUPABASE_DATA_SCHEMA, url: process.env.NEXT_PUBLIC_SUPABASE_URL, secret: process.env.ONPLAY_BILLING_SECRET };
  process.env.SUPABASE_DATA_SCHEMA = "coinops"; process.env.NEXT_PUBLIC_SUPABASE_URL = "https://otdfpmsegjxpqrzisfmi.supabase.co"; process.env.ONPLAY_BILLING_SECRET = "s".repeat(40);
  const oldFetch = globalThis.fetch, token = randomUUID(), calls: { name: string; data: Record<string, unknown> }[] = []; let applies = 0, fail = true;
  const db = { rpc: async (name: string, data: Record<string, unknown>) => { calls.push({ name, data }); if (name === "apply_saas_billing_projection" && ++applies === 2 && fail) return { error: { code: "503" } }; return { data: true, error: null }; } };
  globalThis.fetch = async () => Response.json({ ok: true, subscriptions: [projection(), { ...projection(b), billing_subscription_id: randomUUID() }], next_cursor: b });
  const server = compile("./server.ts", { "server-only": {}, "node:crypto": await import("node:crypto"),
    "@/lib/supabase/server": { createClient: () => ({}) }, "@/lib/supabase/service-role": { createServiceRoleClient: () => db },
    "@/lib/supabase/env": { getSupabaseDataSchema: () => process.env.SUPABASE_DATA_SCHEMA }, "./contract": contract, "./signature": signature }) as { reconcileBilling: (claim: { token: string; cursor: string }, limit: number) => Promise<unknown> };
  try {
    await assert.rejects(server.reconcileBilling({ token, cursor: a }, 20), /billing_apply_failed/);
    assert.deepEqual(calls.at(-1), { name: "finish_saas_billing_sync", data: { p_token: token, p_cursor: a, p_error: "billing_apply_failed" } });
    fail = false; applies = 0; await server.reconcileBilling({ token, cursor: a }, 20);
    assert.deepEqual(calls.at(-1), { name: "finish_saas_billing_sync", data: { p_token: token, p_cursor: b, p_error: null } });
  } finally { globalThis.fetch = oldFetch; for (const [key, value] of Object.entries({ SUPABASE_DATA_SCHEMA: previous.schema, NEXT_PUBLIC_SUPABASE_URL: previous.url, ONPLAY_BILLING_SECRET: previous.secret })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
