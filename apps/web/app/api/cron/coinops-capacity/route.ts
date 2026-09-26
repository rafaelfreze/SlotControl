import { NextRequest, NextResponse } from "next/server";

import { refreshExecutorCapacity } from "@/lib/coinops-capacity/capacity-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "gru1";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  try {
    return NextResponse.json(await refreshExecutorCapacity(),
      { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && /^COINOPS_CAPACITY_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_CAPACITY_REFRESH_FAILED";
    console.error(JSON.stringify({ event: "COINOPS_CAPACITY_CRON", code }));
    return NextResponse.json({ error: code }, { status: 503,
      headers: { "cache-control": "no-store" } });
  }
}
