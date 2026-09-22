import { NextResponse } from "next/server";

import { runConfiguredBinanceReadOnlyReconciliation } from "@/lib/execution/binance-reconciliation-server";
import { runConfiguredRobotV1Shadow } from "@/lib/execution/robot-v1-shadow-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
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
