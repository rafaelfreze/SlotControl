import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { BillingError } from "@/lib/saas-billing/contract";
import { readBillingBody, verifyBillingRequest } from "@/lib/saas-billing/signature";
import { claimBillingSync, reconcileBilling } from "@/lib/saas-billing/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    const raw = await readBillingBody(request), nonce = verifyBillingRequest(request, raw), value = JSON.parse(raw);
    const limit = value?.limit ?? 20;
    if (!value || typeof value !== "object" || Array.isArray(value) || !Number.isInteger(limit) || limit < 1 || limit > 20 || Object.keys(value).some(k => k !== "limit")) throw new BillingError("billing_invalid_query", 400);
    const claim = await claimBillingSync(nonce);
    if (claim) waitUntil(reconcileBilling(claim, limit).catch(() => {
      // The durable checkpoint records the sanitized failure; the next scheduled recovery retries it.
    }));
    return NextResponse.json({ ok: true, accepted: true, synced: false, busy: !claim }, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (e) { return NextResponse.json({ ok: false, error: e instanceof BillingError ? e.code : "billing_sync_failed" }, { status: e instanceof BillingError ? e.status : 503 }); }
}
