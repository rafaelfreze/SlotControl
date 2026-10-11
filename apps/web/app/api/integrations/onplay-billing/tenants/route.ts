import { NextResponse } from "next/server";
import { BillingError, UUID } from "@/lib/saas-billing/contract";
import { readBillingBody, verifyBillingRequest } from "@/lib/saas-billing/signature";
import { billingService } from "@/lib/saas-billing/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const raw = await readBillingBody(request), nonce = verifyBillingRequest(request, raw), v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v) || (v.cursor !== undefined && v.cursor !== null && !UUID.test(v.cursor))
      || (v.user_id !== undefined && !UUID.test(v.user_id)) || Object.keys(v).some(k => !["cursor", "search", "limit", "user_id"].includes(k))
      || (v.search !== undefined && (typeof v.search !== "string" || v.search.length > 160))
      || (v.limit !== undefined && (!Number.isInteger(v.limit) || v.limit < 1 || v.limit > 100))) throw new BillingError("billing_invalid_query", 400);
    const service = billingService();
    const consumed = await service.rpc("claim_saas_billing_nonce", { p_nonce: nonce });
    if (consumed.error) throw new BillingError(consumed.error.code === "23505" ? "billing_replay" : "billing_discovery_unavailable", consumed.error.code === "23505" ? 409 : 503);
    const result = await service.rpc("billing_discover_identities", { p_cursor: v.cursor ?? null, p_search: v.search ?? "", p_limit: v.limit ?? 50, p_user: v.user_id ?? null });
    if (result.error) throw new BillingError("billing_discovery_unavailable");
    return NextResponse.json(result.data, { headers: { "cache-control": "no-store" } });
  } catch (e) { return NextResponse.json({ ok: false, error: e instanceof BillingError ? e.code : "billing_discovery_failed" }, { status: e instanceof BillingError ? e.status : 503 }); }
}
