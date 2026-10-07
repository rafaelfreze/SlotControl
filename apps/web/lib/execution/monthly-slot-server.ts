import "server-only";

import type { createServiceRoleClient } from "../supabase/service-role";
import type { V1Asset } from "./robot-v1";
import { monthlyPeriodKey, physicalSlotIdentity, rankMonthlySlots, type MonthlySlotStatus } from "./monthly-slot-policy";
import { resolveOperatorEngine } from "./operator-context-server";
import { assertPhysicalLedger, boundedLedgerRead, observeLedgerRows } from "./live-ledger-read";
import { LiveReadUnavailable } from "./live-read-error";

type Service = ReturnType<typeof createServiceRoleClient>;
type Scope = { product_id: string; tenant_id: string; user_id: string; asset: V1Asset; config_id?: string;
  operator_id?: string; exchange_account_id?: string; trading_engine_id?: string };
type SlotSnapshot = { slot_number: number; balance_quote?: number | string; balance_usdc?: number | string; balance_brl?: number | string; gain_count?: number; entry_state: string };
type TotalRow = { slot_number: number; physical_slot_id: string; lifetime_gain_count: number;
  monthly_gain_count: number; period_key: string; market_gain_count: number; manual_gain_count: number;
  monthly_market_gain_count: number; monthly_manual_gain_count: number };

/** One scoped snapshot of immutable credits. Missing or inconsistent evidence
 * fails closed before a new entry can be dispatched to either adapter. */
export async function loadMonthlySlotStatuses(service: Service, environment: "SHADOW" | "TESTNET" | "REAL",
  scope: Scope, slots: readonly SlotSnapshot[], observedAt = new Date().toISOString()): Promise<MonthlySlotStatus[]> {
  if (slots.length !== 25) throw new Error("COINOPS_MONTHLY_SLOT_COUNT_INVALID");
  assertPhysicalLedger([...slots]);
  const engine = await resolveOperatorEngine(service, scope, { environment, asset: scope.asset,
    operator_id: scope.operator_id, exchange_account_id: scope.exchange_account_id, trading_engine_id: scope.trading_engine_id });
  const totalsQuery = () => service.from("robot_v1_slot_gain_totals")
    .select("slot_number,physical_slot_id,lifetime_gain_count,monthly_gain_count,period_key,market_gain_count,manual_gain_count,monthly_market_gain_count,monthly_manual_gain_count")
    .eq("product_id", scope.product_id).eq("tenant_id", scope.tenant_id).eq("user_id", scope.user_id)
    .eq("environment", environment).eq("asset", scope.asset).eq("trading_engine_id", engine.trading_engine_id);
  let totals: TotalRow[];
  let configuredTarget: number | null = null;
  if (environment === "REAL") {
    // This is a read-only dependency of every trading tick, not a gain mutation.
    // Discard partial target/totals on a transient error; never replay a trade.
    const snapshot = await boundedLedgerRead(async (deadline, attempt) => {
      const [target, gains] = await Promise.allSettled([
        observeLedgerRows<{ monthly_target: number }>("monthly_target",
          service.from("robot_v1_live_preparations").select("monthly_target")
            .eq("product_id", scope.product_id).eq("tenant_id", scope.tenant_id).eq("user_id", scope.user_id)
            .eq("operator_id", engine.operator_id).eq("exchange_account_id", engine.exchange_account_id)
            .eq("trading_engine_id", engine.trading_engine_id).limit(2).abortSignal(deadline), deadline, attempt),
        observeLedgerRows<TotalRow>("monthly_gains", totalsQuery()
          .eq("operator_id", engine.operator_id).eq("exchange_account_id", engine.exchange_account_id)
          .abortSignal(deadline), deadline, attempt),
      ]);
      for (const result of [target, gains]) if (result.status === "rejected"
        && !(result.reason instanceof LiveReadUnavailable)) throw result.reason;
      if (target.status === "rejected") throw target.reason;
      if (gains.status === "rejected") throw gains.reason;
      if (target.value.length !== 1 || !Number.isInteger(target.value[0].monthly_target)
        || target.value[0].monthly_target <= 0) throw new Error("COINOPS_MONTHLY_TARGET_UNAVAILABLE");
      return { target: target.value[0].monthly_target, totals: gains.value };
    });
    totals = snapshot.totals;
    configuredTarget = snapshot.target;
  } else {
    const { data, error } = await totalsQuery();
    if (error || !Array.isArray(data)) throw new Error("COINOPS_MONTHLY_GAIN_LEDGER_UNAVAILABLE");
    totals = data as TotalRow[];
  }
  const byNumber = new Map(totals.map((row) => [row.slot_number, row]));
  if (byNumber.size !== totals.length || totals.some(row => !Number.isInteger(row.slot_number)
    || row.slot_number < 1 || row.slot_number > 25)) throw new Error("COINOPS_MONTHLY_GAIN_LEDGER_AMBIGUOUS");
  const periodKey = monthlyPeriodKey(observedAt);
  return rankMonthlySlots(scope.asset, observedAt, slots.map((slot) => {
    const physicalSlotId = physicalSlotIdentity(environment, { productId: scope.product_id, tenantId: scope.tenant_id,
      userId: scope.user_id, asset: scope.asset, configId: scope.config_id,
      tradingEngineId: engine.trading_engine_id, legacyCompatible: engine.legacy_compatible }, slot.slot_number);
    const row = byNumber.get(slot.slot_number);
    if (row && (row.physical_slot_id !== physicalSlotId || row.period_key !== periodKey))
      throw new Error("COINOPS_MONTHLY_GAIN_LEDGER_AMBIGUOUS");
    const lifetime = Number(row?.lifetime_gain_count ?? 0);
    const monthly = Number(row?.monthly_gain_count ?? 0);
    if (slot.gain_count != null && (environment === "SHADOW" ? slot.gain_count !== lifetime : slot.gain_count > lifetime))
      throw new Error("COINOPS_MONTHLY_GAIN_LEDGER_MISMATCH");
    return { physicalSlotNumber: slot.slot_number, physicalSlotId, lifetimeGainCount: lifetime,
      monthlyGainCount: monthly, balanceUsdc: Number(slot.balance_quote ?? (environment === "REAL" ? slot.balance_brl : slot.balance_usdc)), entryState: slot.entry_state,
      marketGainCount: Number(row?.market_gain_count ?? 0), manualGainCount: Number(row?.manual_gain_count ?? 0),
      monthlyMarketGainCount: Number(row?.monthly_market_gain_count ?? 0),
      monthlyManualGainCount: Number(row?.monthly_manual_gain_count ?? 0) };
  }), configuredTarget ?? (scope.asset === "BTC" ? 7 : 2));
}
