import { NextRequest } from "next/server";
import { handleLiveCron } from "@/lib/execution/live-cron-server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";
export const preferredRegion = "gru1";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  return handleLiveCron(request, "MONITOR");
}
