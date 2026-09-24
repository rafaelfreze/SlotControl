import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { assertViewerAccount, assertViewerIntent, assertViewerOrigin, type ViewerIntent } from "./policy";

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
        .eq("operator_id", operator.id).order("created_at", { ascending: false }),
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
      const prior = await service.from("viewer_access").select("user_id")
        .eq("operator_id", operator.id).eq("email", email).maybeSingle();
      if (prior.error || prior.data) throw new Error("COINOPS_VIEWER_ALREADY_EXISTS");
      const redirectTo = viewerPasswordRedirect(request.nextUrl.origin);
      const invited = await service.auth.admin.inviteUserByEmail(email, { redirectTo });
      if (invited.error || !invited.data.user) throw new Error("COINOPS_VIEWER_INVITE_FAILED");
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
    const row = await service.from("viewer_access").select("user_id,email,status")
      .eq("operator_id", operator.id).eq("user_id", input.userId!).maybeSingle();
    if (row.error || !row.data) throw new Error("COINOPS_VIEWER_USER_DENIED");
    if (input.operation === "RESET") {
      const result = await service.auth.resetPasswordForEmail(row.data.email,
        { redirectTo: viewerPasswordRedirect(request.nextUrl.origin) });
      if (result.error) throw new Error("COINOPS_VIEWER_RESET_FAILED");
      return json({ status: row.data.status, resetSent: true });
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
      .eq("operator_id", operator.id).eq("user_id", input.userId!);
    if (updated.error) throw new Error("COINOPS_VIEWER_UPDATE_FAILED");
    return json({ status: "ACTIVE" });
  } catch (error) {
    const code = error instanceof Error && /^COINOPS_VIEWER_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_VIEWER_UNAVAILABLE";
    return json({ error: code }, code.includes("UNAVAILABLE") ? 503 : 403);
  }
}
