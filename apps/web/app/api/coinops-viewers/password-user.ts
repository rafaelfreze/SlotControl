import type { SupabaseClient, User } from "@supabase/supabase-js";
import { normalizeViewerWhatsApp, type ViewerIntent } from "./policy.ts";
import { pendingOwnership } from "../../../lib/auth/email-ownership.ts";

export async function createPasswordViewerIdentity(service: Pick<SupabaseClient, "auth">, input: ViewerIntent, actorId: string, operatorId: string, centralMarker?: { request_id: string; product_key: string; fingerprint: string }, report?: (stage: "identity_create" | "identity_reconcile_read", error: unknown) => void) {
  const email = input.email!.trim().toLowerCase();
  const marker = { request_id: input.requestId, actor_id: actorId, operator_id: operatorId };
  const created = await service.auth.admin.createUser({ email, password: input.password!, email_confirm: true,
    user_metadata: { onplay_product: "coinops", company_name: input.companyName!.trim(), owner_name: input.ownerName!.trim(), whatsapp: normalizeViewerWhatsApp(input.whatsapp) },
    app_metadata: { onplay_email_ownership:pendingOwnership("coinops",email), ...(centralMarker ? { onplay_billing_provision: centralMarker } : {}), coinops_role: "VIEWER", coinops_provision: marker,
      ...(/^onplay-qa-[a-z0-9-]+@example\.test$/i.test(email) && input.companyName!.trim().toUpperCase().startsWith("QA ONPLAY ")
        ? { onplay_qa: { product: "coinops", run_id: "20261014-signup", exclude_billing: true, exclude_analytics: true, allow_publication: false } } : {}) } });
  if (!created.error && created.data.user) return created.data.user;
  const existing = ["email_exists", "user_already_exists"].includes(created.error?.code ?? "");
  if (!existing) report?.("identity_create", created.error);
  if (created.error?.code === "weak_password") throw Object.assign(new Error("COINOPS_VIEWER_PASSWORD_INVALID"), { code: "weak_password" });
  if (!existing)
    throw new Error("COINOPS_VIEWER_CREATE_UNCONFIRMED");
  // Recover only this exact request after a lost response/binding failure. The
  // server never returns the Auth directory or modifies an existing password.
  for (let page = 1; page <= 20; page++) {
    const users = await service.auth.admin.listUsers({ page, perPage: 100 });
    if (users.error) { report?.("identity_reconcile_read", users.error); break; }
    const user = users.data.users.find((candidate: User) => candidate.email?.toLowerCase() === email);
    if (user) {
      const provision = user.app_metadata?.coinops_provision;
      if (user.app_metadata?.coinops_role === "VIEWER" && provision?.request_id === input.requestId
        && provision?.actor_id === actorId && provision?.operator_id === operatorId && (!centralMarker || JSON.stringify(user.app_metadata?.onplay_billing_provision) === JSON.stringify(centralMarker))) return user;
      break;
    }
    if (users.data.users.length < 100) break;
  }
  report?.("identity_create", created.error);
  throw new Error("COINOPS_VIEWER_EMAIL_ALREADY_REGISTERED");
}
