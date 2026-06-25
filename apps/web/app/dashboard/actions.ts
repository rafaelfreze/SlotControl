"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

type SlotStatus = "zerado" | "aberto" | "gain";

type SlotRecord = {
  id: string;
  strategy_id: string;
  slot_number: number;
  sort_order: number;
  status: SlotStatus | "hold";
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
  }
) {
  const { supabase } = await getUserClient();
  await supabase.from("history_events").insert({
    user_id: payload.userId,
    strategy_id: payload.strategyId || null,
    slot_id: payload.slotId || null,
    action,
    detail,
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
  const redistributionTarget = Math.max(0, formInt(formData, "redistributionTarget", 0));

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
      redistribution_target: redistributionTarget,
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
  const redistributionTarget = Math.max(0, formInt(formData, "redistributionTarget", 0));

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
      restart_amount: restartAmount,
      redistribution_target: redistributionTarget
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

  await supabase
    .from("slots")
    .update({
      status: "aberto",
      started_once: true,
      preco_alvo:
        Number(slot.preco_alvo || 0) > 0
          ? Number(slot.preco_alvo)
          : Number(slot.preco_entrada || 0) > 0
            ? Number(slot.preco_entrada) * (1 + Number(slot.gain_rate || 0))
            : null
    })
    .eq("id", slot.id)
    .eq("user_id", user.id);
  await addHistory("Abertura", `Slot aberto com valor calculado de ${formatUsdt(currentValue(slot))}.`, {
    userId: user.id,
    strategyId: slot.strategy_id,
    slotId: slot.id,
    slotNumber: slot.slot_number
  });

  finish("Slot aberto.");
}

export async function registerGain(formData: FormData) {
  const { supabase, user } = await getUserClient();
  const slot = await getSlotFromForm(supabase, user.id, formData);
  if (!slot || slot.status === "zerado") {
    return;
  }

  const gains = Number(slot.gains || 0) + 1;
  const nextSlot = { ...slot, gains };
  await supabase
    .from("slots")
    .update({ status: "gain", gains, started_once: true })
    .eq("id", slot.id)
    .eq("user_id", user.id);
  await addHistory("Gain", `Gain registrado. Novo valor: ${formatUsdt(currentValue(nextSlot))}.`, {
    userId: user.id,
    strategyId: slot.strategy_id,
    slotId: slot.id,
    slotNumber: slot.slot_number
  });

  finish("Gain registrado.");
}

export async function resetSlot(formData: FormData) {
  const { supabase, user } = await getUserClient();
  const slot = await getSlotFromForm(supabase, user.id, formData);
  if (!slot) {
    return;
  }

  await supabase
    .from("slots")
    .update({ status: "zerado", gains: 0, started_once: false, notes: "" })
    .eq("id", slot.id)
    .eq("user_id", user.id);
  await addHistory("Zerar", "Slot zerado manualmente.", {
    userId: user.id,
    strategyId: slot.strategy_id,
    slotId: slot.id,
    slotNumber: slot.slot_number
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

  if (!slot || !["zerado", "aberto", "gain"].includes(status)) {
    return;
  }

  await supabase
    .from("slots")
    .update({
      status,
      gains: status === "zerado" ? 0 : gains,
      base_value: baseValue,
      preco_entrada: entryPrice > 0 ? entryPrice : null,
      preco_atual: currentPrice > 0 ? currentPrice : null,
      preco_alvo: targetPrice > 0 ? targetPrice : entryPrice > 0 ? entryPrice * Number(slot.gain_rate || 0) + entryPrice : null,
      started_once: status !== "zerado",
      notes: status === "zerado" ? "" : notes
    })
    .eq("id", slot.id)
    .eq("user_id", user.id);

  await addHistory("Editar", `Slot editado para ${status}, ${status === "zerado" ? 0 : gains} gains.`, {
    userId: user.id,
    strategyId: slot.strategy_id,
    slotId: slot.id,
    slotNumber: slot.slot_number
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
    .select("id,slot_number,sort_order")
    .eq("user_id", user.id)
    .eq("strategy_id", strategyId)
    .order("sort_order", { ascending: true });

  const dropRate = Math.max(0, Number(strategy.drop_percent || 0)) / 100;
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

  await addHistory("Marcacao a mercado", `Precos de entrada aplicados em ${slots?.length || 0} slots de ${strategy.title}.`, {
    userId: user.id,
    strategyId,
    strategyKey: strategy.key
  });

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

export async function redistributeGains(formData: FormData) {
  const { supabase, user } = await getUserClient();
  const strategyId = formText(formData, "strategyId");

  if (!strategyId) {
    return;
  }

  const { data: slots } = await supabase
    .from("slots")
    .select("id,gains,slot_number,strategy_id,status,base_value,gain_rate,sort_order")
    .eq("user_id", user.id)
    .eq("strategy_id", strategyId)
    .in("status", ["zerado", "gain"])
    .order("sort_order", { ascending: true });

  if (!slots?.length) {
    return;
  }

  const totalGains = slots.reduce((sum, slot) => sum + Number(slot.gains || 0), 0);
  const baseGains = Math.floor(totalGains / slots.length);
  const extraGains = totalGains % slots.length;

  await Promise.all(
    slots.map((slot, index) => {
      const gains = baseGains + (index < extraGains ? 1 : 0);
      return supabase
        .from("slots")
        .update({
          gains,
          status: gains > 0 ? "gain" : "zerado",
          started_once: gains > 0
        })
        .eq("id", slot.id)
        .eq("user_id", user.id);
    })
  );

  await addHistory("Redistribuicao", `${totalGains} gains redistribuidos em ${slots.length} slots fechados.`, {
    userId: user.id,
    strategyId
  });

  finish("Gains redistribuidos.");
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
