import { NextRequest } from "next/server";
import { handleTestnetCron } from "@/lib/execution/testnet-cron-server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";
export const preferredRegion = "gru1";
export const maxDuration = 60;

/** Bounded serverless poll: no claim of real-time websocket delivery. */
export async function GET(request: NextRequest) {
  return handleTestnetCron(request, "REACTOR");
}
