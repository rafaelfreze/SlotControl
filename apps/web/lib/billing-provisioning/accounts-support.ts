import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AccountError, assertAccountMarker, type AccountInput, type AccountPlan, type ProvisionMarker } from "./accounts-contract";

export async function assertProvisionUser(db: Pick<SupabaseClient, "auth">, id: string, marker?: ProvisionMarker, report?: (error: unknown) => void) {
  const result = await db.auth.admin.getUserById(id), user = result.data.user;
  if (result.error) report?.(result.error);
  if (result.error || !user || user.deleted_at || Date.parse(user.banned_until ?? "") > Date.now()) throw new AccountError("account_access_unavailable", 409);
  if (marker) assertAccountMarker(user.app_metadata?.onplay_billing_provision, marker);
  return user;
}
/** The central actor is never interpreted as a local role or foreign key. */
export async function localProvisionActor(db: SupabaseClient, product: string, serviceTenantId?: string | null, report?: (stage: "actor_operator_read" | "actor_auth_read", error: unknown) => void) {
  let id: string | undefined;
  if (product === "coinops") {
    if (!serviceTenantId) throw new AccountError("provisioning_actor_unavailable");
    const result = await db.from("operators").select("id,user_id,status").eq("tenant_id", serviceTenantId).eq("status", "ACTIVE").order("id").limit(1).maybeSingle();
    if (result.error) report?.("actor_operator_read", result.error);
    if (result.error || !result.data) throw new AccountError("provisioning_actor_unavailable");
    const user = await assertProvisionUser(db, result.data.user_id, undefined, error => report?.("actor_auth_read", error));
    if (user.app_metadata?.coinops_role === "VIEWER") throw new AccountError("provisioning_actor_unavailable");
    return { id: user.id, operatorId: result.data.id, email: user.email ?? null, fullName: null, role: "master" as const, isActive: true, mustChangePassword: false };
  }
  if (product === "servnexx") {
    const roles = await db.from("platform_roles").select("id").in("key", ["super_admin", "platform_admin"]).eq("status", "active");
    if (roles.error || !roles.data?.length) throw new AccountError("provisioning_actor_unavailable");
    const assignments = await db.from("platform_user_roles").select("user_id").in("role_id", roles.data.map(r => r.id)).eq("status", "active").order("user_id").limit(100);
    if (assignments.error || !assignments.data?.length) throw new AccountError("provisioning_actor_unavailable");
    const profiles = await db.from("profiles").select("id").in("id", assignments.data.map(r => r.user_id)).eq("status", "active").order("id").limit(1).maybeSingle();
    if (profiles.error) throw new AccountError("provisioning_actor_unavailable");
    id = profiles.data?.id;
  } else {
    const table = product === "onfood" ? "platform_users" : "profiles";
    let query = db.from(table).select("*").eq(product === "onplay_ads" ? "platform_role" : "role", product === "nexxfitpro" ? "super_admin" : "master");
    query = product === "onplay_ads" ? query.eq("is_active", true).eq("must_change_password", false) : product === "nexxfitpro" ? query : query.eq("status", "active");
    const result = await query.order("id").limit(1).maybeSingle();
    if (result.error || result.data?.must_change_password === true || result.data?.deactivated_at || result.data?.archived_at || result.data?.is_active === false) throw new AccountError("provisioning_actor_unavailable");
    id = result.data?.id;
  }
  if (!id) throw new AccountError("provisioning_actor_unavailable");
  const user = await assertProvisionUser(db, id);
  return { id, email: user.email ?? null, fullName: null, role: "master" as const, isActive: true, mustChangePassword: false };
}
export function accountResult(input: AccountInput, tenantId: string, payload: Record<string, unknown>, resumed: boolean, loginUrl: string) {
  if (!tenantId || typeof payload.tenant_name !== "string" || typeof payload.tenant_slug !== "string" || !payload.plan || typeof payload.billing_start_on !== "string") throw new AccountError("account_readback_unavailable");
  return { account: { external_tenant_id: tenantId, tenant_name: payload.tenant_name, tenant_slug: payload.tenant_slug, owner_name: input.owner_name, owner_email: input.email, whatsapp: input.whatsapp, plan: payload.plan, trial_ends_at: payload.trial_ends_at ?? null, billing_start_on: payload.billing_start_on, due_day: payload.due_day, current_access: payload.current_access }, resumed, login_url: loginUrl };
}
export function centralTrialPayload(input: AccountInput, name: string, slug: string, createdAt: string) {
  const created = Date.parse(createdAt); if (!Number.isFinite(created)) throw new AccountError("account_readback_unavailable");
  const end = new Date(created + 30 * 86400000), day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Cuiaba", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(end.valueOf() + 86400000));
  return { tenant_name: name, tenant_slug: slug, plan: input.plan, trial_ends_at: end.toISOString(), billing_start_on: day, due_day: Number(day.slice(-2)), current_access: end.valueOf() > Date.now() ? "trial" : "pending" };
}
export function validateLocalPlan(plan: AccountPlan, signed: AccountPlan) {
  if (plan.code !== signed.code || plan.amount_cents !== signed.amount_cents || plan.trial_days !== 30) throw new AccountError("plan_changed_refresh_catalog", 409);
  return plan;
}
