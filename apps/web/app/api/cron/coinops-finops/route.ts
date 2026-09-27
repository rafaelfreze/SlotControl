import { NextRequest, NextResponse } from "next/server";
import { syncAllFinops } from "@/lib/coinops-finops/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "gru1";
export const maxDuration = 300;
export async function GET(request: NextRequest) {
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401, headers });
  try { return NextResponse.json(await syncAllFinops(), { headers }); }
  catch { return NextResponse.json({ error: "COINOPS_FINOPS_SYNC_FAILED" }, { status: 503, headers }); }
}
