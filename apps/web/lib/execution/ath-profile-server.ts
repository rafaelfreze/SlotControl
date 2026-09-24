import { advanceAthState, reconcileHistoricalAth, type AthEnvironment, type AthState } from "./ath-regime";
import { readBinanceHistoricalAth } from "./ath-market-source";
import type { V1Asset } from "./robot-v1";
import type { createServiceRoleClient } from "../supabase/service-role";
import { resolveOperatorEngine } from "./operator-context-server";

type Service = ReturnType<typeof createServiceRoleClient>;
type Scope = { productId: string; tenantId: string; userId: string;
  operatorId?: string; exchangeAccountId?: string; tradingEngineId?: string };
export type AthProfileRow = {
  id: string; product_id: string; tenant_id: string; user_id: string;
  environment: AthEnvironment; asset: V1Asset; config_version: number;
  gain_rate: number | string; normal_spacing_rate: number | string; post_ath_spacing_rate: number | string;
  next_config_version: number | null; next_gain_rate: number | string | null;
  next_normal_spacing_rate: number | string | null; next_post_ath_spacing_rate: number | string | null;
  regime: "NORMAL" | "POST_ATH"; ath_price: number | string | null;
  previous_ath: number | string | null; ath_observed_at: string | null; ath_source: string | null;
  ath_verified_at: string | null; ath_history_candle_count: number | null;
  ath_floor_reference: number | string | null; ath_floor_source: string | null;
  ath_floor_defined_at: string | null; transition_key: string | null; updated_at: string;
  transition_events: string[]; transition_observed_at: string | null;
  operator_id?: string; exchange_account_id?: string; trading_engine_id?: string; quote_asset?: string; symbol?: string;
  reference_symbol?: string;
};

const toState = (profile: AthProfileRow): AthState => ({ regime: profile.regime,
  athPrice: profile.ath_price === null ? null : Number(profile.ath_price),
  previousAth: profile.previous_ath === null ? null : Number(profile.previous_ath),
  athObservedAt: profile.ath_observed_at, athSource: profile.ath_source,
  floorReference: profile.ath_floor_reference === null ? null : Number(profile.ath_floor_reference),
  floorSource: profile.ath_floor_source, floorDefinedAt: profile.ath_floor_defined_at,
  transitionKey: profile.transition_key, lastTransitionAt: profile.transition_observed_at });

export async function loadAthProfile(service: Service, scope: Scope, environment: AthEnvironment,
  asset: V1Asset): Promise<AthProfileRow> {
  const engine = await resolveOperatorEngine(service, { product_id: scope.productId, tenant_id: scope.tenantId, user_id: scope.userId },
    { environment, asset, operator_id: scope.operatorId, exchange_account_id: scope.exchangeAccountId, trading_engine_id: scope.tradingEngineId });
  const { data, error } = await service.from("robot_v1_ath_profiles").select("*")
    .eq("product_id", scope.productId).eq("tenant_id", scope.tenantId).eq("user_id", scope.userId)
    .eq("environment", environment).eq("asset", asset).eq("trading_engine_id", engine.trading_engine_id).single();
  if (error || !data) throw new Error("COINOPS_ATH_PROFILE_UNAVAILABLE");
  return { ...data, symbol: engine.symbol, quote_asset: engine.quote_asset, reference_symbol: engine.ath_reference_symbol } as AthProfileRow;
}

async function ensureTransitionEvents(service: Service, profile: AthProfileRow) {
  if (!profile.transition_key || !profile.transition_observed_at) return;
  for (const type of profile.transition_events) {
    const { error } = await service.from("robot_v1_ath_events").upsert({
      profile_id: profile.id, product_id: profile.product_id, tenant_id: profile.tenant_id,
      user_id: profile.user_id, environment: profile.environment, asset: profile.asset,
      operator_id: profile.operator_id, exchange_account_id: profile.exchange_account_id, trading_engine_id: profile.trading_engine_id,
      event_key: `${type}:${profile.transition_key}`, event_type: type,
      observed_at: profile.transition_observed_at, details: { regime: profile.regime,
        ath_price: profile.ath_price, previous_ath: profile.previous_ath,
        floor_reference: profile.ath_floor_reference, source: profile.ath_source },
    }, { onConflict: "profile_id,event_key", ignoreDuplicates: true });
    if (error) throw new Error("COINOPS_ATH_EVENT_PERSIST_FAILED");
  }
}

/** Reconciles only the per-environment source state. No order or slot changes
 * happen here. The caller must activate the resulting regime under its own
 * cycle/run lease before permitting another entry. */
export async function refreshAthProfile(service: Service, scope: Scope, environment: "SHADOW" | "TESTNET" | "REAL",
  asset: V1Asset, market: { price: number; observedAt: string }): Promise<AthProfileRow> {
  let profile = await loadAthProfile(service, scope, environment, asset);
  await ensureTransitionEvents(service, profile);
  const now = Date.now();
  if (!profile.ath_verified_at || now - Date.parse(profile.ath_verified_at) >= 23 * 3_600_000) {
    const historical = await readBinanceHistoricalAth(asset, fetch, Date.now(), profile.reference_symbol).catch(() => null);
    if (!historical?.fresh) return profile;
    const historyTransition = reconcileHistoricalAth(toState(profile), historical);
    const historicalState = historyTransition.state;
    const updatedAt = new Date().toISOString();
    const { data, error } = await service.from("robot_v1_ath_profiles").update({
      regime: historicalState.regime, ath_price: historicalState.athPrice,
      previous_ath: historicalState.previousAth, ath_observed_at: historicalState.athObservedAt,
      ath_source: historicalState.athSource, transition_key: historicalState.transitionKey,
      transition_events: historyTransition.events.length ? historyTransition.events : profile.transition_events,
      transition_observed_at: historyTransition.events.length ? historical.observedAt : profile.transition_observed_at,
      ath_verified_at: historical.verifiedAt, ath_history_candle_count: historical.candleCount,
      updated_at: updatedAt,
    }).eq("id", profile.id).eq("updated_at", profile.updated_at).select("*").maybeSingle();
    if (error) throw new Error("COINOPS_ATH_BASELINE_PERSIST_FAILED");
    if (!data) return loadAthProfile(service, scope, environment, asset);
    profile = { ...data, symbol: profile.symbol, quote_asset: profile.quote_asset, reference_symbol: profile.reference_symbol } as AthProfileRow;
    await ensureTransitionEvents(service, profile);
  }
  if (!Number.isFinite(Date.parse(market.observedAt)) || Math.abs(now - Date.parse(market.observedAt)) > 90_000)
    return profile;
  const observed = advanceAthState(toState(profile), { price: market.price,
    observedAt: market.observedAt, source: `BINANCE_SPOT_${profile.reference_symbol ?? `${asset}USDC`}_TICKER`, fresh: true });
  if (!observed.events.length) return profile;
  const state = observed.state;
  const { data, error } = await service.from("robot_v1_ath_profiles").update({
    regime: state.regime, ath_price: state.athPrice, previous_ath: state.previousAth,
    ath_observed_at: state.athObservedAt, ath_source: state.athSource,
    transition_key: state.transitionKey, transition_events: observed.events,
    transition_observed_at: market.observedAt, updated_at: new Date().toISOString(),
  }).eq("id", profile.id).eq("updated_at", profile.updated_at).select("*").maybeSingle();
  if (error) throw new Error("COINOPS_ATH_TRANSITION_PERSIST_FAILED");
  if (!data) return loadAthProfile(service, scope, environment, asset);
  profile = { ...data, symbol: profile.symbol, quote_asset: profile.quote_asset, reference_symbol: profile.reference_symbol } as AthProfileRow;
  await ensureTransitionEvents(service, profile);
  return profile;
}
