import assert from "node:assert/strict";
import test from "node:test";
import { buildPremiumAssets } from "./premium-model.ts";
import type { Props } from "./automation-mobile";

const now = Date.parse("2026-10-13T14:30:00Z"), at = new Date(now).toISOString();
function fixture(): Props {
  const slots = Array.from({ length: 25 }, (_, index) => ({ slot_number: index + 1, entry_state: index ? "PLANNED" : "OPEN",
    target_buy_price: 100, operational_rank: index + 1, post_ath_group: null, post_ath_group_rank: null,
    operation_sequence: 1, position_quantity: index ? 0 : 1, position_committed_brl: index ? 0 : 11, missed_at: null }));
  const order = { client_order_id: "COR1-BTC-1-TP", exchange_order_id: "tp-own", slot_number: 1,
    side: "SELL", purpose: "TP", status: "NEW", price: 112, requested_quantity: 1, requested_quote: null,
    executed_quantity: 0, cumulative_quote: 0, revision: 0, operation_sequence: 1, trades_reconciled: true,
    created_at: at, updated_at: at };
  return { balances: [], configs: [], cycles: [], slots: [], operations: [], slotAccounts: [], events: [], candles: [],
    dailyCandles: [], testnet: null, testnetActionError: null, testnetRun: null, testnetSlots: [], testnetOrders: [], testnetEvents: [],
    engineContext: { environment: "REAL", legacy_compatible: true, status: "ACTIVE", engine_kill_switch: true,
      global_kill_switch: false, account_kill_switch: false, strategy_config_pending: false },
    livePreparation: { executor: { gate: "LIVE_EXECUTOR_PROTECTED", health: { healthy: true } },
      configs: [{ asset: "BTC", max_total_exposure_brl: 275, live_enabled: true, kill_switch: true }],
      sizing: [{ asset: "BTC", priceBrl: 100, rules: { quantityStep: .001 } }] },
    liveAssetData: { BTC: { displayOrderNamespace: "COR1-BTC-", displayProtectionComplete: true, run: { id: "run-paused", status: "PAUSED", symbol: "BTCBRL", entry_regime: "NORMAL",
      last_reconciled_at: at, last_error: null, gain_rate: .012, entry_spacing: .02 }, slots,
      accounts: slots.map((slot) => ({ slot_number: slot.slot_number, balance_brl: 11, market_pnl_brl: 0,
        manual_gain_brl: 0, contribution_brl: 11, fees_brl: 0, gain_count: 0 })),
      monthlyGains: [], orders: [order], events: [],
      alerts: [{ code: "COINOPS_LIVE_QUOTE_BALANCE_INSUFFICIENT", severity: "WARNING", last_seen_at: at }] } },
  } as unknown as Props;
}

test("complete paused display proof is distinct from OPERATING health", () => {
  const model = buildPremiumAssets(fixture(), "REAL", now)[0];
  assert.equal(model.entryPauseProtected, true);
  assert.equal(model.health.healthy, false);
  assert.equal(model.health.label, "PAUSADO · POSIÇÕES PROTEGIDAS");
});

test("a new orphan resident SELL must invalidate an existing hidden account projection", () => {
  const data = fixture(); const live = data.liveAssetData!.BTC!;
  live.orders.push({ ...live.orders[0], client_order_id: "COR1-BTC-2-TP", exchange_order_id: "orphan-new", slot_number: 2 });
  assert.equal(buildPremiumAssets(data, "REAL", now)[0].entryPauseProtected, false);
});

test("resident SELL with wrong purpose cannot certify paused TP protection", () => {
  const data = fixture(); data.liveAssetData!.BTC!.orders[0].purpose = "ENTRY";
  assert.equal(buildPremiumAssets(data, "REAL", now)[0].entryPauseProtected, false);
});

test("one whole uncovered LOT_SIZE quantum cannot hide behind a TP display tolerance", () => {
  const data = fixture(); data.liveAssetData!.BTC!.orders[0].requested_quantity = .999;
  assert.equal(buildPremiumAssets(data, "REAL", now)[0].entryPauseProtected, false);
});

test("critical, stale, pending and missing TP still invalidate paused protection", () => {
  for (const mutate of [
    (data: Props) => { data.liveAssetData!.BTC!.alerts[0].severity = "CRITICAL"; },
    (data: Props) => { data.liveAssetData!.BTC!.run.last_error = "COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN"; },
    (data: Props) => { data.liveAssetData!.BTC!.run.last_reconciled_at = new Date(now - 190_000).toISOString(); },
    (data: Props) => { data.liveAssetData!.BTC!.orders[0].status = "PREPARED"; },
    (data: Props) => { data.liveAssetData!.BTC!.orders = []; },
    (data: Props) => { data.liveAssetData!.BTC!.accounts.pop(); },
  ]) { const data = fixture(); mutate(data); assert.equal(buildPremiumAssets(data, "REAL", now)[0].entryPauseProtected, false); }
});

test("unknown or foreign order namespace cannot certify a hidden pause", () => {
  for (const mutate of [
    (data: Props) => { delete data.liveAssetData!.BTC!.displayOrderNamespace; },
    (data: Props) => { data.liveAssetData!.BTC!.orders[0].client_order_id = "C2-0123456789-1-S-foreign"; },
  ]) { const data = fixture(); mutate(data); assert.equal(buildPremiumAssets(data, "REAL", now)[0].entryPauseProtected, false); }
});

test("a capped or unproven fallback snapshot cannot hide a paused account", () => {
  for (const complete of [undefined, false]) {
    const data = fixture(); data.liveAssetData!.BTC!.displayProtectionComplete = complete;
    assert.equal(buildPremiumAssets(data, "REAL", now)[0].entryPauseProtected, false);
  }
});

test("future reconciliation and invalid physical balances cannot hide a paused account", () => {
  for (const mutate of [
    (data: Props) => { data.liveAssetData!.BTC!.run.last_reconciled_at = new Date(now + 30_000).toISOString(); },
    (data: Props) => { data.liveAssetData!.BTC!.accounts[0].balance_brl = -1; },
  ]) { const data = fixture(); mutate(data); assert.equal(buildPremiumAssets(data, "REAL", now)[0].entryPauseProtected, false); }
});
