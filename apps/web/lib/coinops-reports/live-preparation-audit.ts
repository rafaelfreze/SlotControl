import { buildLiveSizing, liveOperationalDivergences, livePreparationGate, type LiveConfig, type LiveRules } from "../execution/live-preparation.ts";
import { STRATEGY_VERSION } from "../execution/strategy-engine.ts";

type Row = Record<string, unknown>;
type Sources = Record<string, Row[]>;
const number = (value: unknown) => Number(value);
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

/** Current read-only preparation snapshot; never confuses a preview with an order/fill. */
export function buildLivePreparationAudit(sources: Sources, generatedAt: string) {
  const configurations = sources.robot_v1_live_preparations ?? [];
  const global = sources.robot_v1_live_global_caps?.[0];
  const market = sources.live_market_snapshot?.[0];
  const accounts = sources.robot_v1_live_slot_accounts ?? [];
  const oldRealCredits = (sources.robot_v1_manual_adjustments ?? []).filter((row) => row.environment === "REAL");
  const marketRows = Array.isArray(market?.markets) ? market.markets as Array<{ rules: LiveRules; priceBrl: number }> : [];
  const globalCap = number(global?.max_total_live_exposure_brl);
  const rows = configurations.flatMap((raw) => {
    if (raw.asset !== "BTC" && raw.asset !== "SOL") return [];
    const asset = raw.asset;
    const profile = (sources.robot_v1_ath_profiles ?? []).find((row) => row.environment === "REAL" && row.asset === asset);
    const quote = marketRows.find((row) => row.rules?.asset === asset);
    const config: LiveConfig | null = profile ? { ...raw, asset, symbol: `${asset}BRL`,
      slot_count: number(raw.slot_count), monthly_target: number(raw.monthly_target),
      gain_rate: number(profile.next_gain_rate ?? profile.gain_rate),
      normal_spacing_rate: number(profile.next_normal_spacing_rate ?? profile.normal_spacing_rate),
      post_ath_spacing_rate: number(profile.next_post_ath_spacing_rate ?? profile.post_ath_spacing_rate),
      regime: profile.regime === "POST_ATH" ? "POST_ATH" : "NORMAL",
      configured_live_capital_brl: raw.configured_live_capital_brl as number,
      max_order_notional_brl: raw.max_order_notional_brl as number,
      max_total_exposure_brl: raw.max_total_exposure_brl as number,
      config_version: number(raw.config_version), live_enabled: false,
      updated_at: String(raw.updated_at ?? "") } : null;
    let sizing: ReturnType<typeof buildLiveSizing> | null = null;
    if (quote && config && market?.observed_at) try {
      sizing = buildLiveSizing(quote.rules, number(quote.priceBrl), config, globalCap,
        String(market.observed_at), Date.parse(generatedAt));
    } catch { /* An unverified filter or cap must not become a passing report. */ }
    const accountRows = accounts.filter((row) => row.asset === asset);
    const nativeLedger = accountRows.length === 25 && accountRows.every((row) => row.quote_asset === "BRL");
    return [{ environment: "REAL", asset, symbol: `${asset}BRL`, status: quote?.rules.status ?? null,
      filters: quote?.rules ?? null, current_price: quote?.priceBrl ?? null,
      observed_at: market?.observed_at ?? null, source: market?.source ?? null,
      current_min_slot_brl: sizing?.currentMinimumBrl ?? null,
      minimum_valid_slot_brl: sizing?.ladderMinimumBrl ?? null,
      recommended_slot_brl: sizing?.recommendedSlotBrl ?? null,
      slots: config?.slot_count ?? null, required_capital_brl: sizing?.recommendedCapitalBrl ?? null,
      configured_capital_brl: raw.configured_live_capital_brl ?? null,
      available_brl: market?.available_brl ?? null,
      shortage_brl: null,
      max_order_notional_brl: raw.max_order_notional_brl ?? null,
      max_total_exposure_brl: raw.max_total_exposure_brl ?? null,
      max_total_live_exposure_brl: global?.max_total_live_exposure_brl ?? null,
      config_version: config?.config_version ?? null,
      strategy_version: STRATEGY_VERSION, dry_run_status: sizing?.dryRun.status ?? "UNAVAILABLE",
      valid_slots: sizing?.validSlots ?? 0, brl_native_ledger: nativeLedger,
      legacy_real_usdc_credits: oldRealCredits.length, live_enabled: false,
      evidence_basis: "CURRENT_DB_CONFIG_AND_BRLRULES; BINANCE_GET; NO_ORDER_WRITE" }];
  });
  const sizing = rows.map((row) => ({ asset: row.asset as "BTC" | "SOL", validSlots: number(row.valid_slots),
    configuredCapitalBrl: number(row.configured_capital_brl),
    recommendedCapitalBrl: number(row.required_capital_brl),
    exposureCapBrl: number(row.max_total_exposure_brl) }));
  const latestReconciliation = [...(sources.exchange_reconciliation_runs ?? [])]
    .sort((a, b) => String(b.completed_at ?? "").localeCompare(String(a.completed_at ?? "")))[0];
  const summary = record(latestReconciliation?.summary);
  const ownedIntents = (sources.exchange_order_intents ?? []).filter((row) => row.execution_mode === "REAL").length;
  const mismatches = liveOperationalDivergences(latestReconciliation?.summary ? summary : null, ownedIntents);
  const nativeReady = rows.length === 2 && rows.every((row) => row.brl_native_ledger === true && row.legacy_real_usdc_credits === 0);
  const gate = nativeReady && market ? livePreparationGate({ assets: sizing, globalCapBrl: globalCap,
    availableBrl: market.available_brl === null ? null : number(market.available_brl),
    activeDivergences: mismatches, reconciliationVerified: latestReconciliation?.status === "COMPLETED" && Boolean(latestReconciliation.summary),
    nativeLedgerReady: nativeReady,
    productionPermission: market.permission === "READ_ONLY" ? "READ_ONLY"
      : market.permission === "UNSAFE" ? "UNSAFE" : "UNVERIFIED" }) : "BLOCKED";
  const totalCapital = rows.reduce((sum, row) => sum + number(row.configured_capital_brl), 0);
  const totalShortage = market?.available_brl == null ? null : Math.max(0, totalCapital - number(market.available_brl));
  return { rows: rows.map((row) => ({ ...row, shortage_brl: totalShortage, gate })), gate, nativeReady };
}
