import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPremiumMarketCandles } from "@/app/automacao/premium-market";
import { getDailyMarketCandles } from "@/lib/execution/market-daily-candles";

export const dynamic = "force-dynamic";
export const preferredRegion = "gru1";

/** Secondary reference charts. No trading, ledger or private Binance calls. */
export async function GET() {
  const started = performance.now();
  const user = (await createClient().auth.getUser()).data.user;
  if (!user) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  const groups = await Promise.all([
    ...(["BTCBRL", "SOLBRL", "BTCUSDT", "SOLUSDT"] as const).map(getPremiumMarketCandles),
    ...(["BTCUSDC", "SOLUSDC"] as const).map((symbol) => getDailyMarketCandles(symbol).catch(() => [])),
  ]);
  return NextResponse.json({ candles: groups.flat(), referenceOnly: true }, {
    headers: { "Cache-Control": "private, no-store", "Server-Timing": `charts;dur=${(performance.now() - started).toFixed(1)}` },
  });
}
