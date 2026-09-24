import { NextResponse } from "next/server";

import { requestExecutorDryRun } from "@/lib/execution/live-executor-client";
import type { LiveConfig } from "@/lib/execution/live-preparation";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Authenticated, scoped no-write diagnostic. The browser never provides an intent or a cap. */
export async function POST() {
  if (getSupabaseDataSchema() !== "coinops")
    return NextResponse.json({ error: "SCHEMA_SCOPE_INVALID" }, { status: 503 });
  const db = createClient();
  const user = (await db.auth.getUser()).data.user;
  if (!user) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  const tenantId = getCoinOpsServiceTenantId();
  if (!tenantId) return NextResponse.json({ error: "TENANT_SCOPE_REQUIRED" }, { status: 403 });
  const { data: scope, error: scopeError } = await db.from("strategies").select("product_id")
    .eq("tenant_id", tenantId).eq("user_id", user.id).limit(1).maybeSingle();
  if (scopeError || !scope) return NextResponse.json({ error: "PRODUCT_SCOPE_REQUIRED" }, { status: 403 });
  const [preparations, profiles, global] = await Promise.all([
    db.from("robot_v1_live_preparations")
      .select("asset,symbol,slot_count,monthly_target,configured_live_capital_brl,max_order_notional_brl,max_total_exposure_brl,config_version,live_enabled,updated_at")
      .eq("product_id", scope.product_id).eq("tenant_id", tenantId).eq("user_id", user.id),
    db.from("robot_v1_ath_profiles")
      .select("asset,environment,gain_rate,normal_spacing_rate,post_ath_spacing_rate,next_gain_rate,next_normal_spacing_rate,next_post_ath_spacing_rate,regime")
      .eq("product_id", scope.product_id).eq("tenant_id", tenantId).eq("user_id", user.id)
      .eq("environment", "REAL"),
    db.from("robot_v1_live_global_caps").select("max_total_live_exposure_brl")
      .eq("product_id", scope.product_id).eq("tenant_id", tenantId).eq("user_id", user.id).maybeSingle(),
  ]);
  if (preparations.error || profiles.error || global.error || !global.data)
    return NextResponse.json({ error: "EXECUTOR_CONFIG_UNAVAILABLE" }, { status: 503 });
  const globalCapBrl = Number(global.data.max_total_live_exposure_brl);
  const configs = (["BTC", "SOL"] as const).map((asset) => {
    const row = preparations.data?.find((item) => item.asset === asset);
    const profile = profiles.data?.find((item) => item.asset === asset);
    if (!row || !profile || row.live_enabled !== false) return null;
    return { ...row, asset, symbol: row.symbol as LiveConfig["symbol"], live_enabled: false as const,
      gain_rate: profile.next_gain_rate ?? profile.gain_rate,
      normal_spacing_rate: profile.next_normal_spacing_rate ?? profile.normal_spacing_rate,
      post_ath_spacing_rate: profile.next_post_ath_spacing_rate ?? profile.post_ath_spacing_rate,
      regime: profile.regime as LiveConfig["regime"] } satisfies LiveConfig;
  });
  if (configs.some((item) => !item))
    return NextResponse.json({ error: "EXECUTOR_CONFIG_UNSAFE" }, { status: 503 });
  const [btc, sol] = configs as [LiveConfig, LiveConfig];
  const caps = { BTC: Number(btc.max_total_exposure_brl), SOL: Number(sol.max_total_exposure_brl) };
  try {
    const results = await Promise.all([btc, sol].map((config) => requestExecutorDryRun(
      config, caps, globalCapBrl)));
    return NextResponse.json({ gate: "NO_WRITE", results }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && /^EXECUTOR_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "EXECUTOR_DIAGNOSTIC_UNAVAILABLE";
    return NextResponse.json({ error: code }, { status: 503 });
  }
}
