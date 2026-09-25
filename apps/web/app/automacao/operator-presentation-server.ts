import "server-only";

import { resolveEngineContext, type DomainRegistry, type EngineContext } from "@/lib/execution/operator-context";
import type { createServiceRoleClient } from "@/lib/supabase/service-role";
import type { Props } from "./automation-mobile";
import { buildPremiumEngine, type PremiumOperatorPresentation, type PremiumSelection } from "./premium-operator";
import { monthlyPeriodKey, rankMonthlySlots } from "@/lib/execution/monthly-slot-policy";
import { loadLiveExecutorStatus, type LiveExecutorStatus } from "@/lib/execution/live-executor-health";

type Client = ReturnType<typeof createServiceRoleClient>;

/** UI observations must not borrow the longer financial dispatch timeout. */
const fetchUiHealth: typeof fetch = (url, init) => fetch(url, { ...init,
  signal: AbortSignal.any([AbortSignal.timeout(5_000), ...(init?.signal ? [init.signal] : [])]) });

function emptyScoped(data: Props, context: EngineContext): Props {
  return { ...data, engineContext: context, balances: [], configs: [], cycles: [], slots: [],
    operations: [], slotAccounts: [], events: [], candles: [], monthlyGoals: [],
    testnet: null, testnetRun: null, testnetSlots: [], testnetOrders: [], testnetEvents: [],
    testnetHistory: [], testnetAssetData: {}, liveAssetData: {}, livePreparation: null, nativeLiveControl: undefined,
    connectionStatus: null, lastSyncedAt: null, reconciliationStatus: null, reconciliationAt: null, mismatches: 0 };
}

/** The pre-migration readers are restricted to the designated legacy account.
 * Nonlegacy engines never inherit those balances, diagnostics or credentials. */
export function legacyEnginePresentation(data: Props, context: EngineContext): Props {
  if (!context.legacy_compatible || !context.is_legacy_default) return emptyScoped(data, context);
  const asset = context.base_asset as "BTC" | "SOL";
  const result = emptyScoped(data, context);
  if (context.environment === "REAL") {
    return { ...result, livePreparation: data.livePreparation, balances: data.balances,
      connectionStatus: data.connectionStatus, reconciliationStatus: data.reconciliationStatus,
      reconciliationAt: data.reconciliationAt, lastSyncedAt: data.lastSyncedAt,
      liveAssetData: data.liveAssetData?.[asset] ? { [asset]: data.liveAssetData[asset] } : {} };
  }
  if (context.environment === "TESTNET") {
    const bundle = data.testnetAssetData?.[asset];
    return { ...result, testnet: data.testnet, testnetEnabled: data.testnetEnabled,
      testnetAssetData: bundle ? { [asset]: bundle } : {}, testnetRun: bundle?.run ?? null,
      testnetSlots: bundle?.slots ?? [], testnetOrders: bundle?.orders ?? [],
      testnetEvents: bundle?.events ?? [], testnetHistory: bundle?.history ?? [],
      monthlyGoals: data.monthlyGoals?.filter((row) => row.environment === "TESTNET" && row.asset === asset) };
  }
  const configs = data.configs.filter((row) => row.asset === asset), ids = new Set(configs.map((row) => row.id));
  const cycles = data.cycles.filter((row) => ids.has(row.config_id)), cycleIds = new Set(cycles.map((row) => row.id));
  return { ...result, configs, cycles, slots: data.slots.filter((row) => cycleIds.has(row.cycle_id)),
    operations: data.operations.filter((row) => cycleIds.has(row.cycle_id)),
    slotAccounts: data.slotAccounts.filter((row) => ids.has(row.config_id)),
    events: data.events.filter((row) => cycleIds.has(row.cycle_id)),
    candles: data.candles.filter((row) => row.symbol === context.symbol),
    monthlyGoals: data.monthlyGoals?.filter((row) => row.environment === "SHADOW" && row.asset === asset) };
}

async function nativeEnginePresentation(client: Client, data: Props, context: EngineContext): Promise<Props> {
  const result = emptyScoped(data, context), asset = context.base_asset as "BTC" | "SOL";
  const query = <Columns extends string>(table: string, columns: Columns) => client.from(table).select(columns)
    .eq("operator_id", context.operator_id).eq("exchange_account_id", context.exchange_account_id)
    .eq("trading_engine_id", context.trading_engine_id);
  const totals = await query("robot_v1_slot_gain_totals", "slot_number,physical_slot_id,period_key,lifetime_gain_count,monthly_gain_count,market_gain_count,manual_gain_count,monthly_market_gain_count,monthly_manual_gain_count");
  if (totals.error) throw new Error("COINOPS_ENGINE_MONTHLY_UNAVAILABLE");
  if (context.environment === "REAL") {
    const run = await query("robot_v1_live_runs", "id,status,symbol,entry_regime,last_reconciled_at,last_error,config_version,gain_rate,entry_spacing")
      .in("status", ["PREPARING", "ACTIVE", "PAUSED"]).maybeSingle();
    if (run.error) throw new Error("COINOPS_ENGINE_RUN_UNAVAILABLE");
    if (!run.data) return result;
    const [slots, orders, accounts, events, alerts, preparation] = await Promise.all([
      query("robot_v1_live_slots", "slot_number,entry_state,target_buy_price,operational_rank,post_ath_group,post_ath_group_rank,operation_sequence,position_quantity,position_committed_brl,position_committed_quote,missed_at").eq("run_id", run.data.id).order("slot_number"),
      query("robot_v1_live_orders", "side,purpose,status,slot_number,client_order_id,exchange_order_id,price,requested_quantity,requested_quote,executed_quantity,cumulative_quote,created_at,updated_at,fee_base,fee_quote,fee_other,reserved_notional_brl,reserved_notional_quote").eq("run_id", run.data.id).order("created_at"),
      query("robot_v1_live_slot_accounts", "slot_number,balance_brl,balance_quote,market_pnl_brl,market_pnl_quote,manual_gain_brl,manual_gain_quote,fees_brl,fees_quote,gain_count,dust_quantity,dust_cost_brl,dust_cost_quote").order("slot_number"),
      query("robot_v1_live_events", "event_type,slot_number,observed_at,details").eq("run_id", run.data.id).order("observed_at", { ascending: false }).limit(40),
      query("robot_v1_live_alerts", "severity,code,last_seen_at").is("resolved_at", null).limit(20),
      query("robot_v1_live_preparations", "live_enabled,kill_switch").maybeSingle(),
    ]);
    if ([slots, orders, accounts, events, alerts, preparation].some((row) => row.error) || !preparation.data)
      throw new Error("COINOPS_ENGINE_LEDGER_UNAVAILABLE");
    result.nativeLiveControl = { liveEnabled: preparation.data.live_enabled,
      killSwitch: preparation.data.kill_switch, executor: null };
    result.liveAssetData = { [asset]: { run: run.data, slots: slots.data ?? [], orders: orders.data ?? [],
      accounts: accounts.data ?? [], events: events.data ?? [], alerts: alerts.data ?? [],
      monthlyGains: (totals.data ?? []).filter((row) => row.period_key === monthlyPeriodKey(new Date())) } };
    return result;
  }
  if (context.environment === "TESTNET") {
    const run = await query("robot_v1_testnet_runs", "id,strategy_version,status,symbol,last_reconciled_at,last_error,created_at,slot_notional_usdc,gain_rate,entry_spacing,next_capital_usdc,next_gain_rate,next_entry_spacing,previous_run_id,completed_at,completion_reason")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (run.error) throw new Error("COINOPS_ENGINE_RUN_UNAVAILABLE");
    if (!run.data) return result;
    const [slots, orders, events] = await Promise.all([
      query("robot_v1_testnet_slots", "run_id,slot_number,entry_state,target_buy_price,balance_usdc,gain_count,net_profit_usdc,missed_at,operation_sequence,entry_origin,entry_reference_price,last_take_profit_price,created_at,updated_at,post_ath_group,post_ath_group_rank,operational_rank").eq("run_id", run.data.id).order("slot_number"),
      query("robot_v1_testnet_orders", "run_id,slot_number,side,purpose,revision,operation_sequence,client_order_id,exchange_order_id,status,requested_quantity,price,executed_quantity,cumulative_quote,fee_base,fee_quote,fee_other,created_at,updated_at").eq("run_id", run.data.id).order("created_at"),
      query("robot_v1_testnet_events", "id,run_id,event_type,slot_number,observed_at,details").eq("run_id", run.data.id).order("observed_at", { ascending: false }).limit(100),
    ]);
    if ([slots, orders, events].some((row) => row.error)) throw new Error("COINOPS_ENGINE_LEDGER_UNAVAILABLE");
    result.testnetAssetData = { [asset]: { run: run.data, slots: slots.data ?? [], orders: orders.data ?? [], events: events.data ?? [] } };
    result.testnetRun = run.data; result.testnetSlots = slots.data ?? []; result.testnetOrders = orders.data ?? []; result.testnetEvents = events.data ?? [];
  } else {
    const [configs, cycles, slots, operations, accounts, events] = await Promise.all([
      query("robot_v1_configs", "id,strategy_version,asset,symbol,execution_mode,capital_usdc,next_capital_usdc,gain_rate,entry_spacing,next_gain_rate,next_entry_spacing,slot_count,kill_switch,pause_new_entries,shadow_test_started_at,shadow_test_target_end_at,last_candle_open_at,last_market_price,last_market_observed_at,last_engine_at,last_engine_error,grid_status,grid_error,configured_live_capital_brl,max_order_notional_brl,max_total_exposure_brl"),
      query("robot_v1_cycles", "id,strategy_version,config_id,asset,status,anchor_price,slot_notional_usdc,capital_usdc,gain_rate,entry_spacing,started_at,completed_at,completion_reason").order("started_at", { ascending: false }).limit(20),
      query("robot_v1_slots", "id,cycle_id,slot_number,logical_level,operation_sequence,entry_state,armed_at,missed_at,buy_client_order_id,sell_client_order_id,allocation_usdc,buy_price,requested_quantity,buy_status,executed_quantity,average_fill_price,take_profit_price,take_profit_status,status,realized_quote_pnl,buy_triggered_at,tp_triggered_at,post_ath_group,post_ath_group_rank,operational_rank").order("created_at", { ascending: false }).limit(500),
      query("robot_v1_slot_operations", "id,cycle_id,slot_id,physical_slot_number,logical_level,operation_sequence,allocation_usdc,entry_price,executed_quantity,take_profit_price,gross_quote_pnl,estimated_quote_fees,net_quote_pnl,opened_at,closed_at").order("closed_at", { ascending: false }).limit(500),
      query("robot_v1_slot_accounts", "config_id,slot_number,initial_balance_usdc,balance_usdc,gain_count,gross_profit_usdc,fees_usdc,net_profit_usdc,last_operation_id").order("slot_number"),
      query("robot_v1_audit_events", "cycle_id,slot_id,event_type,next_state,observed_at").order("observed_at", { ascending: false }).limit(40),
    ]);
    if ([configs, cycles, slots, operations, accounts, events].some((row) => row.error)) throw new Error("COINOPS_ENGINE_LEDGER_UNAVAILABLE");
    Object.assign(result, { configs: configs.data, cycles: cycles.data, slots: slots.data,
      operations: operations.data, slotAccounts: accounts.data, events: events.data });
  }
  const physical = context.environment === "TESTNET" ? result.testnetSlots : result.slotAccounts;
  const month = monthlyPeriodKey(new Date());
  result.monthlyGoals = rankMonthlySlots(asset, new Date().toISOString(), physical.flatMap((slot) => {
    const total = totals.data?.find((item) => item.slot_number === slot.slot_number);
    if (!total?.physical_slot_id) return []; // Missing evidence is not a fabricated physical identity or zero gain.
    return [{ physicalSlotNumber: slot.slot_number, physicalSlotId: total.physical_slot_id,
      lifetimeGainCount: total.lifetime_gain_count, monthlyGainCount: total.period_key === month ? total.monthly_gain_count : null,
      balanceUsdc: Number(slot.balance_usdc), entryState: "entry_state" in slot ? slot.entry_state : "PLANNED" }];
  })).map((row) => ({ ...row, environment: context.environment as "SHADOW" | "TESTNET", asset }));
  return result;
}

export async function buildOperatorPresentation(client: Client, data: Props, registry: DomainRegistry,
  selection: PremiumSelection, prefetchedHealth?: Map<string, LiveExecutorStatus>): Promise<PremiumOperatorPresentation> {
  if (selection.accountId !== "ALL" && !registry.accounts.some((account) => account.id === selection.accountId))
    throw new Error("COINOPS_ACCOUNT_SCOPE_DENIED");
  if (selection.symbol !== "ALL" && !registry.engines.some((engine) => engine.symbol === selection.symbol
    && (selection.accountId === "ALL" || engine.exchange_account_id === selection.accountId)))
    throw new Error("COINOPS_ENGINE_SCOPE_DENIED");
  const engineData: Record<string, Props> = {};
  const capsPromise = client.from("account_quote_caps").select("exchange_account_id,quote_asset,hard_cap_quote")
    .eq("operator_id", registry.operator.id);
  const loaded = await Promise.all(registry.engines.map(async (row) => {
    const context = resolveEngineContext(registry, { environment: row.environment,
      exchange_account_id: row.exchange_account_id, trading_engine_id: row.id });
    const scoped = context.legacy_compatible ? legacyEnginePresentation(data, context)
      : await nativeEnginePresentation(client, data, context);
    return { context, scoped };
  }));
  const caps = await capsPromise;
  if (caps.error) throw new Error("COINOPS_ACCOUNT_CAPS_UNAVAILABLE");
  const live = loaded.filter(({ context, scoped }) => context.environment === "REAL"
    && (scoped.livePreparation || scoped.nativeLiveControl));
  // Two concurrent read-only health checks keep BTC/SOL within one UI budget,
  // while bounding fan-out if additional legitimate engines are introduced.
  for (let offset = 0; offset < live.length; offset += 2) {
    await Promise.all(live.slice(offset, offset + 2).map(async ({ context, scoped }) => {
      // Public /health can intentionally advertise the old compatibility
      // contract during rollout. Only the authenticated, identity-validated
      // engine observation can attest this market's LIVE state and kill switch.
      const executor = prefetchedHealth?.get(context.trading_engine_id)
        ?? await loadLiveExecutorStatus(undefined, undefined, fetchUiHealth, undefined, context);
      if (scoped.livePreparation) scoped.livePreparation = { ...scoped.livePreparation, executor };
      else if (scoped.nativeLiveControl) scoped.nativeLiveControl = { ...scoped.nativeLiveControl, executor };
    }));
  }
  const engines = loaded.map(({ context, scoped }) => {
    engineData[context.trading_engine_id] = scoped;
    return buildPremiumEngine(scoped, context);
  });
  return { accounts: registry.accounts.map((account) => ({ id: account.id, displayName: account.display_name,
    status: account.status, killSwitch: registry.operator.kill_switch || account.kill_switch })),
    engines, engineData, selection, accountCaps: (caps.data ?? []).map((row) => ({
      accountId: row.exchange_account_id, currency: row.quote_asset, cap: Number(row.hard_cap_quote) })) };
}
