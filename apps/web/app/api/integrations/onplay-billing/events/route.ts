import { NextResponse } from "next/server";
import { BILLING_PRODUCT, BillingError, UUID, parseProjection } from "@/lib/saas-billing/contract";
import { readBillingBody, verifyBillingRequest } from "@/lib/saas-billing/signature";
import { applyProjection } from "@/lib/saas-billing/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const raw = await readBillingBody(request), nonce = verifyBillingRequest(request, raw), value = JSON.parse(raw);
    if (value.product_key !== BILLING_PRODUCT || !UUID.test(value.event_id ?? "")
      || typeof value.event_type !== "string" || value.event_type.length < 3 || value.event_type.length > 80
      || !Number.isFinite(Date.parse(value.occurred_at))) throw new BillingError("billing_invalid_event", 400);
    const applied = await applyProjection(parseProjection(value.subscription), value.event_id, nonce, value.event_type);
    return NextResponse.json({ ok: true, applied }, { headers: { "cache-control": "no-store" } });
  } catch (e) { return NextResponse.json({ ok: false, error: e instanceof BillingError ? e.code : "billing_event_failed" }, { status: e instanceof BillingError ? e.status : 503 }); }
}
