import "server-only";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getSupabaseDataSchema } from "@/lib/supabase/env";
import { BILLING_PRODUCT, BillingError, UUID, parseProjection, type BillingProjection } from "./contract";
import { signBillingRequest } from "./signature";

export function billingService() {
  // Billing refuses the preserved legacy development environment rather than falling into public.
  if (getSupabaseDataSchema() !== "coinops" || new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://invalid.local").hostname !== "otdfpmsegjxpqrzisfmi.supabase.co") throw new BillingError("billing_backend_mismatch");
  return createServiceRoleClient();
}
export function centralOrigin() {
  const u = new URL(process.env.ONPLAY_BILLING_ORIGIN ?? "https://www.onplaymkt.com.br");
  if (u.protocol !== "https:" || !["www.onplaymkt.com.br", "onplaymkt.com.br"].includes(u.hostname)
    || u.port || u.username || u.password || u.pathname !== "/" || u.search || u.hash) throw new BillingError("billing_origin_invalid");
  return u.origin;
}
export async function currentBillingIdentity() {
  const auth = createClient();
  const user = (await auth.auth.getUser()).data.user;
  if (!user || !UUID.test(user.id)) throw new BillingError("billing_login_required", 401);
  const service = billingService();
  const identity = await service.rpc("billing_identity_active", { p_user: user.id });
  if (identity.error || identity.data !== true) throw new BillingError("billing_access_denied", 403);
  return { user, auth, service };
}
export async function localProjection(userId: string, service = billingService()) {
  const r = await service.from("saas_billing_projections").select("projection").eq("user_id", userId).maybeSingle();
  if (r.error) throw new BillingError("billing_read_failed");
  if (!r.data) return null;
  const projection = parseProjection(r.data.projection);
  if (projection.external_tenant_id !== userId) throw new BillingError("billing_identity_mismatch");
  return projection;
}
async function centralRequest(pathname: string, input: unknown, timeout = 15000): Promise<Record<string, unknown>> {
  const secret = process.env.ONPLAY_BILLING_SECRET;
  if (!secret || secret.length < 32) throw new BillingError("billing_not_connected");
  const body = JSON.stringify(input), timestamp = new Date().toISOString(), nonce = randomUUID();
  const r = await fetch(`${centralOrigin()}${pathname}`, { method: "POST", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(timeout),
    headers: { "content-type": "application/json", "x-onplay-product": BILLING_PRODUCT, "x-onplay-timestamp": timestamp,
      "x-onplay-nonce": nonce, "x-onplay-signature": signBillingRequest(secret, pathname, timestamp, nonce, body) }, body });
  if (!r.ok) throw new BillingError("billing_central_unavailable", r.status === 409 ? 409 : 503);
  const raw = await r.text(); if (Buffer.byteLength(raw) > 2_000_000) throw new BillingError("billing_invalid_response");
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || value.ok !== true) throw new BillingError("billing_invalid_response");
  return value;
}
export async function applyProjection(projection: BillingProjection, eventId: string = randomUUID(), nonce: string = randomUUID(), eventType = "subscription.reconciled", service = billingService()) {
  const r = await service.rpc("apply_saas_billing_projection", { p_projection: projection, p_event_id: eventId, p_nonce: nonce, p_event_type: eventType });
  if (r.error) throw new BillingError(r.error.code === "23505" ? "billing_replay" : "billing_apply_failed", r.error.code === "23505" ? 409 : 503);
  return r.data === true;
}
export async function refreshBillingIdentity(userId: string) {
  const value = await centralRequest("/api/billing/v1/read", { external_tenant_id: userId, limit: 1, include_catalog: false });
  if (!Array.isArray(value.subscriptions) || value.subscriptions.length > 1) throw new BillingError("billing_invalid_response");
  for (const raw of value.subscriptions) {
    const p = parseProjection(raw); if (p.external_tenant_id !== userId) throw new BillingError("billing_identity_mismatch");
    await applyProjection(p);
  }
  return value.subscriptions.length;
}
export async function checkoutBillingIdentity(userId: string) {
  // No register, plan changes or pricing: the Master links a real contract in FinOps first.
  const p = await localProjection(userId);
  if (!p || p.registration_pending || !p.contract_id) throw new BillingError("billing_contract_not_linked", 409);
  const value = await centralRequest("/api/billing/v1/command", { command_id: randomUUID(), action: "checkout", external_tenant_id: userId, actor_id: userId, data: {} });
  const projection = parseProjection(value.subscription);
  if (projection.external_tenant_id !== userId || projection.billing_subscription_id !== p.billing_subscription_id) throw new BillingError("billing_identity_mismatch");
  await applyProjection(projection);
  const url = (value.subscription as Record<string, unknown>).checkout_url;
  if (typeof url !== "string") throw new BillingError("billing_no_open_charge", 409);
  const target = new URL(url);
  if (target.origin !== centralOrigin() || target.username || target.password || target.pathname !== "/pagamento/cobranca") throw new BillingError("billing_checkout_invalid");
  return target.toString();
}
export type BillingSyncClaim = { token: string; cursor: string | null };
export async function claimBillingSync(nonce: string): Promise<BillingSyncClaim | null> {
  const service = billingService(), token = randomUUID();
  const claimed = await service.rpc("claim_saas_billing_sync", { p_nonce: nonce, p_token: token });
  if (claimed.error) throw new BillingError(claimed.error.code === "23505" ? "billing_replay" : "billing_sync_unavailable", claimed.error.code === "23505" ? 409 : 503);
  if (!claimed.data?.claimed) return null;
  const cursor = claimed.data.cursor ?? null;
  if (cursor !== null && (typeof cursor !== "string" || !UUID.test(cursor))) throw new BillingError("billing_sync_checkpoint_invalid");
  return { token, cursor };
}
export async function reconcileBilling(claim: BillingSyncClaim, limit = 20) {
  const service = billingService(), { token } = claim;
  let cursor = claim.cursor;
  try {
    const value = await centralRequest("/api/billing/v1/read", { cursor, limit, include_catalog: false }, 5000);
    if (!Array.isArray(value.subscriptions) || value.subscriptions.length > limit || !(value.next_cursor === null || (typeof value.next_cursor === "string" && UUID.test(value.next_cursor)))) throw new BillingError("billing_invalid_response");
    for (const raw of value.subscriptions) await applyProjection(parseProjection(raw), randomUUID(), randomUUID(), "subscription.reconciled", service);
    cursor = value.next_cursor as string | null;
    const finish = await service.rpc("finish_saas_billing_sync", { p_token: token, p_cursor: cursor, p_error: null });
    if (finish.error) throw new BillingError("billing_sync_checkpoint_failed");
    return { accepted: true, synced: true, busy: false, count: value.subscriptions.length, has_more: cursor !== null };
  } catch (e) {
    await service.rpc("finish_saas_billing_sync", { p_token: token, p_cursor: claim.cursor, p_error: e instanceof BillingError ? e.code : "billing_sync_failed" });
    throw e instanceof BillingError ? e : new BillingError("billing_sync_failed");
  }
}
