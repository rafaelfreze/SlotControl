import { createServiceRoleClient } from "@/lib/supabase/service-role";

type AutomationMode = "off" | "exit_only" | "entry_exit";
type SlotStatus = "zerado" | "aberto" | "gain" | "hold";
type Asset = "BTC" | "SOL";

type UserSettingRow = {
  user_id: string;
  settings: Record<string, unknown> | null;
};

type StrategyRow = {
  key: string | null;
  title: string | null;
  asset: string | null;
  gain_rate: number | string | null;
};

type SlotAutomationRow = {
  id: string;
  user_id: string;
  strategy_id: string;
  slot_number: number;
  status: SlotStatus;
  gains: number;
  base_value: number | string;
  gain_rate: number | string;
  preco_entrada: number | string | null;
  preco_atual: number | string | null;
  preco_alvo: number | string | null;
  strategies?: StrategyRow | StrategyRow[] | null;
};

type AutomationStats = {
  activeUsers: number;
  checkedSlots: number;
  entriesExecuted: number;
  gainsExecuted: number;
  ignoredSlots: number;
  errors: string[];
  prices: Partial<Record<Asset, number>>;
};

const BINANCE_SYMBOLS: Record<Asset, string> = {
  BTC: "BTCUSDT",
  SOL: "SOLUSDT"
};

function getAutomationMode(settings: Record<string, unknown> | null): AutomationMode {
  const mode = settings?.automationMode;
  if (mode === "exit_only" || mode === "entry_exit" || mode === "off") {
    return mode;
  }

  return settings?.autoGainEnabled === true ? "exit_only" : "off";
}

function normalizeStrategy(slot: SlotAutomationRow) {
  return Array.isArray(slot.strategies) ? slot.strategies[0] || null : slot.strategies || null;
}

function getAsset(slot: SlotAutomationRow): Asset {
  return normalizeStrategy(slot)?.asset?.toUpperCase() === "SOL" ? "SOL" : "BTC";
}

function currentValue(slot: Pick<SlotAutomationRow, "base_value" | "gain_rate" | "gains">) {
  return Number(slot.base_value || 0) * Math.pow(1 + Number(slot.gain_rate || 0), Number(slot.gains || 0));
}

function formatUsdt(value: number) {
  return `${new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)} USDT`;
}

function historyDetail(
  message: string,
  metadata: {
    asset: string;
    eventType: string;
    origin?: "MANUAL" | "AUTO_GAIN" | "CRON" | "SISTEMA" | "IMPORTACAO";
    expectedPrice: number | null;
    executedPrice: number | null;
    currentPrice?: number | null;
    targetPrice: number | null;
    valueBefore?: number | null;
    valueAfter?: number | null;
    slotValue: number | null;
    gains: number | null;
    statusBefore: string | null;
    statusAfter: string | null;
    realizedProfit?: number | null;
    note: string;
  }
) {
  return JSON.stringify({
    schemaVersion: 2,
    message,
    origin: metadata.origin || "CRON",
    ...metadata,
    duplicateKey: historyFingerprint(metadata),
    eventAt: new Date().toISOString()
  });
}

function historyFingerprint(metadata: Parameters<typeof historyDetail>[1]) {
  return JSON.stringify({
    eventType: metadata.eventType,
    expectedPrice: metadata.expectedPrice,
    executedPrice: metadata.executedPrice,
    currentPrice: metadata.currentPrice ?? null,
    targetPrice: metadata.targetPrice,
    valueBefore: metadata.valueBefore ?? null,
    valueAfter: metadata.valueAfter ?? null,
    slotValue: metadata.slotValue,
    gains: metadata.gains,
    statusBefore: metadata.statusBefore,
    statusAfter: metadata.statusAfter
  });
}

async function fetchBinancePrice(asset: Asset) {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${BINANCE_SYMBOLS[asset]}`;
  const method = "GET";

  console.log("[fetchBinancePrice] ASSET", asset);
  console.log("[fetchBinancePrice] URL", url);
  console.log("[fetchBinancePrice] METHOD", method);

  try {
    const response = await fetch(url, {
      method,
      cache: "no-store"
    });

    console.log("[fetchBinancePrice] STATUS", response.status);
    console.log("[fetchBinancePrice] STATUS_TEXT", response.statusText);

    const body = await response.text();
    console.log("[fetchBinancePrice] BODY", body);

    if (!response.ok) {
      throw new Error(`Falha ao buscar preco ${asset}. Status ${response.status}. Body: ${body}`);
    }

    let payload: { price?: string };
    try {
      payload = JSON.parse(body) as { price?: string };
    } catch (error) {
      console.error("[fetchBinancePrice] JSON_PARSE_ERROR", error);
      if (error instanceof Error) {
        console.error("[fetchBinancePrice] JSON_PARSE_STACK", error.stack);
      }
      throw error;
    }

    const price = Number(payload.price);

    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Preco invalido ${asset}. Body: ${body}`);
    }

    return price;
  } catch (error) {
    console.error("[fetchBinancePrice] EXCEPTION", error);
    if (error instanceof Error) {
      console.error("[fetchBinancePrice] EXCEPTION_STACK", error.stack);
    }

    try {
      console.error("[fetchBinancePrice] EXCEPTION_JSON", JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    } catch (jsonError) {
      console.error("[fetchBinancePrice] EXCEPTION_JSON_ERROR", jsonError);
    }

    throw error;
  }
}

async function insertHistory(
  supabase: ReturnType<typeof createServiceRoleClient>,
  slot: SlotAutomationRow,
  action: string,
  message: string,
  metadata: Parameters<typeof historyDetail>[1]
) {
  const strategy = normalizeStrategy(slot);
  const duplicateKey = historyFingerprint(metadata);
  const threeSecondsAgo = new Date(Date.now() - 3000).toISOString();
  const { data: recentEvents } = await supabase
    .from("history_events")
    .select("detail")
    .eq("user_id", slot.user_id)
    .eq("slot_id", slot.id)
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

  const { error: historyError } = await supabase.from("history_events").insert({
    user_id: slot.user_id,
    strategy_id: slot.strategy_id,
    slot_id: slot.id,
    action,
    detail: historyDetail(message, metadata),
    strategy_key: strategy?.key || null,
    slot_number: slot.slot_number
  });
  if (historyError) {
    throw historyError;
  }
}

async function executeAutomaticEntry({
  supabase,
  slot,
  price
}: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  slot: SlotAutomationRow;
  price: number;
}) {
  const strategy = normalizeStrategy(slot);
  const asset = getAsset(slot);
  const entryPrice = Number(slot.preco_entrada || 0);
  const strategyGainRate = Number(strategy?.gain_rate || slot.gain_rate || 0);
  const targetPrice = Number(slot.preco_alvo || 0) > 0 ? Number(slot.preco_alvo || 0) : entryPrice * (1 + strategyGainRate);

  if (slot.status !== "hold" || entryPrice <= 0 || targetPrice <= 0 || price > entryPrice) {
    return { executed: false, ignored: true };
  }

  const confirmedPrice = await fetchBinancePrice(asset);
  if (confirmedPrice > entryPrice) {
    return { executed: false, ignored: true };
  }

  const { data: updatedSlot } = await supabase
    .from("slots")
    .update({
      status: "aberto",
      started_once: true,
      preco_entrada: entryPrice,
      preco_atual: confirmedPrice,
      preco_alvo: targetPrice
    })
    .eq("id", slot.id)
    .eq("user_id", slot.user_id)
    .eq("status", "hold")
    .select("id")
    .single();

  if (!updatedSlot) {
    return { executed: false, ignored: true };
  }

  const message = `Entrada automatica registrada no ${asset} - Slot ${slot.slot_number}`;

  await insertHistory(supabase, slot, "entrada_automatica", message, {
      asset,
      eventType: "entrada_automatica",
      origin: "CRON",
      expectedPrice: entryPrice,
      executedPrice: confirmedPrice,
      currentPrice: confirmedPrice,
      targetPrice,
      valueBefore: currentValue(slot),
      valueAfter: currentValue(slot),
      slotValue: currentValue(slot),
    gains: Number(slot.gains || 0),
    statusBefore: slot.status,
    statusAfter: "aberto",
    note: "Vercel Cron abriu o slot internamente. Nenhuma ordem real foi enviada."
  });

  return { executed: true, ignored: false };
}

async function executeAutomaticExit({
  supabase,
  slot,
  price
}: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  slot: SlotAutomationRow;
  price: number;
}) {
  const asset = getAsset(slot);
  const targetPrice = Number(slot.preco_alvo || 0);

  if (slot.status !== "aberto" || targetPrice <= 0 || price < targetPrice) {
    return { executed: false, ignored: true };
  }

  const confirmedPrice = await fetchBinancePrice(asset);
  if (confirmedPrice < targetPrice) {
    return { executed: false, ignored: true };
  }

  const gains = Number(slot.gains || 0) + 1;
  const valueBefore = currentValue(slot);
  const nextSlot = { ...slot, gains };
  const valueAfter = currentValue(nextSlot);

  const { data: updatedSlot } = await supabase
    .from("slots")
    .update({
      status: "gain",
      gains,
      started_once: true,
      preco_entrada: null,
      preco_atual: null,
      preco_alvo: null
    })
    .eq("id", slot.id)
    .eq("user_id", slot.user_id)
    .eq("status", "aberto")
    .select("id")
    .single();

  if (!updatedSlot) {
    return { executed: false, ignored: true };
  }

  const message = `Gain automatico registrado no ${asset} - Slot ${slot.slot_number}`;

  await insertHistory(supabase, slot, "auto_gain", message, {
    asset,
    eventType: "saida_automatica",
    origin: "CRON",
    expectedPrice: targetPrice,
    executedPrice: confirmedPrice,
    currentPrice: confirmedPrice,
    targetPrice,
    valueBefore,
    valueAfter,
    slotValue: valueAfter,
    gains,
    statusBefore: slot.status,
    statusAfter: "gain",
    realizedProfit: valueAfter - valueBefore,
    note: `Vercel Cron registrou gain interno. Valor antes: ${formatUsdt(valueBefore)}. Valor depois: ${formatUsdt(valueAfter)}.`
  });

  return { executed: true, ignored: false };
}

export async function runSlotAutomationCron(): Promise<AutomationStats> {
  const supabase = createServiceRoleClient();
  const stats: AutomationStats = {
    activeUsers: 0,
    checkedSlots: 0,
    entriesExecuted: 0,
    gainsExecuted: 0,
    ignoredSlots: 0,
    errors: [],
    prices: {}
  };

  const { data: settingsRows, error: settingsError } = await supabase
    .from("user_settings")
    .select("user_id,settings")
    .returns<UserSettingRow[]>();

  if (settingsError) {
    throw settingsError;
  }

  const activeSettings = (settingsRows || [])
    .map((row) => ({ userId: row.user_id, mode: getAutomationMode(row.settings) }))
    .filter((row) => row.mode !== "off");

  stats.activeUsers = activeSettings.length;

  if (!activeSettings.length) {
    return stats;
  }

  const modeByUser = new Map(activeSettings.map((row) => [row.userId, row.mode]));
  const userIds = activeSettings.map((row) => row.userId);

  const [btcPrice, solPrice] = await Promise.all([fetchBinancePrice("BTC"), fetchBinancePrice("SOL")]);
  stats.prices = { BTC: btcPrice, SOL: solPrice };

  const { data: slots, error: slotsError } = await supabase
    .from("slots")
    .select("id,user_id,strategy_id,slot_number,status,gains,base_value,gain_rate,preco_entrada,preco_atual,preco_alvo,strategies(key,title,asset,gain_rate)")
    .in("user_id", userIds)
    .in("status", ["aberto", "hold"])
    .returns<SlotAutomationRow[]>();

  if (slotsError) {
    throw slotsError;
  }

  stats.checkedSlots = slots?.length || 0;

  for (const slot of slots || []) {
    const mode = modeByUser.get(slot.user_id) || "off";
    const asset = getAsset(slot);
    const price = asset === "SOL" ? solPrice : btcPrice;

    try {
      if (mode === "entry_exit" && slot.status === "hold") {
        const result = await executeAutomaticEntry({ supabase, slot, price });
        if (result.executed) {
          stats.entriesExecuted += 1;
        } else if (result.ignored) {
          stats.ignoredSlots += 1;
        }
        continue;
      }

      if ((mode === "exit_only" || mode === "entry_exit") && slot.status === "aberto") {
        const result = await executeAutomaticExit({ supabase, slot, price });
        if (result.executed) {
          stats.gainsExecuted += 1;
        } else if (result.ignored) {
          stats.ignoredSlots += 1;
        }
        continue;
      }

      stats.ignoredSlots += 1;
    } catch (error) {
      stats.errors.push(error instanceof Error ? error.message : "Erro desconhecido no slot");
    }
  }

  try {
    const { processPendingPushNotifications } = await import("@/lib/push/server");
    await processPendingPushNotifications(25);
  } catch (error) {
    console.error("[push-worker] automation_dispatch_failed", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
  }

  return stats;
}
