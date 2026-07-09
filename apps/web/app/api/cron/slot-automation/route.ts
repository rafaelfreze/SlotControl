import { NextResponse } from "next/server";

import { runSlotAutomationCron } from "@/lib/slotgain/automation-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");

  if (!cronSecret || authorization !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  console.log("[slot-automation-cron] inicio");

  try {
    const stats = await runSlotAutomationCron();

    console.log("[slot-automation-cron] resumo", {
      activeUsers: stats.activeUsers,
      checkedSlots: stats.checkedSlots,
      btcPrice: stats.prices.BTC,
      solPrice: stats.prices.SOL,
      entriesExecuted: stats.entriesExecuted,
      gainsExecuted: stats.gainsExecuted,
      ignoredSlots: stats.ignoredSlots,
      errors: stats.errors.length
    });

    return NextResponse.json({ ok: true, stats });
  } catch (error) {
    console.error("[slot-automation-cron] erro", error instanceof Error ? error.message : "Erro desconhecido");
    return NextResponse.json({ ok: false, error: "Cron execution failed" }, { status: 500 });
  }
}
