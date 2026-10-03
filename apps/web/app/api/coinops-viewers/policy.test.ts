import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertViewerAccount, assertViewerIntent, assertViewerOrigin, assertViewerInactive, assertViewerResetActive, assertViewerRestoreIdentity, viewerInviteFailureCode, viewerResetFailureCode } from "./policy.ts";

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

test("existing Auth identity is a safe conflict, never silently rebound to another account", () => {
  assert.equal(viewerInviteFailureCode({ code: "email_exists", status: 422 }),
    "COINOPS_VIEWER_EMAIL_ALREADY_REGISTERED");
  assert.equal(viewerInviteFailureCode({ code: "unexpected_failure", status: 503 }),
    "COINOPS_VIEWER_INVITE_FAILED");
  const route = readFileSync(resolve(process.cwd(), "app/api/coinops-viewers/route.ts"), "utf8");
  const panel = readFileSync(resolve(process.cwd(), "app/automacao/viewer-users-panel.tsx"), "utf8");
  assert.match(route, /viewerInviteFailureCode\(invited\.error\)/);
  assert.match(panel, /if \(created\) form\.reset\(\)/);
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
  assert.match(middleware, /db: \{ schema: getSupabaseDataSchema\(\) \}/);
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
  assert.match(form, /auth\.setSession\(/);
  assert.match(form, /window\.history\.replaceState/);
  assert.match(form, /!sessionReady/);
});

test("binding correction is scoped, inactive-only and does not activate or change Auth", () => {
  assert.doesNotThrow(() => assertViewerIntent({ operation: "REASSIGN", requestId: id(1), userId: id(2), accountId: id(3) }));
  for (const accountId of [undefined, "ALL", "wrong"])
    assert.throws(() => assertViewerIntent({ operation: "REASSIGN", requestId: id(1), userId: id(2), accountId }), /INTENT_INVALID/);
  assert.throws(() => assertViewerIntent({ operation: "REASSIGN", requestId: id(1), userId: id(2), accountId: id(3), email: "new@example.com" }), /INTENT_INVALID/);
  assert.doesNotThrow(() => assertViewerInactive("INACTIVE"));
  for (const status of ["ACTIVE", "", "UNKNOWN"]) assert.throws(() => assertViewerInactive(status), /REQUIRES_INACTIVE/);
  const route = readFileSync(resolve(process.cwd(), "app/api/coinops-viewers/route.ts"), "utf8");
  const branch = route.slice(route.indexOf('if (input.operation === "REASSIGN")'), route.indexOf('if (input.operation === "RESET")'));
  assert.match(branch, /assertViewerAccount\(account.data, operator.id\)/);
  assert.match(branch, /\.eq\("operator_id", operator.id\).*\.eq\("user_id", input.userId!\).*\.eq\("status", "INACTIVE"\)/);
  assert.match(branch, /\.eq\("exchange_account_id", row.data.exchange_account_id\)/);
  assert.match(branch, /status: "INACTIVE"/);
  assert.doesNotMatch(branch, /auth\.|status: "ACTIVE"|trading_engines|robot_v1/);
});

test("removed access can reuse only its original viewer identity, never another Auth email or role", () => {
  assert.doesNotThrow(() => assertViewerRestoreIdentity({ email: "CLIENT@example.com", app_metadata: { coinops_role: "VIEWER" } }, "client@example.com"));
  for (const user of [null, { email: "other@example.com", app_metadata: { coinops_role: "VIEWER" } },
    { email: "client@example.com", app_metadata: { coinops_role: "ADMIN" } }, { email: "client@example.com" }])
    assert.throws(() => assertViewerRestoreIdentity(user, "client@example.com"), /RESTORE_IDENTITY_DENIED/);
  const route = readFileSync(resolve(process.cwd(), "app/api/coinops-viewers/route.ts"), "utf8");
  assert.match(route, /prior.data && !prior.data.deleted_at/);
  assert.match(route, /assertViewerRestoreIdentity\(identity.data.user, email\)/);
  assert.match(route, /\.eq\("deleted_at", prior.data.deleted_at\)/);
  assert.match(route, /\.eq\("updated_at", restoredAt\)/);
  assert.doesNotMatch(route, /deleteUser\(|\.from\("(?:trading_engines|robot_v1_[^"]+)"\)/);
});

test("delete is inactive-only, reversible and keeps the shared Auth identity and RLS deny guard", () => {
  assert.doesNotThrow(() => assertViewerIntent({ operation: "DELETE", requestId: id(1), userId: id(2) }));
  assert.throws(() => assertViewerIntent({ operation: "DELETE", requestId: id(1), userId: id(2), accountId: id(3) }), /INTENT_INVALID/);
  const route = readFileSync(resolve(process.cwd(), "app/api/coinops-viewers/route.ts"), "utf8");
  const branch = route.slice(route.indexOf('if (input.operation === "DELETE")'), route.indexOf('if (input.operation === "REASSIGN")'));
  assert.match(branch, /assertViewerInactive\(row.data.status\)/);
  assert.match(branch, /\.eq\("operator_id", operator.id\).*\.eq\("user_id", input.userId!\).*\.eq\("status", "INACTIVE"\)/);
  assert.doesNotMatch(branch, /\.delete\(|auth\./);
  assert.match(route, /\.is\("deleted_at", null\)/);
  const migration = readFileSync(resolve(process.cwd(), "../../supabase/migrations/20261003234823_add_coinops_viewer_access_removal.sql"), "utf8");
  assert.match(migration, /check \(deleted_at is null or status = 'INACTIVE'\)/);
  assert.doesNotMatch(migration, /drop |delete from|truncate |grant |auth.users/i);
  const panel = readFileSync(resolve(process.cwd(), "app/automacao/viewer-users-panel.tsx"), "utf8");
  assert.match(panel, /window.confirm/);
  assert.match(panel, /Excluir acesso/);
});

test("reset rejects disabled access before email delivery and identifies rate limits", () => {
  assert.doesNotThrow(() => assertViewerResetActive("ACTIVE"));
  assert.throws(() => assertViewerResetActive("INACTIVE"), /RESET_REQUIRES_ACTIVE/);
  assert.equal(viewerResetFailureCode({ status: 429 }), "COINOPS_VIEWER_RESET_RATE_LIMIT");
  assert.equal(viewerResetFailureCode({ code: "user_banned" }), "COINOPS_VIEWER_RESET_REQUIRES_ACTIVE");
  assert.equal(viewerResetFailureCode({ code: "unexpected_failure" }), "COINOPS_VIEWER_RESET_FAILED");
  const route = readFileSync(resolve(process.cwd(), "app/api/coinops-viewers/route.ts"), "utf8");
  assert.match(route, /assertViewerResetActive\(row.data.status\);\s*const result = await service.auth.resetPasswordForEmail/);
  const panel = readFileSync(resolve(process.cwd(), "app/automacao/viewer-users-panel.tsx"), "utf8");
  assert.match(panel, /disabled=\{busy \|\| user.status !== "ACTIVE"\}/);
  assert.match(panel, /body.recipient/);
});
