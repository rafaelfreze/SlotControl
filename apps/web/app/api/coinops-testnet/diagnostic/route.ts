import { NextResponse } from "next/server";

import { BinanceSpotTestnetAdapter } from "@/lib/execution/binance-spot-testnet-adapter";
import { getCoinOpsServiceTenantId } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const authenticated = createClient();
    const { data: { user } } = await authenticated.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: "UNAUTHENTICATED" }, { status: 401 });
    const tenantId = getCoinOpsServiceTenantId();
    const service = createServiceRoleClient();
    const { data: scope, error: scopeError } = await service.from("strategies").select("product_id").eq("tenant_id", tenantId).eq("user_id", user.id).limit(1).maybeSingle();
    if (scopeError || !scope) return NextResponse.json({ ok: false, error: "SCOPE_UNAVAILABLE" }, { status: 403 });

    const adapter = BinanceSpotTestnetAdapter.readsFromEnvironment();
    const account = await adapter.getAccount();
    const balances = account.balances.filter((item) => ["USDT", "USDC", "BTC", "SOL"].includes(item.asset));
    const symbols = ["SOLUSDC", "BTCUSDC", "SOLUSDT", "BTCUSDT"];
    const probes = await Promise.all(symbols.map(async (symbol) => {
      try {
        const [filters, market, orders] = await Promise.all([adapter.getSymbolInfo(symbol), adapter.getMarketPrice(symbol), adapter.getOpenOrders(symbol)]);
        return { symbol, available: true, filters, market, openOrderCount: orders.length, ownedOpenOrderCount: orders.filter((order) => order.clientOrderId?.startsWith("COV1-")).length };
      } catch (error) { return { symbol, available: false, error: error instanceof Error ? error.message : "UNKNOWN" }; }
    }));
    return NextResponse.json({ ok: true, environment: "BINANCE_SPOT_TESTNET", account: { canTrade: account.canTrade, canWithdraw: account.canWithdraw, canDeposit: account.canDeposit, updateTime: account.updateTime }, balances, probes, observedAt: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && /^COINOPS_TESTNET_[A-Z_]+$/.test(error.message) ? error.message : "TESTNET_DIAGNOSTIC_FAILED";
    return NextResponse.json({ ok: false, error: code }, { status: 502 });
  }
}
