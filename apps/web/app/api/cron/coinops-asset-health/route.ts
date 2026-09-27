import { NextRequest, NextResponse } from "next/server";
import { syncAssetHealth } from "@/lib/coinops-asset-health/server";
import { dispatchAssetHealthPush } from "@/lib/coinops-asset-health/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "gru1";
export const maxDuration = 120;
export async function GET(request: NextRequest) {
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401, headers });
  try {
    const collection = await syncAssetHealth();
    const delivery = await dispatchAssetHealthPush().catch(() => ({ status: "DELIVERY_FAILED" }));
    return NextResponse.json({ ...collection, delivery }, { headers });
  } catch {
    return NextResponse.json({ error: "COINOPS_ASSET_HEALTH_SYNC_FAILED" }, { status: 503, headers });
  }
}
