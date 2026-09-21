import "server-only";

import { createServiceRoleClient } from "@/lib/supabase/service-role";

import { buildShadowIntent, type ShadowIntent, type ShadowIntentStore, shouldCreateShadowEntryIntent } from "./shadow-engine";

type ExecutionEngineSettingRow = {
  product_id: string;
  tenant_id: string;
  user_id: string;
  execution_mode: "SHADOW";
  global_kill_switch: boolean;
  max_order_notional_usdt: number | string;
  max_daily_notional_usdt: number | string;
  max_market_age_seconds: number;
};

type ExecutionAssetSettingRow = {
  product_id: string;
  tenant_id: string;
  user_id: string;
  asset: "BTC" | "SOL";
  automation_enabled: boolean;
  kill_switch: boolean;
  max_order_notional_usdt: number | string | null;
  max_daily_notional_usdt: number | string | null;
};

type ShadowSlotRow = {
  id: string;
  strategy_id: string;
  slot_number: number;
  status: string;
  operational_slot_value: number | string | null;
  preco_entrada: number | string | null;
  strategies: Array<{ asset: string | null }> | null;
};

type ActiveCycleRow = { id: string; product_id: string; tenant_id: string; user_id: string; mode: string };

export type ShadowMarketSnapshot = {
  BTC: { price: number; observedAt: string };
  SOL: { price: number; observedAt: string };
};

function settingsKey(row: Pick<ExecutionEngineSettingRow, "product_id" | "tenant_id" | "user_id">) {
  return `${row.product_id}:${row.tenant_id}:${row.user_id}`;
}

function toNumber(value: number | string | null | undefined) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function dayStartUtc(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())).toISOString();
}

function asAsset(value: string | null | undefined): "BTC" | "SOL" | null {
  const asset = value?.toUpperCase();
  return asset === "BTC" || asset === "SOL" ? asset : null;
}

/**
 * Bridge from existing entry triggers into the new execution boundary. It is
 * fail-closed: no settings row, global kill switch, per-asset kill switch, or
 * disabled automation means no intent is recorded. It never calls an exchange
 * adapter and cannot create/cancel an order.
 */
export async function syncEligibleShadowEntryIntents(market: ShadowMarketSnapshot, now = new Date()) {
  const supabase = createServiceRoleClient();
  const [{ data: engineRows, error: engineError }, { data: assetRows, error: assetError }, { data: cycleRows, error: cycleError }] = await Promise.all([
    supabase.from("execution_engine_settings").select("product_id,tenant_id,user_id,execution_mode,global_kill_switch,max_order_notional_usdt,max_daily_notional_usdt,max_market_age_seconds"),
    supabase.from("execution_asset_settings").select("product_id,tenant_id,user_id,asset,automation_enabled,kill_switch,max_order_notional_usdt,max_daily_notional_usdt"),
    supabase.from("operational_cycles").select("id,product_id,tenant_id,user_id,mode").eq("status", "ACTIVE")
  ]);
  if (engineError) throw engineError;
  if (assetError) throw assetError;
  if (cycleError) throw cycleError;

  const activeEngineRows = ((engineRows || []) as ExecutionEngineSettingRow[])
    .filter((row) => row.execution_mode === "SHADOW" && !row.global_kill_switch);
  if (!activeEngineRows.length) return { recorded: 0, skipped: "ENGINE_DISABLED" as const };

  const assetByScope = new Map(((assetRows || []) as ExecutionAssetSettingRow[]).map((row) => [`${settingsKey(row)}:${row.asset}`, row]));
  const cycleByScope = new Map(((cycleRows || []) as ActiveCycleRow[]).map((row) => [settingsKey(row), row]));
  let recorded = 0;

  for (const engine of activeEngineRows) {
    const scope = settingsKey(engine);
    const { data: slotRows, error: slotError } = await supabase
      .from("slots")
      .select("id,strategy_id,slot_number,status,operational_slot_value,preco_entrada,strategies(asset)")
      .eq("product_id", engine.product_id)
      .eq("tenant_id", engine.tenant_id)
      .eq("user_id", engine.user_id)
      .eq("status", "hold");
    if (slotError) throw slotError;

    const { data: dailyRows, error: dailyError } = await supabase
      .from("exchange_order_intents")
      .select("expected_notional_usdt")
      .eq("product_id", engine.product_id)
      .eq("tenant_id", engine.tenant_id)
      .eq("user_id", engine.user_id)
      .gte("created_at", dayStartUtc(now));
    if (dailyError) throw dailyError;
    let dailyNotional = ((dailyRows || []) as Array<{ expected_notional_usdt: number | string }>).reduce((total, row) => total + toNumber(row.expected_notional_usdt), 0);

    const store: ShadowIntentStore = {
      async upsert(intent: ShadowIntent) {
        const { data, error } = await supabase
          .from("exchange_order_intents")
          .upsert({
            product_id: intent.productId,
            tenant_id: intent.tenantId,
            user_id: intent.userId,
            strategy_id: intent.strategyId,
            slot_id: intent.slotId,
            cycle_id: intent.cycleId,
            asset: intent.asset,
            symbol: intent.symbol,
            side: intent.side,
            quantity: intent.quantity,
            expected_notional_usdt: intent.expectedNotionalUsdt,
            reference_price: intent.referencePrice,
            target_price: intent.targetPrice,
            observed_market_price: intent.observedMarketPrice,
            observed_at: intent.observedAt,
            strategy_reason: intent.strategyReason,
            strategy_regime: intent.strategyRegime,
            execution_mode: intent.executionMode,
            status: intent.status,
            idempotency_key: intent.idempotencyKey,
            execution_payload: { schema_version: 1, source: "MARKET_REGIME_SHADOW_BRIDGE" }
          }, { onConflict: "product_id,tenant_id,user_id,idempotency_key", ignoreDuplicates: true })
          .select("id")
          .maybeSingle();
        if (error) throw error;
        return { created: Boolean(data?.id), id: data?.id };
      }
    };

    for (const row of (slotRows || []) as ShadowSlotRow[]) {
      const asset = asAsset(row.strategies?.[0]?.asset);
      if (!asset) continue;
      const assetSettings = assetByScope.get(`${scope}:${asset}`);
      if (!assetSettings || !assetSettings.automation_enabled || assetSettings.kill_switch) continue;
      const snapshot = market[asset];
      const triggerPrice = toNumber(row.preco_entrada) || null;
      if (!shouldCreateShadowEntryIntent(row.status, snapshot.price, triggerPrice)) continue;
      if (triggerPrice === null) continue;
      const quantity = toNumber(row.operational_slot_value) / snapshot.price;
      if (!Number.isFinite(quantity) || quantity <= 0) continue;
      const intent = buildShadowIntent({
        productId: engine.product_id,
        tenantId: engine.tenant_id,
        userId: engine.user_id,
        strategyId: row.strategy_id,
        slotId: row.id,
        cycleId: cycleByScope.get(scope)?.id || null,
        asset,
        side: "BUY",
        quantity,
        referencePrice: triggerPrice,
        targetPrice: triggerPrice,
        observedMarketPrice: snapshot.price,
        observedAt: snapshot.observedAt,
        strategyReason: "ENTRY_TRIGGER_REACHED",
        strategyRegime: cycleByScope.get(scope)?.mode || null,
        executionMode: "SHADOW"
      }, {
        maxOrderNotionalUsdt: toNumber(assetSettings.max_order_notional_usdt) || toNumber(engine.max_order_notional_usdt),
        maxDailyNotionalUsdt: toNumber(assetSettings.max_daily_notional_usdt) || toNumber(engine.max_daily_notional_usdt),
        maxMarketAgeSeconds: engine.max_market_age_seconds,
        dailyNotionalUsdt: dailyNotional
      }, now);
      const result = await store.upsert(intent);
      if (result.created) {
        dailyNotional += intent.expectedNotionalUsdt;
        recorded += 1;
      }
    }
  }
  return { recorded, skipped: null };
}
