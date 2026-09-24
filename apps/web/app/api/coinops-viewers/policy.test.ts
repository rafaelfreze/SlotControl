import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertViewerAccount, assertViewerIntent, assertViewerOrigin } from "./policy.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("viewer creation requires exactly one valid account and no client-selected role", () => {
  assert.doesNotThrow(() => assertViewerIntent({ operation: "CREATE", requestId: id(1), accountId: id(2),
    displayName: "Cliente", email: "cliente@example.com" }));
  assert.throws(() => assertViewerIntent({ operation: "CREATE", requestId: id(1), accountId: "ALL",
    displayName: "Cliente", email: "cliente@example.com" }), /INTENT_INVALID/);
  assert.throws(() => assertViewerIntent({ operation: "DISABLE", requestId: id(1), userId: id(2),
    accountId: id(3) }), /INTENT_INVALID/);
});

test("foreign, disabled and missing accounts are denied before Auth invite", () => {
  assert.doesNotThrow(() => assertViewerAccount({ operator_id: id(1), status: "ACTIVE" }, id(1)));
  for (const account of [null, { operator_id: id(2), status: "ACTIVE" },
    { operator_id: id(1), status: "DISABLED" }])
    assert.throws(() => assertViewerAccount(account, id(1)), /ACCOUNT_DENIED/);
});

test("admin writes require same origin and explicit JSON intent", () => {
  assert.doesNotThrow(() => assertViewerOrigin("https://coinops.test", "https://coinops.test", "same-origin",
    "viewer-access", "application/json"));
  for (const origin of [null, "https://evil.test"])
    assert.throws(() => assertViewerOrigin(origin, "https://coinops.test", "cross-site",
      "viewer-access", "application/json"), /CSRF_DENIED/);
});

test("portal data is server-scoped and omits private order identifiers", () => {
  const page = readFileSync(resolve(process.cwd(), "app/meu-coinops/page.tsx"), "utf8");
  const middleware = readFileSync(resolve(process.cwd(), "middleware.ts"), "utf8");
  const migration = readFileSync(resolve(process.cwd(), "../../supabase/migrations/20260924212849_add_coinops_viewer_access.sql"), "utf8");
  assert.match(page, /\.eq\("user_id", user\.id\)/);
  assert.match(page, /\.eq\("operator_id", operatorId\)\.eq\("exchange_account_id", accountId\)/);
  assert.doesNotMatch(page, /select\([^\n]*client_order_id/);
  assert.doesNotMatch(page, /select\([^\n]*credential_ref/);
  assert.match(middleware, /pathname\.startsWith\("\/api\/"\).*VIEWER_READ_ONLY/);
  assert.match(migration, /not exists \([\s\S]*coinops\.viewer_access viewer/);
  assert.match(migration, /create policy viewer_self_read/);
  assert.doesNotMatch(migration, /grant (?:insert|update|delete|all) on coinops\.viewer_access to authenticated/i);
});

test("invitation and reset land directly on the browser password form", () => {
  const route = readFileSync(resolve(process.cwd(), "app/api/coinops-viewers/route.ts"), "utf8");
  const form = readFileSync(resolve(process.cwd(), "components/auth/password-reset-form.tsx"), "utf8");
  assert.match(route, /viewerPasswordRedirect = \(origin: string\) => `\$\{origin\}\/redefinir-senha`/);
  assert.match(route, /const redirectTo = viewerPasswordRedirect\(request\.nextUrl\.origin\)/);
  assert.match(route, /resetPasswordForEmail[\s\S]*viewerPasswordRedirect\(request\.nextUrl\.origin\)/);
  assert.match(form, /auth\.onAuthStateChange\(/);
  assert.match(form, /auth\.getSession\(\)/);
  assert.match(form, /!sessionReady/);
});
