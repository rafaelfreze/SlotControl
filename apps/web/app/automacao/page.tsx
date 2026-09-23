import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { diagnoseBinanceSpotTestnet } from "@/lib/execution/binance-spot-testnet-adapter";
import { getDailyMarketCandles } from "@/lib/execution/market-daily-candles";
import { SOL_BRL_PUBLIC_SNAPSHOT, assessSolBrlPilot } from "@/lib/execution/robot-v1-live-readiness";
import { getCoinOpsServiceTenantId } from "@/lib/supabase/env";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { recordRuntimeObservation } from "@/lib/coinops-reports/runtime-observation-server";
import { TESTNET_MISSED_EVENT_TYPES } from "@/lib/coinops-reports/missed-level-evidence";
import { summarizeTestnetResults, testnetDiagnosticIssue, testnetPresentationHealth } from "@/lib/slotgain/testnet-results";
import { monthlyPeriodKey, physicalSlotIdentity, rankMonthlySlots, type MonthlySlotStatus } from "@/lib/execution/monthly-slot-policy";

import type { AutomationView } from "./automation-center";
import { AutomationCenter } from "./automation-cockpit";
import { AutomationPageShell } from "./automation-page-shell";
import type { TestnetAssetData } from "./automation-mobile";
import { AthProfilesPanel } from "./ath-profiles-panel";
import { ManualAdjustmentsPanel, type RecentManualAdjustment } from "./manual-adjustments-panel";
import "./ath-profiles.css";

export const metadata: Metadata = { title: "Automação" };
export const dynamic = "force-dynamic";
export const preferredRegion = "gru1";

type IntentRow = { id: string };
type ReconciliationRunRow = { status: string; completed_at: string | null; summary: { MATCH?: number; EXPECTED_ONLY?: number; EXCHANGE_ONLY?: number; QUANTITY_MISMATCH?: number; PRICE_MISMATCH?: number; STATUS_MISMATCH?: number; balances?: Array<{ asset: string; free: number; locked: number; total: number }> } | null };
type RobotV1ConfigRow = { strategy_version?: string | null; id: string; asset: "BTC" | "SOL"; symbol: string; execution_mode: "SHADOW" | "TESTNET"; capital_usdc: number | string; next_capital_usdc: number | string | null; gain_rate: number | string; entry_spacing: number | string; next_gain_rate: number | string | null; next_entry_spacing: number | string | null; slot_count: number; kill_switch: boolean; pause_new_entries: boolean; shadow_test_started_at: string | null; shadow_test_target_end_at: string | null; last_candle_open_at: string | null; last_market_price: number | string | null; last_market_observed_at: string | null; last_engine_at: string | null; last_engine_error: string | null; grid_status: string | null; grid_error: string | null; configured_live_capital_brl: number | string | null; max_order_notional_brl: number | string | null; max_total_exposure_brl: number | string | null };
type RobotV1CycleRow = { strategy_version?: string | null; id: string; config_id: string; asset: "BTC" | "SOL"; status: string; anchor_price: number | string; slot_notional_usdc: number | string; capital_usdc: number | string; gain_rate: number | string; entry_spacing: number | string; started_at: string; completed_at: string | null; completion_reason: string | null };
type RobotV1SlotRow = { id: string; cycle_id: string; slot_number: number; logical_level: number; operation_sequence: number; entry_state: "NONE" | "ARMED" | "PLANNED"; armed_at: string | null; missed_at: string | null; buy_client_order_id: string; sell_client_order_id: string | null; allocation_usdc: number | string; buy_price: number | string; requested_quantity: number | string; buy_status: string; executed_quantity: number | string; average_fill_price: number | string | null; take_profit_price: number | string | null; take_profit_status: string; status: string; realized_quote_pnl: number | string | null; buy_triggered_at: string | null; tp_triggered_at: string | null; post_ath_group?: "PRIMARY" | "RESERVE" | null; post_ath_group_rank?: number | null; operational_rank?: number | null };
type RobotV1OperationRow = { id: string; cycle_id: string; slot_id: string; physical_slot_number: number; logical_level: number; operation_sequence: number; allocation_usdc: number | string; entry_price: number | string; executed_quantity: number | string; take_profit_price: number | string; gross_quote_pnl: number | string; estimated_quote_fees: number | string; net_quote_pnl: number | string; opened_at: string | null; closed_at: string };
type RobotV1SlotAccountRow = { config_id: string; slot_number: number; initial_balance_usdc: number | string; balance_usdc: number | string; gain_count: number; gross_profit_usdc: number | string; fees_usdc: number | string; net_profit_usdc: number | string; last_operation_id: string | null };
type RobotV1EventRow = { cycle_id: string; slot_id: string | null; event_type: string; next_state: Record<string, unknown> | null; observed_at: string };
type RobotV1CandleRow = { symbol: string; candle_open_at: string; open_price: number | string; high_price: number | string; low_price: number | string; close_price: number | string };

export default async function AutomationPage({ searchParams }: { searchParams?: { view?: string; testnet?: string; testnetError?: string; adjust?: string } }) {
  if (!isSupabaseConfigured()) redirect("/login?setup=missing-env");
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const tenantId = getCoinOpsServiceTenantId();
  if (!tenantId) throw new Error("COINOPS_V1_SCOPE_UNAVAILABLE");

  let testnet: Awaited<ReturnType<typeof diagnoseBinanceSpotTestnet>> & { ok: true } | { ok: false; error: string } | null = null;
  const view: AutomationView = searchParams?.view === "shadow" || searchParams?.view === "testnet" || searchParams?.view === "live" ? searchParams.view : searchParams?.testnet === "check" ? "testnet" : "overview";
  if (view === "testnet" || searchParams?.testnet === "check") {
    const { data: scope, error: scopeError } = await createServiceRoleClient().from("strategies").select("product_id").eq("tenant_id", tenantId).eq("user_id", user.id).limit(1).maybeSingle();
    if (scopeError || !scope) throw new Error("COINOPS_V1_SCOPE_UNAVAILABLE");
    const diagnosticStartedAt = new Date().toISOString();
    testnet = await diagnoseBinanceSpotTestnet().then((result) => ({ ok: true as const, ...result })).catch((error) => ({ ok: false as const, error: error instanceof Error ? error.message : "TESTNET_DIAGNOSTIC_FAILED" }));
    if (tenantId) await recordRuntimeObservation({
      scope: { productId: scope.product_id, tenantId, userId: user.id },
      source: "TESTNET_DIAGNOSTIC", environment: "TESTNET",
      reference: `diagnostic:${diagnosticStartedAt.slice(0, 16)}`,
      startedAt: diagnosticStartedAt, finishedAt: new Date().toISOString(),
      status: testnet.ok ? "COMPLETED" : "FAILED", error: testnet.ok ? null : testnet.error, metrics: testnet,
    });
  }

  const [connectionResponse, runsResponse, robotConfigsResponse, robotCyclesResponse, robotSlotsResponse, operationsResponse, accountsResponse, eventsResponse, candlesResponse, intentsResponse, scopeResponse, monthlyResponse, athProfilesResponse] = await Promise.all([
    supabase.from("exchange_connections").select("connection_status,last_reconciled_at,last_synced_at").eq("exchange", "BINANCE_SPOT").maybeSingle(),
    supabase.from("exchange_reconciliation_runs").select("status,completed_at,summary").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("robot_v1_configs").select("id,strategy_version,asset,symbol,execution_mode,capital_usdc,next_capital_usdc,gain_rate,entry_spacing,next_gain_rate,next_entry_spacing,slot_count,kill_switch,pause_new_entries,shadow_test_started_at,shadow_test_target_end_at,last_candle_open_at,last_market_price,last_market_observed_at,last_engine_at,last_engine_error,grid_status,grid_error,configured_live_capital_brl,max_order_notional_brl,max_total_exposure_brl").order("asset"),
    supabase.from("robot_v1_cycles").select("id,strategy_version,config_id,asset,status,anchor_price,slot_notional_usdc,capital_usdc,gain_rate,entry_spacing,started_at,completed_at,completion_reason").order("started_at", { ascending: false }),
    supabase.from("robot_v1_slots").select("id,cycle_id,slot_number,logical_level,operation_sequence,entry_state,armed_at,missed_at,buy_client_order_id,sell_client_order_id,allocation_usdc,buy_price,requested_quantity,buy_status,executed_quantity,average_fill_price,take_profit_price,take_profit_status,status,realized_quote_pnl,buy_triggered_at,tp_triggered_at,post_ath_group,post_ath_group_rank,operational_rank").order("slot_number"),
    supabase.from("robot_v1_slot_operations").select("id,cycle_id,slot_id,physical_slot_number,logical_level,operation_sequence,allocation_usdc,entry_price,executed_quantity,take_profit_price,gross_quote_pnl,estimated_quote_fees,net_quote_pnl,opened_at,closed_at").order("closed_at", { ascending: false }),
    supabase.from("robot_v1_slot_accounts").select("config_id,slot_number,initial_balance_usdc,balance_usdc,gain_count,gross_profit_usdc,fees_usdc,net_profit_usdc,last_operation_id").order("slot_number"),
    supabase.from("robot_v1_audit_events").select("cycle_id,slot_id,event_type,next_state,observed_at").order("observed_at", { ascending: false }).limit(40),
    supabase.from("robot_v1_market_candles").select("symbol,candle_open_at,open_price,high_price,low_price,close_price").in("symbol", ["BTCUSDC", "SOLUSDC"]).order("candle_open_at", { ascending: false }).limit(180),
    supabase.from("exchange_order_intents").select("id").limit(12),
    supabase.from("strategies").select("product_id").eq("tenant_id", tenantId).eq("user_id", user.id).limit(1).maybeSingle(),
    supabase.from("robot_v1_slot_gain_totals").select("product_id,tenant_id,user_id,environment,asset,slot_number,physical_slot_id,lifetime_gain_count,monthly_gain_count,period_key,market_gain_count,manual_gain_count,monthly_market_gain_count,monthly_manual_gain_count")
      .eq("tenant_id", tenantId).eq("user_id", user.id),
    supabase.from("robot_v1_ath_profiles").select("id,environment,asset,config_version,gain_rate,normal_spacing_rate,post_ath_spacing_rate,next_config_version,next_gain_rate,next_normal_spacing_rate,next_post_ath_spacing_rate,regime,ath_price,ath_observed_at,ath_source,ath_verified_at,ath_floor_reference,ath_floor_source")
      .eq("tenant_id", tenantId).eq("user_id", user.id)
  ]);
  const shadowReadError = robotConfigsResponse.error || robotCyclesResponse.error || robotSlotsResponse.error || operationsResponse.error || accountsResponse.error || candlesResponse.error;
  if (shadowReadError) throw shadowReadError;
  if (scopeResponse.error || !scopeResponse.data || monthlyResponse.error) throw new Error("COINOPS_MONTHLY_GAIN_LEDGER_UNAVAILABLE");
  if (athProfilesResponse.error) throw new Error("COINOPS_ATH_PROFILES_UNAVAILABLE");
  const productId = scopeResponse.data.product_id;
  const { data: manualAdjustments, error: manualError } = await supabase.from("robot_v1_manual_adjustments")
    .select("id,environment,asset,slot_number,kind,gain_units,currency,original_amount,converted_amount_usdc,created_at,reversal_of,reason")
    .eq("product_id", productId).eq("tenant_id", tenantId).eq("user_id", user.id)
    .order("created_at", { ascending: false }).limit(40);
  if (manualError) throw new Error("COINOPS_ADJUSTMENT_LEDGER_UNAVAILABLE");
  const targetMatch = /^(SHADOW|TESTNET|REAL):(BTC|SOL):([1-9]|1\d|2[0-5])$/.exec(searchParams?.adjust || "");
  const initialManualTarget = targetMatch ? {
    environment: targetMatch[1] as "SHADOW" | "TESTNET" | "REAL",
    asset: targetMatch[2] as "BTC" | "SOL", slotNumber: Number(targetMatch[3]),
  } : null;
  const dailyCandles = (await Promise.all(["BTCUSDC", "SOLUSDC"].map(async (symbol) =>
    getDailyMarketCandles(symbol as "BTCUSDC" | "SOLUSDC").catch(() => [])
  ))).flat();
  // Each asset resolves its own latest persisted run through the authenticated
  // RLS client. Viewing BTC must never reuse SOL's ledger or start an executor.
  const testnetAssetData: Partial<Record<"BTC" | "SOL", TestnetAssetData>> = {};
  await Promise.all((["BTC", "SOL"] as const).map(async (asset) => {
    const { data: runs, error } = await supabase.from("robot_v1_testnet_runs")
      .select("id,strategy_version,status,symbol,last_reconciled_at,last_error,created_at,slot_notional_usdc,gain_rate,entry_spacing,next_capital_usdc,next_gain_rate,next_entry_spacing,previous_run_id,completed_at,completion_reason,reset_started_at,reset_completed_at,recovery_source")
      .eq("tenant_id", tenantId).eq("user_id", user.id).eq("asset", asset).order("created_at", { ascending: false }).limit(20);
    if (error) throw error;
    const run = runs?.find((item) => item.status === "ACTIVE" || item.status === "PAUSED") || runs?.[0];
    if (!run) return;
    const runIds = (runs || []).map((item) => item.id);
    const [slots, orders, events, missedEvents] = await Promise.all([
      supabase.from("robot_v1_testnet_slots").select("run_id,slot_number,entry_state,target_buy_price,balance_usdc,gain_count,net_profit_usdc,missed_at,operation_sequence,entry_origin,entry_reference_price,last_take_profit_price,created_at,updated_at,post_ath_group,post_ath_group_rank,operational_rank").in("run_id", runIds).order("slot_number"),
      supabase.from("robot_v1_testnet_orders").select("run_id,slot_number,side,purpose,revision,operation_sequence,client_order_id,exchange_order_id,status,requested_quantity,price,executed_quantity,cumulative_quote,fee_base,fee_quote,fee_other,created_at,updated_at").in("run_id", runIds).order("created_at"),
      supabase.from("robot_v1_testnet_events").select("id,run_id,event_type,slot_number,observed_at,details").in("run_id", runIds).order("observed_at", { ascending: false }).limit(40),
      supabase.from("robot_v1_testnet_events").select("id,run_id,event_type,slot_number,observed_at,details").eq("run_id", run.id).in("event_type", [...TESTNET_MISSED_EVENT_TYPES]).order("observed_at", { ascending: false }).limit(100)
    ]);
    if (slots.error || orders.error || events.error || missedEvents.error) throw slots.error || orders.error || events.error || missedEvents.error;
    const allSlots = slots.data || [], allOrders = orders.data || [];
    testnetAssetData[asset] = {
      run,
      slots: allSlots.filter((item) => item.run_id === run.id),
      orders: allOrders.filter((item) => item.run_id === run.id),
      events: [...new Map([...(events.data || []), ...(missedEvents.data || [])].map((event) => [event.id, event])).values()].sort((a, b) => b.observed_at.localeCompare(a.observed_at)),
      history: (runs || []).filter((item) => item.id !== run.id).map((historicalRun) => ({
        run: historicalRun,
        slots: allSlots.filter((item) => item.run_id === historicalRun.id),
        orders: allOrders.filter((item) => item.run_id === historicalRun.id)
      }))
    };
  }));
  const testnetRun = testnetAssetData.SOL?.run || null;
  const monthlyGoals: Array<MonthlySlotStatus & { environment: "SHADOW" | "TESTNET"; asset: "BTC" | "SOL" }> = [];
  const monthlyNow = new Date().toISOString(), periodKey = monthlyPeriodKey(monthlyNow);
  for (const asset of ["BTC", "SOL"] as const) for (const environment of ["SHADOW", "TESTNET"] as const) {
    const config = (robotConfigsResponse.data || []).find((item) => item.asset === asset);
    const cycle = (robotCyclesResponse.data || []).find((item) => item.config_id === config?.id && ["STARTING", "GRID_ACTIVE", "POSITIONS_ACTIVE", "RESETTING"].includes(item.status));
    const run = testnetAssetData[asset]?.run;
    const physical = environment === "SHADOW" ? (accountsResponse.data || []).filter((item) => item.config_id === config?.id)
      : testnetAssetData[asset]?.slots || [];
    if (!(environment === "SHADOW" ? config : run) || physical.length !== 25) continue;
    const inputs = physical.map((item) => {
      const slotNumber = item.slot_number;
      const id = physicalSlotIdentity(environment, { productId, tenantId,
        userId: user.id, asset, configId: config?.id }, slotNumber);
      const total = (monthlyResponse.data || []).find((row) => row.environment === environment && row.asset === asset && row.slot_number === slotNumber);
      const lifetime = Number(total?.lifetime_gain_count ?? 0);
      const consistent = (!total || total.physical_slot_id === id && total.period_key === periodKey)
        && (environment === "SHADOW" ? item.gain_count === lifetime : item.gain_count <= lifetime);
      const slotState = environment === "SHADOW" ? (robotSlotsResponse.data || []).find((row) => row.cycle_id === cycle?.id && row.slot_number === slotNumber)?.status
        : (item as TestnetAssetData["slots"][number]).entry_state;
      return { physicalSlotNumber: slotNumber, physicalSlotId: id, lifetimeGainCount: lifetime,
        monthlyGainCount: consistent ? Number(total?.monthly_gain_count ?? 0) : null,
        balanceUsdc: Number(item.balance_usdc), entryState: slotState || "PLANNED",
        marketGainCount: Number(total?.market_gain_count ?? 0), manualGainCount: Number(total?.manual_gain_count ?? 0),
        monthlyMarketGainCount: Number(total?.monthly_market_gain_count ?? 0),
        monthlyManualGainCount: Number(total?.monthly_manual_gain_count ?? 0) };
    });
    monthlyGoals.push(...rankMonthlySlots(asset, monthlyNow, inputs).map((status) => ({ ...status, environment, asset })));
  }
  const athSlotRows = monthlyGoals.map((goal) => {
    const config = (robotConfigsResponse.data || []).find((item) => item.asset === goal.asset);
    const cycle = (robotCyclesResponse.data || []).find((item) => item.config_id === config?.id
      && ["STARTING", "GRID_ACTIVE", "POSITIONS_ACTIVE", "RESETTING"].includes(item.status));
    const shadowSlot = goal.environment === "SHADOW"
      ? (robotSlotsResponse.data || []).find((item) => item.cycle_id === cycle?.id && item.slot_number === goal.physicalSlotNumber)
      : null;
    const testnetSlots = testnetAssetData[goal.asset]?.slots as Array<TestnetAssetData["slots"][number]
      & { post_ath_group?: "PRIMARY" | "RESERVE" | null; post_ath_group_rank?: number | null;
        operational_rank?: number | null }> | undefined;
    const testnetSlot = goal.environment === "TESTNET"
      ? testnetSlots?.find((item) => item.slot_number === goal.physicalSlotNumber) : null;
    const slot = shadowSlot || testnetSlot;
    return { environment: goal.environment, asset: goal.asset, physicalSlotNumber: goal.physicalSlotNumber,
      physicalSlotId: goal.physicalSlotId, lifetimeGains: goal.lifetimeGainCount,
      monthlyGains: goal.monthlyGainCount, monthlyTarget: goal.monthlyGainTarget,
      balanceUsdc: goal.balanceUsdc, eligible: goal.eligibleForNewEntry,
      operationalRank: slot?.operational_rank ?? goal.operationalRank,
      group: slot?.post_ath_group ?? null, groupRank: slot?.post_ath_group_rank ?? null,
      status: goal.entryState, buyPrice: Number(shadowSlot?.buy_price ?? testnetSlot?.target_buy_price ?? 0) };
  });

  const latestRun = runsResponse.data as ReconciliationRunRow | null;
  const mismatches = (latestRun?.summary?.EXPECTED_ONLY || 0) + (latestRun?.summary?.EXCHANGE_ONLY || 0) + (latestRun?.summary?.QUANTITY_MISMATCH || 0) + (latestRun?.summary?.PRICE_MISMATCH || 0) + (latestRun?.summary?.STATUS_MISMATCH || 0);
  const dashboard = <AutomationCenter view={view} data={{
    connectionStatus: connectionResponse.data?.connection_status,
    lastSyncedAt: connectionResponse.data?.last_synced_at || connectionResponse.data?.last_reconciled_at,
    balances: latestRun?.summary?.balances || [],
    reconciliationStatus: latestRun?.status,
    reconciliationAt: latestRun?.completed_at,
    mismatches,
    configs: (robotConfigsResponse.data || []) as RobotV1ConfigRow[],
    cycles: (robotCyclesResponse.data || []) as RobotV1CycleRow[],
    slots: (robotSlotsResponse.data || []) as RobotV1SlotRow[],
    operations: (operationsResponse.data || []) as RobotV1OperationRow[],
    slotAccounts: (accountsResponse.data || []) as RobotV1SlotAccountRow[],
    events: (eventsResponse.data || []) as RobotV1EventRow[],
    candles: (candlesResponse.data || []) as RobotV1CandleRow[],
    dailyCandles,
    intentCount: (intentsResponse.data as IntentRow[] | null)?.length || 0,
    solBrlPilot: { ...assessSolBrlPilot(SOL_BRL_PUBLIC_SNAPSHOT.filters, SOL_BRL_PUBLIC_SNAPSHOT.priceBrl), observedAt: SOL_BRL_PUBLIC_SNAPSHOT.observedAt, status: SOL_BRL_PUBLIC_SNAPSHOT.status, priceBrl: SOL_BRL_PUBLIC_SNAPSHOT.priceBrl, priceTick: SOL_BRL_PUBLIC_SNAPSHOT.filters.priceTick, quantityStep: SOL_BRL_PUBLIC_SNAPSHOT.filters.quantityStep, minQuantity: SOL_BRL_PUBLIC_SNAPSHOT.filters.minQuantity, minNotional: SOL_BRL_PUBLIC_SNAPSHOT.filters.minNotional, orderTypes: SOL_BRL_PUBLIC_SNAPSHOT.orderTypes },
    testnet,
    testnetActionError: searchParams?.testnetError && /^COINOPS_TESTNET_[A-Z_]+$/.test(searchParams.testnetError) ? searchParams.testnetError : null,
    testnetEnabled: process.env.COINOPS_TESTNET_ENABLED === "true",
    testnetRun,
    testnetSlots: testnetAssetData.SOL?.slots || [],
    testnetOrders: testnetAssetData.SOL?.orders || [],
    testnetEvents: testnetAssetData.SOL?.events || [],
    testnetAssetData
    , monthlyGoals
  }} />;

  const testnetHealth = Object.values(testnetAssetData).map(({ run, slots, orders, events }) => testnetPresentationHealth(
    summarizeTestnetResults(slots, orders, null, Number(run.slot_notional_usdc || 0), { asset: run.symbol.replace("USDC", ""), cycleId: run.id, events }),
    run, Date.now(), testnetDiagnosticIssue(testnet, searchParams?.testnetError)
  ));
  return <AutomationPageShell userLabel={user.email || "Usuário"} status={{
    shadowActive: (robotConfigsResponse.data || []).some((config) => !config.kill_switch && !config.pause_new_entries),
    testnetOperating: testnetHealth.some((health) => health.healthy),
    testnetError: testnetHealth.some((health) => health.tone === "error"),
    testnetAttention: testnetHealth.some((health) => health.tone === "attention") || Boolean(testnetDiagnosticIssue(testnet, searchParams?.testnetError))
  }}><ManualAdjustmentsPanel recent={(manualAdjustments || []) as RecentManualAdjustment[]} initial={initialManualTarget} /><AthProfilesPanel profiles={(athProfilesResponse.data || []) as Parameters<typeof AthProfilesPanel>[0]["profiles"]}
    slots={athSlotRows} marketPrices={{
      BTC: Number((robotConfigsResponse.data || []).find((item) => item.asset === "BTC")?.last_market_price) || null,
      SOL: Number((robotConfigsResponse.data || []).find((item) => item.asset === "SOL")?.last_market_price) || null,
    }} view={view} />{dashboard}</AutomationPageShell>;
}
