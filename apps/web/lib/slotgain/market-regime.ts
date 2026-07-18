export type MarketRegime = "TOP" | "NORMAL" | "DEEP";
export type MarketModeSource = "AUTO" | "MANUAL";
export type MarketAsset = "BTC" | "SOL";

export type MarketRegimeSettings = {
  top_threshold_percent: number;
  deep_threshold_percent: number;
  hysteresis_percent: number;
  classification_timeframe: "DAILY_CLOSE";
  mode_source: MarketModeSource;
  manual_mode: MarketRegime | null;
  last_effective_mode: MarketRegime | null;
  manual_reason: string | null;
};

export type AssetMarketStrategySettings = {
  asset: MarketAsset;
  buy_drop_top_percent: number;
  buy_drop_normal_percent: number;
  buy_drop_deep_percent: number;
  top_zero_reserve_count: number;
  normal_zero_reserve_count: number;
  deep_zero_reserve_count: number;
  deep_active_slot_limit: number | null;
};

export type BtcMarketState = {
  ath_price: number;
  current_price: number;
  classification_price: number;
  distance_from_ath_percent: number;
  calculated_mode: MarketRegime;
  effective_mode: MarketRegime;
  source: string;
  price_updated_at: string | null;
  ath_updated_at: string | null;
  classified_at: string | null;
  mode_changed_at: string | null;
};

export const DEFAULT_MARKET_REGIME_SETTINGS: MarketRegimeSettings = {
  top_threshold_percent: 5,
  deep_threshold_percent: 30,
  hysteresis_percent: 0.5,
  classification_timeframe: "DAILY_CLOSE",
  mode_source: "AUTO",
  manual_mode: null,
  last_effective_mode: null,
  manual_reason: null
};

export const DEFAULT_ASSET_MARKET_SETTINGS: Record<MarketAsset, AssetMarketStrategySettings> = {
  BTC: {
    asset: "BTC",
    buy_drop_top_percent: 4,
    buy_drop_normal_percent: 2,
    buy_drop_deep_percent: 2,
    top_zero_reserve_count: 5,
    normal_zero_reserve_count: 3,
    deep_zero_reserve_count: 0,
    deep_active_slot_limit: 15
  },
  SOL: {
    asset: "SOL",
    buy_drop_top_percent: 12,
    buy_drop_normal_percent: 8,
    buy_drop_deep_percent: 8,
    top_zero_reserve_count: 3,
    normal_zero_reserve_count: 1,
    deep_zero_reserve_count: 0,
    deep_active_slot_limit: null
  }
};

export const MARKET_REGIME_LABELS: Record<MarketRegime, string> = {
  TOP: "TOPO",
  NORMAL: "MEIO / NORMAL",
  DEEP: "FUNDO FORTE"
};

export function asMarketRegime(value: unknown): MarketRegime | null {
  return value === "TOP" || value === "NORMAL" || value === "DEEP" ? value : null;
}

export function distanceFromAthPercent(currentPrice: number, athPrice: number) {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(athPrice) || currentPrice < 0 || athPrice <= 0) return null;
  return ((currentPrice - athPrice) / athPrice) * 100;
}

export function calculateMarketRegime(distancePercent: number, settings: Pick<MarketRegimeSettings, "top_threshold_percent" | "deep_threshold_percent">): MarketRegime {
  if (distancePercent >= -settings.top_threshold_percent) return "TOP";
  if (distancePercent >= -settings.deep_threshold_percent) return "NORMAL";
  return "DEEP";
}

export function applyMarketRegimeHysteresis(
  previousMode: MarketRegime | null,
  distancePercent: number,
  settings: Pick<MarketRegimeSettings, "top_threshold_percent" | "deep_threshold_percent" | "hysteresis_percent">
) {
  const calculated = calculateMarketRegime(distancePercent, settings);
  if (!previousMode) return calculated;

  const topExit = -(settings.top_threshold_percent + settings.hysteresis_percent);
  const topReturn = -(settings.top_threshold_percent - settings.hysteresis_percent);
  const deepEnter = -(settings.deep_threshold_percent + settings.hysteresis_percent);
  const deepExit = -(settings.deep_threshold_percent - settings.hysteresis_percent);

  if (previousMode === "TOP") return distancePercent >= topExit ? "TOP" : calculated;
  if (previousMode === "DEEP") return distancePercent <= deepExit ? "DEEP" : calculated;
  if (calculated === "TOP" && distancePercent < topReturn) return "NORMAL";
  if (calculated === "DEEP" && distancePercent > deepEnter) return "NORMAL";
  return calculated;
}

export function effectiveMarketRegime(settings: Pick<MarketRegimeSettings, "mode_source" | "manual_mode">, automaticMode: MarketRegime) {
  return settings.mode_source === "MANUAL" && settings.manual_mode ? settings.manual_mode : automaticMode;
}

export function activeBuyDropPercent(asset: MarketAsset, regime: MarketRegime, settings?: Partial<AssetMarketStrategySettings> | null) {
  const merged = { ...DEFAULT_ASSET_MARKET_SETTINGS[asset], ...settings };
  if (regime === "TOP") return Number(merged.buy_drop_top_percent);
  if (regime === "DEEP") return Number(merged.buy_drop_deep_percent);
  return Number(merged.buy_drop_normal_percent);
}

export function operatingPlan(asset: MarketAsset, regime: MarketRegime, settings?: Partial<AssetMarketStrategySettings> | null) {
  const merged = { ...DEFAULT_ASSET_MARKET_SETTINGS[asset], ...settings };
  const zeroReserveCount = regime === "TOP"
    ? Number(merged.top_zero_reserve_count)
    : regime === "DEEP"
      ? Number(merged.deep_zero_reserve_count)
      : Number(merged.normal_zero_reserve_count);
  return {
    zeroReserveCount,
    activeSlotLimit: regime === "DEEP" ? merged.deep_active_slot_limit : null
  };
}

export type OperatingSlot = { id: string; slot_number: number; sort_order: number; status: "zerado" | "aberto" | "gain" | "hold"; gains_distribuidos: number };

export function selectOperablePendingSlots(asset: MarketAsset, regime: MarketRegime, slots: OperatingSlot[], settings?: Partial<AssetMarketStrategySettings> | null) {
  const plan = operatingPlan(asset, regime, settings);
  const natural = (a: OperatingSlot, b: OperatingSlot) => a.slot_number - b.slot_number || a.sort_order - b.sort_order || a.id.localeCompare(b.id);
  let universe = [...slots];
  if (asset === "BTC" && regime === "DEEP" && plan.activeSlotLimit) {
    universe = [...slots]
      .sort((a, b) => b.gains_distribuidos - a.gains_distribuidos || natural(a, b))
      .slice(0, plan.activeSlotLimit);
  }
  const reservedZeroIds = new Set(universe.filter((slot) => slot.status === "zerado").sort(natural).slice(0, plan.zeroReserveCount).map((slot) => slot.id));
  return universe.filter((slot) => slot.status === "hold" && !reservedZeroIds.has(slot.id)).sort(natural);
}

export function validateMarketRegimeSettings(input: Pick<MarketRegimeSettings, "top_threshold_percent" | "deep_threshold_percent" | "hysteresis_percent" | "mode_source" | "manual_mode">) {
  if (!Number.isFinite(input.top_threshold_percent) || input.top_threshold_percent <= 0 || input.top_threshold_percent >= 100) return "O limite de topo deve ficar entre 0% e 100%.";
  if (!Number.isFinite(input.deep_threshold_percent) || input.deep_threshold_percent <= input.top_threshold_percent || input.deep_threshold_percent >= 100) return "O limite de fundo forte deve ser maior que o limite de topo e menor que 100%.";
  if (!Number.isFinite(input.hysteresis_percent) || input.hysteresis_percent < 0 || input.hysteresis_percent > 10) return "A histerese deve ficar entre 0% e 10%.";
  if (input.mode_source === "MANUAL" && !input.manual_mode) return "Escolha o modo manual desejado.";
  return null;
}
