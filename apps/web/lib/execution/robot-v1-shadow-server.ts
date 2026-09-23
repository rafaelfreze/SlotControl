import "server-only";

import { createHash } from "node:crypto";

import { getCoinOpsServiceTenantId } from "@/lib/supabase/env";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { recordRuntimeObservation } from "@/lib/coinops-reports/runtime-observation-server";

import { BinanceSpotAdapter } from "./binance-spot-adapter";
import { sumV1DecimalAmounts } from "./robot-v1-audit";
import { V1_RULES, V1_SLOT_COUNT, assertV1ShadowParameters, buildV1Grid, buildV1InitialShadowPosition, buildV1LocalReentry, evaluateV1Candle, planV1NextEntry, planV1ShadowCycleRestart, quantityForV1SlotBalance, selectV1CandleResidentSlots, validateActiveGrid, v1ClientOrderId, v1IdempotencyKey, type V1Asset, type V1ShadowParameters } from "./robot-v1";

type Config = { id: string; product_id: string; tenant_id: string; user_id: string; asset: V1Asset; symbol: string; capital_usdc: number | string; next_capital_usdc: number | string | null; gain_rate: number | string; entry_spacing: number | string; next_gain_rate: number | string | null; next_entry_spacing: number | string | null; kill_switch: boolean; pause_new_entries: boolean; last_candle_open_at: string | null; last_market_price: number | string | null; last_market_observed_at: string | null; last_engine_at: string | null; last_engine_error: string | null; grid_status: string | null; grid_error: string | null };
type Cycle = { id: string; status: string; asset: V1Asset; symbol: string; anchor_price: number | string; started_at: string; gain_rate: number | string; entry_spacing: number | string };
type Slot = { id: string; slot_number: number; logical_level: number; operation_sequence: number; entry_state: "NONE" | "ARMED" | "PLANNED"; armed_at: string | null; missed_at: string | null; allocation_usdc: number | string; buy_price: number | string; requested_quantity: number | string; executed_quantity: number | string; average_fill_price: number | string | null; take_profit_price: number | string | null; realized_quote_pnl: number | string | null; sell_fee: number | string; buy_client_order_id: string; sell_client_order_id: string | null; buy_triggered_at: string | null; tp_triggered_at: string | null; status: "PENDING" | "PARTIALLY_FILLED" | "OPEN" | "TP_ACTIVE" | "CLOSED" | "CANCELLED" };
type SlotAccount = { slot_number: number; initial_balance_usdc: number | string; balance_usdc: number | string; gain_count: number; net_profit_usdc: number | string };
const SLOT_COLUMNS = "id,slot_number,logical_level,operation_sequence,entry_state,armed_at,missed_at,allocation_usdc,buy_price,requested_quantity,executed_quantity,average_fill_price,take_profit_price,realized_quote_pnl,sell_fee,buy_client_order_id,sell_client_order_id,buy_triggered_at,tp_triggered_at,status";
const ACTIVE = ["STARTING", "GRID_ACTIVE", "POSITIONS_ACTIVE", "RESETTING"];

function asNumber(value: number | string | null, code: string) { const result = Number(value); if (!Number.isFinite(result) || result < 0) throw new Error(code); return result; }
function asSignedNumber(value: number | string | null, code: string) { const result = Number(value); if (!Number.isFinite(result)) throw new Error(code); return result; }
function eventKey(configId: string, type: string, reference: string) { return createHash("sha256").update(`coinops-v1-shadow|${configId}|${type}|${reference}`).digest("hex"); }

async function audit(supabase: ReturnType<typeof createServiceRoleClient>, config: Config, type: string, reference: string, values: { cycleId?: string | null; slotId?: string | null; previous?: Record<string, unknown>; next?: Record<string, unknown>; observedAt?: string }) {
  const { error } = await supabase.from("robot_v1_audit_events").upsert({
    product_id: config.product_id, tenant_id: config.tenant_id, user_id: config.user_id, config_id: config.id, cycle_id: values.cycleId || null, slot_id: values.slotId || null,
    event_type: type, previous_state: values.previous || {}, next_state: values.next || {}, observed_at: values.observedAt || new Date().toISOString(), idempotency_key: eventKey(config.id, type, reference)
  }, { onConflict: "product_id,tenant_id,user_id,idempotency_key", ignoreDuplicates: true });
  if (error) throw error;
}

async function archiveClosedShadowOperation(supabase: ReturnType<typeof createServiceRoleClient>, config: Config, cycle: Cycle, slot: Slot, values: { closedAt: string; grossProfit: number; estimatedFees: number }) {
  const { error } = await supabase.from("robot_v1_slot_operations").upsert({
    product_id: config.product_id, tenant_id: config.tenant_id, user_id: config.user_id, cycle_id: cycle.id, slot_id: slot.id, physical_slot_number: slot.slot_number, operation_sequence: slot.operation_sequence, logical_level: slot.logical_level, allocation_usdc: slot.allocation_usdc,
    symbol: cycle.symbol, entry_price: slot.average_fill_price, executed_quantity: slot.executed_quantity, take_profit_price: slot.take_profit_price,
    buy_client_order_id: slot.buy_client_order_id, sell_client_order_id: slot.sell_client_order_id, opened_at: slot.buy_triggered_at, closed_at: values.closedAt,
    gross_quote_pnl: values.grossProfit, estimated_quote_fees: values.estimatedFees, net_quote_pnl: values.grossProfit - values.estimatedFees
  }, { onConflict: "slot_id,operation_sequence", ignoreDuplicates: true });
  if (error) throw error;
}

async function loadSlotAccounts(supabase: ReturnType<typeof createServiceRoleClient>, config: Config) {
  const read = async () => {
    const { data, error } = await supabase.from("robot_v1_slot_accounts")
      .select("slot_number,initial_balance_usdc,balance_usdc,gain_count,net_profit_usdc")
      .eq("config_id", config.id).eq("product_id", config.product_id).eq("tenant_id", config.tenant_id).eq("user_id", config.user_id).order("slot_number");
    if (error) throw error;
    return (data || []) as SlotAccount[];
  };
  let accounts = await read();
  if (accounts.length === 0) {
    const opening = asNumber(config.capital_usdc, "COINOPS_V1_CAPITAL_INVALID") / V1_SLOT_COUNT;
    const { error: seedError } = await supabase.from("robot_v1_slot_accounts").upsert(Array.from({ length: V1_SLOT_COUNT }, (_, index) => ({
      config_id: config.id, slot_number: index + 1, product_id: config.product_id, tenant_id: config.tenant_id, user_id: config.user_id,
      initial_balance_usdc: opening, balance_usdc: opening
    })), { onConflict: "config_id,slot_number", ignoreDuplicates: true });
    if (seedError) throw seedError;
    accounts = await read();
  }
  if (accounts.length !== V1_SLOT_COUNT || accounts.some((account, index) => account.slot_number !== index + 1
    || asNumber(account.initial_balance_usdc, "COINOPS_V1_SLOT_ACCOUNT_INVALID") <= 0
    || asNumber(account.balance_usdc, "COINOPS_V1_SLOT_ACCOUNT_INVALID") <= 0)) throw new Error("COINOPS_V1_SLOT_ACCOUNT_INVALID");
  return accounts;
}

async function reconcileSingleArmedEntry(supabase: ReturnType<typeof createServiceRoleClient>, config: Config, cycle: Cycle, observedFloor: number, observedAt: string, canArm: boolean) {
  const { data, error } = await supabase.from("robot_v1_slots").select(SLOT_COLUMNS).eq("cycle_id", cycle.id).order("slot_number");
  if (error) throw error;
  const slots = (data || []) as Slot[];
  const armed = slots.filter((slot) => slot.status === "PENDING" && slot.entry_state === "ARMED");
  if (armed.length > 1) throw new Error("COINOPS_V1_MULTIPLE_ARMED_BUYS");
  if (!canArm) {
    for (const slot of armed) {
      const { error: disarmError } = await supabase.from("robot_v1_slots").update({ entry_state: "PLANNED", armed_at: null }).eq("id", slot.id).eq("status", "PENDING").eq("entry_state", "ARMED");
      if (disarmError) throw disarmError;
      await audit(supabase, config, "NEXT_BUY_DISARMED", `${cycle.id}:${slot.id}:${slot.operation_sequence}:${observedAt}`, { cycleId: cycle.id, slotId: slot.id, next: { reason: "ENTRIES_PAUSED_OR_GRID_INVALID" }, observedAt });
    }
    return;
  }
  if (armed.length === 1) {
    const current = armed[0]!;
    const higherCandidate = slots.filter((slot) => slot.status === "PENDING" && slot.entry_state !== "ARMED" && slot.missed_at === null)
      .filter((slot) => asNumber(slot.buy_price, "COINOPS_V1_SLOT_INVALID") < observedFloor && asNumber(slot.buy_price, "COINOPS_V1_SLOT_INVALID") > asNumber(current.buy_price, "COINOPS_V1_SLOT_INVALID"))
      .sort((a, b) => asNumber(b.buy_price, "COINOPS_V1_SLOT_INVALID") - asNumber(a.buy_price, "COINOPS_V1_SLOT_INVALID"))[0];
    if (!higherCandidate) return;
    const { error: replaceError } = await supabase.from("robot_v1_slots").update({ entry_state: "PLANNED", armed_at: null })
      .eq("id", current.id).eq("status", "PENDING").eq("entry_state", "ARMED");
    if (replaceError) throw replaceError;
    current.entry_state = "PLANNED";
    current.armed_at = null;
    await audit(supabase, config, "NEXT_BUY_DISARMED", `${cycle.id}:${current.id}:${current.operation_sequence}:higher-reentry`, { cycleId: cycle.id, slotId: current.id, next: { reason: "HIGHER_LOCAL_REENTRY_PRIORITY", replacementSlotNumber: higherCandidate.slot_number }, observedAt });
  }
  const plan = planV1NextEntry(slots.map((slot) => ({ slotNumber: slot.slot_number, buyPrice: asNumber(slot.buy_price, "COINOPS_V1_SLOT_INVALID"), status: slot.status, entryState: slot.entry_state, armedAt: slot.armed_at, missedAt: slot.missed_at })), observedFloor);
  if (plan.current !== null) return;
  for (const slotNumber of plan.missed) {
    const slot = slots.find((candidate) => candidate.slot_number === slotNumber)!;
    const { data: missed, error: missedError } = await supabase.from("robot_v1_slots").update({ entry_state: "PLANNED", missed_at: observedAt })
      .eq("id", slot.id).eq("status", "PENDING").is("missed_at", null).neq("entry_state", "ARMED").select("id").maybeSingle();
    if (missedError) throw missedError;
    if (missed?.id) await audit(supabase, config, "MISSED_LEVEL_DURING_REARM", `${cycle.id}:${slot.id}:${slot.operation_sequence}`, { cycleId: cycle.id, slotId: slot.id, next: { slotNumber, buyPrice: slot.buy_price, observedFloor, reason: "NO_RESIDENT_BUY_AT_CROSSING" }, observedAt });
  }
  if (plan.next === null) return;
  const next = slots.find((slot) => slot.slot_number === plan.next)!;
  const { data: armedRow, error: armError } = await supabase.from("robot_v1_slots").update({ entry_state: "ARMED", armed_at: observedAt })
    .eq("id", next.id).eq("status", "PENDING").is("missed_at", null).in("entry_state", ["NONE", "PLANNED"]).select("id").maybeSingle();
  if (armError) throw armError;
  if (armedRow?.id) {
    await audit(supabase, config, "NEXT_BUY_ARMED", `${cycle.id}:${next.id}:${next.operation_sequence}`, { cycleId: cycle.id, slotId: next.id, next: { slotNumber: next.slot_number, logicalLevel: next.logical_level, buyPrice: next.buy_price, observedFloor }, observedAt });
    if (next.operation_sequence > 1) await audit(supabase, config, "SLOT_REENTRY_ARMED", `${cycle.id}:${next.id}:${next.operation_sequence}`, { cycleId: cycle.id, slotId: next.id, next: { physicalSlotNumber: next.slot_number, operationSequence: next.operation_sequence, reentryPrice: next.buy_price, localRecycleVsGlobalReset: "LOCAL_REENTRY" }, observedAt });
  }
}

async function startInitialShadowCycle(supabase: ReturnType<typeof createServiceRoleClient>, adapter: BinanceSpotAdapter, config: Config, now: Date) {
  const rule = V1_RULES[config.asset];
  const parameters = assertV1ShadowParameters({ gainRate: asNumber(config.gain_rate, "COINOPS_V1_PARAMETERS_INVALID"), entrySpacing: asNumber(config.entry_spacing, "COINOPS_V1_PARAMETERS_INVALID") });
  const [filters, market] = await Promise.all([adapter.getSymbolInfo(rule.symbol), adapter.getMarketPrice(rule.symbol)]);
  const accounts = await loadSlotAccounts(supabase, config);
  const slotBalances = accounts.map((account) => asNumber(account.balance_usdc, "COINOPS_V1_SLOT_ACCOUNT_INVALID"));
  const capital = sumV1DecimalAmounts(accounts.map((account) => account.balance_usdc));
  const grid = buildV1Grid(config.asset, Number(capital), market.price, filters, parameters, slotBalances);
  const { data: created, error: createError } = await supabase.from("robot_v1_cycles").insert({
    product_id: config.product_id, tenant_id: config.tenant_id, user_id: config.user_id, config_id: config.id, asset: config.asset, symbol: rule.symbol,
    execution_mode: "SHADOW", status: "STARTING", anchor_price: market.price, slot_notional_usdc: Number(capital) / grid.length, capital_usdc: capital, gain_rate: parameters.gainRate, entry_spacing: parameters.entrySpacing, started_at: now.toISOString()
  }).select("id,status,asset,symbol,anchor_price,started_at,gain_rate,entry_spacing").single();
  if (createError?.code === "23505") return null;
  if (createError) throw createError;
  const cycle = created as Cycle;
  const initialPosition = buildV1InitialShadowPosition(grid);
  const { error: slotError } = await supabase.from("robot_v1_slots").insert(grid.map((slot) => {
    const isInitial = slot.slotNumber === initialPosition.slotNumber;
    return {
      product_id: config.product_id, tenant_id: config.tenant_id, user_id: config.user_id, cycle_id: cycle.id, slot_number: slot.slotNumber, logical_level: slot.logicalLevel, symbol: rule.symbol, allocation_usdc: accounts[slot.slotNumber - 1]!.balance_usdc,
      entry_state: isInitial ? "NONE" : slot.slotNumber === 2 ? "ARMED" : "PLANNED", armed_at: slot.slotNumber === 2 ? market.observedAt : null,
      buy_price: slot.buyPrice, requested_quantity: slot.quantity, executed_quantity: isInitial ? initialPosition.quantity : 0,
      average_fill_price: isInitial ? initialPosition.buyPrice : null, buy_status: isInitial ? "FILLED" : "PENDING",
      buy_trigger_price: isInitial ? initialPosition.buyPrice : null, buy_trigger_observed_price: isInitial ? market.price : null, buy_triggered_at: isInitial ? market.observedAt : null,
      take_profit_price: isInitial ? initialPosition.takeProfitPrice : null, take_profit_status: isInitial ? "PENDING" : "NONE", status: isInitial ? "TP_ACTIVE" : "PENDING",
      buy_client_order_id: v1ClientOrderId(config.asset, cycle.id, slot.slotNumber, "BUY"), sell_client_order_id: isInitial ? v1ClientOrderId(config.asset, cycle.id, slot.slotNumber, "SELL") : null,
      idempotency_key: v1IdempotencyKey(cycle.id, slot.slotNumber, "BUY"), observed_at: market.observedAt
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
  await audit(supabase, config, "NEXT_BUY_ARMED", `${cycle.id}:2:1`, { cycleId: cycle.id, next: { slotNumber: 2, logicalLevel: 2, buyPrice: grid[1]?.buyPrice, observedFloor: market.price }, observedAt: market.observedAt });
  return cycle;
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
    .select("id,product_id,tenant_id,user_id,asset,symbol,capital_usdc,next_capital_usdc,gain_rate,entry_spacing,next_gain_rate,next_entry_spacing,kill_switch,pause_new_entries,last_candle_open_at,last_market_price,last_market_observed_at,last_engine_at,last_engine_error,grid_status,grid_error")
    .eq("tenant_id", tenantId).eq("execution_mode", "SHADOW").order("asset");
  if (error) throw error;
  const configs = (data || []) as Config[];
  if (!configs.length) return { status: "NOT_CONFIGURED" as const, cyclesStarted: 0, slotsUpdated: 0, candlesProcessed: 0 };

  const adapter = BinanceSpotAdapter.fromEnvironment();
  let cyclesStarted = 0, slotsUpdated = 0, candlesProcessed = 0;
  for (const config of configs) {
    const observationStartedAt = new Date().toISOString();
    const countersBefore = { cyclesStarted, slotsUpdated, candlesProcessed };
    let observationStatus: "COMPLETED" | "FAILED" | "SKIPPED" = "COMPLETED";
    let observationError: unknown = null;
    let observationCycleId: string | null = null;
    try {
    const rule = V1_RULES[config.asset];
    if (config.symbol !== rule.symbol) throw new Error("COINOPS_V1_CONFIG_SYMBOL_INVALID");
    const { data: cycleData, error: cycleError } = await supabase.from("robot_v1_cycles").select("id,status,asset,symbol,anchor_price,started_at,gain_rate,entry_spacing").eq("config_id", config.id).in("status", ACTIVE).maybeSingle();
    if (cycleError) throw cycleError;
    let cycle = cycleData as Cycle | null;
    if (!cycle && !config.kill_switch && !config.pause_new_entries) {
      cycle = await startInitialShadowCycle(supabase, adapter, config, now);
      if (cycle) cyclesStarted += 1;
    }
    if (!cycle) { observationStatus = "SKIPPED"; continue; }
    observationCycleId = cycle.id;

    const filters = await adapter.getSymbolInfo(rule.symbol);
    const market = await adapter.getMarketPrice(rule.symbol);
    const { data: healthRows, error: healthReadError } = await supabase.from("robot_v1_slots").select(SLOT_COLUMNS).eq("cycle_id", cycle.id).order("slot_number");
    if (healthReadError) throw healthReadError;
    const healthSlots = (healthRows || []) as Slot[];
    const cycleParameters: V1ShadowParameters = assertV1ShadowParameters({ gainRate: asNumber(cycle.gain_rate, "COINOPS_V1_PARAMETERS_INVALID"), entrySpacing: asNumber(cycle.entry_spacing, "COINOPS_V1_PARAMETERS_INVALID") });
    const gridValidation = validateActiveGrid(asNumber(cycle.anchor_price, "COINOPS_V1_GRID_INPUT_INVALID"), filters, cycleParameters, healthSlots.map((slot) => ({ slotNumber: slot.slot_number, logicalLevel: slot.logical_level, buyPrice: asNumber(slot.buy_price, "COINOPS_V1_SLOT_INVALID"), status: slot.status })));
    const gridError = gridValidation.valid ? null : `GRADE ${config.asset} INVÁLIDA: ${gridValidation.errors.join(", ")}`;
    const { error: healthUpdateError } = await supabase.from("robot_v1_configs").update({
      last_market_price: market.price, last_market_observed_at: market.observedAt, last_engine_at: now.toISOString(), last_engine_error: gridError,
      grid_status: gridValidation.valid ? "VALID" : "INVALID", grid_error: gridError,
      ...(gridValidation.valid ? {} : { pause_new_entries: true })
    }).eq("id", config.id);
    if (healthUpdateError) throw healthUpdateError;
    if (!gridValidation.valid) await audit(supabase, config, "GRID_INVALID", `${cycle.id}:${gridValidation.errors.join("|")}`, { cycleId: cycle.id, next: { errors: gridValidation.errors, action: "NEW_ENTRIES_PAUSED" }, observedAt: now.toISOString() });
    await reconcileSingleArmedEntry(supabase, config, cycle, market.price, market.observedAt, gridValidation.valid && !config.kill_switch && !config.pause_new_entries);

    const accounts = await loadSlotAccounts(supabase, config);
    for (const slot of healthSlots.filter((item) => item.status === "PENDING")) {
      const account = accounts[slot.slot_number - 1];
      if (!account) throw new Error("COINOPS_V1_SLOT_ACCOUNT_INVALID");
      const { quantity } = quantityForV1SlotBalance(asNumber(account.balance_usdc, "COINOPS_V1_SLOT_ACCOUNT_INVALID"), asNumber(slot.buy_price, "COINOPS_V1_SLOT_INVALID"), filters);
      if (quantity === asNumber(slot.requested_quantity, "COINOPS_V1_SLOT_INVALID")
        && sumV1DecimalAmounts([slot.allocation_usdc]) === sumV1DecimalAmounts([account.balance_usdc])) continue;
      const { error: quantityError } = await supabase.from("robot_v1_slots").update({ requested_quantity: quantity, allocation_usdc: account.balance_usdc })
        .eq("id", slot.id).eq("status", "PENDING").eq("operation_sequence", slot.operation_sequence);
      if (quantityError) throw quantityError;
      await audit(supabase, config, "SLOT_BALANCE_UPDATED", `${cycle.id}:${slot.id}:${slot.operation_sequence}:${account.balance_usdc}`, {
        cycleId: cycle.id, slotId: slot.id, previous: { requestedQuantity: slot.requested_quantity, allocationUsdc: slot.allocation_usdc },
        next: { requestedQuantity: quantity, allocationUsdc: account.balance_usdc, reason: "PENDING_SHADOW_NOTIONAL_RECONCILED" }, observedAt: now.toISOString()
      });
    }

    const startAt = config.last_candle_open_at ? Date.parse(config.last_candle_open_at) + 60_000 : Date.parse(cycle.started_at);
    const candles = (await adapter.getCandles(rule.symbol, "1m", startAt)).filter((candle) => Date.parse(candle.closeTime) <= now.getTime()).sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));
    if (candles.length === 1000 && startAt < Date.parse(candles[0].openTime)) await audit(supabase, config, "DATA_GAP", `${cycle.id}:${candles[0].openTime}`, { cycleId: cycle.id, previous: { requestedStart: new Date(startAt).toISOString() }, next: { firstAvailable: candles[0].openTime } });
    for (const candle of candles) {
      const { error: candleError } = await supabase.from("robot_v1_market_candles").upsert({
        product_id: config.product_id, tenant_id: config.tenant_id, user_id: config.user_id, config_id: config.id, cycle_id: cycle.id, symbol: rule.symbol,
        candle_open_at: candle.openTime, candle_close_at: candle.closeTime, open_price: candle.open, high_price: candle.high, low_price: candle.low, close_price: candle.close
      }, { onConflict: "config_id,candle_open_at", ignoreDuplicates: true });
      if (candleError) throw candleError;
      // A prior attempt may have persisted the candle but failed before its
      // state transitions. Status/entry guards and audit keys make replay safe.
      candlesProcessed += 1;
      const { data: rows, error: slotReadError } = await supabase.from("robot_v1_slots").select(SLOT_COLUMNS).eq("cycle_id", cycle.id).order("slot_number");
      if (slotReadError) throw slotReadError;
      const slots = (rows || []) as Slot[];
      const residentSlots = selectV1CandleResidentSlots(slots.map((slot) => ({ slotNumber: slot.slot_number, status: slot.status, entryState: slot.entry_state, armedAt: slot.armed_at, missedAt: slot.missed_at, buyPrice: asNumber(slot.buy_price, "COINOPS_V1_SLOT_INVALID"), averageFillPrice: slot.average_fill_price === null ? null : asNumber(slot.average_fill_price, "COINOPS_V1_SLOT_INVALID"), takeProfitPrice: slot.take_profit_price === null ? null : asNumber(slot.take_profit_price, "COINOPS_V1_SLOT_INVALID") })), candle.openTime);
      const transitions = evaluateV1Candle(config.asset, candle, residentSlots, filters, cycleParameters);
      let filledBuy = false;
      for (const transition of transitions) {
        const slot = slots.find((candidate) => candidate.slot_number === transition.slotNumber);
        if (!slot) continue;
        if (transition.kind === "BUY_TRIGGERED" && gridValidation.valid && !config.kill_switch && !config.pause_new_entries) {
          const quantity = asNumber(slot.requested_quantity, "COINOPS_V1_SLOT_INVALID");
          const { data: updated, error: updateError } = await supabase.from("robot_v1_slots").update({
            executed_quantity: quantity, average_fill_price: transition.fillPrice, buy_status: "FILLED", buy_trigger_price: asNumber(slot.buy_price, "COINOPS_V1_SLOT_INVALID"), buy_trigger_observed_price: transition.observedPrice, buy_triggered_at: candle.closeTime, take_profit_price: transition.takeProfitPrice, take_profit_status: "PENDING", status: "TP_ACTIVE", entry_state: "NONE", armed_at: null, sell_client_order_id: v1ClientOrderId(config.asset, cycle.id, slot.slot_number, "SELL", slot.operation_sequence), observed_at: candle.closeTime
          }).eq("id", slot.id).eq("status", "PENDING").eq("entry_state", "ARMED").select("id").maybeSingle();
          if (updateError) throw updateError;
          if (!updated?.id) continue;
          await audit(supabase, config, "BUY_TRIGGERED", `${cycle.id}:${slot.id}:${candle.openTime}`, { cycleId: cycle.id, slotId: slot.id, next: { triggerPrice: slot.buy_price, observedLow: transition.observedPrice, fillPrice: transition.fillPrice, takeProfitPrice: transition.takeProfitPrice }, observedAt: candle.closeTime });
          slotsUpdated += 1;
          filledBuy = true;
        }
        if (transition.kind === "TP_TRIGGERED") {
          const quantity = asNumber(slot.executed_quantity, "COINOPS_V1_SLOT_INVALID"), fill = asNumber(slot.average_fill_price, "COINOPS_V1_SLOT_INVALID"), target = asNumber(slot.take_profit_price, "COINOPS_V1_SLOT_INVALID");
          const grossProfit = Number(((target - fill) * quantity).toFixed(12));
          const estimatedFees = 0;
          const { data: updated, error: updateError } = await supabase.from("robot_v1_slots").update({ take_profit_status: "FILLED", status: "CLOSED", sell_fee: estimatedFees, tp_trigger_observed_price: transition.observedPrice, tp_triggered_at: candle.closeTime, realized_quote_pnl: grossProfit - estimatedFees, observed_at: candle.closeTime }).eq("id", slot.id).eq("status", "TP_ACTIVE").select("id").maybeSingle();
          if (updateError) throw updateError;
          if (!updated?.id) continue;
          await archiveClosedShadowOperation(supabase, config, cycle, slot, { closedAt: candle.closeTime, grossProfit, estimatedFees });
          await audit(supabase, config, "TP_TRIGGERED", `${cycle.id}:${slot.id}:${candle.openTime}`, { cycleId: cycle.id, slotId: slot.id, next: { targetPrice: target, observedHigh: transition.observedPrice, grossProfit, estimatedFees, netProfit: grossProfit - estimatedFees }, observedAt: candle.closeTime });
          slotsUpdated += 1;
        }
        if (transition.kind === "AMBIGUOUS") await audit(supabase, config, "INTRABAR_AMBIGUOUS", `${cycle.id}:${slot.id}:${candle.openTime}`, { cycleId: cycle.id, slotId: slot.id, next: { reason: "BUY_AND_TP_IN_SAME_CANDLE", observedHigh: transition.observedPrice }, observedAt: candle.closeTime });
      }
      if (filledBuy) await reconcileSingleArmedEntry(supabase, config, cycle, candle.low, candle.closeTime, gridValidation.valid && !config.kill_switch && !config.pause_new_entries);
      const { error: checkpointError } = await supabase.from("robot_v1_configs").update({ last_candle_open_at: candle.openTime }).eq("id", config.id);
      if (checkpointError) throw checkpointError;
    }
    const { data: reconciledRows, error: remainingError } = await supabase.from("robot_v1_slots").select(SLOT_COLUMNS).eq("cycle_id", cycle.id).order("slot_number");
    if (remainingError) throw remainingError;
    const reconciledSlots = (reconciledRows || []) as Slot[];
    for (const slot of reconciledSlots.filter((item) => item.status === "CLOSED")) {
      await archiveClosedShadowOperation(supabase, config, cycle, slot, {
        closedAt: slot.tp_triggered_at || now.toISOString(),
        grossProfit: Number((asSignedNumber(slot.realized_quote_pnl, "COINOPS_V1_SLOT_INVALID") + asNumber(slot.sell_fee, "COINOPS_V1_SLOT_INVALID")).toFixed(12)),
        estimatedFees: asNumber(slot.sell_fee, "COINOPS_V1_SLOT_INVALID")
      });
    }
    const restartPlan = planV1ShadowCycleRestart(reconciledSlots.map((slot) => ({ slotNumber: slot.slot_number, status: slot.status })));
    const closedSlots = reconciledSlots.filter((slot) => slot.status === "CLOSED");
    if (gridValidation.valid && !restartPlan.shouldRestart && closedSlots.length) {
      const currentAccounts = await loadSlotAccounts(supabase, config);
      const balances = new Map(currentAccounts.map((account) => [account.slot_number, asNumber(account.balance_usdc, "COINOPS_V1_SLOT_ACCOUNT_INVALID")]));
      const recycledEntries = closedSlots.map((slot) => buildV1LocalReentry(slot.slot_number, asNumber(slot.average_fill_price, "COINOPS_V1_SLOT_INVALID"), balances.get(slot.slot_number)!, filters));
      for (const entry of recycledEntries) {
        const closedSlot = closedSlots.find((slot) => slot.slot_number === entry.slotNumber);
        if (!closedSlot) continue;
        const nextSequence = closedSlot.operation_sequence + 1;
        const logicalLevel = closedSlot.logical_level;
        const { data: recycled, error: recycleError } = await supabase.from("robot_v1_slots").update({
          operation_sequence: nextSequence, logical_level: logicalLevel, allocation_usdc: balances.get(closedSlot.slot_number), buy_price: entry.buyPrice, requested_quantity: entry.quantity, executed_quantity: 0, average_fill_price: null, buy_status: "PENDING", entry_state: "PLANNED", armed_at: null, missed_at: null, buy_trigger_price: null, buy_trigger_observed_price: null, buy_triggered_at: null,
          take_profit_price: null, take_profit_status: "NONE", tp_trigger_observed_price: null, tp_triggered_at: null, realized_quote_pnl: null, buy_fee: 0, sell_fee: 0, status: "PENDING",
          buy_client_order_id: v1ClientOrderId(config.asset, cycle.id, closedSlot.slot_number, "BUY", nextSequence), sell_client_order_id: null, observed_at: now.toISOString(), updated_at: now.toISOString(), idempotency_key: v1IdempotencyKey(cycle.id, closedSlot.slot_number, "BUY", nextSequence)
        }).eq("id", closedSlot.id).eq("status", "CLOSED").eq("operation_sequence", closedSlot.operation_sequence).select("id").maybeSingle();
        if (recycleError) throw recycleError;
        if (!recycled?.id) continue;
        const account = currentAccounts.find((item) => item.slot_number === closedSlot.slot_number)!;
        await audit(supabase, config, "SLOT_RECYCLED", `${cycle.id}:${closedSlot.id}:${nextSequence}`, { cycleId: cycle.id, slotId: closedSlot.id, previous: { operationSequence: closedSlot.operation_sequence, logicalLevel: closedSlot.logical_level, status: "CLOSED", entryPrice: closedSlot.average_fill_price, takeProfitPrice: closedSlot.take_profit_price }, next: { operationSequence: nextSequence, logicalLevel, buyPrice: entry.buyPrice, reason: "LOCAL_REENTRY_SAME_PRICE", balanceUsdc: account.balance_usdc }, observedAt: now.toISOString() });
        await audit(supabase, config, "SLOT_REENTRY_PLANNED", `${cycle.id}:${closedSlot.id}:${nextSequence}`, { cycleId: cycle.id, slotId: closedSlot.id, previous: { previousEntryPrice: closedSlot.average_fill_price, balanceBefore: asSignedNumber(account.balance_usdc, "COINOPS_V1_SLOT_ACCOUNT_INVALID") - asSignedNumber(closedSlot.realized_quote_pnl, "COINOPS_V1_SLOT_INVALID"), gainCountBefore: account.gain_count - 1 }, next: { physicalSlotNumber: closedSlot.slot_number, operationSequence: nextSequence, reentryPrice: entry.buyPrice, balanceAfter: account.balance_usdc, gainCountAfter: account.gain_count, otherOpenPositions: reconciledSlots.filter((item) => item.id !== closedSlot.id && ["TP_ACTIVE", "OPEN", "PARTIALLY_FILLED"].includes(item.status)).length, localRecycleVsGlobalReset: "LOCAL_REENTRY" }, observedAt: now.toISOString() });
        // Keep this tick's in-memory snapshot aligned with the successful CAS so
        // Single Active Entry can replace a lower armed level immediately.
        Object.assign(closedSlot, { operation_sequence: nextSequence, logical_level: logicalLevel, allocation_usdc: account.balance_usdc, buy_price: entry.buyPrice, requested_quantity: entry.quantity, executed_quantity: 0, average_fill_price: null, entry_state: "PLANNED", status: "PENDING", missed_at: null, armed_at: null });
        slotsUpdated += 1;
      }
      await reconcileSingleArmedEntry(supabase, config, cycle, market.price, market.observedAt, !config.kill_switch && !config.pause_new_entries);
    }
    if (restartPlan.shouldRestart) {
      if (restartPlan.pendingSlotNumbers.length) {
        const { error: cancelError } = await supabase.from("robot_v1_slots").update({ status: "CANCELLED", buy_status: "CANCELLED", take_profit_status: "CANCELLED", entry_state: "NONE", armed_at: null, observed_at: now.toISOString() }).eq("cycle_id", cycle.id).eq("status", "PENDING");
        if (cancelError) throw cancelError;
      }
      const nextCapital = config.next_capital_usdc === null ? null : asNumber(config.next_capital_usdc, "COINOPS_V1_CAPITAL_INVALID");
      if (nextCapital !== null && nextCapital !== asNumber(config.capital_usdc, "COINOPS_V1_CAPITAL_INVALID")) throw new Error("COINOPS_V1_CAPITAL_CHANGE_UNSUPPORTED");
      const nextParameters = config.next_gain_rate === null || config.next_entry_spacing === null ? null : assertV1ShadowParameters({ gainRate: asNumber(config.next_gain_rate, "COINOPS_V1_PARAMETERS_INVALID"), entrySpacing: asNumber(config.next_entry_spacing, "COINOPS_V1_PARAMETERS_INVALID") });
      const { data: completed, error: finishError } = await supabase.from("robot_v1_cycles").update({ status: "CYCLE_COMPLETE", completed_at: now.toISOString(), completion_reason: "AUTO_RESET_NO_OPEN_SHADOW_POSITIONS" }).eq("id", cycle.id).in("status", ACTIVE).select("id").maybeSingle();
      if (finishError) throw finishError;
      if (!completed?.id) continue;
      const configUpdate = { last_candle_open_at: null, next_capital_usdc: null, ...(nextParameters ? { gain_rate: nextParameters.gainRate, entry_spacing: nextParameters.entrySpacing, next_gain_rate: null, next_entry_spacing: null } : {}) };
      const { error: capitalError } = await supabase.from("robot_v1_configs").update(configUpdate).eq("id", config.id);
      if (capitalError) throw capitalError;
      await audit(supabase, config, "CYCLE_COMPLETED", cycle.id, { cycleId: cycle.id, previous: { capital: config.capital_usdc }, next: { reason: "AUTO_RESET_NO_OPEN_SHADOW_POSITIONS", invalidatedPendingSlots: restartPlan.pendingSlotNumbers, nextCapitalApplied: nextCapital }, observedAt: now.toISOString() });
      const effectiveConfig: Config = { ...config, capital_usdc: nextCapital ?? config.capital_usdc, gain_rate: nextParameters?.gainRate ?? config.gain_rate, entry_spacing: nextParameters?.entrySpacing ?? config.entry_spacing, next_capital_usdc: null, next_gain_rate: null, next_entry_spacing: null, last_candle_open_at: null };
      if (!effectiveConfig.kill_switch && !effectiveConfig.pause_new_entries) {
        const nextCycle = await startInitialShadowCycle(supabase, adapter, effectiveConfig, now);
        if (nextCycle) {
          cyclesStarted += 1;
          await audit(supabase, effectiveConfig, "CYCLE_RESTARTED", `${cycle.id}:${nextCycle.id}`, { cycleId: nextCycle.id, previous: { cycleId: cycle.id, reason: "AUTO_RESET_NO_OPEN_SHADOW_POSITIONS" }, next: { cycleId: nextCycle.id, anchorFrom: "CURRENT_READ_ONLY_MARKET_PRICE" }, observedAt: now.toISOString() });
        }
      }
    }
    } catch (error) {
      observationStatus = "FAILED";
      observationError = error;
      throw error;
    } finally {
      await recordRuntimeObservation({
        scope: { productId: config.product_id, tenantId: config.tenant_id, userId: config.user_id },
        source: "SHADOW_ENGINE", environment: "SHADOW", asset: config.asset, symbol: config.symbol,
        reference: `${config.id}:${now.toISOString()}`, startedAt: observationStartedAt, finishedAt: new Date().toISOString(),
        status: observationStatus, error: observationError,
        metrics: {
          config_id: config.id, cycle_id: observationCycleId,
          cycles_started: cyclesStarted - countersBefore.cyclesStarted, slots_updated: slotsUpdated - countersBefore.slotsUpdated,
          candles_processed: candlesProcessed - countersBefore.candlesProcessed,
          gain_rate: config.gain_rate, entry_spacing: config.entry_spacing, capital_usdc: config.capital_usdc,
          kill_switch: config.kill_switch, pause_new_entries: config.pause_new_entries,
        },
      });
    }
  }
  return { status: "COMPLETED" as const, cyclesStarted, slotsUpdated, candlesProcessed };
}
