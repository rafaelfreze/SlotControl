import assert from "node:assert/strict";
import test from "node:test";

import { parseLiveRules } from "../execution/live-preparation.ts";
import { buildLivePreparationAudit } from "./live-preparation-audit.ts";
import { buildReportPackage } from "./report-package.ts";

const observedAt = "2026-09-23T23:46:33.964Z";
const at = "2026-09-23T23:46:34.964Z";
function rules(asset: "BTC" | "SOL") {
  return parseLiveRules({ symbol: `${asset}BRL`, status: "TRADING", baseAsset: asset, quoteAsset: "BRL",
    baseAssetPrecision: 8, quoteAssetPrecision: 8, quoteOrderQtyMarketAllowed: true,
    orderTypes: ["LIMIT", "MARKET"], filters: [
      { filterType: "PRICE_FILTER", minPrice: "0.1", maxPrice: "10000000", tickSize: asset === "BTC" ? "1" : "0.1" },
      { filterType: "LOT_SIZE", minQty: asset === "BTC" ? "0.00001" : "0.001", maxQty: "9000", stepSize: asset === "BTC" ? "0.00001" : "0.001" },
      { filterType: "MARKET_LOT_SIZE", minQty: "0", maxQty: "0.7", stepSize: "0" },
      { filterType: "NOTIONAL", minNotional: "10", maxNotional: "9000000", applyMinToMarket: true },
    ] });
}
function sources(availableBrl: number | null): Record<string, Record<string, unknown>[]> {
  return {
    robot_v1_live_preparations: (["BTC", "SOL"] as const).map((asset) => ({ asset,
      symbol: `${asset}BRL`, slot_count: 25, monthly_target: asset === "BTC" ? 7 : 2,
      configured_live_capital_brl: asset === "BTC" ? 447 : 269.75,
      max_order_notional_brl: asset === "BTC" ? 17.88 : 10.79,
      max_total_exposure_brl: asset === "BTC" ? 447 : 269.75,
      config_version: 2, live_enabled: false, updated_at: observedAt })),
    robot_v1_live_global_caps: [{ max_total_live_exposure_brl: 716.75 }],
    robot_v1_live_slot_accounts: (["BTC", "SOL"] as const).flatMap((asset) =>
      Array.from({ length: 25 }, (_, index) => ({ asset, slot_number: index + 1,
        quote_asset: "BRL", balance_brl: 0, gain_count: 0 }))),
    robot_v1_ath_profiles: (["BTC", "SOL"] as const).map((asset) => ({ environment: "REAL", asset,
      gain_rate: asset === "BTC" ? .012 : .055,
      normal_spacing_rate: asset === "BTC" ? .01 : .015,
      post_ath_spacing_rate: asset === "BTC" ? .05 : .08,
      regime: "NORMAL" })),
    live_market_snapshot: [{ observed_at: observedAt, source: "BINANCE_GET",
      markets: [{ rules: rules("BTC"), priceBrl: 437365 }, { rules: rules("SOL"), priceBrl: 595.2 }],
      available_brl: availableBrl, permission: "READ_ONLY" }],
    exchange_reconciliation_runs: [{ status: "COMPLETED", completed_at: observedAt,
      summary: { EXCHANGE_ONLY: 165, UNKNOWN: 3 } }],
    robot_v1_manual_adjustments: [],
  };
}

test("LIVE_PREPARATION export distinguishes BRL shortage and preserves no-write evidence", () => {
  const audit = buildLivePreparationAudit(sources(0), at);
  assert.equal(audit.gate, "BRL_INSUFFICIENT");
  assert.equal(audit.rows.length, 2);
  assert.equal(audit.rows[0]?.strategy_version, "4.3.1");
  assert.equal(audit.rows[0]?.dry_run_status, "NO_WRITE");
  assert.equal(audit.rows[0]?.live_enabled, false);
  assert.equal(audit.rows[0]?.brl_native_ledger, true);
  const csv = buildReportPackage({ datasets: { live_preparation: audit.rows }, warnings: [], incompleteSources: [] },
    { start: "2026-09-23T00:00:00Z", end: "2026-09-24T00:00:00Z", assets: ["BTC", "SOL"], environments: ["REAL"] }, at)
    .files.find((file) => file.name === "LIVE_PREPARATION.csv")!.content;
  assert.match(csv, /BTCBRL/); assert.match(csv, /BRL_INSUFFICIENT/);
});

test("readiness requires BRL ledger, no legacy Real-USDC credit, caps and read-only permission", () => {
  assert.equal(buildLivePreparationAudit(sources(716.75), at).gate, "LIVE_PREPARATION_READY");
  const legacy = sources(716.75); legacy.robot_v1_manual_adjustments.push({ environment: "REAL" });
  assert.equal(buildLivePreparationAudit(legacy, at).gate, "BLOCKED");
  const permissions = sources(716.75); permissions.live_market_snapshot[0]!.permission = "UNSAFE";
  assert.equal(buildLivePreparationAudit(permissions, at).gate, "BLOCKED");
  const noMarket = sources(716.75); noMarket.live_market_snapshot = [];
  assert.equal(buildLivePreparationAudit(noMarket, at).gate, "BLOCKED");
  const owned = sources(716.75); owned.exchange_order_intents = [{ execution_mode: "REAL" }];
  assert.equal(buildLivePreparationAudit(owned, at).gate, "BLOCKED");
});

test("native preparation shows one active USDT engine without applying the legacy two-BRL gate", () => {
  const data = sources(716.75);
  const identity = { operator_id: "op", exchange_account_id: "A", trading_engine_id: "BTC-USDT", quote_asset: "USDT" };
  data.robot_v1_live_preparations = [{ ...data.robot_v1_live_preparations[0], ...identity, symbol: "BTCUSDT", live_enabled: true }];
  data.robot_v1_ath_profiles = [{ ...data.robot_v1_ath_profiles[0], ...identity }];
  data.robot_v1_live_slot_accounts = data.robot_v1_live_slot_accounts.filter((row) => row.asset === "BTC").map((row) => ({ ...row, ...identity }));
  data.robot_v1_live_runs = [{ ...identity, status: "ACTIVE", last_reconciled_at: observedAt, last_error: null }];
  data.account_quote_caps = [{ exchange_account_id: "A", quote_asset: "BRL", hard_cap_quote: 725 }, { exchange_account_id: "A", quote_asset: "USDT", hard_cap_quote: 500 }];
  data.live_market_snapshot = [{ exchange_account_id: "A", quote_asset: "BRL", available_quote: 99 },
    { exchange_account_id: "A", quote_asset: "USDT", available_quote: 123, observed_at: observedAt, source: "GET", permission: "SPOT_RESTRICTED",
      markets: [{ trading_engine_id: "BTC-USDT", priceQuote: 437365, rules: { ...rules("BTC"), symbol: "BTCUSDT", quoteAsset: "USDT" } }] }];
  const audit = buildLivePreparationAudit(data, at);
  assert.equal(audit.nativeReady, true); assert.equal(audit.rows.length, 1);
  const nativeRow = audit.rows[0]!;
  assert.ok("available_quote" in nativeRow && "account_cap_quote" in nativeRow);
  assert.equal(nativeRow.available_quote, 123); assert.equal(nativeRow.account_cap_quote, 500);
  assert.equal(audit.rows[0]!.symbol, "BTCUSDT"); assert.equal(audit.rows[0]!.live_enabled, true);
  assert.equal(audit.gate, "LIVE_EXISTING_LEDGER_SNAPSHOT");
  assert.equal(audit.rows[0]!.activation_authorized_by_report, false);
  assert.equal(audit.rows[0]!.dry_run_status, "NO_WRITE");
});
