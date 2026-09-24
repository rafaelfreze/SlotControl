"use server";

import { actionEngine, type ActionEngineIds } from "./engine-action-context";
import type { EngineContext } from "@/lib/execution/operator-context";

import { revalidatePath } from "next/cache";

import { FX_SOURCE, adjustmentCommittedNotional, previewManualAdjustment, validateFxQuote, type AdjustmentEnvironment,
  type AdjustmentKind, type AdjustmentSnapshot, type AdjustmentPreview, type FxQuote } from "@/lib/execution/manual-adjustments";
import { monthlyPeriodKey } from "@/lib/execution/monthly-slot-policy";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema, getSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

type Asset = "BTC" | "SOL";
export type AdjustmentDraft = ActionEngineIds & {
  environment: AdjustmentEnvironment;
  asset: Asset;
  slotNumber: number;
  kind: AdjustmentKind;
  gainUnits?: number;
  explicitGainAmountUsdc?: number;
  currency?: "USD" | "BRL";
  amount?: number;
  reason: string;
  note?: string;
  idempotencyKey: string;
};
export type AdjustmentPreviewResult = { engine: ActionEngineIds; snapshot: AdjustmentSnapshot; preview: AdjustmentPreview };

type Service = ReturnType<typeof createServiceRoleClient>;
type Scope = { productId: string; tenantId: string; userId: string; service: Service; engine?: EngineContext };
type AdjustmentRow = { id: string; environment: AdjustmentEnvironment; asset: Asset; slot_number: number;
  kind: AdjustmentKind | "REVERSAL"; gain_units: number; currency: "USD" | "BRL";
  original_amount: number | string; fx_rate: number | string | null; fx_source: string | null;
  fx_observed_at: string | null; converted_amount_usdc: number | string; reversal_of: string | null;
  balance_after_usdc: number | string; monthly_after: number; lifetime_after: number; reason: string; note: string | null };

async function scope(): Promise<Scope> {
  if (getSupabaseDataSchema() !== "coinops") throw new Error("COINOPS_ADJUSTMENT_SCHEMA_INVALID");
  if (new URL(getSupabaseEnv().supabaseUrl).hostname !== "otdfpmsegjxpqrzisfmi.supabase.co")
    throw new Error("COINOPS_ADJUSTMENT_PROJECT_INVALID");
  const tenantId = getCoinOpsServiceTenantId();
  if (!tenantId) throw new Error("COINOPS_ADJUSTMENT_TENANT_INVALID");
  const client = createClient();
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) throw new Error("COINOPS_ADJUSTMENT_AUTH_REQUIRED");
  const { data: strategy, error } = await client.from("strategies").select("product_id")
    .eq("tenant_id", tenantId).eq("user_id", user.id).limit(1).maybeSingle();
  if (error || !strategy) throw new Error("COINOPS_ADJUSTMENT_SCOPE_INVALID");
  return { productId: strategy.product_id, tenantId, userId: user.id, service: createServiceRoleClient() };
}

function validateDraft(draft: AdjustmentDraft) {
  // 5.1 prepares REAL in BRL; the 4.4 adjustment RPC is USDC-denominated.
  // It must not silently credit a BRL operation with an old USDC balance.
  if (draft.environment === "REAL") throw new Error("COINOPS_REAL_BRL_ADJUSTMENT_NOT_ENABLED");
  if (!["SHADOW", "TESTNET", "REAL"].includes(draft.environment) || !["BTC", "SOL"].includes(draft.asset)
    || !Number.isInteger(draft.slotNumber) || draft.slotNumber < 1 || draft.slotNumber > 25
    || !["MANUAL_TARGET_GAIN", "MANUAL_CONTRIBUTION"].includes(draft.kind)
    || !draft.reason?.trim() || draft.reason.trim().length < 3 || draft.reason.trim().length > 160
    || (draft.note?.length ?? 0) > 500
    || !/^[a-zA-Z0-9:-]{16,100}$/.test(draft.idempotencyKey)) throw new Error("COINOPS_ADJUSTMENT_INPUT_INVALID");
}

async function loadSnapshot(ctx: Scope, environment: AdjustmentEnvironment, asset: Asset,
  slotNumber: number): Promise<AdjustmentSnapshot> {
  const base = ctx.service;
  if (!ctx.engine || ctx.engine.environment !== environment || ctx.engine.base_asset !== asset || !["USDC", "USDT"].includes(ctx.engine.quote_asset)) throw new Error("COINOPS_ADJUSTMENT_ENGINE_SCOPE_INVALID");
  let balanceUsdc = 0, committedNotionalUsdc: number | null = null;
  let entryState = "PREPARED", gainRate = 0;
  if (environment === "SHADOW") {
    const { data: config, error: configError } = await base.from("robot_v1_configs")
      .select("id,gain_rate").eq("product_id", ctx.productId).eq("tenant_id", ctx.tenantId)
      .eq("user_id", ctx.userId).eq("asset", asset).eq("trading_engine_id", ctx.engine.trading_engine_id).eq("execution_mode", "SHADOW").single();
    if (configError || !config) throw new Error("COINOPS_ADJUSTMENT_CONFIG_MISSING");
    const { data: account, error: accountError } = await base.from("robot_v1_slot_accounts")
      .select("balance_usdc").eq("config_id", config.id).eq("product_id", ctx.productId)
      .eq("tenant_id", ctx.tenantId).eq("user_id", ctx.userId).eq("slot_number", slotNumber).single();
    if (accountError || !account) throw new Error("COINOPS_ADJUSTMENT_SLOT_MISSING");
    balanceUsdc = Number(account.balance_usdc); gainRate = Number(config.gain_rate);
    const { data: cycle, error: cycleError } = await base.from("robot_v1_cycles").select("id")
      .eq("config_id", config.id).in("status", ["STARTING", "GRID_ACTIVE", "POSITIONS_ACTIVE", "RESETTING"])
      .order("started_at", { ascending: false }).limit(1).maybeSingle();
    if (cycleError) throw new Error("COINOPS_ADJUSTMENT_POSITION_UNAVAILABLE");
    if (cycle) {
      const { data: slot, error: slotError } = await base.from("robot_v1_slots")
        .select("status,buy_price,executed_quantity").eq("cycle_id", cycle.id).eq("slot_number", slotNumber).maybeSingle();
      if (slotError || !slot) throw new Error("COINOPS_ADJUSTMENT_POSITION_UNAVAILABLE");
      if (slot) {
        entryState = slot.status;
        if (["OPEN", "TP_ACTIVE", "PARTIALLY_FILLED"].includes(slot.status) && Number(slot.executed_quantity) > 0)
          committedNotionalUsdc = Number(slot.buy_price) * Number(slot.executed_quantity);
      }
    }
  } else if (environment === "TESTNET") {
    const { data: run, error: runError } = await base.from("robot_v1_testnet_runs")
      .select("id,gain_rate").eq("product_id", ctx.productId).eq("tenant_id", ctx.tenantId)
      .eq("user_id", ctx.userId).eq("asset", asset).eq("trading_engine_id", ctx.engine.trading_engine_id).eq("status", "ACTIVE").single();
    if (runError || !run) throw new Error("COINOPS_ADJUSTMENT_RUN_MISSING");
    const { data: slot, error: slotError } = await base.from("robot_v1_testnet_slots")
      .select("id,entry_state,balance_usdc,operation_sequence").eq("run_id", run.id)
      .eq("product_id", ctx.productId).eq("tenant_id", ctx.tenantId)
      .eq("user_id", ctx.userId).eq("slot_number", slotNumber).single();
    if (slotError || !slot) throw new Error("COINOPS_ADJUSTMENT_SLOT_MISSING");
    balanceUsdc = Number(slot.balance_usdc); entryState = slot.entry_state; gainRate = Number(run.gain_rate);
    const { data: fills, error: fillsError } = await base.from("robot_v1_testnet_orders")
      .select("side,executed_quantity,fee_base,cumulative_quote").eq("run_id", run.id).eq("slot_id", slot.id)
      .eq("operation_sequence", slot.operation_sequence);
    if (fillsError || !fills) throw new Error("COINOPS_ADJUSTMENT_POSITION_UNAVAILABLE");
    committedNotionalUsdc = adjustmentCommittedNotional(fills);
  } else {
    const { data: profile, error: profileError } = await base.from("robot_v1_ath_profiles")
      .select("gain_rate").eq("product_id", ctx.productId).eq("tenant_id", ctx.tenantId)
      .eq("user_id", ctx.userId).eq("environment", "REAL").eq("asset", asset).single();
    if (profileError || !profile) throw new Error("COINOPS_ADJUSTMENT_REAL_PROFILE_MISSING");
    gainRate = Number(profile.gain_rate);
    const { data: account, error: accountError } = await base.from("robot_v1_real_prepared_slot_accounts")
      .select("balance_usdc").eq("product_id", ctx.productId).eq("tenant_id", ctx.tenantId)
      .eq("user_id", ctx.userId).eq("asset", asset).eq("slot_number", slotNumber).maybeSingle();
    if (accountError) throw new Error("COINOPS_ADJUSTMENT_REAL_ACCOUNT_UNAVAILABLE");
    balanceUsdc = Number(account?.balance_usdc ?? 0);
  }
  const { data: total, error: totalError } = await base.from("robot_v1_slot_gain_totals")
    .select("lifetime_gain_count,monthly_gain_count")
    .eq("product_id", ctx.productId).eq("tenant_id", ctx.tenantId).eq("user_id", ctx.userId)
    .eq("environment", environment).eq("asset", asset).eq("trading_engine_id", ctx.engine.trading_engine_id).eq("slot_number", slotNumber).maybeSingle();
  if (totalError) throw new Error("COINOPS_ADJUSTMENT_GAIN_LEDGER_UNAVAILABLE");
  return { environment, asset, quoteAsset: ctx.engine.quote_asset as "USDC" | "USDT", physicalSlotNumber: slotNumber, balanceUsdc,
    committedNotionalUsdc, entryState, monthlyGainCount: Number(total?.monthly_gain_count ?? 0),
    lifetimeGainCount: Number(total?.lifetime_gain_count ?? 0), gainRate };
}

/** Public, read-only market data. A blank/stale ask fails closed. */
export async function getManualAdjustmentFxQuote(quoteAsset: "USDC" | "USDT" = "USDC"): Promise<FxQuote> {
  await scope();
  if (quoteAsset !== "USDC" && quoteAsset !== "USDT") throw new Error("COINOPS_ADJUSTMENT_QUOTE_INVALID");
  const response = await fetch(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${quoteAsset}BRL`,
    { cache: "no-store", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("COINOPS_ADJUSTMENT_FX_UNAVAILABLE");
  const ticker = await response.json() as { symbol?: string; askPrice?: string; closeTime?: number };
  if (ticker.symbol !== `${quoteAsset}BRL` || !Number.isFinite(Number(ticker.closeTime)))
    throw new Error("COINOPS_ADJUSTMENT_FX_UNAVAILABLE");
  return validateFxQuote({ source: quoteAsset === "USDC" ? FX_SOURCE : "BINANCE_SPOT_USDTBRL_ASK", quoteAsset, rateBrlPerUsdc: Number(ticker.askPrice), rateBrlPerQuote: Number(ticker.askPrice),
    observedAt: new Date(Number(ticker.closeTime)).toISOString() }, Date.now(), quoteAsset);
}

async function buildPreview(ctx: Scope, draft: AdjustmentDraft) {
  ctx.engine = await actionEngine(draft, draft.environment, draft.asset, { product_id: ctx.productId, tenant_id: ctx.tenantId, user_id: ctx.userId });
  const snapshot = await loadSnapshot(ctx, draft.environment, draft.asset, draft.slotNumber);
  const fx = draft.kind === "MANUAL_CONTRIBUTION" && draft.currency === "BRL"
    ? await getManualAdjustmentFxQuote(ctx.engine.quote_asset as "USDC" | "USDT") : null;
  return { engine: { exchange_account_id: ctx.engine.exchange_account_id, trading_engine_id: ctx.engine.trading_engine_id }, snapshot, preview: previewManualAdjustment(snapshot, draft, fx) };
}

export async function previewCoinOpsManualAdjustment(draft: AdjustmentDraft): Promise<AdjustmentPreviewResult> {
  validateDraft(draft);
  const ctx = await scope();
  return buildPreview(ctx, draft);
}

async function existingAdjustment(ctx: Scope, key: string) {
  const { data, error } = await ctx.service.from("robot_v1_manual_adjustments")
    .select("id,environment,asset,slot_number,kind,gain_units,currency,original_amount,fx_rate,fx_source,fx_observed_at,converted_amount_usdc,reversal_of,balance_after_usdc,monthly_after,lifetime_after,reason,note")
    .eq("product_id", ctx.productId).eq("tenant_id", ctx.tenantId).eq("user_id", ctx.userId)
    .eq("idempotency_key", key).eq("trading_engine_id", ctx.engine!.trading_engine_id).maybeSingle();
  if (error) throw new Error("COINOPS_ADJUSTMENT_LEDGER_UNAVAILABLE");
  return data as AdjustmentRow | null;
}

export async function confirmCoinOpsManualAdjustment(draft: AdjustmentDraft,
  expected: AdjustmentPreviewResult): Promise<{ id: string; balanceAfterUsdc: number }> {
  validateDraft(draft);
  const ctx = await scope();
  ctx.engine = await actionEngine(draft, draft.environment, draft.asset, { product_id: ctx.productId, tenant_id: ctx.tenantId, user_id: ctx.userId });
  if (!expected.engine || expected.engine.exchange_account_id !== ctx.engine.exchange_account_id || expected.engine.trading_engine_id !== ctx.engine.trading_engine_id) throw new Error("COINOPS_ADJUSTMENT_PREVIEW_SCOPE_CHANGED");
  const existing = await existingAdjustment(ctx, draft.idempotencyKey);
  if (existing) {
    if (existing.environment !== draft.environment || existing.asset !== draft.asset
      || existing.slot_number !== draft.slotNumber || existing.kind !== draft.kind
      || existing.gain_units !== (draft.kind === "MANUAL_TARGET_GAIN" ? draft.gainUnits : 0)
      || existing.currency !== (draft.kind === "MANUAL_CONTRIBUTION" ? draft.currency ?? "USD" : "USD")
      || (draft.kind === "MANUAL_CONTRIBUTION" && Number(existing.original_amount) !== draft.amount)
      || (draft.kind === "MANUAL_TARGET_GAIN" && draft.explicitGainAmountUsdc !== undefined
        && Number(existing.original_amount) !== draft.explicitGainAmountUsdc)
      || existing.reason !== draft.reason.trim() || (existing.note ?? "") !== (draft.note?.trim() ?? ""))
      throw new Error("COINOPS_ADJUSTMENT_IDEMPOTENCY_CONFLICT");
    return { id: existing.id, balanceAfterUsdc: Number(existing.balance_after_usdc) };
  }
  const current = await buildPreview(ctx, draft);
  if (current.snapshot.quoteAsset !== expected.snapshot.quoteAsset
    || current.preview.quoteAsset !== expected.preview.quoteAsset
    || current.preview.fx?.source !== expected.preview.fx?.source
    || current.snapshot.balanceUsdc !== expected.snapshot.balanceUsdc
    || current.snapshot.monthlyGainCount !== expected.snapshot.monthlyGainCount
    || current.snapshot.lifetimeGainCount !== expected.snapshot.lifetimeGainCount
    || current.snapshot.entryState !== expected.snapshot.entryState
    || current.snapshot.committedNotionalUsdc !== expected.snapshot.committedNotionalUsdc
    || current.snapshot.gainRate !== expected.snapshot.gainRate
    || current.preview.convertedAmountUsdc !== expected.preview.convertedAmountUsdc
    || current.preview.fx?.rateBrlPerUsdc !== expected.preview.fx?.rateBrlPerUsdc)
    throw new Error("COINOPS_ADJUSTMENT_PREVIEW_STALE");
  const preview = current.preview;
  const { data, error } = await ctx.service.rpc("apply_robot_v1_manual_adjustment", {
    p_product_id: ctx.productId, p_tenant_id: ctx.tenantId, p_user_id: ctx.userId, p_created_by: ctx.userId,
    p_trading_engine_id: ctx.engine!.trading_engine_id, p_environment: draft.environment, p_asset: draft.asset, p_slot_number: draft.slotNumber, p_kind: draft.kind,
    p_gain_units: preview.gainUnits, p_currency: preview.currency, p_original_amount: preview.originalAmount,
    p_fx_rate: preview.fx?.rateBrlPerUsdc ?? null, p_fx_source: preview.fx?.source ?? null,
    p_fx_observed_at: preview.fx?.observedAt ?? null, p_reason: draft.reason.trim(), p_note: draft.note?.trim() || null,
    p_reversal_of: null, p_idempotency_key: draft.idempotencyKey,
    p_expected_balance: preview.balanceBeforeUsdc, p_expected_lifetime: preview.lifetimeBefore,
    p_expected_monthly: preview.monthlyBefore,
  });
  if (error || !data) throw new Error(error?.message || "COINOPS_ADJUSTMENT_APPLY_FAILED");
  revalidatePath("/automacao");
  const row = data as { id: string; balance_after_usdc: number | string };
  return { id: row.id, balanceAfterUsdc: Number(row.balance_after_usdc) };
}

export async function reverseCoinOpsManualAdjustment(input: ActionEngineIds & { environment: AdjustmentEnvironment; asset: Asset;
  adjustmentId: string; reason: string; idempotencyKey: string;
}, expected: ActionEngineIds & { balanceUsdc: number; monthlyGainCount: number; lifetimeGainCount: number }): Promise<{ id: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(input.adjustmentId) || !/^[a-zA-Z0-9:-]{16,100}$/.test(input.idempotencyKey)
    || input.reason.trim().length < 3 || input.reason.trim().length > 160)
    throw new Error("COINOPS_ADJUSTMENT_INPUT_INVALID");
  const ctx = await scope();
  ctx.engine = await actionEngine(input, input.environment, input.asset, { product_id: ctx.productId, tenant_id: ctx.tenantId, user_id: ctx.userId });
  if (expected.exchange_account_id !== ctx.engine.exchange_account_id || expected.trading_engine_id !== ctx.engine.trading_engine_id) throw new Error("COINOPS_ADJUSTMENT_PREVIEW_SCOPE_CHANGED");
  const existing = await existingAdjustment(ctx, input.idempotencyKey);
  if (existing) {
    if (existing.kind !== "REVERSAL" || existing.reversal_of !== input.adjustmentId
      || existing.reason !== input.reason.trim())
      throw new Error("COINOPS_ADJUSTMENT_IDEMPOTENCY_CONFLICT");
    return { id: existing.id };
  }
  const { data: original, error: originalError } = await ctx.service.from("robot_v1_manual_adjustments")
    .select("id,environment,asset,slot_number,kind").eq("id", input.adjustmentId).eq("trading_engine_id", ctx.engine.trading_engine_id)
    .eq("product_id", ctx.productId).eq("tenant_id", ctx.tenantId).eq("user_id", ctx.userId).maybeSingle();
  if (originalError || !original || original.kind === "REVERSAL") throw new Error("COINOPS_ADJUSTMENT_REVERSAL_INVALID");
  if (original.environment === "REAL") throw new Error("COINOPS_REAL_BRL_ADJUSTMENT_NOT_ENABLED");
  const snapshot = await loadSnapshot(ctx, original.environment as AdjustmentEnvironment,
    original.asset as Asset, original.slot_number);
  if (snapshot.balanceUsdc !== expected.balanceUsdc
    || snapshot.monthlyGainCount !== expected.monthlyGainCount
    || snapshot.lifetimeGainCount !== expected.lifetimeGainCount)
    throw new Error("COINOPS_ADJUSTMENT_PREVIEW_STALE");
  const { data, error } = await ctx.service.rpc("apply_robot_v1_manual_adjustment", {
    p_product_id: ctx.productId, p_tenant_id: ctx.tenantId, p_user_id: ctx.userId, p_created_by: ctx.userId,
    p_trading_engine_id: ctx.engine!.trading_engine_id, p_environment: original.environment, p_asset: original.asset, p_slot_number: original.slot_number,
    p_kind: "REVERSAL", p_gain_units: 0, p_currency: "USD", p_original_amount: 0,
    p_fx_rate: null, p_fx_source: null, p_fx_observed_at: null,
    p_reason: input.reason.trim(), p_note: null, p_reversal_of: input.adjustmentId,
    p_idempotency_key: input.idempotencyKey, p_expected_balance: snapshot.balanceUsdc,
    p_expected_lifetime: snapshot.lifetimeGainCount, p_expected_monthly: snapshot.monthlyGainCount,
  });
  if (error || !data) throw new Error(error?.message || "COINOPS_ADJUSTMENT_REVERSAL_FAILED");
  revalidatePath("/automacao");
  return { id: (data as { id: string }).id };
}

export async function previewCoinOpsManualReversal(adjustmentId: string, selection: ActionEngineIds & { environment: AdjustmentEnvironment; asset: Asset }) {
  if (!/^[0-9a-f-]{36}$/i.test(adjustmentId)) throw new Error("COINOPS_ADJUSTMENT_INPUT_INVALID");
  const ctx = await scope();
  ctx.engine = await actionEngine(selection, selection.environment, selection.asset, { product_id: ctx.productId, tenant_id: ctx.tenantId, user_id: ctx.userId });
  const { data: original, error } = await ctx.service.from("robot_v1_manual_adjustments")
    .select("id,environment,asset,slot_number,kind,gain_units,converted_amount_usdc,period_key")
    .eq("id", adjustmentId).eq("trading_engine_id", ctx.engine.trading_engine_id).eq("product_id", ctx.productId).eq("tenant_id", ctx.tenantId)
    .eq("user_id", ctx.userId).maybeSingle();
  if (error || !original || original.kind === "REVERSAL") throw new Error("COINOPS_ADJUSTMENT_REVERSAL_INVALID");
  if (original.environment === "REAL") throw new Error("COINOPS_REAL_BRL_ADJUSTMENT_NOT_ENABLED");
  const { data: alreadyReversed } = await ctx.service.from("robot_v1_manual_adjustments")
    .select("id").eq("reversal_of", adjustmentId).eq("product_id", ctx.productId)
    .eq("tenant_id", ctx.tenantId).eq("user_id", ctx.userId).maybeSingle();
  if (alreadyReversed) throw new Error("COINOPS_ADJUSTMENT_ALREADY_REVERSED");
  const snapshot = await loadSnapshot(ctx, original.environment as AdjustmentEnvironment,
    original.asset as Asset, original.slot_number);
  const delta = -Number(original.converted_amount_usdc);
  if (snapshot.balanceUsdc + delta < (original.environment === "REAL" ? 0 : 0.00000001)
    || snapshot.lifetimeGainCount - original.gain_units < 0)
    throw new Error("COINOPS_ADJUSTMENT_REVERSAL_BALANCE_INVALID");
  return { adjustmentId, engine: { exchange_account_id: ctx.engine.exchange_account_id, trading_engine_id: ctx.engine.trading_engine_id }, snapshot, deltaUsdc: delta, balanceAfterUsdc: snapshot.balanceUsdc + delta,
    lifetimeAfter: snapshot.lifetimeGainCount - original.gain_units,
    monthlyAfter: snapshot.monthlyGainCount - (original.period_key === monthlyPeriodKey(new Date()) ? original.gain_units : 0),
    originalPeriod: original.period_key };
}
