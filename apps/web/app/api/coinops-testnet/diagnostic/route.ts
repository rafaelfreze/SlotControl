import { NextResponse } from "next/server";

import { diagnoseBinanceSpotTestnet } from "@/lib/execution/binance-spot-testnet-adapter";
import { getCoinOpsServiceTenantId } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "gru1";

export async function GET() {
  try {
    const authenticated = createClient();
    const { data: { user } } = await authenticated.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: "UNAUTHENTICATED" }, { status: 401 });
    const tenantId = getCoinOpsServiceTenantId();
    const service = createServiceRoleClient();
    const { data: scope, error: scopeError } = await service.from("strategies").select("product_id").eq("tenant_id", tenantId).eq("user_id", user.id).limit(1).maybeSingle();
    if (scopeError || !scope) return NextResponse.json({ ok: false, error: "SCOPE_UNAVAILABLE" }, { status: 403 });

    return NextResponse.json({ ok: true, environment: "BINANCE_SPOT_TESTNET", ...await diagnoseBinanceSpotTestnet() }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && /^COINOPS_TESTNET_[A-Z_]+$/.test(error.message) ? error.message : "TESTNET_DIAGNOSTIC_FAILED";
    return NextResponse.json({ ok: false, error: code }, { status: 502 });
  }
}
