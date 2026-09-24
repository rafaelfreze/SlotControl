import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getSupabaseDataSchema } from "@/lib/supabase/env";
import { readLiveExecutorState } from "@/lib/execution/live-executor-transport";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });

/** No account or engine parameter is accepted. Only the stored viewer binding selects the executor scope. */
export async function GET() {
  try {
    if (getSupabaseDataSchema() !== "coinops") throw new Error("VIEWER_SCHEMA_DENIED");
    const user = (await createClient().auth.getUser()).data.user;
    if (!user || user.app_metadata?.coinops_role !== "VIEWER") return json({ error: "VIEWER_DENIED" }, 403);
    const service = createServiceRoleClient();
    const binding = await service.from("viewer_access").select("operator_id,exchange_account_id,status")
      .eq("user_id", user.id).maybeSingle();
    if (binding.error || !binding.data || binding.data.status !== "ACTIVE") return json({ error: "VIEWER_DENIED" }, 403);
    const { operator_id: operatorId, exchange_account_id: accountId } = binding.data;
    const account = await service.from("exchange_accounts").select("status")
      .eq("operator_id", operatorId).eq("id", accountId).single();
    if (account.error || !account.data || account.data.status !== "ACTIVE")
      return json({ error: "VIEWER_ACCOUNT_INACTIVE" }, 409);
    const engines = await service.from("trading_engines")
      .select("id,symbol,quote_asset,status")
      .eq("operator_id", operatorId).eq("exchange_account_id", accountId).eq("environment", "REAL")
      .eq("status", "ACTIVE").limit(8);
    if (engines.error) throw new Error("VIEWER_ENGINE_UNAVAILABLE");
    if (!engines.data?.length) return json({ balances: [], markets: [], observedAt: null });
    const observations = await Promise.allSettled(engines.data.map((engine) => readLiveExecutorState({
      operator_id: operatorId, exchange_account_id: accountId, trading_engine_id: engine.id,
      symbol: engine.symbol, quote_asset: engine.quote_asset,
    })));
    const valid = observations.flatMap((row) => row.status === "fulfilled" ? [row.value] : []);
    if (!valid.length) return json({ error: "VIEWER_BINANCE_UNAVAILABLE" }, 503);
    const balances = valid[0].balances.filter((row) => row.free > 0 || row.locked > 0)
      .map((row) => ({ asset: row.asset, free: row.free, locked: row.locked, total: row.total }));
    return json({ balances, markets: valid.map((row) => ({ symbol: row.symbol,
      price: row.price.price, observedAt: row.price.observedAt })), observedAt: valid[0].observed_at });
  } catch { return json({ error: "VIEWER_BINANCE_UNAVAILABLE" }, 503); }
}
