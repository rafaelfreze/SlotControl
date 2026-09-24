import type { LiveAssetData, Props, TestnetAssetData } from "../../../app/automacao/automation-mobile";
import { buildLiveSizing, type LiveConfig, type LiveRules } from "../../../lib/execution/live-preparation";
import { rankMonthlySlots } from "../../../lib/execution/monthly-slot-policy";

// Entirely synthetic. No account identifiers, credentials, or production snapshots.
export const AUTOMATION_FIXTURE_NOW = "2026-09-24T12:00:00.000Z";
const assets = ["BTC", "SOL"] as const;
type Asset = typeof assets[number];
const slots = Array.from({ length: 25 }, (_, index) => index + 1);
const virtualPrice = (asset: Asset) => asset === "BTC" ? 80_000 : 120;
const realPrice = (asset: Asset) => asset === "BTC" ? 400_000 : 600;
const syntheticId = (context: string, asset: Asset, slot = 0) => `synthetic-${context}-${asset}-${slot}`;

function liveConfig(asset: Asset): LiveConfig {
  return { asset, symbol: `${asset}BRL`, slot_count: 25, gain_rate: asset === "BTC" ? 0.012 : 0.055,
    normal_spacing_rate: asset === "BTC" ? 0.01 : 0.015, post_ath_spacing_rate: 0.025,
    regime: "NORMAL", monthly_target: asset === "BTC" ? 7 : 2,
    configured_live_capital_brl: asset === "BTC" ? 450 : 275,
    max_order_notional_brl: asset === "BTC" ? 18 : 11,
    max_total_exposure_brl: asset === "BTC" ? 450 : 275,
    config_version: 3, live_enabled: true, updated_at: AUTOMATION_FIXTURE_NOW };
}

function liveRules(asset: Asset): LiveRules {
  return { symbol: `${asset}BRL`, asset, quoteAsset: "BRL", status: "TRADING", basePrecision: 8, quotePrecision: 8,
    quoteOrderQtyMarketAllowed: true, orderTypes: ["MARKET", "LIMIT"],
    priceTick: asset === "BTC" ? 1 : 0.1, minPrice: 0.1, maxPrice: 1_000_000,
    quantityStep: asset === "BTC" ? 0.000001 : 0.001,
    minQuantity: asset === "BTC" ? 0.000001 : 0.001, maxQuantity: 1000,
    marketQuantityStep: 0, marketMinQuantity: 0, marketMaxQuantity: 1000,
    minNotional: 5, maxNotional: null, marketMinNotional: true, avgPriceMins: 5 };
}

function liveAsset(asset: Asset): LiveAssetData {
  const market = realPrice(asset), capital = asset === "BTC" ? 18 : 11;
  const quantity = asset === "BTC" ? 0.00004 : 0.018;
  const gain = Number(liveConfig(asset).gain_rate);
  return {
    run: { id: syntheticId("live-cycle", asset), status: "ACTIVE", symbol: `${asset}BRL`,
      entry_regime: "NORMAL", last_reconciled_at: AUTOMATION_FIXTURE_NOW, last_error: null,
      config_version: 3, gain_rate: gain, entry_spacing: 0.01 },
    slots: slots.map((slot) => ({ slot_number: slot, entry_state: slot <= 2 ? "OPEN" : slot === 3 ? "ARMED" : "PLANNED",
      target_buy_price: market * (1 - (slot - 1) * 0.01), operational_rank: slot,
      post_ath_group: null, post_ath_group_rank: null, operation_sequence: 1,
      position_quantity: slot <= 2 ? quantity : 0,
      position_committed_brl: slot <= 2 ? quantity * market * (1 - (slot - 1) * 0.01) : 0, missed_at: null })),
    orders: [1, 2, 3].flatMap((slot) => {
      const price = market * (1 - (slot - 1) * 0.01);
      const common = { slot_number: slot, requested_quantity: quantity, requested_quote: null };
      const buy = { ...common, side: "BUY", purpose: slot === 1 ? "INITIAL" : "ENTRY",
        status: slot <= 2 ? "FILLED" : "NEW", client_order_id: syntheticId("live-buy", asset, slot),
        exchange_order_id: syntheticId("exchange-buy", asset, slot), price: slot === 1 ? null : price,
        executed_quantity: slot <= 2 ? quantity : 0, cumulative_quote: slot <= 2 ? quantity * price : 0 };
      return slot <= 2 ? [buy, { ...common, side: "SELL", purpose: "TP", status: "NEW",
        client_order_id: syntheticId("live-tp", asset, slot), exchange_order_id: syntheticId("exchange-tp", asset, slot),
        price: price * (1 + gain), executed_quantity: 0, cumulative_quote: 0 }] : [buy];
    }),
    accounts: slots.map((slot) => ({ slot_number: slot, balance_brl: capital,
      market_pnl_brl: 0, manual_gain_brl: 0, fees_brl: slot <= 2 ? 0.02 : 0,
      gain_count: 0, dust_quantity: 0, dust_cost_brl: 0 })),
    monthlyGains: slots.map((slot) => ({ slot_number: slot, monthly_gain_count: 0, lifetime_gain_count: 0 })),
    events: [{ event_type: "RECONCILED", slot_number: null, observed_at: AUTOMATION_FIXTURE_NOW, details: { source: "synthetic-fixture" } },
      { event_type: "NEXT_BUY_ARMED", slot_number: 3, observed_at: "2026-09-24T11:59:00.000Z", details: { source: "synthetic-fixture" } }],
    alerts: [],
  };
}

function testnetAsset(asset: Asset): TestnetAssetData {
  const price = virtualPrice(asset), quantity = 10 / price;
  const runId = syntheticId("testnet-cycle", asset);
  return {
    run: { id: runId, strategy_version: "4.3.1", status: "ACTIVE", symbol: `${asset}USDC`,
      last_reconciled_at: AUTOMATION_FIXTURE_NOW, last_error: null,
      created_at: "2026-09-23T12:00:00.000Z", slot_notional_usdc: 10, gain_rate: 0.005, entry_spacing: 0.01 },
    slots: slots.map((slot) => ({ run_id: runId, slot_number: slot,
      entry_state: slot <= 2 ? "OPEN" : slot === 3 ? "ARMED" : "PLANNED",
      target_buy_price: price * (1 - (slot - 1) * 0.01), balance_usdc: 10,
      gain_count: 0, net_profit_usdc: 0, missed_at: null, operation_sequence: 1,
      entry_origin: "GRID", entry_reference_price: price,
      last_take_profit_price: null, created_at: AUTOMATION_FIXTURE_NOW, updated_at: AUTOMATION_FIXTURE_NOW })),
    orders: [1, 2, 3].flatMap((slot) => {
      const entry = price * (1 - (slot - 1) * 0.01);
      const common = { run_id: runId, slot_number: slot, revision: 0, operation_sequence: 1,
        requested_quantity: quantity, created_at: AUTOMATION_FIXTURE_NOW, updated_at: AUTOMATION_FIXTURE_NOW,
        fee_base: 0, fee_quote: 0, fee_other: [] };
      const buy = { ...common, side: "BUY", purpose: slot === 1 ? "INITIAL" : "ENTRY",
        status: slot <= 2 ? "FILLED" : "NEW", client_order_id: syntheticId("testnet-buy", asset, slot),
        exchange_order_id: syntheticId("testnet-exchange-buy", asset, slot), price: entry,
        executed_quantity: slot <= 2 ? quantity : 0, cumulative_quote: slot <= 2 ? quantity * entry : 0 };
      return slot <= 2 ? [buy, { ...common, side: "SELL", purpose: "TP", status: "NEW",
        client_order_id: syntheticId("testnet-tp", asset, slot), exchange_order_id: syntheticId("testnet-exchange-tp", asset, slot),
        price: entry * 1.005, executed_quantity: 0, cumulative_quote: 0 }] : [buy];
    }),
    events: [{ id: syntheticId("testnet-event", asset), run_id: runId, event_type: "RECONCILED",
      slot_number: null, observed_at: AUTOMATION_FIXTURE_NOW, details: {} }], history: [],
  };
}

export function automationPremiumFixture(): Props & {
  athProfiles: Array<{ environment: "SHADOW" | "TESTNET" | "REAL"; asset: Asset; regime: "NORMAL" }>;
  deploymentSha: string;
} {
  const testnetAssetData = { BTC: testnetAsset("BTC"), SOL: testnetAsset("SOL") };
  const liveAssetData = { BTC: liveAsset("BTC"), SOL: liveAsset("SOL") };
  const now = AUTOMATION_FIXTURE_NOW;
  const candleRows = assets.flatMap((asset) => Array.from({ length: 36 }, (_, index) => {
    const close = virtualPrice(asset) * (0.94 + index * 0.0017 + Math.sin(index * 1.7) * 0.007);
    return { symbol: `${asset}USDC`, candle_open_at: new Date(Date.parse(now) - (35 - index) * 86_400_000).toISOString(),
      open_price: close * 0.997, high_price: close * 1.006, low_price: close * 0.993, close_price: close };
  }));
  return {
    connectionStatus: "CONNECTED", lastSyncedAt: now, balances: [],
    reconciliationStatus: "COMPLETED", reconciliationAt: now, mismatches: 0,
    configs: assets.map((asset) => ({ id: syntheticId("config", asset), strategy_version: "4.3.1", asset,
      symbol: `${asset}USDC`, execution_mode: "SHADOW", capital_usdc: 250,
      next_capital_usdc: null, gain_rate: 0.005, entry_spacing: 0.01, next_gain_rate: null,
      next_entry_spacing: null, slot_count: 25, kill_switch: false, pause_new_entries: false,
      shadow_test_started_at: "2026-09-23T12:00:00.000Z", shadow_test_target_end_at: null,
      last_candle_open_at: now, last_market_price: virtualPrice(asset), last_market_observed_at: now,
      last_engine_at: now, last_engine_error: null, grid_status: "VALID", grid_error: null,
      configured_live_capital_brl: null, max_order_notional_brl: null, max_total_exposure_brl: null })),
    cycles: assets.map((asset) => ({ id: syntheticId("shadow-cycle", asset), config_id: syntheticId("config", asset),
      strategy_version: "4.3.1", asset, status: "POSITIONS_ACTIVE", anchor_price: virtualPrice(asset),
      slot_notional_usdc: 10, capital_usdc: 250, gain_rate: 0.005, entry_spacing: 0.01,
      started_at: "2026-09-23T12:00:00.000Z", completed_at: null, completion_reason: null })),
    slots: assets.flatMap((asset) => slots.map((slot) => ({ id: syntheticId("shadow-slot", asset, slot),
      cycle_id: syntheticId("shadow-cycle", asset), slot_number: slot, logical_level: slot, operation_sequence: 1,
      entry_state: slot <= 2 ? "NONE" as const : slot === 3 ? "ARMED" as const : "PLANNED" as const,
      armed_at: slot === 3 ? now : null, missed_at: null,
      buy_client_order_id: syntheticId("shadow-buy", asset, slot), sell_client_order_id: slot <= 2 ? syntheticId("shadow-tp", asset, slot) : null,
      allocation_usdc: 10, buy_price: virtualPrice(asset) * (1 - (slot - 1) * 0.01),
      requested_quantity: 10 / virtualPrice(asset), executed_quantity: slot <= 2 ? 10 / virtualPrice(asset) : 0,
      average_fill_price: slot <= 2 ? virtualPrice(asset) * (1 - (slot - 1) * 0.01) : null,
      take_profit_price: slot <= 2 ? virtualPrice(asset) * (1 - (slot - 1) * 0.01) * 1.005 : null,
      status: slot <= 2 ? "TP_ACTIVE" : "PENDING", buy_triggered_at: slot <= 2 ? now : null, tp_triggered_at: null }))),
    operations: [],
    slotAccounts: assets.flatMap((asset) => slots.map((slot) => ({ config_id: syntheticId("config", asset),
      slot_number: slot, initial_balance_usdc: 10, balance_usdc: 10, gain_count: 0,
      gross_profit_usdc: 0, fees_usdc: 0, net_profit_usdc: 0, last_operation_id: null }))),
    events: assets.map((asset) => ({ cycle_id: syntheticId("shadow-cycle", asset), slot_id: null,
      event_type: "NEXT_BUY_ARMED", next_state: { slotNumber: 3 }, observed_at: now })),
    candles: candleRows, dailyCandles: [...candleRows, ...candleRows.map((candle) => ({ ...candle,
      symbol: candle.symbol.replace("USDC", "BRL"), open_price: Number(candle.open_price) * 5,
      high_price: Number(candle.high_price) * 5, low_price: Number(candle.low_price) * 5,
      close_price: Number(candle.close_price) * 5 }))], intentCount: 0,
    solBrlPilot: { observedAt: now, status: "TRADING", priceBrl: 600, priceTick: 0.1, quantityStep: 0.001,
      minQuantity: 0.001, minNotional: 5, orderTypes: ["MARKET", "LIMIT"], accepted: true,
      executableNotional: 10.8, minimumPerSlotBrl: 5.4, minimumCapitalFor25SlotsBrl: 135 },
    testnet: { ok: true, observedAt: now,
      account: { canTrade: true, canWithdraw: false, canDeposit: true, updateTime: now },
      balances: [{ asset: "USDC", free: 500, locked: 20, total: 520 }],
      probes: assets.map((asset) => ({ symbol: `${asset}USDC`, available: true,
        filters: { symbol: `${asset}USDC`, baseAsset: asset, quoteAsset: "USDC",
          minQuantity: 0.000001, maxQuantity: 1000, minNotional: 5, quantityStep: 0.000001, priceTick: 0.01 },
        market: { symbol: `${asset}USDC`, price: virtualPrice(asset), observedAt: now },
        openOrderCount: 3, ownedOpenOrderCount: 3 })),
      tradePermission: { ok: true, error: null }, userStreamPermission: { ok: true, error: null } },
    testnetEnabled: true, testnetActionError: null,
    testnetRun: testnetAssetData.SOL.run, testnetSlots: testnetAssetData.SOL.slots,
    testnetOrders: testnetAssetData.SOL.orders, testnetEvents: testnetAssetData.SOL.events,
    testnetAssetData, liveAssetData,
    monthlyGoals: (["SHADOW", "TESTNET"] as const).flatMap((environment) => assets.flatMap((asset) =>
      rankMonthlySlots(asset, now, slots.map((slot) => ({ physicalSlotNumber: slot,
        physicalSlotId: syntheticId(environment, asset, slot), lifetimeGainCount: 0, monthlyGainCount: 0,
        balanceUsdc: 10, entryState: slot <= 2 ? "OPEN" : slot === 3 ? "ARMED" : "PLANNED" })))
        .map((row) => ({ ...row, environment, asset })))),
    livePreparation: { configs: assets.map(liveConfig), sizing: assets.map((asset) => buildLiveSizing(liveRules(asset), realPrice(asset), liveConfig(asset), 725, now, Date.parse(now))),
      gate: "LIVE_PREPARATION_READY", executor: { gate: "LIVE_EXECUTOR_ACTIVE", ip: "192.0.2.10",
        health: { healthy: true, version: "synthetic", region: "test", environment: "BINANCE_PRODUCTION_PREPARED",
          clock: now, clock_drift_ms: 12, binance_connectivity: "OK", account_permission: "SPOT_RESTRICTED",
          egress_ipv4: "192.0.2.10", egress_ipv4_verified: true, trading_enabled: true, kill_switch: false, latency_ms: 38 } },
      nativeLedgerReady: true, reconciliationVerified: true, ownedDivergences: 0,
      globalCapBrl: 725, globalConfigVersion: 3, brlFree: 900, brlLocked: 26,
      observedAt: now, balanceObservedAt: now, source: "OFFLINE_SYNTHETIC", permissions: "SPOT_RESTRICTED",
      ipRestricted: true, error: null },
    athProfiles: (["SHADOW", "TESTNET", "REAL"] as const).flatMap((environment) => assets.map((asset) => ({ environment, asset, regime: "NORMAL" as const }))),
    deploymentSha: "synthetic-ui-fixture",
  };
}
