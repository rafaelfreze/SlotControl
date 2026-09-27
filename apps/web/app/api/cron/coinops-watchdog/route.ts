import { NextRequest, NextResponse } from "next/server";
import { runServerWatchdog } from "@/lib/coinops-watchdog/watchdog-server";
import { monitorAssetHealthCollector } from "@/lib/coinops-asset-health/collector-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "gru1";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET
    || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  try {
    const result = await runServerWatchdog();
    // Informational collector supervision is isolated from engine health/recovery.
    const assetHealthCollector = await monitorAssetHealthCollector()
      .catch(() => ({ status: "UNAVAILABLE", code: "ASSET_COLLECTOR_UNAVAILABLE" }));
    return NextResponse.json({ ...result, assetHealthCollector },
      { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_WATCHDOG_FAILED";
    console.error(JSON.stringify({ event: "COINOPS_WATCHDOG_CRON", code }));
    return NextResponse.json({ error: code }, { status: 503,
      headers: { "cache-control": "no-store" } });
  }
}
