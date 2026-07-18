import { NextResponse } from "next/server";

import { processPendingPushNotifications } from "@/lib/push/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const stats = await processPendingPushNotifications();
    return NextResponse.json({ ok: true, stats });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("[push-worker] cron_failed", { message });
    return NextResponse.json({ ok: false, error: "Push worker failed" }, { status: 500 });
  }
}
