import assert from "node:assert/strict";
import test from "node:test";
import { buildPremiumAssets } from "./premium-model.ts";
import type { Props } from "./automation-mobile";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const AT = new Date(NOW).toISOString();
function fixture(extra: Record<string, unknown> = {}): Props {
  return { balances: [], configs: [], cycles: [], slots: [], operations: [], slotAccounts: [],
    events: [], candles: [], dailyCandles: [], testnet: null, testnetActionError: null,
    testnetRun: null, testnetSlots: [], testnetOrders: [], testnetEvents: [], ...extra } as unknown as Props;
}
const order = (extra: Record<string, unknown> = {}) => ({
  client_order_id: "coinops-order", exchange_order_id: "exchange-order", slot_number: 1,
  side: "BUY", purpose: "ENTRY", status: "NEW", price: 90, requested_quantity: 1,
  executed_quantity: 0, cumulative_quote: 0, revision: 0, operation_sequence: 1,
  created_at: AT, updated_at: AT, ...extra,
});

test("empty evidence stays unavailable and never inherits another environment's capital", () => {
  for (const environment of ["REAL", "SHADOW", "TESTNET"] as const) {
    const assets = buildPremiumAssets(fixture({ balances: [{ asset: "BTC", total: 50 }] }), environment, NOW);
    assert.equal(assets.length, 2);
    assert.equal(assets[0].capital, null);
    assert.equal(assets[0].realizedPnl, null);
    assert.equal(assets[0].price, null);
    assert.equal(assets[0].health.healthy, false);
  }
});

test("LIVE uses CoinOps position only, actual fill price, remaining BUY reservation and per-slot goals", () => {
  const slots = Array.from({ length: 25 }, (_, index) => ({ slot_number: index + 1,
    entry_state: index === 0 ? "OPEN" : index === 1 ? "ARMED" : "PLANNED",
    target_buy_price: 95, operational_rank: index + 1, post_ath_group: null,
    post_ath_group_rank: null, operation_sequence: 1, position_quantity: index === 0 ? 1 : 0,
    position_committed_brl: index === 0 ? 100 : 0, missed_at: null }));
  const accounts = slots.map((row) => ({ slot_number: row.slot_number, balance_brl: 18,
    market_pnl_brl: 0, fees_brl: 0, gain_count: row.slot_number === 1 ? 7 : 0,
    manual_gain_brl: 0, dust_quantity: 0, dust_cost_brl: 0 }));
  const data = fixture({ balances: [{ asset: "BTC", total: 100 }],
    livePreparation: { executor: { gate: "LIVE_EXECUTOR_ACTIVE" }, configs: [{ asset: "BTC", max_total_exposure_brl: 450, regime: "NORMAL" }],
      sizing: [{ asset: "BTC", priceBrl: 110 }] },
    liveAssetData: { BTC: { run: { id: "real-btc", status: "ACTIVE", symbol: "BTCBRL",
      entry_regime: "NORMAL", last_reconciled_at: AT, last_error: null, gain_rate: .012, entry_spacing: .01 },
      slots, accounts, monthlyGains: [{ slot_number: 1, monthly_gain_count: 7, lifetime_gain_count: 7 }],
      events: [], alerts: [], orders: [
        order({ client_order_id: "filled", status: "FILLED", price: null, executed_quantity: 1, cumulative_quote: 100 }),
        order({ client_order_id: "tp", side: "SELL", purpose: "TP", price: 101.2 }),
        order({ client_order_id: "next", slot_number: 2, price: 90, requested_quantity: 1,
          executed_quantity: .25, cumulative_quote: 22.5, status: "PARTIALLY_FILLED" }),
      ] } } });
  const [btc, sol] = buildPremiumAssets(data, "REAL", NOW);
  assert.equal(btc.committed, 100);
  assert.equal(btc.reserved, 67.5);
  assert.equal(btc.exposure, 167.5);
  assert.equal(btc.capital, 450);
  assert.equal(btc.freeCapital, 282.5);
  assert.equal(btc.slots[0].quantity, 1);
  assert.equal(btc.slots[0].entryPrice, 100);
  assert.equal(btc.openPnl, 10);
  assert.equal(btc.tpCount, 1);
  assert.equal(btc.nextCount, 1);
  assert.equal(btc.slots[0].targetReached, true);
  assert.equal(btc.slots[0].state, "OPEN");
  assert.equal(btc.slots[0].nextAction, "Aguardar TP");
  assert.equal(btc.slots[0].eligible, false);
  assert.equal(btc.health.healthy, true);
  assert.equal(sol.capital, null);

  const persistedReserve = structuredClone(data);
  persistedReserve.liveAssetData!.BTC!.orders[2].reserved_notional_brl = "105";
  const persisted = buildPremiumAssets(persistedReserve, "REAL", NOW)[0];
  assert.equal(persisted.reserved, 82.5);
  assert.equal(persisted.exposure, 182.5);
  assert.equal(persisted.orders[2].at, AT);

  persistedReserve.liveAssetData!.BTC!.orders[2].reserved_notional_brl = "0";
  assert.equal(buildPremiumAssets(persistedReserve, "REAL", NOW)[0].reserved, 0);

  const duplicate = structuredClone(data);
  duplicate.liveAssetData!.BTC!.orders.push({ ...duplicate.liveAssetData!.BTC!.orders[1], client_order_id: "duplicate-tp" });
  assert.equal(buildPremiumAssets(duplicate, "REAL", NOW)[0].health.tone, "error");

  const uncovered = structuredClone(data);
  uncovered.liveAssetData!.BTC!.orders[1].requested_quantity = .5;
  assert.equal(buildPremiumAssets(uncovered, "REAL", NOW)[0].health.tone, "error");

  const unhealthyExecutor = structuredClone(data);
  unhealthyExecutor.livePreparation!.executor.gate = "ATTENTION";
  assert.equal(buildPremiumAssets(unhealthyExecutor, "REAL", NOW)[0].health.healthy, false);

  const brokenCap = structuredClone(data);
  brokenCap.livePreparation!.configs[0].max_total_exposure_brl = 150;
  assert.equal(buildPremiumAssets(brokenCap, "REAL", NOW)[0].health.tone, "error");
});

test("LIVE prepared TP is not claimed resident or protective", () => {
  const data = fixture({ liveAssetData: { BTC: {
    run: { id: "run", status: "ACTIVE", entry_regime: "NORMAL", last_reconciled_at: AT, last_error: null },
    slots: [{ slot_number: 1, entry_state: "OPEN", target_buy_price: 100, position_quantity: 1,
      position_committed_brl: 100, operation_sequence: 1 }],
    accounts: [{ slot_number: 1, balance_brl: 100, market_pnl_brl: 0, fees_brl: 0, gain_count: 0 }],
    monthlyGains: [], events: [], alerts: [],
    orders: [order({ side: "SELL", purpose: "TP", status: "PREPARED", exchange_order_id: null })],
  } } });
  const btc = buildPremiumAssets(data, "REAL", NOW)[0];
  assert.equal(btc.tpCount, 0);
  assert.equal(btc.orders[0].resident, false);
  assert.equal(btc.health.tone, "error");
});

test("native USDT LIVE uses its own executor, preparation gates and quote ledger", () => {
  const slots = Array.from({ length: 25 }, (_, index) => ({ slot_number: index + 1,
    entry_state: index === 0 ? "OPEN" : index === 1 ? "ARMED" : "PLANNED",
    target_buy_price: 80, operational_rank: index + 1, post_ath_group: null,
    post_ath_group_rank: null, operation_sequence: 1, position_quantity: index === 0 ? .1 : 0,
    position_committed_brl: 0, position_committed_quote: index === 0 ? 10 : 0, missed_at: null }));
  const accounts = slots.map((row) => ({ slot_number: row.slot_number, balance_brl: 0,
    balance_quote: 16.76, market_pnl_brl: 0, market_pnl_quote: 0,
    fees_brl: 0, fees_quote: 0, gain_count: 0 }));
  const input = fixture({ engineContext: { environment: "REAL", legacy_compatible: false,
    hard_cap_quote: 419 }, nativeLiveControl: { liveEnabled: true, killSwitch: false,
      executor: { gate: "LIVE_EXECUTOR_ACTIVE" } }, liveAssetData: { BTC: {
        run: { id: "thyely-btc", status: "ACTIVE", entry_regime: "NORMAL",
          last_reconciled_at: AT, last_error: null, gain_rate: .012, entry_spacing: .02 },
        slots, accounts, monthlyGains: [], events: [], alerts: [], orders: [
          order({ client_order_id: "filled", status: "FILLED", executed_quantity: .1, cumulative_quote: 10 }),
          order({ client_order_id: "tp", side: "SELL", purpose: "TP", price: 101.2, requested_quantity: .1 }),
          order({ client_order_id: "next", slot_number: 2, price: 80,
            requested_quantity: .2, requested_quote: 16, reserved_notional_brl: 0,
            reserved_notional_quote: 16 }),
        ] } } });
  const native = buildPremiumAssets(input, "REAL", NOW)[0];
  assert.equal(native.health.healthy, true);
  assert.equal(native.cap, 419);
  assert.ok(Math.abs(native.capital! - 419) < 1e-9);
  assert.equal(native.committed, 10);
  assert.equal(native.reserved, 16);
  assert.equal(native.exposure, 26);
  const noExecutor = structuredClone(input);
  noExecutor.nativeLiveControl!.executor!.gate = "ATTENTION";
  assert.equal(buildPremiumAssets(noExecutor, "REAL", NOW)[0].health.healthy, false);
  const paused = structuredClone(input);
  paused.nativeLiveControl!.killSwitch = true;
  assert.equal(buildPremiumAssets(paused, "REAL", NOW)[0].health.healthy, false);
  const exceeded = structuredClone(input);
  exceeded.engineContext!.hard_cap_quote = 25;
  assert.equal(buildPremiumAssets(exceeded, "REAL", NOW)[0].health.tone, "error");
});

test("Testnet preserves immutable cycle totals and does not reserve PREPARED intentions", () => {
  const slot = { slot_number: 1, entry_state: "PLANNED", target_buy_price: 90,
    balance_usdc: 10.5, gain_count: 1, net_profit_usdc: .5, missed_at: null,
    operation_sequence: 2, entry_origin: "REENTRY" };
  const data = fixture({ testnetAssetData: { BTC: {
    run: { id: "test-current", status: "ACTIVE", symbol: "BTCUSDC", last_reconciled_at: AT,
      last_error: null, slot_notional_usdc: 10, gain_rate: .005, entry_spacing: .01 },
    slots: [slot], orders: [order({ exchange_order_id: null, status: "PREPARED", operation_sequence: 2 })], events: [],
    history: [{ run: { id: "test-history" }, slots: [{ ...slot, gain_count: 3, net_profit_usdc: 1.5 }], orders: [] }],
  } } });
  const btc = buildPremiumAssets(data, "TESTNET", NOW)[0];
  assert.equal(btc.capital, 10.5);
  assert.equal(btc.realizedPnl, 2);
  assert.equal(btc.gains, 4);
  assert.equal(btc.monthlyGains, null);
  assert.equal(btc.reserved, 0);
  assert.equal(btc.orders[0].resident, false);
  assert.equal(btc.slots[0].state, "REENTRY_WAITING");
  assert.equal(btc.price, null);
});

test("Shadow presentation does not turn virtual orders into Binance-resident orders", () => {
  const data = fixture({ configs: [{ id: "cfg", asset: "BTC", execution_mode: "SHADOW",
    last_market_price: 110, last_engine_at: AT, gain_rate: .005, entry_spacing: .01,
    grid_status: "VALID", kill_switch: false, pause_new_entries: false }],
    cycles: [{ id: "cycle", config_id: "cfg", asset: "BTC", status: "POSITIONS_ACTIVE", started_at: AT }],
    slots: [{ id: "slot", cycle_id: "cycle", slot_number: 1, status: "TP_ACTIVE",
      entry_state: "NONE", operation_sequence: 1, buy_client_order_id: "virtual-buy",
      sell_client_order_id: "virtual-tp", requested_quantity: 1, executed_quantity: 1,
      average_fill_price: 100, buy_price: 99, take_profit_price: 100.5, buy_triggered_at: AT }],
    slotAccounts: [{ config_id: "cfg", slot_number: 1, initial_balance_usdc: 100,
      balance_usdc: 100, gain_count: 0, gross_profit_usdc: 0, net_profit_usdc: 0, fees_usdc: 0 }],
  });
  const btc = buildPremiumAssets(data, "SHADOW", NOW)[0];
  assert.equal(btc.openPnl, 10);
  assert.equal(btc.orders.length, 2);
  assert.equal(btc.orders.every((row) => !row.resident), true);
  assert.equal(btc.orders[1].status, "VIRTUAL_TP");
  assert.equal(btc.slots[0].physicalId, "SHADOW:cfg:1");
  assert.equal(btc.monthlyGains, null);
});

test("Shadow freshness respects its five-minute cron cadence plus one-minute tolerance", () => {
  const data = fixture({ configs: [{ id: "cfg", asset: "BTC", execution_mode: "SHADOW",
    last_market_price: 110, last_engine_at: new Date(NOW - 240_000).toISOString(),
    gain_rate: .005, entry_spacing: .01, grid_status: "VALID", kill_switch: false, pause_new_entries: false }],
    cycles: [{ id: "cycle", config_id: "cfg", asset: "BTC", status: "POSITIONS_ACTIVE", started_at: AT }],
    slots: Array.from({ length: 25 }, (_, index) => ({ id: `slot-${index + 1}`, cycle_id: "cycle",
      slot_number: index + 1, status: index === 0 ? "TP_ACTIVE" : "PENDING", entry_state: index === 1 ? "ARMED" : "PLANNED",
      operation_sequence: 1, buy_client_order_id: `virtual-buy-${index + 1}`,
      sell_client_order_id: index === 0 ? "virtual-tp" : null, requested_quantity: 1,
      executed_quantity: index === 0 ? 1 : 0, average_fill_price: index === 0 ? 100 : null,
      buy_price: 100, take_profit_price: index === 0 ? 100.5 : null })),
    slotAccounts: Array.from({ length: 25 }, (_, index) => ({ config_id: "cfg", slot_number: index + 1,
      initial_balance_usdc: 100, balance_usdc: 100, gain_count: 0, gross_profit_usdc: 0,
      net_profit_usdc: 0, fees_usdc: 0 })),
  });
  assert.equal(buildPremiumAssets(data, "SHADOW", NOW)[0].health.healthy, true);
  data.configs[0].last_engine_at = new Date(NOW - 360_000).toISOString();
  assert.equal(buildPremiumAssets(data, "SHADOW", NOW)[0].health.healthy, true);
  data.configs[0].last_engine_at = new Date(NOW - 361_000).toISOString();
  assert.equal(buildPremiumAssets(data, "SHADOW", NOW)[0].health.tone, "attention");
  assert.equal(buildPremiumAssets(data, "SHADOW", NOW)[0].health.healthy, false);
});

test("a historical filled Testnet TP is never presented as current protection", () => {
  const data = fixture({ testnetAssetData: { BTC: {
    run: { id: "test", status: "ACTIVE", symbol: "BTCUSDC", last_reconciled_at: AT, slot_notional_usdc: 10 },
    slots: [{ slot_number: 1, entry_state: "OPEN", target_buy_price: 100, balance_usdc: 10,
      gain_count: 0, net_profit_usdc: 0, missed_at: null, operation_sequence: 1 }],
    orders: [order({ client_order_id: "buy", status: "FILLED", executed_quantity: 1, cumulative_quote: 100 }),
      order({ client_order_id: "old-sell", side: "SELL", purpose: "TP", status: "FILLED",
        price: 101, requested_quantity: .5, executed_quantity: .5, cumulative_quote: 50.5 })],
    events: [], history: [],
  } } });
  const btc = buildPremiumAssets(data, "TESTNET", NOW)[0];
  assert.equal(btc.slots[0].quantity, .5);
  assert.equal(btc.slots[0].tpPrice, null);
  assert.equal(btc.tpCount, 0);
  assert.equal(btc.health.healthy, false);
});

test("Testnet partially filled BUY/TP shows remaining net position and reserves only unfilled BUY", () => {
  const data = fixture({ testnet: { ok: true, probes: [{ symbol: "BTCUSDC", available: true, market: { price: 105 } }] },
    testnetAssetData: { BTC: {
      run: { id: "test-partial", status: "ACTIVE", symbol: "BTCUSDC", last_reconciled_at: AT, slot_notional_usdc: 100 },
      slots: [{ slot_number: 1, entry_state: "OPEN", target_buy_price: 100, balance_usdc: 100,
        gain_count: 0, net_profit_usdc: 0, missed_at: null, operation_sequence: 1 }],
      orders: [order({ client_order_id: "partial-buy", status: "PARTIALLY_FILLED", price: 100,
        requested_quantity: 1, executed_quantity: .6, cumulative_quote: 60, fee_base: .01, fee_quote: .03 }),
      order({ client_order_id: "partial-tp", side: "SELL", purpose: "TP", status: "PARTIALLY_FILLED",
        price: 101, requested_quantity: .59, executed_quantity: .2, cumulative_quote: 20.2 })],
      events: [], history: [],
    } } });
  const btc = buildPremiumAssets(data, "TESTNET", NOW)[0];
  const expectedPosition = (.6 - .01 - .2);
  const expectedCost = 60.03 * expectedPosition / .59;
  assert.equal(btc.slots[0].state, "OPEN");
  assert.ok(Math.abs(btc.slots[0].quantity! - .39) < 1e-10);
  assert.equal(btc.reserved, 40);
  assert.ok(Math.abs(btc.committed! - expectedCost) < 1e-10);
  assert.ok(Math.abs(btc.exposure! - expectedCost - 40) < 1e-10);
  assert.ok(Math.abs(btc.openPnl! - (expectedPosition * 105 - expectedCost)) < 1e-10);
  assert.equal(btc.tpCount, 1);
  assert.equal(btc.slots[0].tpPrice, 101);

  data.testnetAssetData!.BTC!.orders[0].fee_other = [{ asset: "BNB", amount: ".001" }];
  assert.equal(buildPremiumAssets(data, "TESTNET", NOW)[0].openPnl, null);
});
