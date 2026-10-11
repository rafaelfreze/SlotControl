import { NextResponse } from "next/server";
import { BillingError } from "@/lib/saas-billing/contract";
import { currentBillingIdentity, refreshBillingIdentity, checkoutBillingIdentity } from "@/lib/saas-billing/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") !== new URL(request.url).origin || request.headers.get("x-coinops-billing-intent") !== "owner"
      || !request.headers.get("content-type")?.startsWith("application/json")) throw new BillingError("billing_request_denied", 403);
    const raw = await request.text(); if (Buffer.byteLength(raw) > 2048) throw new BillingError("billing_invalid_query", 400);
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Object.keys(v).length !== 1 || !["sync", "checkout"].includes(v.operation)) throw new BillingError("billing_invalid_query", 400);
    const { user } = await currentBillingIdentity();
    const result = v.operation === "checkout" ? { url: await checkoutBillingIdentity(user.id) } : { updated: await refreshBillingIdentity(user.id) };
    return NextResponse.json({ ok: true, ...result }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (e) { return NextResponse.json({ ok: false, error: e instanceof BillingError ? e.code : "billing_unavailable" }, { status: e instanceof BillingError ? e.status : 503, headers: { "cache-control": "no-store" } }); }
}
