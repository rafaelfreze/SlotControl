import { NextResponse } from "next/server";

import { requestExecutorDryRun } from "@/lib/execution/live-executor-client";
import { resolveOperatorEngine } from "@/lib/execution/operator-context-server";
import type { LiveConfig } from "@/lib/execution/live-preparation";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Only authenticated scope/configuration creates this no-write intent. */
export async function POST(request: Request) {
  if (getSupabaseDataSchema() !== "coinops")
    return NextResponse.json({ error: "SCHEMA_SCOPE_INVALID" }, { status: 503 });
  const db = createClient(), user = (await db.auth.getUser()).data.user;
  if (!user) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  const tenantId = getCoinOpsServiceTenantId();
  if (!tenantId) return NextResponse.json({ error: "TENANT_SCOPE_REQUIRED" }, { status: 403 });
  const owner = await db.from("operators").select("product_id,tenant_id,user_id")
    .eq("tenant_id", tenantId).eq("user_id", user.id).eq("status", "ACTIVE").single();
  if (owner.error || !owner.data) return NextResponse.json({ error: "PRODUCT_SCOPE_REQUIRED" }, { status: 403 });
  try {
    const payload = await request.json().catch(() => ({})) as { exchange_account_id?: string; trading_engine_id?: string };
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || Object.keys(payload).some((key) => !["exchange_account_id", "trading_engine_id"].includes(key)))
      throw new Error("EXECUTOR_DIAGNOSTIC_SCOPE_INVALID");
    const explicit = payload.exchange_account_id !== undefined || payload.trading_engine_id !== undefined;
    const engines = explicit ? [await resolveOperatorEngine(db, owner.data,
      { environment: "REAL", exchange_account_id: payload.exchange_account_id,
        trading_engine_id: payload.trading_engine_id })] : await Promise.all((["BTC", "SOL"] as const).map((asset) =>
        resolveOperatorEngine(db, owner.data!, { environment: "REAL", asset })));
    const results = await Promise.all(engines.map(async (engine) => {
      const [preparation, profile, cap, portfolio] = await Promise.all([
        db.from("robot_v1_live_preparations").select("*").eq("trading_engine_id", engine.trading_engine_id).single(),
        db.from("robot_v1_ath_profiles").select("*").eq("trading_engine_id", engine.trading_engine_id).single(),
        db.from("account_quote_caps").select("hard_cap_quote").eq("exchange_account_id", engine.exchange_account_id)
          .eq("quote_asset", engine.quote_asset).single(),
        db.from("trading_engines").select("base_asset,hard_cap_quote").eq("exchange_account_id", engine.exchange_account_id)
          .eq("environment", "REAL").eq("quote_asset", engine.quote_asset),
      ]);
      if (preparation.error || profile.error || cap.error || portfolio.error
        || !preparation.data || !profile.data || !cap.data || !portfolio.data)
        throw new Error("EXECUTOR_CONFIG_UNAVAILABLE");
      const row = preparation.data, p = profile.data;
      const config: LiveConfig = { ...row, live_enabled: false,
        gain_rate: p.next_gain_rate ?? p.gain_rate,
        normal_spacing_rate: p.next_normal_spacing_rate ?? p.normal_spacing_rate,
        post_ath_spacing_rate: p.next_post_ath_spacing_rate ?? p.post_ath_spacing_rate, regime: p.regime };
      const caps = { BTC: Number(portfolio.data.find((item) => item.base_asset === "BTC")?.hard_cap_quote ?? 0),
        SOL: Number(portfolio.data.find((item) => item.base_asset === "SOL")?.hard_cap_quote ?? 0) };
      return { exchange_account_id: engine.exchange_account_id, trading_engine_id: engine.trading_engine_id,
        quote_asset: engine.quote_asset, ...await requestExecutorDryRun(config, caps, Number(cap.data.hard_cap_quote), engine) };
    }));
    return NextResponse.json({ gate: "NO_WRITE", results }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && /^(?:EXECUTOR|COINOPS)_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "EXECUTOR_DIAGNOSTIC_UNAVAILABLE";
    return NextResponse.json({ error: code }, { status: 503 });
  }
}
