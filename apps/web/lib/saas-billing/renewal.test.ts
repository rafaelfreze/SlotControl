import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { parseProjection, type BillingProjection } from "./contract.ts";
import { billingToday, billingViewerAccessAllowed, buildRenewalNotice } from "./renewal.ts";

const user = "11111111-1111-4111-8111-111111111111";
const projection = (overrides: Partial<BillingProjection> = {}): BillingProjection => ({
  billing_subscription_id: "33333333-3333-4333-8333-333333333333", product_key: "coinops", external_tenant_id: user,
  tenant_name: "Fixture", tenant_slug: "fixture", plan_code: "contract_existing", plan_name: "Contrato existente",
  amount_cents: 4950, status: "grace", version: 1, trial_ends_at: null, billing_start_on: "2026-09-11", due_day: 10,
  next_due_date: "2026-10-10", grace_until: "2026-10-17", last_paid_at: "2026-09-10T15:00:00Z",
  paused_at: null, canceled_at: null, manual_pause: false, registration_pending: false, capabilities: {},
  installment_id: "44444444-4444-4444-8444-444444444444", balance_cents: 4950,
  contract_id: "55555555-5555-4555-8555-555555555555", updated_at: "2026-10-13T12:00:00Z", ...overrides,
});
const compile = (path: string, dependencies: Record<string, unknown>) => {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", js)((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, exports);
  return exports;
};

test("renewal uses Campo Grande day across midnight and the persisted deadline", () => {
  assert.equal(billingToday(new Date("2026-10-18T03:59:59Z")), "2026-10-17");
  assert.equal(billingToday(new Date("2026-10-18T04:00:00Z")), "2026-10-18");
  const notice = buildRenewalNotice(projection(), "2026-10-13")!;
  assert.equal(notice.blocked, false);
  assert.match(notice.description, /até 7 dias.*17\/10\/2026.*18\/10\/2026/);
  assert.equal(buildRenewalNotice(projection(), "2026-10-16")!.description, notice.description);
});
test("the entire last payment day is allowed and the next day blocks stale active projection", () => {
  assert.equal(billingViewerAccessAllowed(projection(), "2026-10-17"), true);
  for (const status of ["active", "grace", "overdue", "paused"] as const) {
    assert.equal(billingViewerAccessAllowed(projection({ status }), "2026-10-18"), false);
    assert.equal(buildRenewalNotice(projection({ status }), "2026-10-18")!.blocked, true);
  }
});
test("a confirmed payment releases commercial web access without an engine action", () => {
  const paid = projection({ balance_cents: 0, next_due_date: "2026-11-10", grace_until: null, status: "active", last_paid_at: "2026-10-18T13:00:00Z" });
  assert.equal(billingViewerAccessAllowed(paid, "2026-10-18"), true);
  assert.equal(buildRenewalNotice(paid, "2026-10-18"), null);
});
test("unlinked identity, missing date and legacy state do not create a local suspension or grace", () => {
  for (const p of [null, projection({ registration_pending: true }), projection({ grace_until: null }), projection({ next_due_date: null }), projection({ balance_cents: null })])
    assert.equal(billingViewerAccessAllowed(p, "2026-10-18"), true);
  assert.doesNotMatch(buildRenewalNotice(projection({ grace_until: "2026-10-20" }), "2026-10-13")!.description, /até 7 dias/);
  assert.equal(buildRenewalNotice(projection({ status: "pending", last_paid_at: null }), "2026-10-13"), null);
  assert.equal(buildRenewalNotice(projection({ manual_pause: true }), "2026-10-13"), null);
  assert.equal(buildRenewalNotice(projection({ status: "active" }), "2026-10-10"), null);
});
test("a unavailable read cannot block operations or grant an invented payment period", async () => {
  const server = compile("./renewal-server.ts", { "server-only": {}, "./server": { localProjection: async () => { throw Error("fixture"); } },
    "./renewal": { billingViewerAccessAllowed, buildRenewalNotice } }) as { readBillingRenewal: (id: string) => Promise<{ blocked: boolean; notice: { description: string } }> };
  const result = await server.readBillingRenewal(user);
  assert.equal(result.blocked, false);
  assert.doesNotMatch(result.notice.description, /7 dias/);
});

async function middleware(path: string, role = "VIEWER", p: BillingProjection | null = projection(), commercialReadThrows = false) {
  const previous = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://otdfpmsegjxpqrzisfmi.supabase.co"; process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fixture-public";
  const tables: string[] = [], authChecks: string[] = [];
  const url = new URL(path, "https://coinops.example");
  const response = { next: () => ({ kind: "next" }), redirect: (u: URL) => ({ kind: "redirect", location: u.toString() }),
    json: (body: unknown, init: { status: number }) => ({ kind: "json", body, status: init.status }) };
  try {
    const handler = compile("../../middleware.ts", {
      "next/server": { NextResponse: response }, "@/lib/auth/navigation": { getAuthDestination: () => "/automacao" },
      "@/lib/supabase/env": { getSupabaseDataSchema: () => "coinops" }, "@/lib/saas-billing/contract": { parseProjection },
      "@/lib/saas-billing/renewal": { billingViewerAccessAllowed: (value: BillingProjection | null) => billingViewerAccessAllowed(value, "2026-10-18") },
      "@supabase/ssr": { createServerClient: () => ({ auth: { getUser: async () => { authChecks.push("auth"); return { data: { user: { id: user, app_metadata: { coinops_role: role } } } }; } },
        from: (table: string) => { tables.push(table); if (table === "saas_billing_projections" && commercialReadThrows) throw Error("fixture-read-failure"); return { select: () => ({ eq: (_key: string, id: string) => { assert.equal(id, user); return { maybeSingle: async () => ({ data: table === "viewer_access" ? { status: "ACTIVE" } : p ? { projection: p } : null, error: null }) }; } }) }; } }) },
    }) as { middleware: (r: unknown) => Promise<{ kind: string; location?: string; status?: number }> };
    const result = await handler.middleware({ url: url.toString(), nextUrl: Object.assign(url, { clone: () => new URL(url) }),
      method: path === "/api/assinatura" ? "POST" : "GET", cookies: { getAll: () => [], set() {} } });
    return { result, tables, authChecks };
  } finally { for (const [key, value] of Object.entries({ NEXT_PUBLIC_SUPABASE_URL: previous.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: previous.key })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } }
}
test("expired VIEWER navigation redirects to own payment portal and read API returns 403", async () => {
  assert.equal((await middleware("/meu-coinops")).result.location, "https://coinops.example/assinatura?aviso=renovacao-vencida");
  assert.equal((await middleware("/api/coinops-viewer-state")).result.status, 403);
  assert.equal((await middleware("/meu-coinops", "VIEWER", projection({ balance_cents: 0 }))).result.kind, "next");
});
test("subscription, checkout, ADMIN supervision and cron execution remain accessible", async () => {
  for (const path of ["/assinatura", "/api/assinatura", "/redefinir-senha"]) {
    const r = await middleware(path); assert.equal(r.result.kind, "next"); assert.deepEqual(r.tables, ["viewer_access"]);
  }
  const admin = await middleware("/automacao", "ADMIN"); assert.equal(admin.result.kind, "next"); assert.deepEqual(admin.tables, []);
  const cron = await middleware("/api/cron/robot"); assert.equal(cron.result.kind, "next"); assert.deepEqual(cron.authChecks, []);
});
test("a different identity or absent projection cannot suspend this viewer", async () => {
  const p = projection({ external_tenant_id: "22222222-2222-4222-8222-222222222222" });
  assert.equal((await middleware("/meu-coinops", "VIEWER", p)).result.kind, "next");
  assert.equal((await middleware("/meu-coinops", "VIEWER", null)).result.kind, "next");
  assert.equal((await middleware("/meu-coinops", "VIEWER", projection(), true)).result.kind, "next");
});
test("direct read API checks commercial expiry before querying an engine or executor", async () => {
  let executionReads = 0; const tables: string[] = [];
  const handler = compile("../../app/api/coinops-viewer-state/route.ts", {
    "next/server": { NextResponse: { json: Response.json } }, "@/lib/supabase/server": { createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: user, app_metadata: { coinops_role: "VIEWER" } } } }) } }) },
    "@/lib/supabase/service-role": { createServiceRoleClient: () => ({ from: (table: string) => { tables.push(table); return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { operator_id: "op", exchange_account_id: "account", status: "ACTIVE" }, error: null }) }) }) }; } }) },
    "@/lib/supabase/env": { getSupabaseDataSchema: () => "coinops" },
    "@/lib/execution/live-executor-transport": { readLiveExecutorState: async () => { executionReads++; } },
    "@/lib/saas-billing/renewal-server": { readBillingRenewal: async (id: string) => { assert.equal(id, user); return { blocked: true }; } },
  }) as { GET: () => Promise<Response> };
  assert.equal((await handler.GET()).status, 403); assert.equal(executionReads, 0); assert.deepEqual(tables, ["viewer_access"]);
});
