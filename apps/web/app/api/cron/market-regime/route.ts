import { NextResponse } from "next/server";

import { refreshBtcMarketRegime } from "@/lib/slotgain/market-regime-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const state = await refreshBtcMarketRegime();
    console.log("[market-regime-cron] refreshed", {
      source: state.source,
      effectiveMode: state.effective_mode,
      changedUsers: state.changedUsers
    });
    return NextResponse.json({ ok: true, state });
  } catch (error) {
    console.error("[market-regime-cron] failed", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return NextResponse.json({ ok: false, error: "Market regime refresh failed" }, { status: 500 });
  }
}
