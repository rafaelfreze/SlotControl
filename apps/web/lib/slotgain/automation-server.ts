import { createServiceRoleClient } from "@/lib/supabase/service-role";

import { automationIdempotencyKey, findFirstCrossedWindow, type AutomationAsset, type AutomationEventType, type PriceWindow } from "./automation";
import { DEFAULT_ASSET_MARKET_SETTINGS, DEFAULT_MARKET_REGIME_SETTINGS, asMarketRegime, effectiveMarketRegime, selectOperablePendingSlots, type AssetMarketStrategySettings } from "./market-regime";
import { refreshBtcMarketRegime } from "./market-regime-server";

type AutomationMode = "off" | "exit_only" | "entry_exit";
type SlotStatus = "zerado" | "aberto" | "gain" | "hold";

type UserSettingRow = { user_id: string; settings: Record<string, unknown> | null };
type StrategyRow = { key: string | null; asset: string | null; gain_rate: number | string | null };
type SlotAutomationRow = {
  id: string;
  user_id: string;
  strategy_id: string;
  slot_number: number;
  sort_order: number;
  status: SlotStatus;
  gains: number;
  gains_distribuidos: number;
  preco_entrada: number | string | null;
  preco_alvo: number | string | null;
  updated_at: string | null;
  strategies?: StrategyRow | StrategyRow[] | null;
};
type CursorClaim = { ok: boolean; code?: string; asset?: AutomationAsset; start?: string; end?: string };
type AutomationDecisionResult = { ok: boolean; decision?: "EXECUTED" | "SKIPPED" | "RETRY" | "FAILED" | "BLOCKED"; reason?: string; message?: string };

export type AutomationStats = {
  activeUsers: number;
  checkedSlots: number;
  entriesExecuted: number;
  gainsExecuted: number;
  ignoredSlots: number;
  candlesProcessed: number;
  backlogCandles: number;
  errors: string[];
  prices: Partial<Record<AutomationAsset, number>>;
  marketRegime: string | null;
  sourceByAsset: Partial<Record<AutomationAsset, string>>;
};

export type AutomationDiagnostics = {
  worker: { status: string; startedAt: string | null; completedAt: string | null; source: string | null; error: string | null; stats: Record<string, unknown> } | null;
  cursors: Array<{ asset: string; lastWindowEnd: string | null; lastSource: string | null; lastSuccessAt: string | null; lastError: string | null; lockedUntil: string | null }>;
  latestWindows: Array<{ asset: string; windowEnd: string; low: number | string; high: number | string; close: number | string; source: string }>;
  decisions: Array<{ id: string; asset: string; slotId: string; eventType: string; decision: string; reason: string; triggerPrice: number | string | null; intervalLow: number | string | null; intervalHigh: number | string | null; windowEnd: string; createdAt: string }>;
};

const BINANCE_SYMBOLS: Record<AutomationAsset, string> = { BTC: "BTCUSDT", SOL: "SOLUSDT" };
const BINANCE_KLINE_BASES = ["https://api.binance.com", "https://data-api.binance.vision"];
const MAX_CANDLES_PER_RUN = 300;
const INITIAL_BACKFILL_MINUTES = 360;

function getAutomationMode(settings: Record<string, unknown> | null): AutomationMode {
  const mode = settings?.automationMode;
  if (mode === "exit_only" || mode === "entry_exit" || mode === "off") return mode;
  return settings?.autoGainEnabled === true ? "exit_only" : "off";
}

function strategyFor(slot: SlotAutomationRow) {
  return Array.isArray(slot.strategies) ? slot.strategies[0] || null : slot.strategies || null;
}

function assetFor(slot: SlotAutomationRow): AutomationAsset {
  return strategyFor(slot)?.asset?.toUpperCase() === "SOL" ? "SOL" : "BTC";
}

function numeric(value: number | string | null | undefined) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function sanitizeError(error: unknown) {
  return (error instanceof Error ? error.message : "Erro desconhecido").replace(/[\r\n]+/g, " ").slice(0, 400);
}

async function fetchCandles(asset: AutomationAsset, start: string, end: string): Promise<PriceWindow[]> {
  const params = new URLSearchParams({
    symbol: BINANCE_SYMBOLS[asset],
    interval: "1m",
    startTime: String(new Date(start).getTime()),
    endTime: String(new Date(end).getTime()),
    limit: String(MAX_CANDLES_PER_RUN)
  });
  let lastError: unknown;

  for (const [index, base] of BINANCE_KLINE_BASES.entries()) {
    try {
      const response = await fetch(`${base}/api/v3/klines?${params}`, {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(12_000)
      });
      if (!response.ok) throw new Error(`Fonte de candles respondeu ${response.status}.`);
      const rows = await response.json() as Array<[number, string, string, string, string, string, number]>;
      const source = index === 0 ? "BINANCE_GLOBAL_1M" : "BINANCE_DATA_API_1M_FALLBACK";
      const windows = rows.map((row) => ({
        asset,
        windowStart: new Date(row[0]).toISOString(),
        windowEnd: new Date(row[6]).toISOString(),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        source
      })).filter((window) => window.windowEnd <= end && Number.isFinite(window.open) && Number.isFinite(window.high) && Number.isFinite(window.low) && Number.isFinite(window.close));
      if (!windows.length) throw new Error("A fonte nao retornou candles fechados para a janela solicitada.");
      return windows;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Candles de ${asset} indisponiveis: ${sanitizeError(lastError)}`);
}

async function loadAutomationSlots(marketRegime: string | null) {
  const supabase = createServiceRoleClient();
  const { data: settingsRows, error: settingsError } = await supabase.from("user_settings").select("user_id,settings").returns<UserSettingRow[]>();
  if (settingsError) throw settingsError;

  const activeSettings = (settingsRows || []).map((row) => ({ userId: row.user_id, mode: getAutomationMode(row.settings) })).filter((row) => row.mode !== "off");
  if (!activeSettings.length) return { activeSettings, slots: [] as SlotAutomationRow[], allowedHoldIds: new Set<string>() };

  const userIds = activeSettings.map((row) => row.userId);
  const [slotsResponse, regimeResponse, assetSettingsResponse] = await Promise.all([
    supabase.from("slots").select("id,user_id,strategy_id,slot_number,sort_order,status,gains,gains_distribuidos,preco_entrada,preco_alvo,updated_at,strategies(key,asset,gain_rate)").in("user_id", userIds).returns<SlotAutomationRow[]>(),
    supabase.from("market_regime_settings").select("user_id,mode_source,manual_mode,last_effective_mode").in("user_id", userIds),
    supabase.from("asset_market_strategy_settings").select("user_id,asset,buy_drop_top_percent,buy_drop_normal_percent,buy_drop_deep_percent,top_zero_reserve_count,normal_zero_reserve_count,deep_zero_reserve_count,deep_active_slot_limit").in("user_id", userIds)
  ]);
  if (slotsResponse.error) throw slotsResponse.error;
  if (regimeResponse.error) throw regimeResponse.error;
  if (assetSettingsResponse.error) throw assetSettingsResponse.error;

  const automaticMode = asMarketRegime(marketRegime) || "NORMAL";
  const regimeByUser = new Map((regimeResponse.data || []).map((row) => [row.user_id, row]));
  const settingsByAsset = new Map<string, Partial<AssetMarketStrategySettings>>();
  for (const row of assetSettingsResponse.data || []) settingsByAsset.set(`${row.user_id}:${row.asset}`, row as Partial<AssetMarketStrategySettings>);

  const allowedHoldIds = new Set<string>();
  const grouped = new Map<string, SlotAutomationRow[]>();
  for (const slot of slotsResponse.data || []) {
    const key = `${slot.user_id}:${assetFor(slot)}`;
    grouped.set(key, [...(grouped.get(key) || []), slot]);
  }
  for (const [key, userSlots] of grouped) {
    const separator = key.lastIndexOf(":");
    const userId = key.slice(0, separator);
    const asset = key.slice(separator + 1) as AutomationAsset;
    const configured = regimeByUser.get(userId);
    const regime = effectiveMarketRegime({
      ...DEFAULT_MARKET_REGIME_SETTINGS,
      mode_source: configured?.mode_source === "MANUAL" ? "MANUAL" : "AUTO",
      manual_mode: asMarketRegime(configured?.manual_mode)
    }, asMarketRegime(configured?.last_effective_mode) || automaticMode);
    const assetSettings = settingsByAsset.get(`${userId}:${asset}`) || DEFAULT_ASSET_MARKET_SETTINGS[asset];
    for (const slot of selectOperablePendingSlots(asset, regime, userSlots, assetSettings)) allowedHoldIds.add(slot.id);
  }

  return { activeSettings, slots: slotsResponse.data || [], allowedHoldIds };
}

async function processAssetWindows(input: {
  asset: AutomationAsset;
  workerRunId: string;
  slots: SlotAutomationRow[];
  modeByUser: Map<string, AutomationMode>;
  allowedHoldIds: Set<string>;
  stats: AutomationStats;
}) {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc("claim_automation_asset_cursor", {
    p_asset: input.asset,
    p_worker_run_id: input.workerRunId,
    p_lock_seconds: 120,
    p_initial_backfill_minutes: INITIAL_BACKFILL_MINUTES
  });
  if (error) throw error;
  const claim = data as CursorClaim;
  if (!claim?.ok) return;

  try {
    const windows = await fetchCandles(input.asset, String(claim.start), String(claim.end));
    const source = windows[0]?.source || "BINANCE_1M";
    input.stats.candlesProcessed += windows.length;
    const lastFetchedWindowEnd = windows.at(-1)?.windowEnd;
    const remainingMilliseconds = lastFetchedWindowEnd ? new Date(String(claim.end)).getTime() - new Date(lastFetchedWindowEnd).getTime() : 0;
    input.stats.backlogCandles += Math.max(0, Math.ceil(remainingMilliseconds / 60_000));
    input.stats.prices[input.asset] = windows.at(-1)?.close;
    input.stats.sourceByAsset[input.asset] = source;

    const { error: upsertError } = await supabase.from("automation_price_windows").upsert(
      windows.map((window) => ({
        asset: window.asset,
        window_start: window.windowStart,
        window_end: window.windowEnd,
        open_price: window.open,
        high_price: window.high,
        low_price: window.low,
        close_price: window.close,
        source: window.source,
        worker_run_id: input.workerRunId
      })),
      { onConflict: "asset,window_start" }
    );
    if (upsertError) throw upsertError;

    const actionable = input.slots.filter((slot) => assetFor(slot) === input.asset && (
      slot.status === "aberto" || (slot.status === "hold" && input.allowedHoldIds.has(slot.id))
    ));
    input.stats.checkedSlots += actionable.length;

    for (const slot of actionable) {
      const mode = input.modeByUser.get(slot.user_id) || "off";
      const eventType: AutomationEventType | null = slot.status === "hold" && mode === "entry_exit"
        ? "ENTRY"
        : slot.status === "aberto" && (mode === "exit_only" || mode === "entry_exit")
          ? "EXIT"
          : null;
      const triggerPrice = eventType === "ENTRY" ? numeric(slot.preco_entrada) : numeric(slot.preco_alvo);
      if (!eventType || triggerPrice <= 0) {
        input.stats.ignoredSlots += 1;
        continue;
      }

      const crossedWindow = findFirstCrossedWindow(eventType, windows, triggerPrice, slot.updated_at);
      if (!crossedWindow) {
        input.stats.ignoredSlots += 1;
        continue;
      }
      const index = windows.findIndex((window) => window.windowStart === crossedWindow.windowStart);
      const previousPrice = index > 0 ? windows[index - 1]?.close : null;
      const idempotencyKey = automationIdempotencyKey({ asset: input.asset, slotId: slot.id, eventType, triggerPrice, windowStart: crossedWindow.windowStart });
      const { data: decisionData, error: decisionError } = await supabase.rpc("execute_slot_automation_decision", {
        p_slot_id: slot.id,
        p_event_type: eventType,
        p_asset: input.asset,
        p_trigger_price: triggerPrice,
        p_previous_price: previousPrice,
        p_current_price: crossedWindow.close,
        p_interval_low: crossedWindow.low,
        p_interval_high: crossedWindow.high,
        p_window_start: crossedWindow.windowStart,
        p_window_end: crossedWindow.windowEnd,
        p_source: crossedWindow.source,
        p_worker_run_id: input.workerRunId,
        p_idempotency_key: idempotencyKey
      });
      if (decisionError) throw decisionError;
      const decision = decisionData as AutomationDecisionResult;
      if (decision.decision === "EXECUTED") {
        if (eventType === "ENTRY") input.stats.entriesExecuted += 1;
        else input.stats.gainsExecuted += 1;
      } else {
        input.stats.ignoredSlots += 1;
      }
    }

    const lastWindowEnd = windows.at(-1)?.windowEnd || null;
    const { error: completeError } = await supabase.rpc("complete_automation_asset_cursor", {
      p_asset: input.asset,
      p_worker_run_id: input.workerRunId,
      p_last_window_end: lastWindowEnd,
      p_source: source,
      p_error: null
    });
    if (completeError) throw completeError;
  } catch (error) {
    const message = sanitizeError(error);
    input.stats.errors.push(`${input.asset}: ${message}`);
    await supabase.rpc("complete_automation_asset_cursor", {
      p_asset: input.asset,
      p_worker_run_id: input.workerRunId,
      p_last_window_end: null,
      p_source: null,
      p_error: message
    });
  }
}

export async function runSlotAutomationCron(): Promise<AutomationStats> {
  const supabase = createServiceRoleClient();
  const stats: AutomationStats = {
    activeUsers: 0,
    checkedSlots: 0,
    entriesExecuted: 0,
    gainsExecuted: 0,
    ignoredSlots: 0,
    candlesProcessed: 0,
    backlogCandles: 0,
    errors: [],
    prices: {},
    marketRegime: null,
    sourceByAsset: {}
  };
  const { data: worker, error: workerError } = await supabase.from("automation_worker_runs").insert({ status: "RUNNING" }).select("id").single<{ id: string }>();
  if (workerError || !worker) throw workerError || new Error("Nao foi possivel iniciar a auditoria do worker.");

  try {
    try {
      const market = await refreshBtcMarketRegime();
      stats.marketRegime = market.effective_mode;
    } catch (error) {
      stats.errors.push(`Regime BTC indisponivel: ${sanitizeError(error)}`);
    }

    const automation = await loadAutomationSlots(stats.marketRegime);
    stats.activeUsers = automation.activeSettings.length;
    const modeByUser = new Map(automation.activeSettings.map((row) => [row.userId, row.mode]));
    if (automation.activeSettings.length) {
      for (const asset of ["BTC", "SOL"] as const) {
        await processAssetWindows({ asset, workerRunId: worker.id, slots: automation.slots, modeByUser, allowedHoldIds: automation.allowedHoldIds, stats });
      }
    }

    try {
      const { processPendingPushNotifications } = await import("@/lib/push/server");
      await processPendingPushNotifications(25);
    } catch (error) {
      console.error("[slot-automation] push_dispatch_failed", { message: sanitizeError(error) });
    }

    const status = stats.errors.length ? "DEGRADED" : "COMPLETED";
    await supabase.from("automation_worker_runs").update({
      status,
      completed_at: new Date().toISOString(),
      source: Object.values(stats.sourceByAsset).join(",") || null,
      stats,
      error_message: stats.errors.length ? stats.errors.join(" | ").slice(0, 1200) : null
    }).eq("id", worker.id);
    console.info("[slot-automation] completed", { workerRunId: worker.id, status, ...stats });
    return stats;
  } catch (error) {
    const message = sanitizeError(error);
    await supabase.from("automation_worker_runs").update({ status: "FAILED", completed_at: new Date().toISOString(), stats, error_message: message }).eq("id", worker.id);
    throw error;
  }
}

export async function getAutomationDiagnostics(userId: string): Promise<AutomationDiagnostics> {
  const supabase = createServiceRoleClient();
  const [workerResponse, cursorsResponse, latestWindowsResponse, decisionsResponse] = await Promise.all([
    supabase.from("automation_worker_runs").select("status,started_at,completed_at,source,error_message,stats").order("started_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("automation_market_cursors").select("asset,last_window_end,last_source,last_success_at,last_error,locked_until").order("asset"),
    supabase.from("automation_price_windows").select("asset,window_end,low_price,high_price,close_price,source").order("window_end", { ascending: false }).limit(12),
    supabase.from("automation_decisions").select("id,asset,slot_id,event_type,decision,reason,trigger_price,interval_low,interval_high,window_end,created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(8)
  ]);
  if (workerResponse.error) throw workerResponse.error;
  if (cursorsResponse.error) throw cursorsResponse.error;
  if (latestWindowsResponse.error) throw latestWindowsResponse.error;
  if (decisionsResponse.error) throw decisionsResponse.error;
  const worker = workerResponse.data;
  return {
    worker: worker ? {
      status: worker.status,
      startedAt: worker.started_at,
      completedAt: worker.completed_at,
      source: worker.source,
      error: worker.error_message,
      stats: (worker.stats || {}) as Record<string, unknown>
    } : null,
    cursors: (cursorsResponse.data || []).map((cursor) => ({
      asset: cursor.asset,
      lastWindowEnd: cursor.last_window_end,
      lastSource: cursor.last_source,
      lastSuccessAt: cursor.last_success_at,
      lastError: cursor.last_error,
      lockedUntil: cursor.locked_until
    })),
    latestWindows: Array.from(new Map((latestWindowsResponse.data || []).map((window) => [window.asset, {
      asset: window.asset,
      windowEnd: window.window_end,
      low: window.low_price,
      high: window.high_price,
      close: window.close_price,
      source: window.source
    }])).values()),
    decisions: (decisionsResponse.data || []).map((decision) => ({
      id: decision.id,
      asset: decision.asset,
      slotId: decision.slot_id,
      eventType: decision.event_type,
      decision: decision.decision,
      reason: decision.reason,
      triggerPrice: decision.trigger_price,
      intervalLow: decision.interval_low,
      intervalHigh: decision.interval_high,
      windowEnd: decision.window_end,
      createdAt: decision.created_at
    }))
  };
}
