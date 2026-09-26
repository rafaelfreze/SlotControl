import { NextRequest, NextResponse } from "next/server";
import { dispatchOperationalPush } from "@/lib/coinops-notifications/push-server";
import { dispatchCapacityPush } from "@/lib/coinops-capacity/capacity-push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "gru1";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  try {
    const [operations, capacity] = await Promise.allSettled([
      dispatchOperationalPush(), dispatchCapacityPush(),
    ]);
    if (operations.status === "rejected" || capacity.status === "rejected")
      throw new Error("COINOPS_PUSH_DISPATCH_FAILED");
    return NextResponse.json({ operations: operations.value, capacity: capacity.value },
      { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && /^COINOPS_PUSH_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_PUSH_DISPATCH_FAILED";
    console.error(JSON.stringify({ event: "COINOPS_PUSH_CRON", code }));
    return NextResponse.json({ error: code }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
