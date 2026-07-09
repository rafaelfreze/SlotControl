"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

type SlotStatus = "zerado" | "aberto" | "gain" | "hold";

type SlotRecord = {
  id: string;
  strategy_id: string;
  slot_number: number;
  sort_order: number;
  status: SlotStatus;
  gains: number;
  base_value: number | string;
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

type AutomationMode = "off" | "exit_only" | "entry_exit";

function normalizeAutomationMode(value: string): AutomationMode {
  return value === "exit_only" || value === "entry_exit" ? value : "off";
}

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

function currentValue(slot: Pick<SlotRecord, "base_value" | "gain_rate" | "gains">) {
  return Number(slot.base_value || 0) * Math.pow(1 + Number(slot.gain_rate || 0), Number(slot.gains || 0));
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

  return lastEntryPrice * (asset === "SOL" ? 0.92 : 0.98);
}

function finish(message: string, path = "/slots"): never {
  revalidatePath("/dashboard");
  revalidatePath("/slots");
  revalidatePath("/historico");
  revalidatePath("/config");
  redirect(`${path}?notice=${encodeURIComponent(message)}`);
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

  await supabase.from("history_events").insert({
    user_id: payload.userId,
    strategy_id: payload.strategyId || null,
    slot_id: payload.slotId || null,
    action,
    detail: detailPayload,
    strategy_key: payload.strategyKey || null,
    slot_number: payload.slotNumber || null
  });
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
  const asset = formText(formData, "asset").toUpperCase();
  const baseValue = Math.max(0, formNumber(formData, "baseValue", 0));
  const gainRate = Math.max(0, formNumber(formData, "gainRate", 0)) / 100;
  const dropPercent = Math.max(0, formNumber(formData, "dropPercent", 0));
  const restartAmount = Math.max(0, formInt(formData, "restartAmount", 0));

  if (!id || !title || !asset) {
    return;
  }

  const { data } = await supabase
    .from("strategies")
    .update({
      title,
      display_name: `${title} | Novo Slot ${dropPercent}%`,
      asset,
      base_value: baseValue,
      gain_rate: gainRate,
      drop_percent: dropPercent,
      restart_amount: restartAmount
    })
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id,key,title")
    .single();

  if (data) {
    await addHistory("Estrategia", `Estrategia ${data.title} editada.`, {
      userId: user.id,
      strategyId: data.id,
      strategyKey: data.key
    });
  }

  finish("Estrategia atualizada.", "/config");
}

export async function deleteStrategy(formData: FormData) {
  const { supabase, user } = await getUserClient();
  const id = formText(formData, "strategyId");
  const title = formText(formData, "title", "Estrategia");

  if (!id) {
    return;
  }

  await supabase.from("strategies").delete().eq("id", id).eq("user_id", user.id);
  await addHistory("Estrategia", `${title} removida com seus slots.`, {
    userId: user.id,
    strategyId: null
  });

  finish("Estrategia removida.", "/config");
}

export async function updateAutomationMode(mode: AutomationMode) {
  const { supabase, user } = await getUserClient();
  const automationMode = normalizeAutomationMode(mode);

  const { data: currentSettings } = await supabase
    .from("user_settings")
    .select("settings")
    .eq("user_id", user.id)
    .maybeSingle<{ settings: Record<string, unknown> | null }>();

  const settings = {
    ...(currentSettings?.settings || {}),
    automationMode,
    autoGainEnabled: automationMode !== "off"
  };

  const { error: upsertError } = await supabase.from("user_settings").upsert({
    user_id: user.id,
    settings
  });

  if (upsertError) {
    throw new Error("Falha ao salvar configuracao de automacao.");
  }

  await addHistory("Automacao", `Modo de automacao alterado para ${automationMode}.`, {
    userId: user.id,
    metadata: {
      eventType: "configuracao_automacao",
      statusBefore: null,
      statusAfter: automationMode,
      note: "Configuracao salva para uso pelo app e pelo Vercel Cron."
    }
  });

  revalidatePath("/dashboard");
  revalidatePath("/slots");
  revalidatePath("/config");

  return { mode: automationMode };
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
  const { supabase, user } = await getUserClient();
  const slot = await getSlotFromForm(supabase, user.id, formData);
  if (!slot || slot.status === "aberto") {
    return;
  }

  let entryPrice = Math.max(0, formNumber(formData, "entryPrice", 0));
  if (entryPrice <= 0) {
    entryPrice = await getSuggestedEntryPriceFromLastOpen(supabase, user.id, slot);
  }
  const strategyGainRate = await getCurrentStrategyGainRate(supabase, user.id, slot.strategy_id);
  const targetPrice = entryPrice > 0 ? entryPrice * (1 + strategyGainRate) : null;
  const { data: strategy } = await supabase
    .from("strategies")
    .select("key,asset")
    .eq("id", slot.strategy_id)
    .eq("user_id", user.id)
    .single<Pick<StrategyRecord, "key" | "asset">>();

  await supabase
    .from("slots")
    .update({
      status: "aberto",
      started_once: true,
      preco_entrada: entryPrice > 0 ? entryPrice : null,
      preco_atual: entryPrice > 0 ? entryPrice : null,
      preco_alvo: targetPrice
    })
    .eq("id", slot.id)
    .eq("user_id", user.id);
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

  finish("Slot aberto.");
}

export async function registerGain(formData: FormData) {
  const { supabase, user } = await getUserClient();
  const slot = await getSlotFromForm(supabase, user.id, formData);
  if (!slot || slot.status === "zerado" || slot.status === "hold") {
    return;
  }

  const gains = Number(slot.gains || 0) + 1;
  const nextSlot = { ...slot, gains };
  const { data: strategy } = await supabase
    .from("strategies")
    .select("key,asset")
    .eq("id", slot.strategy_id)
    .eq("user_id", user.id)
    .single<Pick<StrategyRecord, "key" | "asset">>();
  const valueBefore = currentValue(slot);
  const valueAfter = currentValue(nextSlot);

  await supabase
    .from("slots")
    .update({ status: "gain", gains, started_once: true, preco_entrada: null, preco_atual: null, preco_alvo: null })
    .eq("id", slot.id)
    .eq("user_id", user.id);
  await addHistory("Gain", `Gain registrado. Novo valor: ${formatUsdt(currentValue(nextSlot))}.`, {
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
      realizedProfit: valueAfter - valueBefore,
      note: "Gain manual registrado pelo usuario."
    }
  });

  finish("Gain registrado.");
}

export async function registerAutomaticEntry(payload: { slotId: string; currentPrice: number }) {
  const { supabase, user } = await getUserClient();
  const slotId = String(payload.slotId || "");
  const currentPrice = Number(payload.currentPrice || 0);

  if (!slotId || currentPrice <= 0) {
    return { registered: false };
  }

  const { data: slot } = await supabase
    .from("slots")
    .select("id,strategy_id,slot_number,sort_order,status,gains,base_value,gain_rate,preco_entrada,preco_atual,preco_alvo")
    .eq("id", slotId)
    .eq("user_id", user.id)
    .single<SlotRecord>();

  if (!slot || slot.status === "aberto") {
    return { registered: false };
  }

  const { data: strategy } = await supabase
    .from("strategies")
    .select("key,title,asset,gain_rate")
    .eq("id", slot.strategy_id)
    .eq("user_id", user.id)
    .single<Pick<StrategyRecord, "key" | "title" | "asset" | "gain_rate">>();

  const entryPrice = Number(slot.preco_entrada || 0);
  const strategyGainRate = Number(strategy?.gain_rate || 0);
  const targetPrice = Number(slot.preco_alvo || 0) > 0 ? Number(slot.preco_alvo || 0) : entryPrice * (1 + strategyGainRate);

  if (entryPrice <= 0 || targetPrice <= 0 || currentPrice > entryPrice || !["zerado", "gain", "hold"].includes(slot.status)) {
    return { registered: false };
  }

  const { data: updatedSlot } = await supabase
    .from("slots")
    .update({
      status: "aberto",
      started_once: true,
      preco_entrada: entryPrice,
      preco_atual: currentPrice,
      preco_alvo: targetPrice
    })
    .eq("id", slot.id)
    .eq("user_id", user.id)
    .in("status", ["zerado", "gain", "hold"])
    .select("id")
    .single();

  if (!updatedSlot) {
    return { registered: false };
  }

  const asset = strategy?.asset?.toUpperCase() || "BTC";
  const message = `Entrada automatica registrada no ${asset} - Slot ${slot.slot_number}`;

  await addHistory("entrada_automatica", message, {
    userId: user.id,
    strategyId: slot.strategy_id,
    slotId: slot.id,
    strategyKey: strategy?.key || null,
    slotNumber: slot.slot_number,
    metadata: {
      asset,
      eventType: "entrada_automatica",
      origin: "AUTO_GAIN",
      expectedPrice: entryPrice,
      executedPrice: currentPrice,
      currentPrice,
      targetPrice,
      valueBefore: currentValue(slot),
      valueAfter: currentValue(slot),
      slotValue: currentValue(slot),
      gains: Number(slot.gains || 0),
      statusBefore: slot.status,
      statusAfter: "aberto",
      note: "Preco atual atingiu o preco de entrada configurado. Nenhuma ordem real foi enviada."
    }
  });

  revalidatePath("/dashboard");
  revalidatePath("/slots");
  revalidatePath("/historico");
  revalidatePath("/config");

  return { registered: true, message, asset, slotId: slot.id, slotNumber: slot.slot_number };
}

export async function registerAutoGain(payload: { slotId: string; currentPrice: number; targetPrice?: number }) {
  const { supabase, user } = await getUserClient();
  const slotId = String(payload.slotId || "");
  const currentPrice = Number(payload.currentPrice || 0);

  if (!slotId || currentPrice <= 0) {
    return { registered: false };
  }

  const { data: slot } = await supabase
    .from("slots")
    .select("id,strategy_id,slot_number,sort_order,status,gains,base_value,gain_rate,preco_entrada,preco_atual,preco_alvo")
    .eq("id", slotId)
    .eq("user_id", user.id)
    .single<SlotRecord>();

  if (!slot || slot.status !== "aberto") {
    return { registered: false };
  }

  const { data: strategy } = await supabase
    .from("strategies")
    .select("key,title,asset,gain_rate")
    .eq("id", slot.strategy_id)
    .eq("user_id", user.id)
    .single<Pick<StrategyRecord, "key" | "title" | "asset" | "gain_rate">>();

  const entryPrice = Number(slot.preco_entrada || 0);
  const strategyGainRate = Number(strategy?.gain_rate || 0);
  const targetPrice = entryPrice > 0 ? entryPrice * (1 + strategyGainRate) : Number(slot.preco_alvo || payload.targetPrice || 0);
  if (targetPrice <= 0 || currentPrice < targetPrice) {
    return { registered: false };
  }

  const gains = Number(slot.gains || 0) + 1;
  const valueBefore = currentValue(slot);
  const nextSlot = { ...slot, gains };
  const valueAfter = currentValue(nextSlot);

  const { data: updatedSlot } = await supabase
    .from("slots")
    .update({ status: "gain", gains, started_once: true, preco_entrada: null, preco_atual: null, preco_alvo: null })
    .eq("id", slot.id)
    .eq("user_id", user.id)
    .eq("status", "aberto")
    .select("id")
    .single();

  if (!updatedSlot) {
    return { registered: false };
  }

  const asset = strategy?.asset?.toUpperCase() || "BTC";
  const message = `Gain automatico registrado no ${asset} - Slot ${slot.slot_number}`;

  await addHistory("auto_gain", message, {
    userId: user.id,
    strategyId: slot.strategy_id,
    slotId: slot.id,
    strategyKey: strategy?.key || null,
    slotNumber: slot.slot_number,
    metadata: {
      asset,
      eventType: "saida_automatica",
      origin: "AUTO_GAIN",
      expectedPrice: targetPrice,
      executedPrice: currentPrice,
      currentPrice,
      targetPrice,
      valueBefore,
      valueAfter,
      slotValue: valueAfter,
      gains,
      statusBefore: slot.status,
      statusAfter: "gain",
      realizedProfit: valueAfter - valueBefore,
      note: "Preco atual atingiu o alvo configurado. Nenhuma ordem real foi enviada."
    }
  });

  revalidatePath("/dashboard");
  revalidatePath("/slots");
  revalidatePath("/historico");
  revalidatePath("/config");

  return { registered: true, message, asset, slotId: slot.id, slotNumber: slot.slot_number };
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

  await supabase
    .from("slots")
    .update({ status: "zerado", gains: 0, started_once: false, notes: "", preco_entrada: null, preco_atual: null, preco_alvo: null })
    .eq("id", slot.id)
    .eq("user_id", user.id);
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
  const gains = Math.max(0, formInt(formData, "gains", 0));
  const baseValue = Math.max(0, formNumber(formData, "baseValue", 0));
  const entryPrice = Math.max(0, formNumber(formData, "entryPrice", 0));
  const currentPrice = Math.max(0, formNumber(formData, "currentPrice", 0));
  const targetPrice = Math.max(0, formNumber(formData, "targetPrice", 0));
  const notes = formText(formData, "notes");
  const keepsPrices = status === "aberto" || status === "hold";

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

  await supabase
    .from("slots")
    .update({
      status,
      gains: status === "zerado" ? 0 : gains,
      base_value: baseValue,
      preco_entrada: keepsPrices && entryPrice > 0 ? entryPrice : null,
      preco_atual: status === "aberto" && currentPrice > 0 ? currentPrice : null,
      preco_alvo: keepsPrices && entryPrice > 0 ? entryPrice * (1 + strategyGainRate) : keepsPrices && targetPrice > 0 ? targetPrice : null,
      started_once: status !== "zerado",
      notes: status === "zerado" ? "" : notes
    })
    .eq("id", slot.id)
    .eq("user_id", user.id);

  await addHistory("Editar", `Slot editado para ${status}, ${status === "zerado" ? 0 : gains} gains.`, {
    userId: user.id,
    strategyId: slot.strategy_id,
    slotId: slot.id,
    strategyKey: strategy?.key || null,
    slotNumber: slot.slot_number,
    metadata: {
      asset: strategy?.asset || null,
      eventType: "edicao",
      origin: "MANUAL",
      expectedPrice: keepsPrices && entryPrice > 0 ? entryPrice : null,
      executedPrice: status === "aberto" && currentPrice > 0 ? currentPrice : null,
      currentPrice: status === "aberto" && currentPrice > 0 ? currentPrice : null,
      targetPrice: keepsPrices && entryPrice > 0 ? entryPrice * (1 + strategyGainRate) : keepsPrices && targetPrice > 0 ? targetPrice : null,
      valueBefore: currentValue(slot),
      valueAfter: baseValue * Math.pow(1 + Number(slot.gain_rate || 0), status === "zerado" ? 0 : gains),
      slotValue: baseValue,
      gains: status === "zerado" ? 0 : gains,
      statusBefore: slot.status,
      statusAfter: status,
      note: notes || "Slot editado manualmente."
    }
  });

  finish("Slot editado.");
}

export async function applyStrategyMarketPrices(formData: FormData) {
  const { supabase, user } = await getUserClient();
  const strategyId = formText(formData, "strategyId");
  const firstEntryPrice = Math.max(0, formNumber(formData, "firstEntryPrice", 0));
  const currentPrice = Math.max(0, formNumber(formData, "currentPrice", 0));

  if (!strategyId || firstEntryPrice <= 0) {
    return;
  }

  const { data: strategy } = await supabase
    .from("strategies")
    .select("id,key,title,asset,base_value,gain_rate,drop_percent")
    .eq("id", strategyId)
    .eq("user_id", user.id)
    .single<StrategyRecord>();

  if (!strategy) {
    return;
  }

  const { data: slots } = await supabase
    .from("slots")
    .select("id,slot_number,sort_order,status,gains,base_value,gain_rate,preco_entrada,preco_atual,preco_alvo")
    .eq("user_id", user.id)
    .eq("strategy_id", strategyId)
    .eq("status", "aberto")
    .order("sort_order", { ascending: true });

  const fallbackDropPercent = strategy.asset.toUpperCase() === "SOL" ? 8 : 2;
  const dropRate = Math.max(0, Number(strategy.drop_percent || fallbackDropPercent)) / 100;
  const gainRate = Number(strategy.gain_rate || 0);

  await Promise.all(
    (slots || []).map((slot, index) => {
      const entryPrice = firstEntryPrice * Math.pow(1 - dropRate, index);
      return supabase
        .from("slots")
        .update({
          preco_entrada: entryPrice,
          preco_atual: currentPrice > 0 ? currentPrice : null,
          preco_alvo: entryPrice * (1 + gainRate)
        })
        .eq("id", slot.id)
        .eq("user_id", user.id);
    })
  );

  for (const slot of slots || []) {
    const index = (slots || []).findIndex((item) => item.id === slot.id);
    const entryPrice = firstEntryPrice * Math.pow(1 - dropRate, index);
    const targetPrice = entryPrice * (1 + gainRate);

    await addHistory("Marcacao a mercado", `Preco de entrada recalculado em ${strategy.title} - Slot ${slot.slot_number}.`, {
      userId: user.id,
      strategyId,
      slotId: slot.id,
      strategyKey: strategy.key,
      slotNumber: slot.slot_number,
      metadata: {
        asset: strategy.asset,
        eventType: "marcacao_mercado",
        origin: "MANUAL",
        expectedPrice: entryPrice,
        executedPrice: null,
        currentPrice: currentPrice > 0 ? currentPrice : null,
        targetPrice,
        valueBefore: currentValue(slot),
        valueAfter: currentValue(slot),
        slotValue: currentValue(slot),
        gains: Number(slot.gains || 0),
        statusBefore: slot.status,
        statusAfter: slot.status,
        note: `Recalculo aplicado somente em slots abertos. Total afetado: ${slots?.length || 0}.`
      }
    });
  }

  finish("Precos de marcacao atualizados.");
}

export async function addBalance(formData: FormData) {
  const { supabase, user } = await getUserClient();
  const strategyId = formText(formData, "strategyId");
  const amount = Math.max(0, formNumber(formData, "amount", 0));

  if (!strategyId || amount <= 0) {
    return;
  }

  const { data: slots } = await supabase
    .from("slots")
    .select("id,base_value,slot_number,strategy_id")
    .eq("user_id", user.id)
    .eq("strategy_id", strategyId)
    .in("status", ["zerado", "gain"]);

  const updates = (slots || []).map((slot) =>
    supabase
      .from("slots")
      .update({ base_value: Number(slot.base_value || 0) + amount })
      .eq("id", slot.id)
      .eq("user_id", user.id)
  );

  await Promise.all(updates);
  await addHistory("Adicionar saldo", `${formatUsdt(amount)} adicionados ao valor base de ${slots?.length || 0} slots fechados.`, {
    userId: user.id,
    strategyId
  });

  finish("Saldo adicionado.");
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
    .select("id,strategy_id,slot_number,sort_order,status,gains,base_value,gain_rate,preco_entrada,preco_atual,preco_alvo")
    .eq("id", slotId)
    .eq("user_id", userId)
    .single<SlotRecord>();

  return data;
}
