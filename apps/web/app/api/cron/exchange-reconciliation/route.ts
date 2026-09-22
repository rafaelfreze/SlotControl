import { NextResponse } from "next/server";

import { runConfiguredBinanceReadOnlyReconciliation } from "@/lib/execution/binance-reconciliation-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runConfiguredBinanceReadOnlyReconciliation();
    return NextResponse.json({ ok: result.status !== "FAILED", status: result.status, processed: result.processed });
  } catch (error) {
    console.error("[exchange-reconciliation-cron] failed", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return NextResponse.json({ ok: false, error: "Exchange reconciliation failed" }, { status: 500 });
  }
}