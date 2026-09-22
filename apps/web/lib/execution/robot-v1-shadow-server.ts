import "server-only";

import { createHash } from "node:crypto";

import { getCoinOpsServiceTenantId } from "@/lib/supabase/env";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

import { BinanceSpotAdapter } from "./binance-spot-adapter";
import { V1_RULES, assertV1ShadowParameters, buildV1Grid, buildV1InitialShadowPosition, evaluateV1Candle, v1ClientOrderId, v1IdempotencyKey, type V1Asset, type V1ShadowParameters } from "./robot-v1";

type Config = { id: string; product_id: string; tenant_id: string; user_id: string; asset: V1Asset; symbol: string; capital_usdc: number | string; next_capital_usdc: number | string | null; gain_rate: number | string; entry_spacing: number | string; next_gain_rate: number | string | null; next_entry_spacing: number | string | null; kill_switch: boolean; pause_new_entries: boolean; last_candle_open_at: string | null };
type Cycle = { id: string; status: string; asset: V1Asset; symbol: string; started_at: string; gain_rate: number | string; entry_spacing: number | string };
type Slot = { id: string; slot_number: number; buy_price: number | string; requested_quantity: number | string; executed_quantity: number | string; average_fill_price: number | string | null; take_profit_price: number | string | null; status: "PENDING" | "PARTIALLY_FILLED" | "OPEN" | "TP_ACTIVE" | "CLOSED" };
const ACTIVE = ["STARTING", "GRID_ACTIVE", "POSITIONS_ACTIVE", "RESETTING"];

function asNumber(value: number | string | null, code: string) { const result = Number(value); if (!Number.isFinite(result) || result < 0) throw new Error(code); return result; }
function eventKey(configId: string, type: string, reference: string) { return createHash("sha256").update(`coinops-v1-shadow|${configId}|${type}|${reference}`).digest("hex"); }

async function audit(supabase: ReturnType<typeof createServiceRoleClient>, config: Config, type: string, reference: string, values: { cycleId?: string | null; slotId?: string | null; previous?: Record<string, unknown>; next?: Record<string, unknown>; observedAt?: string }) {
  const { error } = await supabase.from("robot_v1_audit_events").upsert({
    product_id: config.product_id, tenant_id: config.tenant_id, user_id: config.user_id, config_id: config.id, cycle_id: values.cycleId || null, slot_id: values.slotId || null,
    event_type: type, previous_state: values.previous || {}, next_state: values.next || {}, observed_at: values.observedAt || new Date().toISOString(), idempotency_key: eventKey(config.id, type, reference)
  }, { onConflict: "product_id,tenant_id,user_id,idempotency_key", ignoreDuplicates: true });
  if (error) throw error;
}

/**
 * Server-only V1 Shadow worker. Production Binance calls remain GET-only.
 * One-minute candles prove crossed levels between five-minute cron runs; a
 * BUY and TP in the same candle stays ambiguous and never fabricates a gain.
 */
export async function runConfiguredRobotV1Shadow(now = new Date()) {
  const supabase = createServiceRoleClient();
  const tenantId = getCoinOpsServiceTenantId();
  const { data, error } = await supabase.from("robot_v1_configs")
    .select("id,product_id,tenant_id,user_id,asset,symbol,capital_usdc,next_capital_usdc,gain_rate,entry_spacing,next_gain_rate,next_entry_spacing,kill_switch,pause_new_entries,last_candle_open_at")
    .eq("tenant_id", tenantId).eq("execution_mode", "SHADOW").order("asset");
  if (error) throw error;
  const configs = (data || []) as Config[];
  if (!configs.length) return { status: "NOT_CONFIGURED" as const, cyclesStarted: 0, slotsUpdated: 0, candlesProcessed: 0 };

  const adapter = BinanceSpotAdapter.fromEnvironment();
  let cyclesStarted = 0, slotsUpdated = 0, candlesProcessed = 0;
  for (const config of configs) {
    const rule = V1_RULES[config.asset];
    const parameters = assertV1ShadowParameters({ gainRate: asNumber(config.gain_rate, "COINOPS_V1_PARAMETERS_INVALID"), entrySpacing: asNumber(config.entry_spacing, "COINOPS_V1_PARAMETERS_INVALID") });
    if (config.symbol !== rule.symbol) throw new Error("COINOPS_V1_CONFIG_SYMBOL_INVALID");
    const { data: cycleData, error: cycleError } = await supabase.from("robot_v1_cycles").select("id,status,asset,symbol,started_at,gain_rate,entry_spacing").eq("config_id", config.id).in("status", ACTIVE).maybeSingle();
    if (cycleError) throw cycleError;
    let cycle = cycleData as Cycle | null;
    if (!cycle && !config.kill_switch && !config.pause_new_entries) {
      const [filters, market] = await Promise.all([adapter.getSymbolInfo(rule.symbol), adapter.getMarketPrice(rule.symbol)]);
      const capital = asNumber(config.capital_usdc, "COINOPS_V1_CAPITAL_INVALID");
      const grid = buildV1Grid(config.asset, capital, market.price, filters, parameters);
      const { data: created, error: createError } = await supabase.from("robot_v1_cycles").insert({
        product_id: config.product_id, tenant_id: config.tenant_id, user_id: config.user_id, config_id: config.id, asset: config.asset, symbol: rule.symbol,
        execution_mode: "SHADOW", status: "STARTING", anchor_price: market.price, slot_notional_usdc: capital / grid.length, capital_usdc: capital, gain_rate: parameters.gainRate, entry_spacing: parameters.entrySpacing, started_at: now.toISOString()
      }).select("id,status,asset,symbol,started_at,gain_rate,entry_spacing").single();
      if (createError) throw createError;
      cycle = created as Cycle;
      const initialPosition = buildV1InitialShadowPosition(grid);
      const { error: slotError } = await supabase.from("robot_v1_slots").insert(grid.map((slot) => {
        const isInitial = slot.slotNumber === initialPosition.slotNumber;
        return {
          product_id: config.product_id, tenant_id: config.tenant_id, user_id: config.user_id, cycle_id: cycle!.id, slot_number: slot.slotNumber, symbol: rule.symbol,
          buy_price: slot.buyPrice, requested_quantity: slot.quantity, executed_quantity: isInitial ? initialPosition.quantity : 0,
          average_fill_price: isInitial ? initialPosition.buyPrice : null, buy_status: isInitial ? "FILLED" : "PENDING",
          buy_trigger_price: isInitial ? initialPosition.buyPrice : null, buy_trigger_observed_price: isInitial ? market.price : null, buy_triggered_at: isInitial ? market.observedAt : null,
          take_profit_price: isInitial ? initialPosition.takeProfitPrice : null, take_profit_status: isInitial ? "PENDING" : "NONE", status: isInitial ? "TP_ACTIVE" : "PENDING",
          buy_client_order_id: v1ClientOrderId(config.asset, cycle!.id, slot.slotNumber, "BUY"), sell_client_order_id: isInitial ? v1ClientOrderId(config.asset, cycle!.id, slot.slotNumber, "SELL") : null,
          idempotency_key: v1IdempotencyKey(cycle!.id, slot.slotNumber, "BUY"), observed_at: market.observedAt
        };
      }));
      if (slotError) {
        const failureCode = /^[A-Z0-9_]{1,48}$/i.test(slotError.code || "") ? slotError.code : "UNKNOWN";
        await supabase.from("robot_v1_cycles").update({ status: "FAILED", completion_reason: `GRID_SLOT_INSERT_${failureCode}` }).eq("id", cycle.id);
        throw slotError;
      }
      const { error: activateError } = await supabase.from("robot_v1_cycles").update({ status: "GRID_ACTIVE" }).eq("id", cycle.id);
      if (activateError) throw activateError;
      await audit(supabase, config, "CYCLE_STARTED", cycle.id, { cycleId: cycle.id, next: { asset: config.asset, symbol: rule.symbol, capital, slots: grid.length, anchorPrice: market.price, gainRate: parameters.gainRate, entrySpacing: parameters.entrySpacing } });
      await audit(supabase, config, "INITIAL_POSITION_OPENED", `${cycle.id}:1`, { cycleId: cycle.id, next: { slotNumber: initialPosition.slotNumber, fillPrice: initialPosition.buyPrice, observedPrice: market.price, takeProfitPrice: initialPosition.takeProfitPrice }, observedAt: market.observedAt });
      cyclesStarted += 1;
    }
    if (!cycle) continue;

    const startAt = config.last_candle_open_at ? Date.parse(config.last_candle_open_at) + 60_000 : Date.parse(cycle.started_at);
    const candles = (await adapter.getCandles(rule.symbol, "1m", startAt)).filter((candle) => Date.parse(candle.closeTime) <= now.getTime()).sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));
    if (candles.length === 1000 && startAt < Date.parse(candles[0].openTime)) await audit(supabase, config, "DATA_GAP", `${cycle.id}:${candles[0].openTime}`, { cycleId: cycle.id, previous: { requestedStart: new Date(startAt).toISOString() }, next: { firstAvailable: candles[0].openTime } });
    const filters = await adapter.getSymbolInfo(rule.symbol);
    for (const candle of candles) {
      const { data: persisted, error: candleError } = await supabase.from("robot_v1_market_candles").upsert({
        product_id: config.product_id, tenant_id: config.tenant_id, user_id: config.user_id, config_id: config.id, cycle_id: cycle.id, symbol: rule.symbol,
        candle_open_at: candle.openTime, candle_close_at: candle.closeTime, open_price: candle.open, high_price: candle.high, low_price: candle.low, close_price: candle.close
      }, { onConflict: "config_id,candle_open_at", ignoreDuplicates: true }).select("id").maybeSingle();
      if (candleError) throw candleError;
      if (!persisted?.id) continue;
      candlesProcessed += 1;
      const { data: rows, error: slotReadError } = await supabase.from("robot_v1_slots").select("id,slot_number,buy_price,requested_quantity,executed_quantity,average_fill_price,take_profit_price,status").eq("cycle_id", cycle.id).order("slot_number");
      if (slotReadError) throw slotReadError;
      const slots = (rows || []) as Slot[];
      const cycleParameters: V1ShadowParameters = assertV1ShadowParameters({ gainRate: asNumber(cycle.gain_rate, "COINOPS_V1_PARAMETERS_INVALID"), entrySpacing: asNumber(cycle.entry_spacing, "COINOPS_V1_PARAMETERS_INVALID") });
      const transitions = evaluateV1Candle(config.asset, candle, slots.map((slot) => ({ slotNumber: slot.slot_number, status: slot.status, buyPrice: asNumber(slot.buy_price, "COINOPS_V1_SLOT_INVALID"), averageFillPrice: slot.average_fill_price === null ? null : asNumber(slot.average_fill_price, "COINOPS_V1_SLOT_INVALID"), takeProfitPrice: slot.take_profit_price === null ? null : asNumber(slot.take_profit_price, "COINOPS_V1_SLOT_INVALID") })), filters, cycleParameters);
      for (const transition of transitions) {
        const slot = slots.find((candidate) => candidate.slot_number === transition.slotNumber);
        if (!slot) continue;
        if (transition.kind === "BUY_TRIGGERED" && !config.kill_switch && !config.pause_new_entries) {
          const quantity = asNumber(slot.requested_quantity, "COINOPS_V1_SLOT_INVALID");
          const { error: updateError } = await supabase.from("robot_v1_slots").update({
            executed_quantity: quantity, average_fill_price: transition.fillPrice, buy_status: "FILLED", buy_trigger_price: asNumber(slot.buy_price, "COINOPS_V1_SLOT_INVALID"), buy_trigger_observed_price: transition.observedPrice, buy_triggered_at: candle.closeTime, take_profit_price: transition.takeProfitPrice, take_profit_status: "PENDING", status: "TP_ACTIVE", sell_client_order_id: v1ClientOrderId(config.asset, cycle.id, slot.slot_number, "SELL"), observed_at: candle.closeTime
          }).eq("id", slot.id).eq("status", "PENDING");
          if (updateError) throw updateError;
          await audit(supabase, config, "BUY_TRIGGERED", `${cycle.id}:${slot.id}:${candle.openTime}`, { cycleId: cycle.id, slotId: slot.id, next: { triggerPrice: slot.buy_price, observedLow: transition.observedPrice, fillPrice: transition.fillPrice, takeProfitPrice: transition.takeProfitPrice }, observedAt: candle.closeTime });
          slotsUpdated += 1;
        }
        if (transition.kind === "TP_TRIGGERED") {
          const quantity = asNumber(slot.executed_quantity, "COINOPS_V1_SLOT_INVALID"), fill = asNumber(slot.average_fill_price, "COINOPS_V1_SLOT_INVALID"), target = asNumber(slot.take_profit_price, "COINOPS_V1_SLOT_INVALID");
          const { error: updateError } = await supabase.from("robot_v1_slots").update({ take_profit_status: "FILLED", status: "CLOSED", tp_trigger_observed_price: transition.observedPrice, tp_triggered_at: candle.closeTime, realized_quote_pnl: Number(((target - fill) * quantity).toFixed(12)), observed_at: candle.closeTime }).eq("id", slot.id).eq("status", "TP_ACTIVE");
          if (updateError) throw updateError;
          await audit(supabase, config, "TP_TRIGGERED", `${cycle.id}:${slot.id}:${candle.openTime}`, { cycleId: cycle.id, slotId: slot.id, next: { targetPrice: target, observedHigh: transition.observedPrice }, observedAt: candle.closeTime });
          slotsUpdated += 1;
        }
        if (transition.kind === "AMBIGUOUS") await audit(supabase, config, "INTRABAR_AMBIGUOUS", `${cycle.id}:${slot.id}:${candle.openTime}`, { cycleId: cycle.id, slotId: slot.id, next: { reason: "BUY_AND_TP_IN_SAME_CANDLE", observedHigh: transition.observedPrice }, observedAt: candle.closeTime });
      }
      const { error: checkpointError } = await supabase.from("robot_v1_configs").update({ last_candle_open_at: candle.openTime }).eq("id", config.id);
      if (checkpointError) throw checkpointError;
    }
    const { data: remaining, error: remainingError } = await supabase.from("robot_v1_slots").select("id").eq("cycle_id", cycle.id).neq("status", "CLOSED").limit(1);
    if (remainingError) throw remainingError;
    if (!remaining?.length) {
      const nextCapital = config.next_capital_usdc === null ? null : asNumber(config.next_capital_usdc, "COINOPS_V1_CAPITAL_INVALID");
      const { error: finishError } = await supabase.from("robot_v1_cycles").update({ status: "CYCLE_COMPLETE", completed_at: now.toISOString() }).eq("id", cycle.id);
      if (finishError) throw finishError;
      const nextParameters = config.next_gain_rate === null || config.next_entry_spacing === null ? null : assertV1ShadowParameters({ gainRate: asNumber(config.next_gain_rate, "COINOPS_V1_PARAMETERS_INVALID"), entrySpacing: asNumber(config.next_entry_spacing, "COINOPS_V1_PARAMETERS_INVALID") });
      const configUpdate = { last_candle_open_at: null, ...(nextCapital ? { capital_usdc: nextCapital, next_capital_usdc: null } : {}), ...(nextParameters ? { gain_rate: nextParameters.gainRate, entry_spacing: nextParameters.entrySpacing, next_gain_rate: null, next_entry_spacing: null } : {}) };
      const { error: capitalError } = await supabase.from("robot_v1_configs").update(configUpdate).eq("id", config.id);
      if (capitalError) throw capitalError;
      await audit(supabase, config, "CYCLE_COMPLETED", cycle.id, { cycleId: cycle.id, previous: { capital: config.capital_usdc }, next: { nextCapitalApplied: nextCapital }, observedAt: now.toISOString() });
    }
  }
  return { status: "COMPLETED" as const, cyclesStarted, slotsUpdated, candlesProcessed };
}
