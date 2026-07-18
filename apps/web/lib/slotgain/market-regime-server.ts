import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { DEFAULT_ASSET_MARKET_SETTINGS, DEFAULT_MARKET_REGIME_SETTINGS, activeBuyDropPercent, applyMarketRegimeHysteresis, asMarketRegime, calculateMarketRegime, distanceFromAthPercent, effectiveMarketRegime, type AssetMarketStrategySettings, type BtcMarketState, type MarketRegimeSettings } from "./market-regime";

type BinanceKline = [number, string, string, string, string];
type StateRow = BtcMarketState & { singleton: boolean };

const BINANCE_TICKER_URL = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";
const BINANCE_MONTHLY_URL = "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1M&limit=1000";
const BINANCE_DAILY_URL = "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=2";
const COINGECKO_BTC_URL = "https://api.coingecko.com/api/v3/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false";

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Binance respondeu ${response.status}.`);
  return response.json() as Promise<T>;
}

async function fetchBtcReferencePrices() {
  try {
    const [ticker, monthly, daily] = await Promise.all([
      fetchJson<{ price?: string }>(BINANCE_TICKER_URL),
      fetchJson<BinanceKline[]>(BINANCE_MONTHLY_URL),
      fetchJson<BinanceKline[]>(BINANCE_DAILY_URL)
    ]);
    const currentPrice = Number(ticker.price);
    const monthlyHigh = Math.max(...monthly.map((candle) => Number(candle[2])));
    const latestClosedDaily = daily.length > 1 ? Number(daily[0]?.[4]) : currentPrice;
    if (![currentPrice, monthlyHigh, latestClosedDaily].every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error("Referencia da Binance invalida.");
    }
    return { currentPrice, monthlyHigh, latestClosedDaily, source: "BINANCE_BTCUSDT_MONTHLY_HIGH" };
  } catch (binanceError) {
    const coin = await fetchJson<{ market_data?: { ath?: { usd?: number }; current_price?: { usd?: number } } }>(COINGECKO_BTC_URL);
    const currentPrice = Number(coin.market_data?.current_price?.usd);
    const athPrice = Number(coin.market_data?.ath?.usd);
    if (![currentPrice, athPrice].every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error(`Fontes de ATH indisponiveis: ${binanceError instanceof Error ? binanceError.message : "Binance sem resposta"}.`);
    }
    return { currentPrice, monthlyHigh: athPrice, latestClosedDaily: currentPrice, source: "COINGECKO_BTC_USD_FALLBACK" };
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

async function enqueueMarketChange(
  userId: string,
  previousMode: string | null,
  nextMode: string,
  state: Pick<BtcMarketState, "ath_price" | "current_price" | "distance_from_ath_percent">,
  assetSettings: Record<"BTC" | "SOL", Partial<AssetMarketStrategySettings>>
) {
  const supabase = createServiceRoleClient();
  const eventId = `market-regime:${userId}:${nextMode}:${state.ath_price}:${state.current_price}`;
  await supabase.from("notification_outbox").upsert({
    event_id: eventId,
    user_id: userId,
    event_type: "market_regime",
    origin: "automatic",
    asset: "BTC",
    slot_id: null,
    operation_id: null,
    payload: {
      previousMode,
      nextMode,
      athPrice: state.ath_price,
      currentPrice: state.current_price,
      distancePercent: state.distance_from_ath_percent,
      btcDrop: activeBuyDropPercent("BTC", nextMode as "TOP" | "NORMAL" | "DEEP", assetSettings.BTC),
      solDrop: activeBuyDropPercent("SOL", nextMode as "TOP" | "NORMAL" | "DEEP", assetSettings.SOL),
      url: "/config"
    },
    status: "pending",
    next_attempt_at: new Date().toISOString()
  }, { onConflict: "event_id" });
}

export async function refreshBtcMarketRegime() {
  const supabase = createServiceRoleClient();
  const { data: previous } = await supabase.from("btc_market_state").select("*").eq("singleton", true).maybeSingle<StateRow>();
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
  const { error: stateError } = await supabase.from("btc_market_state").upsert(state, { onConflict: "singleton" });
  if (stateError) throw stateError;

  const [{ data: settingsRows, error: settingsError }, { data: assetRows, error: assetError }] = await Promise.all([
    supabase.from("market_regime_settings").select("*"),
    supabase.from("asset_market_strategy_settings").select("user_id,asset,buy_drop_top_percent,buy_drop_normal_percent,buy_drop_deep_percent,top_zero_reserve_count,normal_zero_reserve_count,deep_zero_reserve_count,deep_active_slot_limit")
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
  for (const row of settingsRows || []) {
    const settings = asSettings(row as Record<string, unknown>);
    const calculatedForUser = calculateMarketRegime(distance, settings);
    const nextMode = settings.mode_source === "MANUAL"
      ? effectiveMarketRegime(settings, calculatedForUser)
      : applyMarketRegimeHysteresis(settings.last_effective_mode, distance, settings);
    if (nextMode === settings.last_effective_mode) continue;
    changedUsers += 1;
    await supabase.from("market_regime_settings").update({ last_effective_mode: nextMode, updated_at: now }).eq("user_id", row.user_id);
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
    if (settings.mode_source === "AUTO") {
      await enqueueMarketChange(row.user_id, settings.last_effective_mode, nextMode, state, {
        BTC: assetSettingsByUser.get(`${row.user_id}:BTC`) || DEFAULT_ASSET_MARKET_SETTINGS.BTC,
        SOL: assetSettingsByUser.get(`${row.user_id}:SOL`) || DEFAULT_ASSET_MARKET_SETTINGS.SOL
      });
    }
  }
  return { ...state, changedUsers };
}

export async function getBtcMarketState() {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.from("btc_market_state").select("*").eq("singleton", true).maybeSingle<StateRow>();
  if (error) throw error;
  return data;
}
