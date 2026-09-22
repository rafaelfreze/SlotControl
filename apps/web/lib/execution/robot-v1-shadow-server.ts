import "server-only";

import { getCoinOpsServiceTenantId } from "@/lib/supabase/env";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

import { BinanceSpotAdapter } from "./binance-spot-adapter";
import { V1_RULES, buildV1Grid, calculateV1TakeProfit, v1ClientOrderId, v1IdempotencyKey, type V1Asset } from "./robot-v1";

type V1ConfigRow = { id: string; product_id: string; tenant_id: string; user_id: string; asset: V1Asset; symbol: string; execution_mode: "SHADOW"; capital_usdc: number | string };
type V1CycleRow = { id: string; status: "STARTING" | "GRID_ACTIVE" | "POSITIONS_ACTIVE" | "RESETTING"; asset: V1Asset; symbol: string };
type V1SlotRow = { id: string; slot_number: number; buy_price: number | string; requested_quantity: number | string; executed_quantity: number | string; average_fill_price: number | string | null; take_profit_price: number | string | null; status: "PENDING" | "PARTIALLY_FILLED" | "OPEN" | "TP_ACTIVE" | "CLOSED" };

const ACTIVE_CYCLE_STATUSES = ["STARTING", "GRID_ACTIVE", "POSITIONS_ACTIVE", "RESETTING"];

function asNumber(value: number | string | null, code: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(code);
  return number;
}

/**
 * Runs a fully simulated V1 cycle using production Binance market observations.
 * It is deliberately SHADOW-only: the production adapter cannot issue a POST,
 * DELETE, transfer, conversion, withdrawal, or order request.
 */
export async function runConfiguredRobotV1Shadow(now = new Date()) {
  const supabase = createServiceRoleClient();
  const tenantId = getCoinOpsServiceTenantId();
  const { data: configData, error: configError } = await supabase
    .from("robot_v1_configs")
    .select("id,product_id,tenant_id,user_id,asset,symbol,execution_mode,capital_usdc")
    .eq("tenant_id", tenantId)
    .eq("execution_mode", "SHADOW")
    .eq("kill_switch", false)
    .order("asset");
  if (configError) throw configError;
  const configs = (configData || []) as V1ConfigRow[];
  if (!configs.length) return { status: "NOT_CONFIGURED" as const, cyclesStarted: 0, slotsUpdated: 0 };

  const adapter = BinanceSpotAdapter.fromEnvironment();
  let cyclesStarted = 0;
  let slotsUpdated = 0;

  for (const config of configs) {
    const rule = V1_RULES[config.asset];
    if (config.symbol !== rule.symbol) throw new Error("COINOPS_V1_CONFIG_SYMBOL_INVALID");
    const { data: currentCycle, error: cycleError } = await supabase.from("robot_v1_cycles")
      .select("id,status,asset,symbol").eq("config_id", config.id).in("status", ACTIVE_CYCLE_STATUSES).maybeSingle();
    if (cycleError) throw cycleError;
    const [filters, market] = await Promise.all([adapter.getSymbolInfo(rule.symbol), adapter.getMarketPrice(rule.symbol)]);
    let cycle = currentCycle as V1CycleRow | null;

    if (!cycle) {
      const capitalUsdc = asNumber(config.capital_usdc, "COINOPS_V1_CAPITAL_INVALID");
      const grid = buildV1Grid(config.asset, capitalUsdc, market.price, filters);
      const { data: createdCycle, error: createCycleError } = await supabase.from("robot_v1_cycles").insert({
        product_id: config.product_id, tenant_id: config.tenant_id, user_id: config.user_id, config_id: config.id,
        asset: config.asset, symbol: rule.symbol, execution_mode: "SHADOW", status: "STARTING", anchor_price: market.price,
        slot_notional_usdc: capitalUsdc / grid.length, capital_usdc: capitalUsdc, started_at: now.toISOString()
      }).select("id,status,asset,symbol").single();
      if (createCycleError) throw createCycleError;
      cycle = createdCycle as V1CycleRow;
      const { error: createSlotsError } = await supabase.from("robot_v1_slots").insert(grid.map((slot) => ({
        product_id: config.product_id, tenant_id: config.tenant_id, user_id: config.user_id, cycle_id: cycle!.id,
        slot_number: slot.slotNumber, symbol: rule.symbol, buy_price: slot.buyPrice, requested_quantity: slot.quantity,
        buy_client_order_id: v1ClientOrderId(config.asset, cycle!.id, slot.slotNumber, "BUY"),
        idempotency_key: v1IdempotencyKey(cycle!.id, slot.slotNumber, "BUY"), observed_at: market.observedAt
      })));
      if (createSlotsError) {
        await supabase.from("robot_v1_cycles").update({ status: "FAILED" }).eq("id", cycle.id);
        throw createSlotsError;
      }
      const { error: activateCycleError } = await supabase.from("robot_v1_cycles").update({ status: "GRID_ACTIVE" }).eq("id", cycle.id);
      if (activateCycleError) throw activateCycleError;
      cyclesStarted += 1;
    }

    const { data: slotData, error: slotsError } = await supabase.from("robot_v1_slots")
      .select("id,slot_number,buy_price,requested_quantity,executed_quantity,average_fill_price,take_profit_price,status")
      .eq("cycle_id", cycle.id).order("slot_number");
    if (slotsError) throw slotsError;
    const slots = (slotData || []) as V1SlotRow[];
    for (const slot of slots) {
      const buyPrice = asNumber(slot.buy_price, "COINOPS_V1_SLOT_INVALID");
      const requestedQuantity = asNumber(slot.requested_quantity, "COINOPS_V1_SLOT_INVALID");
      if (slot.status === "PENDING" && market.price <= buyPrice) {
        const takeProfitPrice = calculateV1TakeProfit(config.asset, market.price, filters);
        const { error } = await supabase.from("robot_v1_slots").update({
          executed_quantity: requestedQuantity, average_fill_price: market.price, buy_status: "FILLED", take_profit_price: takeProfitPrice,
          take_profit_status: "PENDING", status: "TP_ACTIVE", sell_client_order_id: v1ClientOrderId(config.asset, cycle.id, slot.slot_number, "SELL"), observed_at: market.observedAt
        }).eq("id", slot.id).eq("status", "PENDING");
        if (error) throw error;
        slotsUpdated += 1;
      } else if (slot.status === "TP_ACTIVE") {
        const averageFillPrice = asNumber(slot.average_fill_price, "COINOPS_V1_SLOT_INVALID");
        const takeProfitPrice = asNumber(slot.take_profit_price, "COINOPS_V1_SLOT_INVALID");
        const executedQuantity = asNumber(slot.executed_quantity, "COINOPS_V1_SLOT_INVALID");
        if (market.price >= takeProfitPrice) {
          const { error } = await supabase.from("robot_v1_slots").update({
            take_profit_status: "FILLED", status: "CLOSED", realized_quote_pnl: Number(((market.price - averageFillPrice) * executedQuantity).toFixed(12)), observed_at: market.observedAt
          }).eq("id", slot.id).eq("status", "TP_ACTIVE");
          if (error) throw error;
          slotsUpdated += 1;
        }
      }
    }

    const { data: remainingSlots, error: remainingError } = await supabase.from("robot_v1_slots").select("id").eq("cycle_id", cycle.id).neq("status", "CLOSED").limit(1);
    if (remainingError) throw remainingError;
    if (!remainingSlots?.length) {
      const { error } = await supabase.from("robot_v1_cycles").update({ status: "CYCLE_COMPLETE", completed_at: now.toISOString() }).eq("id", cycle.id);
      if (error) throw error;
    }
  }
  return { status: "COMPLETED" as const, cyclesStarted, slotsUpdated };
}
