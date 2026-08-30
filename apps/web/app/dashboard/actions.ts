"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getValueForGains } from "@/lib/slotgain/gain-calculation";
import { DEFAULT_ASSET_MARKET_SETTINGS, DEFAULT_MARKET_REGIME_SETTINGS, activeBuyDropPercent, applyMarketRegimeHysteresis, asMarketRegime, effectiveMarketRegime, validateMarketRegimeSettings, type AssetMarketStrategySettings, type MarketRegimeSettings } from "@/lib/slotgain/market-regime";
import { recalculateFutureEntryTriggers } from "@/lib/slotgain/market-regime-server";
import { addNoticeToPath, getSlotsReturnPath } from "@/lib/slotgain/slot-filter-navigation";

type SlotStatus = "zerado" | "aberto" | "gain" | "hold";

type SlotRecord = {
  id: string;
  strategy_id: string;
  slot_number: number;
  sort_order: number;
  status: SlotStatus;
  gains: number;
  real_gains: number;
  added_gains: number;
  base_value: number | string;
  realized_profit: number | string;
  growth_contribution: number | string;
  operational_slot_value: number | string;
  operational_gains: number | string;
  redistribution_received_usdt: number | string;
  redistribution_sent_usdt: number | string;
  position_notional_usdt: number | string | null;
  position_gain_unit_usdt: number | string | null;
  accounting_version: number;
  gain_rate: number | string;
  preco_entrada: number | string | null;
  preco_atual: number | string | null;
  preco_alvo: number | string | null;
};

type StrategyRecord = {
  id: string;
  key: string;
  title: string;
  asset: string;
  base_value: number | string;
  gain_rate: number | string;
  drop_percent?: number | string;
};

type RegisterGainRpcResult = {
  already_applied?: boolean;
  asset?: string;
  gains_after?: number | string;
  value_before?: number | string;
  value_after?: number | string;
  gain_amount_usdt?: number | string;
};

async function getUserClient() {
  if (!isSupabaseConfigured()) {
    redirect("/login?setup=missing-env");
  }

  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return { supabase, user };
}

function formText(formData: FormData, name: string, fallback = "") {
  return String(formData.get(name) || fallback).trim();
}

function formNumber(formData: FormData, name: string, fallback = 0) {
  const value = Number.parseFloat(String(formData.get(name) || "").replace(",", "."));
  return Number.isFinite(value) ? value : fallback;
}

function formInt(formData: FormData, name: string, fallback = 0) {
  const value = Number.parseInt(String(formData.get(name) || ""), 10);
  return Number.isFinite(value) ? value : fallback;
}

function normalizeKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function formatUsdt(value: number) {
  return `${new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)} USDT`;
}

function currentValue(slot: Pick<SlotRecord, "base_value" | "gain_rate" | "gains" | "operational_slot_value">) {
  const operationalValue = Number(slot.operational_slot_value);
  return Number.isFinite(operationalValue) && operationalValue >= 0
    ? operationalValue
    : getValueForGains(Number(slot.base_value || 0), 0, Number(slot.gain_rate || 0), Number(slot.gains || 0));
}

function roundEntryPrice(value: number) {
  return Math.round(value);
}

function operationalValueForGains(slot: Pick<SlotRecord, "base_value" | "growth_contribution" | "gains">, gainRate: number, gains = Number(slot.gains || 0)) {
  return getValueForGains(Number(slot.base_value || 0), Number(slot.growth_contribution || 0), gainRate, gains);
}

type HistoryMetadata = {
  asset?: string | null;
  eventType?: string;
  origin?: "MANUAL" | "AUTO_GAIN" | "CRON" | "SISTEMA" | "IMPORTACAO";
  expectedPrice?: number | null;
  executedPrice?: number | null;
  currentPrice?: number | null;
  targetPrice?: number | null;
  valueBefore?: number | null;
  valueAfter?: number | null;
  slotValue?: number | null;
  gains?: number | null;
  realGains?: number | null;
  addedGains?: number | null;
  statusBefore?: string | null;
  statusAfter?: string | null;
  realizedProfit?: number | null;
  note?: string | null;
};

function historyFingerprint(action: string, payload: { strategyId?: string | null; slotId?: string | null; slotNumber?: number | null; metadata?: HistoryMetadata }) {
  return JSON.stringify({
    action,
    strategyId: payload.strategyId || null,
    slotId: payload.slotId || null,
    slotNumber: payload.slotNumber || null,
    eventType: payload.metadata?.eventType || action,
    expectedPrice: payload.metadata?.expectedPrice ?? null,
    executedPrice: payload.metadata?.executedPrice ?? null,
    currentPrice: payload.metadata?.currentPrice ?? null,
    targetPrice: payload.metadata?.targetPrice ?? null,
    valueBefore: payload.metadata?.valueBefore ?? null,
    valueAfter: payload.metadata?.valueAfter ?? null,
    slotValue: payload.metadata?.slotValue ?? null,
    gains: payload.metadata?.gains ?? null,
    statusBefore: payload.metadata?.statusBefore ?? null,
    statusAfter: payload.metadata?.statusAfter ?? null
  });
}

function historyDetail(message: string, metadata?: HistoryMetadata, duplicateKey?: string) {
  if (!metadata) {
    return message;
  }

  return JSON.stringify({
    schemaVersion: 2,
    message,
    origin: metadata.origin || "MANUAL",
    ...metadata,
    duplicateKey,
    eventAt: new Date().toISOString()
  });
}

async function getCurrentStrategyGainRate(
  supabase: Awaited<ReturnType<typeof getUserClient>>["supabase"],
  userId: string,
  strategyId: string
) {
  const { data: strategy } = await supabase
    .from("strategies")
    .select("gain_rate")
    .eq("id", strategyId)
    .eq("user_id", userId)
    .single<Pick<StrategyRecord, "gain_rate">>();

  return Number(strategy?.gain_rate || 0);
}

async function getSuggestedEntryPriceFromLastOpen(
  supabase: Awaited<ReturnType<typeof getUserClient>>["supabase"],
  userId: string,
  slot: SlotRecord
) {
  const { data: strategy } = await supabase
    .from("strategies")
    .select("asset")
    .eq("id", slot.strategy_id)
    .eq("user_id", userId)
    .single<Pick<StrategyRecord, "asset">>();

  const asset = strategy?.asset?.toUpperCase();
  if (!asset) {
    return 0;
  }

  const { data: sameAssetStrategies } = await supabase
    .from("strategies")
    .select("id")
    .eq("user_id", userId)
    .eq("asset", asset);

  const strategyIds = (sameAssetStrategies || []).map((item) => item.id);
  if (!strategyIds.length) {
    return 0;
  }

  const { data: lastOpenSlots } = await supabase
    .from("slots")
    .select("preco_entrada")
    .eq("user_id", userId)
    .in("strategy_id", strategyIds)
    .eq("status", "aberto")
    .neq("id", slot.id)
    .not("preco_entrada", "is", null)
    .order("preco_entrada", { ascending: true })
    .limit(1);

  const lastEntryPrice = Number(lastOpenSlots?.[0]?.preco_entrada || 0);
  if (lastEntryPrice <= 0) {
    return 0;
  }

  const normalizedAsset = asset === "SOL" ? "SOL" : "BTC";
  const [{ data: marketState }, { data: regimeSettings }, { data: assetSettings }] = await Promise.all([
    supabase.from("btc_market_state").select("effective_mode").eq("singleton", true).maybeSingle(),
    supabase.from("market_regime_settings").select("mode_source,manual_mode,last_effective_mode").eq("user_id", userId).maybeSingle(),
    supabase.from("asset_market_strategy_settings").select("buy_drop_top_percent,buy_drop_normal_percent,buy_drop_deep_percent").eq("user_id", userId).eq("asset", normalizedAsset).maybeSingle()
  ]);
  const automaticMode = asMarketRegime(regimeSettings?.last_effective_mode) || asMarketRegime(marketState?.effective_mode) || "NORMAL";
  const effectiveMode = effectiveMarketRegime({
    mode_source: regimeSettings?.mode_source === "MANUAL" ? "MANUAL" : "AUTO",
    manual_mode: asMarketRegime(regimeSettings?.manual_mode)
  }, automaticMode);
  const dropPercent = activeBuyDropPercent(normalizedAsset, effectiveMode, assetSettings || DEFAULT_ASSET_MARKET_SETTINGS[normalizedAsset]);
  return lastEntryPrice * (1 - dropPercent / 100);
}

function finish(message: string, path = "/slots"): never {
  revalidatePath("/dashboard");
  revalidatePath("/slots");
  revalidatePath("/historico");
  revalidatePath("/config");
  revalidatePath("/plano-crescimento");
  redirect(addNoticeToPath(path, message));
}

async function addHistory(
  action: string,
  detail: string,
  payload: {
    userId: string;
    strategyId?: string | null;
    slotId?: string | null;
    strategyKey?: string | null;
    slotNumber?: number | null;
    metadata?: HistoryMetadata;
  }
) {
  const { supabase } = await getUserClient();
  const duplicateKey = historyFingerprint(action, payload);
  const detailPayload = historyDetail(detail, payload.metadata, duplicateKey);

  if (payload.slotId && payload.metadata) {
    const threeSecondsAgo = new Date(Date.now() - 3000).toISOString();
    const { data: recentEvents } = await supabase
      .from("history_events")
      .select("detail")
      .eq("user_id", payload.userId)
      .eq("slot_id", payload.slotId)
      .eq("action", action)
      .gte("created_at", threeSecondsAgo)
      .limit(5);

    const hasDuplicate = (recentEvents || []).some((event) => {
      try {
        return JSON.parse(String(event.detail || "{}")).duplicateKey === duplicateKey;
      } catch {
        return false;
      }
    });

    if (hasDuplicate) {
      return;
    }
  }

  const { error: historyError } = await supabase.from("history_events").insert({
    user_id: payload.userId,
    strategy_id: payload.strategyId || null,
    slot_id: payload.slotId || null,
    action,
    detail: detailPayload,
    strategy_key: payload.strategyKey || null,
    slot_number: payload.slotNumber || null
  });

  if (historyError) {
    throw new Error("Falha ao registrar o histórico da operação.");
  }

}

export async function createStrategy(formData: FormData) {
  const { supabase, user } = await getUserClient();
  const title = formText(formData, "title");
  const asset = formText(formData, "asset").toUpperCase();
  const key = normalizeKey(formText(formData, "key") || asset || title);
  const baseValue = Math.max(0, formNumber(formData, "baseValue", 0));
  const gainRate = Math.max(0, formNumber(formData, "gainRate", 0)) / 100;
  const dropPercent = Math.max(0, formNumber(formData, "dropPercent", 0));
  const restartAmount = Math.max(0, formInt(formData, "restartAmount", 0));

  if (!title || !asset || !key) {
    return;
  }

  const { data: existing } = await supabase
    .from("strategies")
    .select("sort_order")
    .eq("user_id", user.id)
    .order("sort_order", { ascending: false })
    .limit(1);

  const nextOrder = Number(existing?.[0]?.sort_order || 0) + 1;

  const { data } = await supabase
    .from("strategies")
    .insert({
      user_id: user.id,
      key,
      title,
      display_name: `${title} | Novo Slot ${dropPercent}%`,
      asset,
      base_value: baseValue,
      gain_rate: gainRate,
      initial_slots: 0,
      drop_percent: dropPercent,
      restart_amount: restartAmount,
      sort_order: nextOrder
    })
    .select("id,key,title")
    .single();

  if (data) {
    await addHistory("Estrategia", `Estrategia ${data.title} criada.`, {
      userId: user.id,
      strategyId: data.id,
      strategyKey: data.key
    });
  }

  finish("Estrategia criada.", "/config");
}

export async function updateStrategy(formData: FormData) {
  const { supabase, user } = await getUserClient();
  const id = formText(formData, "strategyId");
  const title = formText(formData, "title");
  const baseValue = Math.max(0, formNumber(formData, "baseValue", 0));
  const gainRate = Math.max(0, formNumber(formData, "gainRate", 0)) / 100;
  const dropPercent = Math.max(0, formNumber(formData, "dropPercent", 0));
  const restartAmount = Math.max(0, formInt(formData, "restartAmount", 0));

  if (!id || !title) {
    return;
  }

  const { data: existingStrategy, error: existingStrategyError } = await supabase
    .from("strategies")
    .select("asset")
    .eq("id", id)
    .eq("user_id", user.id)
    .single<Pick<StrategyRecord, "asset">>();
  if (existingStrategyError || !existingStrategy) {
    throw new Error("A estratégia não foi encontrada no escopo da conta.");
  }
  const asset = existingStrategy.asset.toUpperCase();

  if (asset === "BTC" || asset === "SOL") {
    const { error } = await supabase.rpc("update_asset_strategy", {
      p_strategy_id: id,
      p_title: title,
      p_base_value: baseValue,
      p_gain_rate: gainRate,
      p_drop_percent: dropPercent,
      p_restart_amount: restartAmount
    });
    if (error) {
      throw new Error(`A estratégia ${asset} não pôde ser atualizada de forma atômica.`);
    }
    finish("Estrategia atualizada.", "/config");
  }

  const { data: affectedSlots, error: affectedSlotsError } = await supabase
    .from("slots")
    .select("id,status,preco_entrada,base_value,growth_contribution,gains")
    .eq("user_id", user.id)
    .eq("strategy_id", id);
  if (affectedSlotsError) {
    throw new Error("Os slots da estratégia não puderam ser carregados.");
  }

  const { data, error: strategyUpdateError } = await supabase
    .from("strategies")
    .update({
      title,
      display_name: `${title} | Novo Slot ${dropPercent}%`,
      base_value: baseValue,
      gain_rate: gainRate,
      drop_percent: dropPercent,
      restart_amount: restartAmount
    })
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id,key,title")
    .single();
  if (strategyUpdateError || !data) {
    throw new Error("A estratégia não pôde ser atualizada.");
  }

  const slotUpdates = await Promise.all((affectedSlots || []).map((slot) => {
      const entryPrice = Number(slot.preco_entrada || 0);
      const keepsTarget = (slot.status === "aberto" || slot.status === "hold") && entryPrice > 0;
      const slotUpdate = {
        gain_rate: gainRate,
        realized_profit: operationalValueForGains(slot as SlotRecord, gainRate) - Number(slot.base_value || 0) - Number(slot.growth_contribution || 0),
        preco_alvo: keepsTarget ? roundEntryPrice(entryPrice * (1 + gainRate)) : null
      };

      return supabase
        .from("slots")
        .update(slotUpdate)
        .eq("id", slot.id)
        .eq("user_id", user.id);
  }));
  if (slotUpdates.some((result) => result.error)) {
    throw new Error("A estratégia foi salva, mas a taxa não pôde ser sincronizada em todos os slots.");
  }
  await addHistory("Estrategia", `Estrategia ${data.title} editada.`, {
    userId: user.id,
    strategyId: data.id,
    strategyKey: data.key
  });

  finish("Estrategia atualizada.", "/config");
}

export async function deleteStrategy(formData: FormData) {
  const { supabase, user } = await getUserClient();
  const id = formText(formData, "strategyId");
  const title = formText(formData, "title", "Estrategia");

  if (!id) {
    return;
  }

  const { data: strategy, error: strategyError } = await supabase
    .from("strategies")
    .select("asset")
    .eq("id", id)
    .eq("user_id", user.id)
    .single<Pick<StrategyRecord, "asset">>();
  if (strategyError || !strategy) {
    throw new Error("A estratégia não foi encontrada no escopo da conta.");
  }
  if (["BTC", "SOL"].includes(strategy.asset.toUpperCase())) {
    throw new Error(`A estratégia ${strategy.asset.toUpperCase()} possui histórico financeiro e não pode ser excluída.`);
  }

  const { error: deleteError } = await supabase.from("strategies").delete().eq("id", id).eq("user_id", user.id);
  if (deleteError) {
    throw new Error("A estratégia não pôde ser removida porque possui dados vinculados.");
  }
  await addHistory("Estrategia", `${title} removida com seus slots.`, {
    userId: user.id,
    strategyId: null
  });

  finish("Estrategia removida.", "/config");
}

export type MarketRegimeConfigurationInput = {
  regime: Pick<MarketRegimeSettings, "top_threshold_percent" | "deep_threshold_percent" | "hysteresis_percent" | "mode_source" | "manual_mode"> & { manual_reason?: string | null };
  assets: Array<Pick<AssetMarketStrategySettings, "asset" | "buy_drop_top_percent" | "buy_drop_normal_percent" | "buy_drop_deep_percent" | "top_zero_reserve_count" | "normal_zero_reserve_count" | "deep_zero_reserve_count" | "deep_active_slot_limit">>;
};

export async function saveMarketRegimeConfiguration(input: MarketRegimeConfigurationInput) {
  const { user } = await getUserClient();
  const regime = {
    ...DEFAULT_MARKET_REGIME_SETTINGS,
    ...input.regime,
    manual_mode: asMarketRegime(input.regime.manual_mode),
    manual_reason: String(input.regime.manual_reason || "").trim() || null
  };
  const invalid = validateMarketRegimeSettings(regime);
  if (invalid) throw new Error(invalid);
  if (!Array.isArray(input.assets) || input.assets.length !== 2) throw new Error("Informe as configuracoes de BTC e SOL.");
  for (const asset of input.assets) {
    if ((asset.asset !== "BTC" && asset.asset !== "SOL") || [asset.buy_drop_top_percent, asset.buy_drop_normal_percent, asset.buy_drop_deep_percent].some((value) => !Number.isFinite(value) || value <= 0 || value > 90)) {
      throw new Error("Os percentuais de nova compra devem ficar entre 0% e 90%.");
    }
  }

  const service = createServiceRoleClient();
  const { data: previousSettings } = await service.from("market_regime_settings").select("last_effective_mode").eq("user_id", user.id).maybeSingle();
  const { data: marketState } = await service.from("btc_market_state").select("ath_price,current_price,distance_from_ath_percent,effective_mode,source").eq("singleton", true).maybeSingle();
  const automaticMode = marketState?.source && marketState.source !== "UNAVAILABLE"
    ? applyMarketRegimeHysteresis(asMarketRegime(previousSettings?.last_effective_mode), Number(marketState.distance_from_ath_percent), regime)
    : asMarketRegime(marketState?.effective_mode) || "NORMAL";
  const nextEffectiveMode = effectiveMarketRegime(regime, automaticMode);
  const now = new Date().toISOString();
  const { error: regimeError } = await service.from("market_regime_settings").upsert({
    user_id: user.id,
    top_threshold_percent: regime.top_threshold_percent,
    deep_threshold_percent: regime.deep_threshold_percent,
    hysteresis_percent: regime.hysteresis_percent,
    classification_timeframe: "DAILY_CLOSE",
    mode_source: regime.mode_source,
    manual_mode: regime.mode_source === "MANUAL" ? regime.manual_mode : null,
    manual_reason: regime.mode_source === "MANUAL" ? regime.manual_reason : null,
    last_effective_mode: nextEffectiveMode,
    updated_at: now
  });
  if (regimeError) throw new Error("Nao foi possivel salvar o modo de mercado.");
  const rows = input.assets.map((asset) => ({
    user_id: user.id,
    asset: asset.asset,
    buy_drop_top_percent: asset.buy_drop_top_percent,
    buy_drop_normal_percent: asset.buy_drop_normal_percent,
    buy_drop_deep_percent: asset.buy_drop_deep_percent,
    top_zero_reserve_count: asset.top_zero_reserve_count,
    normal_zero_reserve_count: asset.normal_zero_reserve_count,
    deep_zero_reserve_count: asset.deep_zero_reserve_count,
    deep_active_slot_limit: asset.deep_active_slot_limit,
    updated_at: now
  }));
  const { error: assetsError } = await service.from("asset_market_strategy_settings").upsert(rows, { onConflict: "user_id,asset" });
  if (assetsError) throw new Error("Nao foi possivel salvar os percentuais de nova compra.");
  await recalculateFutureEntryTriggers(user.id, nextEffectiveMode, {
    BTC: rows.find((row) => row.asset === "BTC") || DEFAULT_ASSET_MARKET_SETTINGS.BTC,
    SOL: rows.find((row) => row.asset === "SOL") || DEFAULT_ASSET_MARKET_SETTINGS.SOL
  });

  const previousMode = asMarketRegime(previousSettings?.last_effective_mode);
  if (previousMode !== nextEffectiveMode || regime.mode_source === "MANUAL") {
    await service.from("market_regime_history").insert({
      user_id: user.id,
      previous_mode: previousMode,
      new_mode: nextEffectiveMode,
      mode_source: regime.mode_source,
      ath_price: Number(marketState?.ath_price || 0),
      current_price: Number(marketState?.current_price || 0),
      distance_percent: Number(marketState?.distance_from_ath_percent || 0),
      reason: regime.mode_source === "MANUAL" ? regime.manual_reason || "Override manual ativado." : "Configuracao automatica atualizada; novos gatilhos usarao os percentuais salvos."
    });
  }

  revalidatePath("/dashboard");
  revalidatePath("/slots");
  revalidatePath("/config");
  return { ok: true, effectiveMode: nextEffectiveMode };
}

export async function createSlots(formData: FormData) {
  const { supabase, user } = await getUserClient();
  const strategyId = formText(formData, "strategyId");
  const quantity = Math.min(50, Math.max(1, formInt(formData, "quantity", 1)));

  const { data: strategy } = await supabase
    .from("strategies")
    .select("id,key,title,base_value,gain_rate")
    .eq("id", strategyId)
    .eq("user_id", user.id)
    .single<StrategyRecord>();

  if (!strategy) {
    return;
  }

  const [{ data: maxNumberRows }, { data: maxOrderRows }] = await Promise.all([
    supabase
      .from("slots")
      .select("slot_number")
      .eq("user_id", user.id)
      .eq("strategy_id", strategy.id)
      .order("slot_number", { ascending: false })
      .limit(1),
    supabase.from("slots").select("sort_order").eq("user_id", user.id).order("sort_order", { ascending: false }).limit(1)
  ]);

  const nextNumber = Number(maxNumberRows?.[0]?.slot_number || 0) + 1;
  const nextOrder = Number(maxOrderRows?.[0]?.sort_order || 0) + 1;
  const rows = Array.from({ length: quantity }, (_, index) => ({
    user_id: user.id,
    strategy_id: strategy.id,
    slot_number: nextNumber + index,
    sort_order: nextOrder + index,
    status: "zerado",
    gains: 0,
    base_value: Number(strategy.base_value || 0),
    gain_rate: Number(strategy.gain_rate || 0),
    preco_alvo: null,
    preco_atual: null,
    preco_entrada: null,
    started_once: false
  }));

  await supabase.from("slots").insert(rows);
  await addHistory("Criacao de slots", `${quantity} slot${quantity > 1 ? "s" : ""} adicionado${quantity > 1 ? "s" : ""} em ${strategy.title}.`, {
    userId: user.id,
    strategyId: strategy.id,
    strategyKey: strategy.key
  });

  finish("Slots adicionados.");
}

export async function moveSlot(formData: FormData) {
  const { supabase, user } = await getUserClient();
  const slot = await getSlotFromForm(supabase, user.id, formData);
  const direction = formText(formData, "direction");

  if (!slot || !["up", "down"].includes(direction)) {
    return;
  }

  const { data: strategySlots } = await supabase
    .from("slots")
    .select("id,slot_number,sort_order")
    .eq("user_id", user.id)
    .eq("strategy_id", slot.strategy_id)
    .order("sort_order", { ascending: true });

  const orderedSlots = strategySlots || [];
  const currentIndex = orderedSlots.findIndex((item) => item.id === slot.id);
  const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  const targetSlot = orderedSlots[targetIndex];

  if (currentIndex < 0 || !targetSlot) {
    finish("Slot ja esta no limite da ordem.");
  }

  await Promise.all([
    supabase
      .from("slots")
      .update({ sort_order: Number(targetSlot.sort_order || 0) })
      .eq("id", slot.id)
      .eq("user_id", user.id),
    supabase
      .from("slots")
      .update({ sort_order: Number(slot.sort_order || 0) })
      .eq("id", targetSlot.id)
      .eq("user_id", user.id)
  ]);

  await addHistory("Ordem", `Slot ${slot.slot_number} movido ${direction === "up" ? "para cima" : "para baixo"}.`, {
    userId: user.id,
    strategyId: slot.strategy_id,
    slotId: slot.id,
    slotNumber: slot.slot_number
  });

  finish("Ordem do slot atualizada.");
}

export async function openSlot(formData: FormData) {
  const returnPath = getSlotsReturnPath(formData.get("returnFilter"));
  const { supabase, user } = await getUserClient();
  const slot = await getSlotFromForm(supabase, user.id, formData);
  if (!slot || slot.status === "aberto") {
    return;
  }

  const { data: eligibility, error: eligibilityError } = await supabase.rpc(
    "validate_official_slot_entry",
    { p_slot_id: slot.id }
  );
  if (eligibilityError && eligibilityError.code !== "PGRST202") {
    finish("Não foi possível validar a fila oficial. Nenhuma abertura foi registrada.", returnPath);
  }
  const officialEligibility = eligibility as { active?: boolean; allowed?: boolean; code?: string; expected_slot_number?: number } | null;
  if (officialEligibility?.active && !officialEligibility.allowed) {
    if (officialEligibility.code === "ALL_TARGETS_MET") {
      finish("Todos os slots habilitados atingiram a meta deste ciclo. Novas entradas estão pausadas.", returnPath);
    }
    const expected = officialEligibility.expected_slot_number ? ` O próximo é o Slot #${officialEligibility.expected_slot_number}.` : "";
    finish(`Este slot não é o próximo da fila oficial.${expected}`, returnPath);
  }


  let entryPrice = Math.max(0, formNumber(formData, "entryPrice", 0));
  if (entryPrice <= 0) {
    entryPrice = await getSuggestedEntryPriceFromLastOpen(supabase, user.id, slot);
  }
  entryPrice = entryPrice > 0 ? roundEntryPrice(entryPrice) : 0;
  const strategyGainRate = await getCurrentStrategyGainRate(supabase, user.id, slot.strategy_id);
  const targetPrice = entryPrice > 0 ? roundEntryPrice(entryPrice * (1 + strategyGainRate)) : null;
  const { data: strategy } = await supabase
    .from("strategies")
    .select("key,asset")
    .eq("id", slot.strategy_id)
    .eq("user_id", user.id)
    .single<Pick<StrategyRecord, "key" | "asset">>();

  const slotUpdate: Record<string, unknown> = {
    status: "aberto",
    started_once: true,
    gain_rate: strategyGainRate,
    preco_entrada: entryPrice > 0 ? entryPrice : null,
    preco_atual: entryPrice > 0 ? entryPrice : null,
    preco_alvo: targetPrice
  };

  const { data: updatedSlot, error: updateError } = await supabase
    .from("slots")
    .update(slotUpdate)
    .eq("id", slot.id)
    .eq("user_id", user.id)
    .neq("status", "aberto")
    .select("id")
    .maybeSingle();
  if (updateError || !updatedSlot) {
    throw new Error("O slot não pôde ser aberto porque foi atualizado por outra operação.");
  }
  await addHistory("Abertura", `Slot aberto com valor calculado de ${formatUsdt(currentValue(slot))}.`, {
    userId: user.id,
    strategyId: slot.strategy_id,
    slotId: slot.id,
    strategyKey: strategy?.key || null,
    slotNumber: slot.slot_number,
    metadata: {
      asset: strategy?.asset || null,
      eventType: "entrada_manual",
      origin: "MANUAL",
      expectedPrice: entryPrice || null,
      executedPrice: entryPrice || null,
      currentPrice: entryPrice || null,
      targetPrice,
      valueBefore: currentValue(slot),
      valueAfter: currentValue(slot),
      slotValue: currentValue(slot),
      gains: Number(slot.gains || 0),
      statusBefore: slot.status,
      statusAfter: "aberto",
      note: "Entrada manual registrada pelo usuario."
    }
  });

  finish("Slot aberto.", returnPath);
}

export async function registerGain(formData: FormData) {
  const returnPath = getSlotsReturnPath(formData.get("returnFilter"));
  const { supabase, user } = await getUserClient();
  const slot = await getSlotFromForm(supabase, user.id, formData);
  if (!slot) {
    finish("Slot não encontrado.", returnPath);
  }
  if (slot.status !== "aberto") {
    finish(slot.status === "gain" ? "Gain já registrado." : "Este slot não está aberto.", returnPath);
  }

  const { data: strategy } = await supabase
    .from("strategies")
    .select("key,asset")
    .eq("id", slot.strategy_id)
    .eq("user_id", user.id)
    .single<Pick<StrategyRecord, "key" | "asset">>();

  const { data: rpcData, error: rpcError } = await supabase.rpc(
    "register_asset_real_gain",
    { p_slot_id: slot.id }
  );
  if (rpcError) {
    console.error(JSON.stringify({
      level: "error",
      event: "register_asset_real_gain_failed",
      slotId: slot.id,
      code: rpcError.code,
      details: rpcError.details,
      hint: rpcError.hint
    }));
    finish("Não foi possível registrar o gain. O slot continua aberto.", returnPath);
  }

  const result = rpcData as RegisterGainRpcResult | null;
  if (!result) {
    finish("Não foi possível confirmar o gain. O slot continua aberto.", returnPath);
  }
  if (result.already_applied) {
    finish("Gain já registrado.", returnPath);
  }

  const gains = Number(result.gains_after);
  const valueBefore = Number(result.value_before);
  const valueAfter = Number(result.value_after);
  const realizedGain = Number(result.gain_amount_usdt);
  if (![gains, valueBefore, valueAfter, realizedGain].every(Number.isFinite)) {
    console.error(JSON.stringify({
      level: "error",
      event: "register_asset_real_gain_invalid_result",
      slotId: slot.id
    }));
    finish("O gain foi processado, mas a atualização da tela falhou. Recarregue a página.", returnPath);
  }

  await addHistory("Gain", `Gain registrado. Novo valor: ${formatUsdt(valueAfter)}.`, {
    userId: user.id,
    strategyId: slot.strategy_id,
    slotId: slot.id,
    strategyKey: strategy?.key || null,
    slotNumber: slot.slot_number,
    metadata: {
      asset: strategy?.asset || null,
      eventType: "gain_manual",
      origin: "MANUAL",
      expectedPrice: Number(slot.preco_alvo || 0) || null,
      executedPrice: Number(slot.preco_atual || 0) || null,
      currentPrice: Number(slot.preco_atual || 0) || null,
      targetPrice: Number(slot.preco_alvo || 0) || null,
      valueBefore,
      valueAfter,
      slotValue: valueAfter,
      gains,
      statusBefore: slot.status,
      statusAfter: "gain",
      realizedProfit: realizedGain,
      note: "Gain manual registrado pelo usuario."
    }
  });

  finish("Gain registrado.", returnPath);
}

export async function resetSlot(formData: FormData) {
  const { supabase, user } = await getUserClient();
  const slot = await getSlotFromForm(supabase, user.id, formData);
  if (!slot) {
    return;
  }
  const { data: strategy } = await supabase
    .from("strategies")
    .select("key,asset")
    .eq("id", slot.strategy_id)
    .eq("user_id", user.id)
    .single<Pick<StrategyRecord, "key" | "asset">>();

  const resetUpdate = {
    status: "zerado" as const,
    started_once: false,
    notes: "",
    preco_entrada: null,
    preco_atual: null,
    preco_alvo: null
  };
  const { error: resetError } = await supabase
    .from("slots")
    .update(resetUpdate)
    .eq("id", slot.id)
    .eq("user_id", user.id);
  if (resetError) {
    throw new Error("Não foi possível alterar o estado do slot sem violar o histórico financeiro.");
  }
  await addHistory("Zerar", "Slot zerado manualmente.", {
    userId: user.id,
    strategyId: slot.strategy_id,
    slotId: slot.id,
    strategyKey: strategy?.key || null,
    slotNumber: slot.slot_number,
    metadata: {
      asset: strategy?.asset || null,
      eventType: "zerar",
      origin: "MANUAL",
      expectedPrice: Number(slot.preco_entrada || 0) || null,
      executedPrice: Number(slot.preco_atual || 0) || null,
      currentPrice: Number(slot.preco_atual || 0) || null,
      targetPrice: Number(slot.preco_alvo || 0) || null,
      valueBefore: currentValue(slot),
      valueAfter: currentValue(slot),
      slotValue: currentValue(slot),
      gains: Number(slot.gains || 0),
      statusBefore: slot.status,
      statusAfter: "zerado",
      note: "Slot zerado manualmente."
    }
  });

  finish("Slot zerado.");
}

export async function updateSlot(formData: FormData) {
  const { supabase, user } = await getUserClient();
  const slot = await getSlotFromForm(supabase, user.id, formData);
  const status = formText(formData, "status") as SlotStatus;
  const baseValue = Math.max(0, formNumber(formData, "baseValue", 0));
  const notes = formText(formData, "notes");

  if (!slot || !["zerado", "aberto", "gain", "hold"].includes(status)) {
    return;
  }

  const strategyGainRate = await getCurrentStrategyGainRate(supabase, user.id, slot.strategy_id);
  const { data: strategy } = await supabase
    .from("strategies")
    .select("key,asset")
    .eq("id", slot.strategy_id)
    .eq("user_id", user.id)
    .single<Pick<StrategyRecord, "key" | "asset">>();
  const isGrowthAsset = ["BTC", "SOL"].includes(strategy?.asset?.toUpperCase() || "");
  if (isGrowthAsset && Math.abs(baseValue - Number(slot.base_value || 0)) > 0.00000001) {
    throw new Error(`O capital ${strategy?.asset?.toUpperCase()} não pode ser editado diretamente. Use o Plano.`);
  }
  if (isGrowthAsset && status !== slot.status) {
    throw new Error(`O estado do slot ${strategy?.asset?.toUpperCase()} só pode mudar pelas ações Abrir, +Gain ou Zerar.`);
  }

  const effectiveGains = isGrowthAsset
    ? Number(slot.gains || 0)
    : status === "zerado" ? 0 : Number(slot.gains || 0);
  const nextValue = isGrowthAsset
    ? currentValue(slot)
    : getValueForGains(baseValue, Number(slot.growth_contribution || 0), strategyGainRate, effectiveGains);
  const slotUpdate = isGrowthAsset
    ? {
        status,
        started_once: status !== "zerado",
        notes: status === "zerado" ? "" : notes
      }
    : {
        status,
        gains: effectiveGains,
        real_gains: status === "zerado" ? 0 : Number(slot.real_gains || 0),
        added_gains: status === "zerado" ? 0 : Number(slot.added_gains || 0),
        base_value: baseValue,
        gain_rate: strategyGainRate,
        realized_profit: nextValue - baseValue - Number(slot.growth_contribution || 0),
        started_once: status !== "zerado",
        notes: status === "zerado" ? "" : notes
      };

  const { data: updatedSlot, error: updateError } = await supabase
    .from("slots")
    .update(slotUpdate)
    .eq("id", slot.id)
    .eq("user_id", user.id)
    .select("id")
    .maybeSingle();

  if (updateError || !updatedSlot) {
    throw new Error("Não foi possível editar o slot com as regras atuais de gains.");
  }

  await addHistory("Editar", `Slot editado para ${status}, ${effectiveGains} gains.`, {
    userId: user.id,
    strategyId: slot.strategy_id,
    slotId: slot.id,
    strategyKey: strategy?.key || null,
    slotNumber: slot.slot_number,
    metadata: {
      asset: strategy?.asset || null,
      eventType: "edicao",
      origin: "MANUAL",
      expectedPrice: Number(slot.preco_entrada || 0) || null,
      executedPrice: Number(slot.preco_atual || 0) || null,
      currentPrice: Number(slot.preco_atual || 0) || null,
      targetPrice: Number(slot.preco_alvo || 0) || null,
      valueBefore: currentValue(slot),
      valueAfter: nextValue,
      slotValue: baseValue,
      gains: effectiveGains,
      statusBefore: slot.status,
      statusAfter: status,
      note: notes || "Slot editado manualmente."
    }
  });

  finish("Slot editado.");
}

async function getSlotFromForm(
  supabase: Awaited<ReturnType<typeof getUserClient>>["supabase"],
  userId: string,
  formData: FormData
) {
  const slotId = formText(formData, "slotId");
  if (!slotId) {
    return null;
  }

  const { data } = await supabase
    .from("slots")
    .select("id,strategy_id,slot_number,sort_order,status,gains,real_gains,added_gains,base_value,realized_profit,growth_contribution,operational_slot_value,operational_gains,redistribution_received_usdt,redistribution_sent_usdt,position_notional_usdt,position_gain_unit_usdt,accounting_version,gain_rate,preco_entrada,preco_atual,preco_alvo")
    .eq("id", slotId)
    .eq("user_id", userId)
    .single<SlotRecord>();

  return data;
}
