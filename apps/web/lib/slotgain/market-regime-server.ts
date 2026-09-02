import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import type { OfficialStrategyMode } from "@/lib/coinops-monitoring/domain";
import { DEFAULT_ASSET_MARKET_SETTINGS, DEFAULT_MARKET_REGIME_SETTINGS, activeBuyDropPercent, applyMarketRegimeHysteresis, asMarketRegime, calculateMarketRegime, distanceFromAthPercent, effectiveMarketRegime, selectOperablePendingSlots, type AssetMarketStrategySettings, type BtcMarketState, type MarketRegime, type MarketRegimeSettings } from "./market-regime";
import { buildOfficialFutureEntryPlan, type OfficialTriggerSlot } from "./official-entry-triggers";

type BinanceKline = [number, string, string, string, string];
type StateRow = BtcMarketState & { singleton: boolean };

const BINANCE_TICKER_URL = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";
const BINANCE_SOL_TICKER_URL = "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT";
const BINANCE_MONTHLY_URL = "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1M&limit=1000";
const BINANCE_DAILY_URL = "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=2";
const COINGECKO_BTC_URL = "https://api.coingecko.com/api/v3/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false";
const COINGECKO_SOL_URL = "https://api.coingecko.com/api/v3/coins/solana?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false";

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Binance respondeu ${response.status}.`);
  return response.json() as Promise<T>;
}

async function fetchBtcReferencePrices() {
  try {
    const [ticker, solTicker, monthly, daily] = await Promise.all([
      fetchJson<{ price?: string }>(BINANCE_TICKER_URL),
      fetchJson<{ price?: string }>(BINANCE_SOL_TICKER_URL),
      fetchJson<BinanceKline[]>(BINANCE_MONTHLY_URL),
      fetchJson<BinanceKline[]>(BINANCE_DAILY_URL)
    ]);
    const currentPrice = Number(ticker.price);
    const solCurrentPrice = Number(solTicker.price);
    const monthlyHigh = Math.max(...monthly.map((candle) => Number(candle[2])));
    const latestClosedDaily = daily.length > 1 ? Number(daily[0]?.[4]) : currentPrice;
    if (![currentPrice, solCurrentPrice, monthlyHigh, latestClosedDaily].every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error("Referencia da Binance invalida.");
    }
    return { currentPrice, solCurrentPrice, monthlyHigh, latestClosedDaily, source: "BINANCE_BTCUSDT_MONTHLY_HIGH" };
  } catch (binanceError) {
    const [coin, solCoin] = await Promise.all([
      fetchJson<{ market_data?: { ath?: { usd?: number }; current_price?: { usd?: number } } }>(COINGECKO_BTC_URL),
      fetchJson<{ market_data?: { current_price?: { usd?: number } } }>(COINGECKO_SOL_URL)
    ]);
    const currentPrice = Number(coin.market_data?.current_price?.usd);
    const solCurrentPrice = Number(solCoin.market_data?.current_price?.usd);
    const athPrice = Number(coin.market_data?.ath?.usd);
    if (![currentPrice, solCurrentPrice, athPrice].every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error(`Fontes de ATH indisponiveis: ${binanceError instanceof Error ? binanceError.message : "Binance sem resposta"}.`);
    }
    return { currentPrice, solCurrentPrice, monthlyHigh: athPrice, latestClosedDaily: currentPrice, source: "COINGECKO_BTC_SOL_USD_FALLBACK" };
  }
}

function asSettings(value: Record<string, unknown>): MarketRegimeSettings {
  return {
    ...DEFAULT_MARKET_REGIME_SETTINGS,
    top_threshold_percent: Number(value.top_threshold_percent ?? DEFAULT_MARKET_REGIME_SETTINGS.top_threshold_percent),
    deep_threshold_percent: Number(value.deep_threshold_percent ?? DEFAULT_MARKET_REGIME_SETTINGS.deep_threshold_percent),
    hysteresis_percent: Number(value.hysteresis_percent ?? DEFAULT_MARKET_REGIME_SETTINGS.hysteresis_percent),
    mode_source: value.mode_source === "MANUAL" ? "MANUAL" : "AUTO",
    manual_mode: asMarketRegime(value.manual_mode),
    last_effective_mode: asMarketRegime(value.last_effective_mode),
    manual_reason: typeof value.manual_reason === "string" ? value.manual_reason : null
  };
}

type PendingSlot = { id: string; strategy_id: string; slot_number: number; sort_order: number; status: "zerado" | "aberto" | "gain" | "hold"; gains: number; operational_gains: number | string; operational_slot_value: number | string; preco_entrada: number | string | null; strategies: { asset: string | null; gain_rate: number | string | null } | null };
type OfficialProgressRow = { cycle_id: string; slot_id: string; asset: "BTC" | "SOL"; cycle_progress: number | string; last_operated_at: string | null };
type OfficialPoolRow = { baseline_id: string; slot_id: string | null; asset: "BTC" | "SOL"; slot_number: number; pool: "MAIN" | "RESERVE"; enabled: boolean; funded: boolean; allow_reserve: boolean; active_from_cycle: number };
type OfficialTriggerContext = { baselineId: string; userId: string; tenantId: string; mode: OfficialStrategyMode; cycleId: string; cycleNumber: number; progress: OfficialProgressRow[]; pool: OfficialPoolRow[] };

function officialScopeKey(userId: string, tenantId: unknown) {
  return `${typeof tenantId === "string" ? tenantId : ""}:${userId}`;
}

async function loadOfficialTriggerContexts(tenantId: string | null) {
  const supabase = createServiceRoleClient();
  let baselineQuery = supabase.from("monitoring_baselines").select("id,user_id,tenant_id").eq("status", "ACTIVE");
  if (tenantId) baselineQuery = baselineQuery.eq("tenant_id", tenantId);
  const { data: baselineRows, error: baselineError } = await baselineQuery;
  if (baselineError) throw baselineError;
  if (!baselineRows?.length) return new Map<string, OfficialTriggerContext>();

  const baselineIds = baselineRows.map((row) => row.id);
  const [{ data: regimeRows, error: regimeError }, { data: cycleRows, error: cycleError }, { data: poolRows, error: poolError }] = await Promise.all([
    supabase.from("strategy_regime_state").select("baseline_id,mode").in("baseline_id", baselineIds),
    supabase.from("operational_cycles").select("id,baseline_id,cycle_number").in("baseline_id", baselineIds).eq("status", "ACTIVE"),
    supabase.from("slot_pool_configuration").select("baseline_id,slot_id,asset,slot_number,pool,enabled,funded,allow_reserve,active_from_cycle").in("baseline_id", baselineIds)
  ]);
  if (regimeError) throw regimeError;
  if (cycleError) throw cycleError;
  if (poolError) throw poolError;

  const cycleIds = (cycleRows || []).map((row) => row.id);
  const { data: progressRows, error: progressError } = cycleIds.length
    ? await supabase.from("cycle_slot_progress").select("cycle_id,slot_id,asset,cycle_progress,last_operated_at").in("cycle_id", cycleIds)
    : { data: [], error: null };
  if (progressError) throw progressError;

  const contexts = new Map<string, OfficialTriggerContext>();
  for (const baseline of baselineRows) {
    const regime = (regimeRows || []).find((row) => row.baseline_id === baseline.id);
    const cycle = (cycleRows || []).find((row) => row.baseline_id === baseline.id);
    if (!regime || !cycle || (regime.mode !== "NORMAL_GROWTH" && regime.mode !== "DEFENSIVE_POST_ATH")) {
      throw new Error("COINOPS_OFFICIAL_TRIGGER_CONTEXT_INCOMPLETE");
    }
    contexts.set(officialScopeKey(baseline.user_id, baseline.tenant_id), {
      baselineId: baseline.id,
      userId: baseline.user_id,
      tenantId: baseline.tenant_id,
      mode: regime.mode,
      cycleId: cycle.id,
      cycleNumber: Number(cycle.cycle_number),
      progress: (progressRows || []).filter((row) => row.cycle_id === cycle.id) as OfficialProgressRow[],
      pool: (poolRows || []).filter((row) => row.baseline_id === baseline.id) as OfficialPoolRow[]
    });
  }
  return contexts;
}

export async function recalculateFutureEntryTriggers(userId: string, regime: MarketRegime, settingsByAsset: Record<"BTC" | "SOL", Partial<AssetMarketStrategySettings>>, officialContext?: OfficialTriggerContext) {
  const supabase = createServiceRoleClient();
  const tenantId = getCoinOpsServiceTenantId();
  const scopedTenantId = officialContext?.tenantId || tenantId;
  let slotsQuery = supabase
    .from("slots")
    .select("id,strategy_id,slot_number,sort_order,status,gains,operational_gains,operational_slot_value,preco_entrada,strategies(asset,gain_rate)")
    .eq("user_id", userId)
    .in("status", ["aberto", "hold"]);
  if (scopedTenantId) slotsQuery = slotsQuery.eq("tenant_id", scopedTenantId);
  const { data: rows, error } = await slotsQuery;
  if (error) throw error;
  let recalculated = 0;
  for (const asset of ["BTC", "SOL"] as const) {
    const slots = ((rows || []) as unknown as PendingSlot[]).filter((slot) => (slot.strategies?.asset || "BTC").toUpperCase() === asset);
    const reference = Math.min(...slots.filter((slot) => slot.status === "aberto").map((slot) => Number(slot.preco_entrada || 0)).filter((value) => value > 0));
    if (!Number.isFinite(reference)) continue;
    let pending: PendingSlot[];
    let drop: number;
    if (officialContext) {
      const progressBySlot = new Map(officialContext.progress.filter((row) => row.asset === asset).map((row) => [row.slot_id, row]));
      const triggerSlots = officialContext.pool.flatMap((pool): OfficialTriggerSlot[] => {
        const current = pool.asset === asset && pool.slot_id ? slots.find((slot) => slot.id === pool.slot_id) : null;
        const progress = current ? progressBySlot.get(current.id) : null;
        if (!current || !progress) return [];
        return [{
          id: current.id,
          asset,
          status: current.status,
          slotNumber: pool.slot_number,
          pool: pool.pool,
          enabled: pool.enabled,
          funded: pool.funded,
          allowReserve: pool.allow_reserve,
          activeFromCycleNumber: pool.active_from_cycle,
          operationalGains: Number(current.operational_gains || 0),
          operationalValue: Number(current.operational_slot_value || 0),
          cycleProgress: Number(progress.cycle_progress || 0),
          lastOperatedAt: progress.last_operated_at
        }];
      });
      const plan = buildOfficialFutureEntryPlan(asset, officialContext.mode, officialContext.cycleNumber, triggerSlots);
      const pendingById = new Map(slots.map((slot) => [slot.id, slot]));
      pending = plan.candidateIds.flatMap((id) => {
        const candidate = pendingById.get(id);
        return candidate ? [candidate] : [];
      });
      drop = plan.dropPercent;
    } else {
      const pendingIds = selectOperablePendingSlots(asset, regime, slots.map((slot) => ({ id: slot.id, slot_number: slot.slot_number, sort_order: slot.sort_order, status: slot.status, gains: Number(slot.gains || 0) })), settingsByAsset[asset]);
      const pendingById = new Map(slots.map((slot) => [slot.id, slot]));
      pending = pendingIds.flatMap((candidate) => {
        const slot = pendingById.get(candidate.id);
        return slot ? [slot] : [];
      });
      drop = activeBuyDropPercent(asset, regime, settingsByAsset[asset]);
    }
    for (const [index, candidate] of pending.entries()) {
      const slot = candidate;
      const entryPrice = Math.round(reference * Math.pow(1 - drop / 100, index + 1));
      if (Math.abs(Number(slot.preco_entrada || 0) - entryPrice) < 1) continue;
      const gainRate = Number(slots.find((item) => item.id === slot.id)?.strategies?.gain_rate || 0);
      let updateQuery = supabase.from("slots").update({ preco_entrada: entryPrice, preco_alvo: Math.round(entryPrice * (1 + gainRate)) }).eq("id", slot.id).eq("user_id", userId).eq("status", "hold");
      if (scopedTenantId) updateQuery = updateQuery.eq("tenant_id", scopedTenantId);
      const { data: updated } = await updateQuery.select("id").maybeSingle();
      if (!updated) continue;
      recalculated += 1;
      await supabase.from("history_events").insert({ user_id: userId, strategy_id: slot.strategy_id, slot_id: slot.id, action: "Gatilho de entrada", detail: JSON.stringify({ schemaVersion: 2, eventType: "gatilho_futuro_recalculado", asset, regime: officialContext?.mode || regime, modeSource: officialContext ? "OFFICIAL_BASELINE" : "LEGACY", dropPercent: drop, expectedPrice: entryPrice, note: "Apenas entrada futura recalculada; slot aberto e historico permaneceram inalterados.", eventAt: new Date().toISOString() }), slot_number: slot.slot_number });
    }
  }
  return recalculated;
}

export async function refreshBtcMarketRegime() {
  const supabase = createServiceRoleClient();
  const tenantId = getCoinOpsServiceTenantId();
  let previousQuery = supabase.from("btc_market_state").select("*").eq("singleton", true);
  if (tenantId) previousQuery = previousQuery.eq("tenant_id", tenantId);
  const { data: previous } = await previousQuery.maybeSingle<StateRow>();
  const prices = await fetchBtcReferencePrices();
  const athPrice = Math.max(Number(previous?.ath_price || 0), prices.monthlyHigh, prices.currentPrice);
  const distance = distanceFromAthPercent(prices.latestClosedDaily, athPrice);
  if (distance === null) throw new Error("Nao foi possivel calcular a distancia do ATH.");
  const calculatedMode = calculateMarketRegime(distance, DEFAULT_MARKET_REGIME_SETTINGS);
  const automaticMode = applyMarketRegimeHysteresis(asMarketRegime(previous?.effective_mode), distance, DEFAULT_MARKET_REGIME_SETTINGS);
  const now = new Date().toISOString();
  const state = {
    singleton: true,
    ath_price: athPrice,
    current_price: prices.currentPrice,
    classification_price: prices.latestClosedDaily,
    distance_from_ath_percent: distance,
    calculated_mode: calculatedMode,
    effective_mode: automaticMode,
    source: prices.source,
    price_updated_at: now,
    ath_updated_at: athPrice > Number(previous?.ath_price || 0) ? now : previous?.ath_updated_at || now,
    classified_at: now,
    mode_changed_at: automaticMode !== previous?.effective_mode ? now : previous?.mode_changed_at || now,
    updated_at: now
  };
  // The legacy source has a singleton unique key.  In the shared platform the
  // same state is scoped by product and tenant; its before-insert scope trigger
  // provides both values before the composite conflict key is evaluated.
  const stateConflictKey = getSupabaseDataSchema() === "coinops"
    ? "product_id,tenant_id"
    : "singleton";
  const { error: stateError } = await supabase.from("btc_market_state").upsert(state, { onConflict: stateConflictKey });
  if (stateError) throw stateError;

  let officialMonitoringResponse = await supabase.rpc(
    "process_official_monitoring_tick",
    { p_btc_price: prices.currentPrice, p_sol_price: prices.solCurrentPrice, p_observed_at: now }
  );
  if (officialMonitoringResponse.error?.code === "PGRST202") {
    officialMonitoringResponse = await supabase.rpc(
      "process_official_monitoring_tick",
      { p_btc_price: prices.currentPrice, p_observed_at: now }
    );
  }
  const { data: officialMonitoring, error: officialMonitoringError } = officialMonitoringResponse;
  if (officialMonitoringError && officialMonitoringError.code !== "PGRST202") {
    throw officialMonitoringError;
  }
  const officialTriggerContexts = officialMonitoringError?.code === "PGRST202"
    ? new Map<string, OfficialTriggerContext>()
    : await loadOfficialTriggerContexts(tenantId);


  let settingsQuery = supabase.from("market_regime_settings").select("*");
  let assetSettingsQuery = supabase.from("asset_market_strategy_settings").select("user_id,asset,buy_drop_top_percent,buy_drop_normal_percent,buy_drop_deep_percent,top_zero_reserve_count,normal_zero_reserve_count,deep_zero_reserve_count,deep_active_slot_limit");
  if (tenantId) {
    settingsQuery = settingsQuery.eq("tenant_id", tenantId);
    assetSettingsQuery = assetSettingsQuery.eq("tenant_id", tenantId);
  }
  const [{ data: settingsRows, error: settingsError }, { data: assetRows, error: assetError }] = await Promise.all([
    settingsQuery,
    assetSettingsQuery
  ]);
  if (settingsError) throw settingsError;
  if (assetError) throw assetError;
  const assetSettingsByUser = new Map<string, Partial<AssetMarketStrategySettings>>();
  for (const row of assetRows || []) {
    if (row.asset === "BTC" || row.asset === "SOL") {
      assetSettingsByUser.set(`${row.user_id}:${row.asset}`, row as Partial<AssetMarketStrategySettings>);
    }
  }
  let changedUsers = 0;
  let recalculatedTriggers = 0;
  for (const officialContext of officialTriggerContexts.values()) {
    const triggerCount = await recalculateFutureEntryTriggers(officialContext.userId, "NORMAL", {
      BTC: DEFAULT_ASSET_MARKET_SETTINGS.BTC,
      SOL: DEFAULT_ASSET_MARKET_SETTINGS.SOL
    }, officialContext);
    recalculatedTriggers += triggerCount;
  }
  for (const row of settingsRows || []) {
    const officialContext = officialTriggerContexts.get(officialScopeKey(row.user_id, row.tenant_id));
    if (officialContext) continue;
    const settings = asSettings(row as Record<string, unknown>);
    const calculatedForUser = calculateMarketRegime(distance, settings);
    const nextMode = settings.mode_source === "MANUAL"
      ? effectiveMarketRegime(settings, calculatedForUser)
      : applyMarketRegimeHysteresis(settings.last_effective_mode, distance, settings);
    if (nextMode === settings.last_effective_mode) continue;
    changedUsers += 1;
    let settingsUpdate = supabase.from("market_regime_settings").update({ last_effective_mode: nextMode, updated_at: now }).eq("user_id", row.user_id);
    if (tenantId) settingsUpdate = settingsUpdate.eq("tenant_id", tenantId);
    await settingsUpdate;
    await supabase.from("market_regime_history").insert({
      user_id: row.user_id,
      previous_mode: settings.last_effective_mode,
      new_mode: nextMode,
      mode_source: settings.mode_source,
      ath_price: athPrice,
      current_price: prices.currentPrice,
      distance_percent: distance,
      reason: settings.mode_source === "MANUAL" ? "Override manual mantido." : `Fechamento diario do BTC e histerese aplicados (${calculatedForUser}).`
    });
    const triggerCount = await recalculateFutureEntryTriggers(row.user_id, nextMode, {
      BTC: assetSettingsByUser.get(`${row.user_id}:BTC`) || DEFAULT_ASSET_MARKET_SETTINGS.BTC,
      SOL: assetSettingsByUser.get(`${row.user_id}:SOL`) || DEFAULT_ASSET_MARKET_SETTINGS.SOL
    });
    recalculatedTriggers += triggerCount;
  }

  const previousMode = previous ? asMarketRegime(previous.effective_mode) : null;
  const globalModeChanged = previousMode !== null && previousMode !== automaticMode;
  if (globalModeChanged || changedUsers > 0 || recalculatedTriggers > 0) {
    console.info("[market-regime] relevant_changes", {
      globalModeChanged,
      previousMode,
      effectiveMode: automaticMode,
      changedUsers,
      recalculatedTriggers,
      officialUsers: officialTriggerContexts.size
    });
  }
  return { ...state, changedUsers, officialUsers: officialTriggerContexts.size, officialMonitoring };
}

export async function getBtcMarketState() {
  const supabase = createServiceRoleClient();
  const tenantId = getCoinOpsServiceTenantId();
  let stateQuery = supabase.from("btc_market_state").select("*").eq("singleton", true);
  if (tenantId) stateQuery = stateQuery.eq("tenant_id", tenantId);
  const { data, error } = await stateQuery.maybeSingle<StateRow>();
  if (error) throw error;
  return data;
}
