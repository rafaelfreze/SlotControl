import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { DesktopWorkspace } from "@/components/app/desktop-workspace";
import { MobileScreen } from "@/components/app/mobile-ui";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

import { AutomationMobile } from "./automation-mobile";

export const metadata: Metadata = { title: "Automação" };
export const dynamic = "force-dynamic";

type IntentRow = { id: string };
type ReconciliationRunRow = { status: string; completed_at: string | null; summary: { MATCH?: number; EXPECTED_ONLY?: number; EXCHANGE_ONLY?: number; QUANTITY_MISMATCH?: number; PRICE_MISMATCH?: number; STATUS_MISMATCH?: number; balances?: Array<{ asset: string; free: number; locked: number; total: number }> } | null };
type RobotV1ConfigRow = { id: string; asset: "BTC" | "SOL"; symbol: string; execution_mode: "SHADOW" | "TESTNET"; capital_usdc: number | string; next_capital_usdc: number | string | null; gain_rate: number | string; entry_spacing: number | string; next_gain_rate: number | string | null; next_entry_spacing: number | string | null; slot_count: number; kill_switch: boolean; pause_new_entries: boolean; shadow_test_started_at: string | null; shadow_test_target_end_at: string | null; last_candle_open_at: string | null; last_market_price: number | string | null; last_market_observed_at: string | null; last_engine_at: string | null; last_engine_error: string | null; grid_status: string | null; grid_error: string | null };
type RobotV1CycleRow = { id: string; config_id: string; asset: "BTC" | "SOL"; status: string; anchor_price: number | string; slot_notional_usdc: number | string; capital_usdc: number | string; gain_rate: number | string; entry_spacing: number | string; started_at: string; completed_at: string | null; completion_reason: string | null };
type RobotV1SlotRow = { id: string; cycle_id: string; slot_number: number; logical_level: number; operation_sequence: number; allocation_usdc: number | string; buy_price: number | string; requested_quantity: number | string; buy_status: string; executed_quantity: number | string; average_fill_price: number | string | null; take_profit_price: number | string | null; take_profit_status: string; status: string; realized_quote_pnl: number | string | null; buy_triggered_at: string | null };
type RobotV1OperationRow = { id: string; cycle_id: string; slot_id: string; physical_slot_number: number; logical_level: number; operation_sequence: number; allocation_usdc: number | string; entry_price: number | string; take_profit_price: number | string; gross_quote_pnl: number | string; estimated_quote_fees: number | string; net_quote_pnl: number | string; opened_at: string | null; closed_at: string };
type RobotV1SlotAccountRow = { config_id: string; slot_number: number; initial_balance_usdc: number | string; balance_usdc: number | string; gain_count: number; gross_profit_usdc: number | string; fees_usdc: number | string; net_profit_usdc: number | string; last_operation_id: string | null };
type RobotV1EventRow = { cycle_id: string; slot_id: string | null; event_type: string; next_state: Record<string, unknown> | null; observed_at: string };

export default async function AutomationPage() {
  if (!isSupabaseConfigured()) redirect("/login?setup=missing-env");
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [connectionResponse, runsResponse, robotConfigsResponse, robotCyclesResponse, robotSlotsResponse, operationsResponse, accountsResponse, eventsResponse, intentsResponse] = await Promise.all([
    supabase.from("exchange_connections").select("connection_status,last_reconciled_at,last_synced_at").eq("exchange", "BINANCE_SPOT").maybeSingle(),
    supabase.from("exchange_reconciliation_runs").select("status,completed_at,summary").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("robot_v1_configs").select("id,asset,symbol,execution_mode,capital_usdc,next_capital_usdc,gain_rate,entry_spacing,next_gain_rate,next_entry_spacing,slot_count,kill_switch,pause_new_entries,shadow_test_started_at,shadow_test_target_end_at,last_candle_open_at,last_market_price,last_market_observed_at,last_engine_at,last_engine_error,grid_status,grid_error").order("asset"),
    supabase.from("robot_v1_cycles").select("id,config_id,asset,status,anchor_price,slot_notional_usdc,capital_usdc,gain_rate,entry_spacing,started_at,completed_at,completion_reason").order("started_at", { ascending: false }),
    supabase.from("robot_v1_slots").select("id,cycle_id,slot_number,logical_level,operation_sequence,allocation_usdc,buy_price,requested_quantity,buy_status,executed_quantity,average_fill_price,take_profit_price,take_profit_status,status,realized_quote_pnl,buy_triggered_at").order("slot_number"),
    supabase.from("robot_v1_slot_operations").select("id,cycle_id,slot_id,physical_slot_number,logical_level,operation_sequence,allocation_usdc,entry_price,take_profit_price,gross_quote_pnl,estimated_quote_fees,net_quote_pnl,opened_at,closed_at").order("closed_at", { ascending: false }),
    supabase.from("robot_v1_slot_accounts").select("config_id,slot_number,initial_balance_usdc,balance_usdc,gain_count,gross_profit_usdc,fees_usdc,net_profit_usdc,last_operation_id").order("slot_number"),
    supabase.from("robot_v1_audit_events").select("cycle_id,slot_id,event_type,next_state,observed_at").order("observed_at", { ascending: false }).limit(40),
    supabase.from("exchange_order_intents").select("id").limit(12)
  ]);
  const shadowReadError = robotConfigsResponse.error || robotCyclesResponse.error || robotSlotsResponse.error || operationsResponse.error || accountsResponse.error;
  if (shadowReadError) throw shadowReadError;

  const latestRun = runsResponse.data as ReconciliationRunRow | null;
  const mismatches = (latestRun?.summary?.EXPECTED_ONLY || 0) + (latestRun?.summary?.EXCHANGE_ONLY || 0) + (latestRun?.summary?.QUANTITY_MISMATCH || 0) + (latestRun?.summary?.PRICE_MISMATCH || 0) + (latestRun?.summary?.STATUS_MISMATCH || 0);
  const dashboard = <AutomationMobile
    connectionStatus={connectionResponse.data?.connection_status}
    lastSyncedAt={connectionResponse.data?.last_synced_at || connectionResponse.data?.last_reconciled_at}
    balances={latestRun?.summary?.balances || []}
    reconciliationStatus={latestRun?.status}
    reconciliationAt={latestRun?.completed_at}
    mismatches={mismatches}
    configs={(robotConfigsResponse.data || []) as RobotV1ConfigRow[]}
    cycles={(robotCyclesResponse.data || []) as RobotV1CycleRow[]}
    slots={(robotSlotsResponse.data || []) as RobotV1SlotRow[]}
    operations={(operationsResponse.data || []) as RobotV1OperationRow[]}
    slotAccounts={(accountsResponse.data || []) as RobotV1SlotAccountRow[]}
    events={(eventsResponse.data || []) as RobotV1EventRow[]}
    intentCount={(intentsResponse.data as IntentRow[] | null)?.length || 0}
  />;

  return <MobileScreen desktop={<DesktopWorkspace title="Automação — Seu robô CoinOps" subtitle="Mercado real • dinheiro virtual" userLabel={user.email || "Usuário"}>{dashboard}</DesktopWorkspace>}>{dashboard}</MobileScreen>;
}
