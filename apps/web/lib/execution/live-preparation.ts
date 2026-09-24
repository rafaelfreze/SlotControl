import { planAthLadder } from "./ath-ladder.ts";
import { calculateStrategyTakeProfit, planStrategyClosedSlot, planStrategyInitialEntry, planStrategyNextEntry, planStrategyTakeProfit,
  planStrategyPostAthNextEntry, STRATEGY_VERSION, type StrategyCandidate } from "./strategy-engine.ts";
import type { V1Asset } from "./robot-v1.ts";

export const LIVE_PREPARATION_VERSION = "5.1";
export const LIVE_FEE_RESERVE_RATE = 0.002; // Conservative until account commission is verified (0.2%).
export const LIVE_PRICE_BUFFER_RATE = 0.02; // Ticker/average-price and quantity-rounding headroom.
export const LIVE_MARKET_MAX_AGE_MS = 120_000;
export const LIVE_SLOT_COUNT = 25;

type RawFilter = { filterType?: string; minPrice?: string; maxPrice?: string; tickSize?: string;
  minQty?: string; maxQty?: string; stepSize?: string; minNotional?: string; maxNotional?: string;
  applyToMarket?: boolean; applyMinToMarket?: boolean; avgPriceMins?: number };
export type RawLiveSymbol = { symbol?: string; status?: string; baseAsset?: string; quoteAsset?: string;
  baseAssetPrecision?: number; quoteAssetPrecision?: number; quoteOrderQtyMarketAllowed?: boolean;
  orderTypes?: string[]; filters?: RawFilter[] };
export type LiveRules = { symbol: "BTCBRL" | "SOLBRL"; asset: V1Asset; status: string;
  basePrecision: number; quotePrecision: number; quoteOrderQtyMarketAllowed: boolean;
  orderTypes: string[]; priceTick: number; minPrice: number; maxPrice: number;
  quantityStep: number; minQuantity: number; maxQuantity: number;
  marketQuantityStep: number; marketMinQuantity: number; marketMaxQuantity: number;
  minNotional: number; maxNotional: number | null; marketMinNotional: boolean; avgPriceMins: number };
export type LiveConfig = { asset: V1Asset; symbol: "BTCBRL" | "SOLBRL"; slot_count: number;
  gain_rate: number | string; normal_spacing_rate: number | string; post_ath_spacing_rate: number | string;
  regime: "NORMAL" | "POST_ATH"; monthly_target: number; configured_live_capital_brl: number | string;
  max_order_notional_brl: number | string; max_total_exposure_brl: number | string;
  config_version: number; live_enabled: false; updated_at: string };
export type LiveSlotPreview = { physicalSlotNumber: number; operationalRank: number | null;
  postAthGroup: "PRIMARY" | "RESERVE" | null; capitalBrl: number; entryPriceBrl: number;
  estimatedQuantity: number; sellQuantityAfterFee: number; tpPriceBrl: number; valid: boolean };

function positive(value: unknown, code: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error(code);
  return result;
}
function filter(symbol: RawLiveSymbol, name: string) { return symbol.filters?.find((item) => item.filterType === name); }
function roundUpStep(value: number, step: number) { return Number((Math.ceil(value / step - 1e-9) * step).toPrecision(15)); }
function roundDownStep(value: number, step: number) { return Number((Math.floor(value / step + 1e-9) * step).toPrecision(15)); }
function centsUp(value: number) { return Math.ceil(value * 100 - 1e-8) / 100; }

export function parseLiveRules(raw: RawLiveSymbol): LiveRules {
  if (raw.symbol !== "BTCBRL" && raw.symbol !== "SOLBRL") throw new Error("COINOPS_LIVE_SYMBOL_UNSUPPORTED");
  if (raw.baseAsset !== raw.symbol.slice(0, -3) || raw.quoteAsset !== "BRL") throw new Error("COINOPS_LIVE_QUOTE_INVALID");
  const price = filter(raw, "PRICE_FILTER"), lot = filter(raw, "LOT_SIZE");
  const market = filter(raw, "MARKET_LOT_SIZE");
  const notional = filter(raw, "NOTIONAL") ?? filter(raw, "MIN_NOTIONAL");
  const minNotional = positive(notional?.minNotional, "COINOPS_LIVE_NOTIONAL_FILTER_INVALID");
  const maxNotional = Number(notional?.maxNotional ?? 0);
  const rules: LiveRules = { symbol: raw.symbol, asset: raw.baseAsset as V1Asset,
    status: raw.status ?? "UNKNOWN", basePrecision: Number(raw.baseAssetPrecision),
    quotePrecision: Number(raw.quoteAssetPrecision), quoteOrderQtyMarketAllowed: raw.quoteOrderQtyMarketAllowed === true,
    orderTypes: raw.orderTypes ?? [], priceTick: positive(price?.tickSize, "COINOPS_LIVE_PRICE_FILTER_INVALID"),
    minPrice: positive(price?.minPrice, "COINOPS_LIVE_PRICE_FILTER_INVALID"),
    maxPrice: positive(price?.maxPrice, "COINOPS_LIVE_PRICE_FILTER_INVALID"),
    quantityStep: positive(lot?.stepSize, "COINOPS_LIVE_LOT_FILTER_INVALID"),
    minQuantity: positive(lot?.minQty, "COINOPS_LIVE_LOT_FILTER_INVALID"),
    maxQuantity: positive(lot?.maxQty, "COINOPS_LIVE_LOT_FILTER_INVALID"),
    marketQuantityStep: Number(market?.stepSize ?? 0), marketMinQuantity: Number(market?.minQty ?? 0),
    marketMaxQuantity: Number(market?.maxQty ?? 0), minNotional,
    maxNotional: maxNotional > 0 ? maxNotional : null,
    marketMinNotional: notional?.applyMinToMarket !== false && notional?.applyToMarket !== false,
    avgPriceMins: Number(notional?.avgPriceMins ?? 0) };
  if (!Number.isInteger(rules.basePrecision) || !Number.isInteger(rules.quotePrecision)
    || rules.maxQuantity < rules.minQuantity || rules.maxPrice < rules.minPrice
    || !Number.isFinite(rules.marketQuantityStep) || rules.marketQuantityStep < 0
    || !Number.isFinite(rules.marketMinQuantity) || rules.marketMinQuantity < 0
    || !Number.isFinite(rules.marketMaxQuantity) || rules.marketMaxQuantity < 0
    || !rules.orderTypes.includes("MARKET") || !rules.orderTypes.includes("LIMIT")
    || !rules.quoteOrderQtyMarketAllowed) throw new Error("COINOPS_LIVE_FILTERS_INCOMPLETE");
  return rules;
}

export function validateLiveConfig(config: LiveConfig, globalCapBrl: number) {
  const capital = positive(config.configured_live_capital_brl, "COINOPS_LIVE_CAP_INVALID");
  const orderCap = positive(config.max_order_notional_brl, "COINOPS_LIVE_CAP_INVALID");
  const exposure = positive(config.max_total_exposure_brl, "COINOPS_LIVE_CAP_INVALID");
  if (config.symbol !== `${config.asset}BRL` || config.slot_count !== LIVE_SLOT_COUNT || config.live_enabled !== false
    || config.monthly_target !== (config.asset === "BTC" ? 7 : 2)
    || ![config.gain_rate, config.normal_spacing_rate, config.post_ath_spacing_rate].every((v) => Number(v) > 0 && Number(v) < 1)
    || orderCap > exposure || exposure > capital || !Number.isFinite(globalCapBrl) || globalCapBrl <= 0)
    throw new Error("COINOPS_LIVE_CAP_INVALID");
  return { capital, orderCap, exposure };
}

/** Exact discrete-lot search at the observed price. A future executor MUST recheck fresh filters and price. */
function minimumQuantity(rules: LiveRules, entry: number, tp: number, market: boolean) {
  const start = roundUpStep(Math.max(rules.minQuantity, rules.minNotional / entry), rules.quantityStep);
  for (let units = Math.round(start / rules.quantityStep); units <= Math.round(rules.maxQuantity / rules.quantityStep); units++) {
    const quantity = Number((units * rules.quantityStep).toPrecision(15));
    const sellQuantity = roundDownStep(quantity * (1 - LIVE_FEE_RESERVE_RATE), rules.quantityStep);
    const buyNotional = quantity * entry, sellNotional = sellQuantity * tp;
    if (market && (rules.marketMinQuantity > 0 && quantity < rules.marketMinQuantity
      || rules.marketMaxQuantity > 0 && quantity > rules.marketMaxQuantity
      || rules.marketQuantityStep > 0 && Math.abs(quantity / rules.marketQuantityStep - Math.round(quantity / rules.marketQuantityStep)) > 1e-7)) continue;
    if (buyNotional + 1e-8 >= rules.minNotional && sellQuantity + 1e-10 >= rules.minQuantity
      && sellNotional + 1e-8 >= rules.minNotional
      && (rules.maxNotional === null || Math.max(buyNotional, sellNotional) <= rules.maxNotional)) return quantity;
    if (units - Math.round(start / rules.quantityStep) > 100_000) break;
  }
  throw new Error("COINOPS_LIVE_NO_VALID_SLOT");
}

export function buildLiveSizing(rules: LiveRules, observedPriceBrl: number, config: LiveConfig, globalCapBrl: number,
  observedAt: string, now = Date.now()) {
  const caps = validateLiveConfig(config, globalCapBrl);
  const price = positive(observedPriceBrl, "COINOPS_LIVE_PRICE_INVALID");
  const age = now - Date.parse(observedAt);
  if (!Number.isFinite(age) || age < -10_000 || age > LIVE_MARKET_MAX_AGE_MS) throw new Error("COINOPS_LIVE_MARKET_STALE");
  if (rules.symbol !== config.symbol || rules.status !== "TRADING") throw new Error("COINOPS_LIVE_PAIR_UNAVAILABLE");
  const spacing = Number(config.regime === "POST_ATH" ? config.post_ath_spacing_rate : config.normal_spacing_rate);
  const gainRate = Number(config.gain_rate);
  const initial = Array.from({ length: LIVE_SLOT_COUNT }, (_, i) => ({
    physicalSlotId: `LIVE_PREVIEW:${config.asset}:${i + 1}`, physicalSlotNumber: i + 1,
    lifetimeGainCount: 0, monthlyGainCount: 0, entryState: "PLANNED", blocked: false,
    buyPrice: price, entryOrigin: "GRID" as const, operationSequence: 1, status: "PENDING" }));
  const ladder = planAthLadder(config.asset, config.regime, price,
    { gainRate, normalSpacing: Number(config.normal_spacing_rate), postAthSpacing: Number(config.post_ath_spacing_rate) },
    rules.priceTick, initial);
  const levels = ladder.map((level) => {
    const entry = level.nextBuyPrice;
    const tp = calculateStrategyTakeProfit(entry, rules.priceTick, { gainRate, entrySpacing: spacing });
    const quantity = minimumQuantity(rules, entry, tp, level.operationalRank === 1);
    return { ...level, entry, tp, minimumQuantity: quantity, minimumNotionalBrl: Number((quantity * entry).toFixed(8)) };
  });
  const currentMinimumBrl = levels.find((level) => level.operationalRank === 1)!.minimumNotionalBrl;
  const ladderMinimumBrl = Math.max(...levels.map((level) => level.minimumNotionalBrl));
  const recommendedSlotBrl = centsUp(ladderMinimumBrl * (1 + LIVE_FEE_RESERVE_RATE + LIVE_PRICE_BUFFER_RATE));
  const slotCapital = caps.capital / LIVE_SLOT_COUNT;
  const slots: LiveSlotPreview[] = levels.map((level) => {
    const estimatedQuantity = roundDownStep(slotCapital / level.entry, rules.quantityStep);
    const sellQuantityAfterFee = roundDownStep(estimatedQuantity * (1 - LIVE_FEE_RESERVE_RATE), rules.quantityStep);
    const valid = estimatedQuantity >= level.minimumQuantity && estimatedQuantity <= rules.maxQuantity
      && slotCapital <= caps.orderCap && estimatedQuantity * level.entry <= caps.orderCap
      && (rules.maxNotional === null || estimatedQuantity * level.entry <= rules.maxNotional);
    return { physicalSlotNumber: level.physicalSlotNumber, operationalRank: level.operationalRank,
      postAthGroup: level.postAthGroup, capitalBrl: slotCapital, entryPriceBrl: level.entry,
      estimatedQuantity, sellQuantityAfterFee, tpPriceBrl: level.tp, valid };
  });
  const candidates: StrategyCandidate[] = slots.map((slot) => ({ id: `LIVE_PREVIEW:${config.asset}:${slot.physicalSlotNumber}`,
    slotNumber: slot.physicalSlotNumber, operationSequence: 1, buyPrice: slot.entryPriceBrl,
    balanceQuote: slot.capitalBrl, operationalRank: slot.operationalRank,
    monthlyTargetReached: false, postAthGroup: slot.postAthGroup, entryOrigin: "GRID", state: "PLANNED" }));
  const context = { asset: config.asset, cycleId: `LIVE_PREVIEW:${config.asset}`, observedAt, quoteAsset: "BRL" as const };
  const first = candidates.find((item) => item.operationalRank === 1)!;
  const initialDecision = planStrategyInitialEntry(context, first);
  const tpDecision = planStrategyTakeProfit(context, { ...first, state: "OPEN" }, first.buyPrice,
    { symbol: rules.symbol, baseAsset: rules.asset, quoteAsset: "BRL", minQuantity: rules.minQuantity,
      maxQuantity: rules.maxQuantity, minNotional: rules.minNotional,
      quantityStep: rules.quantityStep, priceTick: rules.priceTick },
    { gainRate, entrySpacing: spacing });
  const next = config.regime === "POST_ATH"
    ? planStrategyPostAthNextEntry(context, candidates.filter((item) => item.id !== first.id), price)
    : planStrategyNextEntry(context, candidates.filter((item) => item.id !== first.id), price);
  // Exercise the same closure policy with hypothetical BRL ledger balances.
  // The OPEN position and its TP stay frozen; only the next operation sees +5 BRL.
  const adjustedClosed = { ...first, state: "CLOSED" as const, balanceQuote: candidateBalanceForPreview(first) + 5 };
  const localReentry = planStrategyClosedSlot(context,
    [adjustedClosed, { ...candidates[1]!, state: "OPEN" }, ...candidates.slice(2)], first.id);
  const monthlyHold = planStrategyClosedSlot(context,
    [{ ...adjustedClosed, monthlyTargetReached: true }, { ...candidates[1]!, state: "OPEN" }, ...candidates.slice(2)], first.id);
  const globalReset = planStrategyClosedSlot(context,
    [adjustedClosed, ...candidates.slice(1).map((item) => ({ ...item, state: "CLOSED" as const }))], first.id);
  return { asset: config.asset, symbol: config.symbol, observedAt, priceBrl: price, rules,
    currentMinimumBrl, ladderMinimumBrl, recommendedSlotBrl,
    minimumCapitalBrl: centsUp(ladderMinimumBrl * LIVE_SLOT_COUNT),
    recommendedCapitalBrl: centsUp(recommendedSlotBrl * LIVE_SLOT_COUNT),
    configuredCapitalBrl: caps.capital, orderCapBrl: caps.orderCap, exposureCapBrl: caps.exposure,
    slots, validSlots: slots.filter((slot) => slot.valid).length,
    dryRun: { status: "NO_WRITE" as const, strategyVersion: STRATEGY_VERSION,
      initial: initialDecision, takeProfit: tpDecision, nextBuy: next.decision, planned: 23, open: 0,
      localReentry: localReentry.decisions[0], monthlyHold: monthlyHold.decisions[0],
      globalReset: globalReset.decisions, hypotheticalManualGainBrl: 5 } };
}

function candidateBalanceForPreview(candidate: StrategyCandidate) { return candidate.balanceQuote ?? 0; }

export function livePreparationGate(input: { assets: Array<{ asset: V1Asset; validSlots: number; configuredCapitalBrl: number;
  recommendedCapitalBrl: number; exposureCapBrl: number }>; globalCapBrl: number;
  availableBrl: number | null; activeDivergences: number; reconciliationVerified: boolean;
  nativeLedgerReady: boolean; productionPermission: "READ_ONLY" | "UNVERIFIED" | "UNSAFE" }) {
  if (input.assets.length !== 2 || new Set(input.assets.map((item) => item.asset)).size !== 2
    || input.assets.some((item) => item.validSlots !== 25 || item.configuredCapitalBrl < item.recommendedCapitalBrl)
    || input.assets.reduce((sum, item) => sum + item.exposureCapBrl, 0) > input.globalCapBrl
    || !input.reconciliationVerified || !input.nativeLedgerReady || input.activeDivergences !== 0
    || input.productionPermission !== "READ_ONLY") return "BLOCKED" as const;
  if (input.availableBrl === null) return "BALANCE_UNKNOWN" as const;
  if (input.availableBrl < input.assets.reduce((sum, item) => sum + item.configuredCapitalBrl, 0))
    return "BRL_INSUFFICIENT" as const;
  return "LIVE_PREPARATION_READY" as const;
}

/** Exchange-only legacy manual orders and UNKNOWN balance observations are
 * visible in reconciliation, but are not CoinOps order divergences. */
export function liveOperationalDivergences(summary: Record<string, unknown> | null, ownedIntentCount: number) {
  if (!summary || !Number.isInteger(ownedIntentCount) || ownedIntentCount < 0) return Number.POSITIVE_INFINITY;
  const keys = ["EXPECTED_ONLY", "QUANTITY_MISMATCH", "PRICE_MISMATCH", "STATUS_MISMATCH"];
  const counts = keys.map((key) => Number(summary[key] ?? 0));
  return counts.every((count) => Number.isInteger(count) && count >= 0)
    ? counts.reduce((sum, count) => sum + count, ownedIntentCount) : Number.POSITIVE_INFINITY;
}
