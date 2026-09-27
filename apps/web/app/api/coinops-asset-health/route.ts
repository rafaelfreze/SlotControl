import { NextRequest, NextResponse } from "next/server";
import { requireAssetHealthAccess } from "@/lib/coinops-asset-health/access";
import { historyDays } from "@/lib/coinops-asset-health/collector-policy";
import { loadAssetHealthDashboard, syncAssetHealth } from "@/lib/coinops-asset-health/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "gru1";
export const maxDuration = 120;
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
function failure(error: unknown) {
  const code = error instanceof Error ? error.message : "COINOPS_ASSET_HEALTH_UNAVAILABLE";
  return NextResponse.json({ error: /^(?:COINOPS_ASSET_HEALTH_[A-Z0-9_]+|AUTH_REQUIRED|ADMIN_REQUIRED|ACCESS_DENIED)$/.test(code)
    ? code : "COINOPS_ASSET_HEALTH_UNAVAILABLE" },
  { status: code === "AUTH_REQUIRED" ? 401 : ["ADMIN_REQUIRED", "ACCESS_DENIED"].includes(code) ? 403 : 503, headers });
}
export async function GET(request: NextRequest) {
  try {
    await requireAssetHealthAccess();
    return NextResponse.json(await loadAssetHealthDashboard(historyDays(request.nextUrl.searchParams.get("days"))), { headers });
  } catch (error) { return failure(error); }
}
/** Safe bootstrap/refresh for ADMIN; accepts no client scope, force flag or provider URL. */
export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin || request.headers.get("sec-fetch-site") === "cross-site")
    return NextResponse.json({ error: "ACCESS_DENIED" }, { status: 403, headers });
  try {
    await requireAssetHealthAccess(true);
    return NextResponse.json(await syncAssetHealth(), { headers });
  } catch (error) { return failure(error); }
}
