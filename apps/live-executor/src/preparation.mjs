import { buildLiveSizing, parseLiveRules } from "../../web/lib/execution/live-preparation.ts";
import { STRATEGY_VERSION } from "../../web/lib/execution/strategy-engine.ts";
import { ExecutorRejection } from "./security.mjs";

export const EXECUTOR_CAPS = Object.freeze({
  BTC: Object.freeze({ symbol: "BTCBRL", capitalBrl: 450, orderBrl: 18, exposureBrl: 450 }),
  SOL: Object.freeze({ symbol: "SOLBRL", capitalBrl: 275, orderBrl: 11, exposureBrl: 275 }),
  globalBrl: 725,
});

function finite(value) { return typeof value === "number" && Number.isFinite(value); }

export function validateDryRunIntent(input, engine = null) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.action !== "DRY_RUN"
    || input.environment !== "REAL" || !["BTC", "SOL"].includes(input.asset)
    || input.symbol !== (engine?.symbol ?? EXECUTOR_CAPS[input.asset].symbol)
    || input.strategy_version !== STRATEGY_VERSION
    || !/^[a-zA-Z0-9:_-]{8,160}$/.test(input.decision_id ?? ""))
    throw new ExecutorRejection("EXECUTOR_INTENT_INVALID");
  const config = input.config;
  const hard = engine ? { capitalBrl: engine.hard_cap_quote, orderBrl: engine.max_order_quote,
    exposureBrl: engine.hard_cap_quote } : EXECUTOR_CAPS[input.asset];
  const portfolio = input.portfolio_caps_brl;
  if (!config || !portfolio || typeof portfolio !== "object" || Array.isArray(portfolio)
    || !finite(portfolio.BTC) || !finite(portfolio.SOL)
    || portfolio.BTC < 0 || portfolio.SOL < 0
    || !engine && (portfolio.BTC <= 0 || portfolio.SOL <= 0
      || portfolio.BTC > EXECUTOR_CAPS.BTC.exposureBrl || portfolio.SOL > EXECUTOR_CAPS.SOL.exposureBrl)
    || portfolio.BTC + portfolio.SOL > (engine?.account_cap_quote ?? EXECUTOR_CAPS.globalBrl)
    || !finite(input.global_cap_brl) || input.global_cap_brl <= 0
    || input.global_cap_brl > (engine?.account_cap_quote ?? EXECUTOR_CAPS.globalBrl)
    || input.global_cap_brl < portfolio.BTC + portfolio.SOL
    || config.asset !== input.asset || config.symbol !== input.symbol
    || config.slot_count !== 25 || config.live_enabled !== false
    || !Number.isSafeInteger(config.config_version) || config.config_version < 1
    || !finite(config.configured_live_capital_brl) || !finite(config.max_order_notional_brl)
    || !finite(config.max_total_exposure_brl)
    || config.configured_live_capital_brl > hard.capitalBrl
    || config.max_order_notional_brl > hard.orderBrl
    || config.max_total_exposure_brl > hard.exposureBrl
    || config.max_total_exposure_brl > portfolio[input.asset])
    throw new ExecutorRejection("EXECUTOR_HARD_CAP_DENIED", 403);
  return config;
}

export function buildExecutorDryRun(input, market, now = Date.now(), engine = null) {
  const config = validateDryRunIntent(input, engine);
  if (market?.raw?.symbol !== input.symbol || !finite(market.priceBrl))
    throw new ExecutorRejection("EXECUTOR_MARKET_UNAVAILABLE", 503);
  let sizing;
  try {
    sizing = buildLiveSizing(parseLiveRules(market.raw), market.priceBrl,
      config, input.global_cap_brl, market.observedAt, now, engine ? { engineCap: engine.hard_cap_quote,
        orderCap: engine.max_order_quote, accountCap: engine.account_cap_quote, quoteAsset: engine.quote_asset } : undefined);
  } catch {
    throw new ExecutorRejection("EXECUTOR_FILTER_OR_PREVIEW_INVALID", 503);
  }
  if (sizing.validSlots !== 25 || sizing.dryRun.status !== "NO_WRITE")
    throw new ExecutorRejection("EXECUTOR_SLOT_OR_PREVIEW_INVALID", 503);
  return {
    status: "NO_WRITE", symbol: input.symbol, decision_id: input.decision_id,
    strategy_version: sizing.dryRun.strategyVersion,
    observed_at: market.observedAt, price_brl: sizing.priceBrl,
    filters: { price_tick: sizing.rules.priceTick, quantity_step: sizing.rules.quantityStep,
      min_quantity: sizing.rules.minQuantity, min_notional_brl: sizing.rules.minNotional },
    quote_asset: engine?.quote_asset ?? "BRL",
    caps: engine ? { engine_quote: engine.hard_cap_quote, account_quote: engine.account_cap_quote,
      order_quote: engine.max_order_quote } : EXECUTOR_CAPS, valid_slots: sizing.validSlots,
    configured_capital_brl: sizing.configuredCapitalBrl,
    recommended_capital_brl: sizing.recommendedCapitalBrl,
    initial: sizing.dryRun.initial, take_profit: sizing.dryRun.takeProfit,
    next_buy: sizing.dryRun.nextBuy, planned: sizing.dryRun.planned,
    local_reentry: sizing.dryRun.localReentry,
    monthly_hold: sizing.dryRun.monthlyHold,
    global_reset: sizing.dryRun.globalReset,
    trading_enabled: false, kill_switch: true,
  };
}
