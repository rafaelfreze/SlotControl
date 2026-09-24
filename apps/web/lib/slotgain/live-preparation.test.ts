import assert from "node:assert/strict";
import test from "node:test";

import { buildLiveSizing, livePreparationGate, parseLiveRules, type LiveConfig, type RawLiveSymbol } from "../execution/live-preparation.ts";
import { BinanceSpotAdapter } from "../execution/binance-spot-adapter.ts";
import { LiveExecutionBlockedError } from "../execution/types.ts";

const observedAt = "2026-09-23T23:46:33.964Z";
function raw(asset: "BTC" | "SOL"): RawLiveSymbol {
  return { symbol: `${asset}BRL`, status: "TRADING", baseAsset: asset, quoteAsset: "BRL",
    baseAssetPrecision: 8, quoteAssetPrecision: 8, quoteOrderQtyMarketAllowed: true,
    orderTypes: ["LIMIT", "MARKET", "LIMIT_MAKER"], filters: [
      { filterType: "PRICE_FILTER", minPrice: asset === "BTC" ? "1" : "0.1", maxPrice: "10000000", tickSize: asset === "BTC" ? "1" : "0.1" },
      { filterType: "LOT_SIZE", minQty: asset === "BTC" ? "0.00001" : "0.001", maxQty: "9000", stepSize: asset === "BTC" ? "0.00001" : "0.001" },
      { filterType: "MARKET_LOT_SIZE", minQty: "0", maxQty: "0.7", stepSize: "0" },
      { filterType: "NOTIONAL", minNotional: "10", maxNotional: "9000000", applyMinToMarket: true, avgPriceMins: 5 },
    ] };
}
function config(asset: "BTC" | "SOL"): LiveConfig {
  return { asset, symbol: `${asset}BRL`, slot_count: 25, gain_rate: asset === "BTC" ? .012 : .055,
    normal_spacing_rate: asset === "BTC" ? .01 : .015,
    post_ath_spacing_rate: asset === "BTC" ? .05 : .08, regime: "NORMAL",
    monthly_target: asset === "BTC" ? 7 : 2,
    configured_live_capital_brl: asset === "BTC" ? 447 : 269.75,
    max_order_notional_brl: asset === "BTC" ? 17.88 : 10.79,
    max_total_exposure_brl: asset === "BTC" ? 447 : 269.75,
    config_version: 2, live_enabled: false, updated_at: observedAt };
}
function sizing(asset: "BTC" | "SOL") {
  return buildLiveSizing(parseLiveRules(raw(asset)), asset === "BTC" ? 437365 : 595.2,
    config(asset), 716.75, observedAt, Date.parse(observedAt) + 1000);
}

test("BTCBRL and SOLBRL require all filters, quoteOrderQty and TRADING", () => {
  for (const asset of ["BTC", "SOL"] as const) assert.equal(parseLiveRules(raw(asset)).symbol, `${asset}BRL`);
  assert.throws(() => buildLiveSizing(parseLiveRules({ ...raw("BTC"), status: "HALT" }), 437365,
    config("BTC"), 716.75, observedAt, Date.parse(observedAt)), /PAIR_UNAVAILABLE/);
  assert.throws(() => parseLiveRules({ ...raw("BTC"), quoteOrderQtyMarketAllowed: false }), /FILTERS_INCOMPLETE/);
  assert.throws(() => parseLiveRules({ ...raw("BTC"), filters: [] }), /FILTER_INVALID/);
});

test("25 BRL slots account for buy lot, fee-reduced TP lot, notional, ladder and caps", () => {
  const btc = sizing("BTC"), sol = sizing("SOL");
  assert.equal(btc.currentMinimumBrl, 17.4946);
  assert.equal(btc.recommendedSlotBrl, 17.88);
  assert.equal(sol.recommendedSlotBrl, 10.79);
  assert.equal(btc.recommendedCapitalBrl, 447);
  assert.equal(sol.recommendedCapitalBrl, 269.75);
  for (const result of [btc, sol]) {
    assert.equal(result.slots.length, 25);
    assert.equal(result.validSlots, 25);
    assert.equal(result.dryRun.status, "NO_WRITE");
    assert.equal(result.dryRun.initial.action_type, "OPEN_INITIAL_MARKET");
    assert.equal(result.dryRun.takeProfit.action_type, "CREATE_TP");
    assert.equal(result.dryRun.nextBuy.action_type, "ARM_NEXT_BUY");
    assert.equal(result.dryRun.planned, 23);
    assert.equal(result.dryRun.localReentry.action_type, "PLAN_LOCAL_REENTRY");
    assert.equal(result.dryRun.localReentry.target_notional, result.dryRun.initial.target_notional! + 5);
    assert.equal(result.dryRun.monthlyHold.reason, "MONTHLY_TARGET_REACHED");
    assert.deepEqual(result.dryRun.globalReset.map((decision) => decision.action_type), ["COMPLETE_CYCLE", "REANCHOR"]);
    assert.ok(result.slots.every((slot) => slot.sellQuantityAfterFee * slot.tpPriceBrl + 1e-8 >= result.rules.minNotional));
  }
  assert.equal(btc.dryRun.initial.target_notional, 17.88); // BRL quote, not USDC.
});

test("config and live gate fail closed on stale price, insufficient BRL and excess caps", () => {
  assert.throws(() => buildLiveSizing(parseLiveRules(raw("BTC")), 437365, config("BTC"), 716.75,
    observedAt, Date.parse(observedAt) + 121_000), /MARKET_STALE/);
  assert.throws(() => buildLiveSizing(parseLiveRules(raw("BTC")), 437365,
    { ...config("BTC"), live_enabled: true as false }, 716.75, observedAt, Date.parse(observedAt)), /CAP_INVALID/);
  const assets = [sizing("BTC"), sizing("SOL")].map((row) => ({ asset: row.asset,
    validSlots: row.validSlots, configuredCapitalBrl: row.configuredCapitalBrl,
    recommendedCapitalBrl: row.recommendedCapitalBrl, exposureCapBrl: row.exposureCapBrl }));
  const base = { assets, globalCapBrl: 716.75, availableBrl: 716.75,
    activeDivergences: 0, reconciliationVerified: true, nativeLedgerReady: true,
    productionPermission: "READ_ONLY" as const };
  assert.equal(livePreparationGate(base), "LIVE_PREPARATION_READY");
  assert.equal(livePreparationGate({ ...base, availableBrl: 0 }), "BRL_INSUFFICIENT");
  assert.equal(livePreparationGate({ ...base, availableBrl: null }), "BALANCE_UNKNOWN");
  assert.equal(livePreparationGate({ ...base, availableBrl: 5000, globalCapBrl: 700 }), "BLOCKED");
  assert.equal(livePreparationGate({ ...base, productionPermission: "UNSAFE" }), "BLOCKED");
  assert.equal(livePreparationGate({ ...base, nativeLedgerReady: false }), "BLOCKED");
  assert.equal(livePreparationGate({ ...base, reconciliationVerified: false }), "BLOCKED");
});

test("Production create and cancel remain structurally unavailable", async () => {
  const adapter = new BinanceSpotAdapter(null, { fetcher: async () => { throw new Error("GET should not run"); } });
  await assert.rejects(adapter.createOrder({ symbol: "BTCBRL", side: "BUY", quantity: 1, clientOrderId: "never" }), LiveExecutionBlockedError);
  await assert.rejects(adapter.cancelOrder("SOLBRL", "never"), LiveExecutionBlockedError);
});
