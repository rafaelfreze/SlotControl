import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { assertViewerAccount, assertViewerIntent, assertViewerOrigin, assertViewerInactive, assertViewerResetActive, assertViewerRestoreIdentity, viewerInviteFailureCode, viewerResetFailureCode, type ViewerIntent } from "./policy";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
// Invite/recovery tokens are delivered in the URL fragment. A server-side
// callback redirect loses that fragment before the browser Auth client sees it.
const viewerPasswordRedirect = (origin: string) => `${origin}/redefinir-senha`;

async function adminScope() {
  if (getSupabaseDataSchema() !== "coinops") throw new Error("COINOPS_VIEWER_SCHEMA_DENIED");
  const tenantId = getCoinOpsServiceTenantId();
  const client = createClient();
  const user = (await client.auth.getUser()).data.user;
  if (!user || !tenantId || user.app_metadata?.coinops_role === "VIEWER")
    throw new Error("COINOPS_VIEWER_ADMIN_DENIED");
  const { data: operator, error } = await client.from("operators").select("id,user_id,status")
    .eq("tenant_id", tenantId).eq("user_id", user.id).eq("status", "ACTIVE").single();
  if (error || !operator) throw new Error("COINOPS_VIEWER_ADMIN_DENIED");
  return { operator, service: createServiceRoleClient() };
}

export async function GET() {
  try {
    const { operator, service } = await adminScope();
    const [access, accounts] = await Promise.all([
      service.from("viewer_access").select("user_id,exchange_account_id,display_name,email,status,created_at")
        .eq("operator_id", operator.id).is("deleted_at", null).order("created_at", { ascending: false }),
      service.from("exchange_accounts").select("id,display_name,status")
        .eq("operator_id", operator.id).in("status", ["ACTIVE", "INACTIVE"]).order("display_name"),
    ]);
    if (access.error || accounts.error) throw new Error("COINOPS_VIEWER_READ_FAILED");
    return json({ users: access.data ?? [], accounts: accounts.data ?? [] });
  } catch { return json({ error: "COINOPS_VIEWER_ADMIN_DENIED" }, 403); }
}

export async function POST(request: NextRequest) {
  try {
    assertViewerOrigin(request.headers.get("origin"), request.nextUrl.origin,
      request.headers.get("sec-fetch-site"), request.headers.get("x-coinops-admin-intent"),
      request.headers.get("content-type"));
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 2048) throw new Error("COINOPS_VIEWER_BODY_TOO_LARGE");
    const input = JSON.parse(raw) as ViewerIntent;
    assertViewerIntent(input);
    const { operator, service } = await adminScope();
    if (input.operation === "CREATE") {
      const account = await service.from("exchange_accounts").select("operator_id,status")
        .eq("id", input.accountId!).maybeSingle();
      if (account.error) throw new Error("COINOPS_VIEWER_ACCOUNT_READ_FAILED");
      assertViewerAccount(account.data, operator.id);
      const email = input.email!.trim().toLowerCase();
      const prior = await service.from("viewer_access").select("user_id,status,deleted_at")
        .eq("operator_id", operator.id).eq("email", email).maybeSingle();
      if (prior.error) throw new Error("COINOPS_VIEWER_READ_FAILED");
      if (prior.data && !prior.data.deleted_at) throw new Error("COINOPS_VIEWER_ALREADY_EXISTS");
      if (prior.data) {
        assertViewerInactive(prior.data.status);
        const identity = await service.auth.admin.getUserById(prior.data.user_id);
        if (identity.error) throw new Error("COINOPS_VIEWER_RESTORE_IDENTITY_DENIED");
        assertViewerRestoreIdentity(identity.data.user, email);
        // Reuse only this operator's removed VIEWER identity, never an arbitrary
        // existing Auth email. CAS wins before any unban/email side effect.
        const restoredAt = new Date().toISOString();
        const restored = await service.from("viewer_access").update({ exchange_account_id: input.accountId!,
          display_name: input.displayName!.trim(), status: "ACTIVE", deleted_at: null, updated_at: restoredAt })
          .eq("operator_id", operator.id).eq("user_id", prior.data.user_id).eq("status", "INACTIVE")
          .eq("deleted_at", prior.data.deleted_at).select("user_id").single();
        if (restored.error || !restored.data) throw new Error("COINOPS_VIEWER_BINDING_CHANGED");
        const unbanned = await service.auth.admin.updateUserById(prior.data.user_id, { ban_duration: "none" });
        const recovery = unbanned.error ? null : await service.auth.resetPasswordForEmail(email,
          { redirectTo: viewerPasswordRedirect(request.nextUrl.origin) });
        if (unbanned.error || !recovery || recovery.error) {
          // Fail closed, retaining a removable/retryable binding; no Auth delete.
          const rollback = await service.from("viewer_access")
            .update({ status: "INACTIVE", deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq("operator_id", operator.id).eq("user_id", prior.data.user_id).eq("updated_at", restoredAt)
            .select("user_id").single();
          if (rollback.error || !rollback.data) throw new Error("COINOPS_VIEWER_RESTORE_ROLLBACK_FAILED");
          throw new Error(unbanned.error ? "COINOPS_VIEWER_AUTH_UNBAN_FAILED" : viewerResetFailureCode(recovery?.error ?? null));
        }
        return json({ userId: prior.data.user_id, status: "ACTIVE", recoverySent: true,
          reusedAccess: true, recipient: email }, 201);
      }
      const redirectTo = viewerPasswordRedirect(request.nextUrl.origin);
      const invited = await service.auth.admin.inviteUserByEmail(email, { redirectTo });
      if (invited.error || !invited.data.user) throw new Error(viewerInviteFailureCode(invited.error));
      const userId = invited.data.user.id;
      const stored = await service.from("viewer_access").insert({ user_id: userId,
        operator_id: operator.id, exchange_account_id: input.accountId!, role: "VIEWER",
        display_name: input.displayName!.trim(), email, status: "ACTIVE", created_by: operator.user_id });
      if (stored.error) {
        await service.auth.admin.updateUserById(userId, { ban_duration: "876000h" });
        throw new Error("COINOPS_VIEWER_BINDING_FAILED");
      }
      const role = await service.auth.admin.updateUserById(userId,
        { app_metadata: { ...invited.data.user.app_metadata, coinops_role: "VIEWER" } });
      if (role.error) {
        await service.from("viewer_access").update({ status: "INACTIVE" }).eq("user_id", userId);
        await service.auth.admin.updateUserById(userId, { ban_duration: "876000h" });
        throw new Error("COINOPS_VIEWER_ROLE_FAILED");
      }
      return json({ userId, status: "ACTIVE", inviteSent: true }, 201);
    }
    const row = await service.from("viewer_access").select("user_id,email,status,exchange_account_id")
      .eq("operator_id", operator.id).eq("user_id", input.userId!).is("deleted_at", null).maybeSingle();
    if (row.error || !row.data) throw new Error("COINOPS_VIEWER_USER_DENIED");
    if (input.operation === "DELETE") {
      assertViewerInactive(row.data.status);
      // Inactive access is already denied on every read. Preserve shared Auth,
      // RLS tombstone and immutable financial history instead of hard-deleting.
      const deletedAt = new Date().toISOString();
      const removed = await service.from("viewer_access")
        .update({ deleted_at: deletedAt, updated_at: deletedAt })
        .eq("operator_id", operator.id).eq("user_id", input.userId!).eq("status", "INACTIVE")
        .is("deleted_at", null).select("user_id").single();
      if (removed.error || !removed.data) throw new Error("COINOPS_VIEWER_BINDING_CHANGED");
      return json({ status: "INACTIVE", accessRemoved: true });
    }
    if (input.operation === "REASSIGN") {
      assertViewerInactive(row.data.status);
      const account = await service.from("exchange_accounts").select("operator_id,status")
        .eq("id", input.accountId!).maybeSingle();
      if (account.error) throw new Error("COINOPS_VIEWER_ACCOUNT_READ_FAILED");
      assertViewerAccount(account.data, operator.id);
      // Compare-and-set: a concurrent reactivation must never be rebound.
      // Keep Auth banned and access INACTIVE; ENABLE is a separate operation.
      const updated = await service.from("viewer_access")
        .update({ exchange_account_id: input.accountId!, updated_at: new Date().toISOString() })
        .eq("operator_id", operator.id).eq("user_id", input.userId!).eq("status", "INACTIVE").is("deleted_at", null)
        .eq("exchange_account_id", row.data.exchange_account_id).select("user_id").single();
      if (updated.error || !updated.data) throw new Error("COINOPS_VIEWER_BINDING_CHANGED");
      return json({ status: "INACTIVE", accountId: input.accountId, bindingUpdated: true });
    }
    if (input.operation === "RESET") {
      assertViewerResetActive(row.data.status);
      const result = await service.auth.resetPasswordForEmail(row.data.email,
        { redirectTo: viewerPasswordRedirect(request.nextUrl.origin) });
      if (result.error) throw new Error(viewerResetFailureCode(result.error));
      return json({ status: row.data.status, resetSent: true, recipient: row.data.email });
    }
    if (input.operation === "DISABLE" || input.operation === "REVOKE") {
      const updated = await service.from("viewer_access").update({ status: "INACTIVE", updated_at: new Date().toISOString() })
        .eq("operator_id", operator.id).eq("user_id", input.userId!);
      if (updated.error) throw new Error("COINOPS_VIEWER_UPDATE_FAILED");
      const banned = await service.auth.admin.updateUserById(input.userId!, { ban_duration: "876000h" });
      if (banned.error) throw new Error("COINOPS_VIEWER_AUTH_BAN_FAILED");
      return json({ status: "INACTIVE" });
    }
    const unbanned = await service.auth.admin.updateUserById(input.userId!, { ban_duration: "none" });
    if (unbanned.error) throw new Error("COINOPS_VIEWER_AUTH_UNBAN_FAILED");
    const updated = await service.from("viewer_access").update({ status: "ACTIVE", updated_at: new Date().toISOString() })
      .eq("operator_id", operator.id).eq("user_id", input.userId!)
      .eq("exchange_account_id", row.data.exchange_account_id).is("deleted_at", null).select("user_id").single();
    if (updated.error || !updated.data) throw new Error("COINOPS_VIEWER_BINDING_CHANGED");
    return json({ status: "ACTIVE" });
  } catch (error) {
    const code = error instanceof Error && /^COINOPS_VIEWER_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_VIEWER_UNAVAILABLE";
    return json({ error: code }, code === "COINOPS_VIEWER_RESET_RATE_LIMIT" ? 429
      : ["COINOPS_VIEWER_EMAIL_ALREADY_REGISTERED", "COINOPS_VIEWER_BINDING_CHANGED"].includes(code) ? 409
      : code.includes("UNAVAILABLE") ? 503 : 403);
  }
}
