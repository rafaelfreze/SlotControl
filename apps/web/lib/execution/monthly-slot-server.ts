import "server-only";

import type { createServiceRoleClient } from "../supabase/service-role";
import type { V1Asset } from "./robot-v1";
import { monthlyPeriodKey, physicalSlotIdentity, rankMonthlySlots, type MonthlySlotStatus } from "./monthly-slot-policy";

type Service = ReturnType<typeof createServiceRoleClient>;
type Scope = { product_id: string; tenant_id: string; user_id: string; asset: V1Asset; config_id?: string };
type SlotSnapshot = { slot_number: number; balance_usdc: number | string; gain_count?: number; entry_state: string };
type TotalRow = { slot_number: number; physical_slot_id: string; lifetime_gain_count: number;
  monthly_gain_count: number; period_key: string; market_gain_count: number; manual_gain_count: number;
  monthly_market_gain_count: number; monthly_manual_gain_count: number };

/** One scoped snapshot of immutable credits. Missing or inconsistent evidence
 * fails closed before a new entry can be dispatched to either adapter. */
export async function loadMonthlySlotStatuses(service: Service, environment: "SHADOW" | "TESTNET",
  scope: Scope, slots: readonly SlotSnapshot[], observedAt = new Date().toISOString()): Promise<MonthlySlotStatus[]> {
  if (slots.length !== 25) throw new Error("COINOPS_MONTHLY_SLOT_COUNT_INVALID");
  const { data, error } = await service.from("robot_v1_slot_gain_totals")
    .select("slot_number,physical_slot_id,lifetime_gain_count,monthly_gain_count,period_key,market_gain_count,manual_gain_count,monthly_market_gain_count,monthly_manual_gain_count")
    .eq("product_id", scope.product_id).eq("tenant_id", scope.tenant_id).eq("user_id", scope.user_id)
    .eq("environment", environment).eq("asset", scope.asset);
  if (error || !Array.isArray(data)) throw new Error("COINOPS_MONTHLY_GAIN_LEDGER_UNAVAILABLE");
  const totals = data as TotalRow[];
  const byNumber = new Map(totals.map((row) => [row.slot_number, row]));
  if (byNumber.size !== totals.length) throw new Error("COINOPS_MONTHLY_GAIN_LEDGER_AMBIGUOUS");
  const periodKey = monthlyPeriodKey(observedAt);
  return rankMonthlySlots(scope.asset, observedAt, slots.map((slot) => {
    const physicalSlotId = physicalSlotIdentity(environment, { productId: scope.product_id, tenantId: scope.tenant_id,
      userId: scope.user_id, asset: scope.asset, configId: scope.config_id }, slot.slot_number);
    const row = byNumber.get(slot.slot_number);
    if (row && (row.physical_slot_id !== physicalSlotId || row.period_key !== periodKey))
      throw new Error("COINOPS_MONTHLY_GAIN_LEDGER_AMBIGUOUS");
    const lifetime = Number(row?.lifetime_gain_count ?? 0);
    const monthly = Number(row?.monthly_gain_count ?? 0);
    if (slot.gain_count != null && (environment === "SHADOW" ? slot.gain_count !== lifetime : slot.gain_count > lifetime))
      throw new Error("COINOPS_MONTHLY_GAIN_LEDGER_MISMATCH");
    return { physicalSlotNumber: slot.slot_number, physicalSlotId, lifetimeGainCount: lifetime,
      monthlyGainCount: monthly, balanceUsdc: Number(slot.balance_usdc), entryState: slot.entry_state,
      marketGainCount: Number(row?.market_gain_count ?? 0), manualGainCount: Number(row?.manual_gain_count ?? 0),
      monthlyMarketGainCount: Number(row?.monthly_market_gain_count ?? 0),
      monthlyManualGainCount: Number(row?.monthly_manual_gain_count ?? 0) };
  }));
}
