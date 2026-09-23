import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { diagnoseBinanceSpotTestnet } from "@/lib/execution/binance-spot-testnet-adapter";
import { getDailyMarketCandles } from "@/lib/execution/market-daily-candles";
import { SOL_BRL_PUBLIC_SNAPSHOT, assessSolBrlPilot } from "@/lib/execution/robot-v1-live-readiness";
import { getCoinOpsServiceTenantId } from "@/lib/supabase/env";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { recordRuntimeObservation } from "@/lib/coinops-reports/runtime-observation-server";

import type { AutomationView } from "./automation-center";
import { AutomationCenter } from "./automation-cockpit";
import { AutomationPageShell } from "./automation-page-shell";
import type { TestnetAssetData } from "./automation-mobile";

export const metadata: Metadata = { title: "Automação" };
export const dynamic = "force-dynamic";
export const preferredRegion = "gru1";

type IntentRow = { id: string };
type ReconciliationRunRow = { status: string; completed_at: string | null; summary: { MATCH?: number; EXPECTED_ONLY?: number; EXCHANGE_ONLY?: number; QUANTITY_MISMATCH?: number; PRICE_MISMATCH?: number; STATUS_MISMATCH?: number; balances?: Array<{ asset: string; free: number; locked: number; total: number }> } | null };
type RobotV1ConfigRow = { id: string; asset: "BTC" | "SOL"; symbol: string; execution_mode: "SHADOW" | "TESTNET"; capital_usdc: number | string; next_capital_usdc: number | string | null; gain_rate: number | string; entry_spacing: number | string; next_gain_rate: number | string | null; next_entry_spacing: number | string | null; slot_count: number; kill_switch: boolean; pause_new_entries: boolean; shadow_test_started_at: string | null; shadow_test_target_end_at: string | null; last_candle_open_at: string | null; last_market_price: number | string | null; last_market_observed_at: string | null; last_engine_at: string | null; last_engine_error: string | null; grid_status: string | null; grid_error: string | null; configured_live_capital_brl: number | string | null; max_order_notional_brl: number | string | null; max_total_exposure_brl: number | string | null };
type RobotV1CycleRow = { id: string; config_id: string; asset: "BTC" | "SOL"; status: string; anchor_price: number | string; slot_notional_usdc: number | string; capital_usdc: number | string; gain_rate: number | string; entry_spacing: number | string; started_at: string; completed_at: string | null; completion_reason: string | null };
type RobotV1SlotRow = { id: string; cycle_id: string; slot_number: number; logical_level: number; operation_sequence: number; entry_state: "NONE" | "ARMED" | "PLANNED"; armed_at: string | null; missed_at: string | null; buy_client_order_id: string; sell_client_order_id: string | null; allocation_usdc: number | string; buy_price: number | string; requested_quantity: number | string; buy_status: string; executed_quantity: number | string; average_fill_price: number | string | null; take_profit_price: number | string | null; take_profit_status: string; status: string; realized_quote_pnl: number | string | null; buy_triggered_at: string | null; tp_triggered_at: string | null };
type RobotV1OperationRow = { id: string; cycle_id: string; slot_id: string; physical_slot_number: number; logical_level: number; operation_sequence: number; allocation_usdc: number | string; entry_price: number | string; executed_quantity: number | string; take_profit_price: number | string; gross_quote_pnl: number | string; estimated_quote_fees: number | string; net_quote_pnl: number | string; opened_at: string | null; closed_at: string };
type RobotV1SlotAccountRow = { config_id: string; slot_number: number; initial_balance_usdc: number | string; balance_usdc: number | string; gain_count: number; gross_profit_usdc: number | string; fees_usdc: number | string; net_profit_usdc: number | string; last_operation_id: string | null };
type RobotV1EventRow = { cycle_id: string; slot_id: string | null; event_type: string; next_state: Record<string, unknown> | null; observed_at: string };
type RobotV1CandleRow = { symbol: string; candle_open_at: string; open_price: number | string; high_price: number | string; low_price: number | string; close_price: number | string };

export default async function AutomationPage({ searchParams }: { searchParams?: { view?: string; testnet?: string; testnetError?: string } }) {
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

  const [connectionResponse, runsResponse, robotConfigsResponse, robotCyclesResponse, robotSlotsResponse, operationsResponse, accountsResponse, eventsResponse, candlesResponse, intentsResponse] = await Promise.all([
    supabase.from("exchange_connections").select("connection_status,last_reconciled_at,last_synced_at").eq("exchange", "BINANCE_SPOT").maybeSingle(),
    supabase.from("exchange_reconciliation_runs").select("status,completed_at,summary").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("robot_v1_configs").select("id,asset,symbol,execution_mode,capital_usdc,next_capital_usdc,gain_rate,entry_spacing,next_gain_rate,next_entry_spacing,slot_count,kill_switch,pause_new_entries,shadow_test_started_at,shadow_test_target_end_at,last_candle_open_at,last_market_price,last_market_observed_at,last_engine_at,last_engine_error,grid_status,grid_error,configured_live_capital_brl,max_order_notional_brl,max_total_exposure_brl").order("asset"),
    supabase.from("robot_v1_cycles").select("id,config_id,asset,status,anchor_price,slot_notional_usdc,capital_usdc,gain_rate,entry_spacing,started_at,completed_at,completion_reason").order("started_at", { ascending: false }),
    supabase.from("robot_v1_slots").select("id,cycle_id,slot_number,logical_level,operation_sequence,entry_state,armed_at,missed_at,buy_client_order_id,sell_client_order_id,allocation_usdc,buy_price,requested_quantity,buy_status,executed_quantity,average_fill_price,take_profit_price,take_profit_status,status,realized_quote_pnl,buy_triggered_at,tp_triggered_at").order("slot_number"),
    supabase.from("robot_v1_slot_operations").select("id,cycle_id,slot_id,physical_slot_number,logical_level,operation_sequence,allocation_usdc,entry_price,executed_quantity,take_profit_price,gross_quote_pnl,estimated_quote_fees,net_quote_pnl,opened_at,closed_at").order("closed_at", { ascending: false }),
    supabase.from("robot_v1_slot_accounts").select("config_id,slot_number,initial_balance_usdc,balance_usdc,gain_count,gross_profit_usdc,fees_usdc,net_profit_usdc,last_operation_id").order("slot_number"),
    supabase.from("robot_v1_audit_events").select("cycle_id,slot_id,event_type,next_state,observed_at").order("observed_at", { ascending: false }).limit(40),
    supabase.from("robot_v1_market_candles").select("symbol,candle_open_at,open_price,high_price,low_price,close_price").in("symbol", ["BTCUSDC", "SOLUSDC"]).order("candle_open_at", { ascending: false }).limit(180),
    supabase.from("exchange_order_intents").select("id").limit(12)
  ]);
  const shadowReadError = robotConfigsResponse.error || robotCyclesResponse.error || robotSlotsResponse.error || operationsResponse.error || accountsResponse.error || candlesResponse.error;
  if (shadowReadError) throw shadowReadError;
  const dailyCandles = (await Promise.all(["BTCUSDC", "SOLUSDC"].map(async (symbol) =>
    getDailyMarketCandles(symbol as "BTCUSDC" | "SOLUSDC").catch(() => [])
  ))).flat();
  // Each asset resolves its own latest persisted run through the authenticated
  // RLS client. Viewing BTC must never reuse SOL's ledger or start an executor.
  const testnetAssetData: Partial<Record<"BTC" | "SOL", TestnetAssetData>> = {};
  await Promise.all((["BTC", "SOL"] as const).map(async (asset) => {
    const { data: runs, error } = await supabase.from("robot_v1_testnet_runs")
      .select("id,status,symbol,last_reconciled_at,last_error,created_at,slot_notional_usdc,gain_rate,entry_spacing,next_capital_usdc,next_gain_rate,next_entry_spacing,previous_run_id,completed_at,completion_reason,reset_started_at,reset_completed_at,recovery_source")
      .eq("tenant_id", tenantId).eq("user_id", user.id).eq("asset", asset).order("created_at", { ascending: false }).limit(20);
    if (error) throw error;
    const run = runs?.find((item) => item.status === "ACTIVE" || item.status === "PAUSED") || runs?.[0];
    if (!run) return;
    const runIds = (runs || []).map((item) => item.id);
    const [slots, orders, events] = await Promise.all([
      supabase.from("robot_v1_testnet_slots").select("run_id,slot_number,entry_state,target_buy_price,balance_usdc,gain_count,net_profit_usdc,missed_at,operation_sequence,entry_origin,entry_reference_price,last_take_profit_price,created_at,updated_at").in("run_id", runIds).order("slot_number"),
      supabase.from("robot_v1_testnet_orders").select("run_id,slot_number,side,purpose,revision,operation_sequence,client_order_id,exchange_order_id,status,requested_quantity,price,executed_quantity,cumulative_quote,fee_base,fee_quote,fee_other,created_at,updated_at").in("run_id", runIds).order("created_at"),
      supabase.from("robot_v1_testnet_events").select("run_id,event_type,slot_number,observed_at,details").in("run_id", runIds).order("observed_at", { ascending: false }).limit(40)
    ]);
    if (slots.error || orders.error || events.error) throw slots.error || orders.error || events.error;
    const allSlots = slots.data || [], allOrders = orders.data || [];
    testnetAssetData[asset] = {
      run,
      slots: allSlots.filter((item) => item.run_id === run.id),
      orders: allOrders.filter((item) => item.run_id === run.id),
      events: events.data || [],
      history: (runs || []).filter((item) => item.id !== run.id).map((historicalRun) => ({
        run: historicalRun,
        slots: allSlots.filter((item) => item.run_id === historicalRun.id),
        orders: allOrders.filter((item) => item.run_id === historicalRun.id)
      }))
    };
  }));
  const testnetRun = testnetAssetData.SOL?.run || null;

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
  }} />;

  return <AutomationPageShell userLabel={user.email || "Usuário"} status={{
    shadowActive: (robotConfigsResponse.data || []).some((config) => !config.kill_switch && !config.pause_new_entries),
    testnetOperating: Object.values(testnetAssetData).some(({ run }) => run.status === "ACTIVE" && !run.last_error),
    testnetError: Boolean(Object.values(testnetAssetData).some(({ run }) => run.last_error) || searchParams?.testnetError || (testnet && !testnet.ok))
  }}>{dashboard}</AutomationPageShell>;
}
