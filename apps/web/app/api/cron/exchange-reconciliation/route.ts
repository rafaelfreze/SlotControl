import { NextResponse } from "next/server";

import { runConfiguredBinanceReadOnlyReconciliation } from "@/lib/execution/binance-reconciliation-server";
import { runConfiguredRobotV1Shadow } from "@/lib/execution/robot-v1-shadow-server";
import { hasActiveNonRealEngine } from "@/lib/execution/nonreal-cron-gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Reconciliation precedes the two independent Shadow ladders. Reserve enough
// time for both READ-ONLY Binance scans so one asset cannot be skipped after
// the first finishes its health check.
export const maxDuration = 60;

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    if (!await hasActiveNonRealEngine("SHADOW"))
      return NextResponse.json({ ok: true, status: "PAUSED", processed: 0 });
    const reconciliation = await runConfiguredBinanceReadOnlyReconciliation();
    const robotV1 = await runConfiguredRobotV1Shadow();
    return NextResponse.json({
      ok: reconciliation.status !== "FAILED",
      status: reconciliation.status,
      processed: reconciliation.processed,
      robotV1
    });
  } catch (error) {
    console.error("[exchange-reconciliation-cron] failed", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return NextResponse.json({ ok: false, error: "Exchange reconciliation failed" }, { status: 500 });
  }
}
