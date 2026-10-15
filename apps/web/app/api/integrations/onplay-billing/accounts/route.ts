import { receiveAccounts } from "@/lib/billing-provisioning/accounts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(request: Request) {
  try { return await receiveAccounts(request); } catch { return Response.json({ ok: false, error: "provisioning_unavailable" }, { status: 503, headers: { "cache-control": "private, no-store" } }); }
}
