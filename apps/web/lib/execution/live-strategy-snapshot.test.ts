import assert from "node:assert/strict";
import test from "node:test";
import { strategyRatesForOrder } from "./live-strategy-snapshot.ts";
import { assertStrategyTakeProfitPrice } from "./strategy-price-invariant.ts";

test("an OPEN TP keeps its old decision snapshot when post-ATH changes 8% to 5%", () => {
  const run = { config_snapshot: { regime: "POST_ATH", post_ath_spacing_rate: 0.05,
    gain_rate: 0.02, ladder_anchor_price: 100 }, entry_spacing: 0.05, gain_rate: 0.02, anchor_price: 100 };
  const existing = { config_snapshot: { regime: "POST_ATH", post_ath_spacing_rate: 0.08,
    gain_rate: 0.01, ladder_anchor_price: 100 } };
  const rates = strategyRatesForOrder(existing, run);
  assert.deepEqual(rates, { gain: 0.01, spacing: 0.08, anchor: 100 });
  assert.equal(assertStrategyTakeProfitPrice({ price: 101, averageFillPrice: 100,
    gainRate: rates.gain, spacing: rates.spacing, tick: 0.01 }), 101);
  assert.throws(() => assertStrategyTakeProfitPrice({ price: 101, averageFillPrice: 100,
    gainRate: Number(run.gain_rate), spacing: Number(run.entry_spacing), tick: 0.01 }),
  /COINOPS_STRATEGY_PRICE_INVARIANT_FAILED/);
});

test("legacy order snapshot derives spacing from its frozen regime", () => {
  const run = { config_snapshot: {}, entry_spacing: 0.05, gain_rate: 0.01, anchor_price: 100 };
  assert.equal(strategyRatesForOrder({ config_snapshot: { regime: "NORMAL", normal_spacing_rate: 0.03,
    post_ath_spacing_rate: 0.08, gain_rate: 0.01, ladder_anchor_price: 120 } }, run).spacing, 0.03);
  assert.equal(strategyRatesForOrder({ config_snapshot: { regime: "POST_ATH", normal_spacing_rate: 0.03,
    post_ath_spacing_rate: 0.08, gain_rate: 0.01, ladder_anchor_price: 120 } }, run).spacing, 0.08);
});

test("missing or invalid order strategy snapshot fails closed", () => {
  assert.throws(() => strategyRatesForOrder({ config_snapshot: { entry_spacing: 0 } },
    { config_snapshot: {}, entry_spacing: 0.05, gain_rate: 0.01, anchor_price: 100 }),
  /COINOPS_STRATEGY_ORDER_SNAPSHOT_INVALID/);
});
