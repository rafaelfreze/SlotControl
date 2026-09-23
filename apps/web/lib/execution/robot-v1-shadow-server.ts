import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { getCoinOpsServiceTenantId } from "@/lib/supabase/env";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { recordRuntimeObservation } from "@/lib/coinops-reports/runtime-observation-server";

import { BinanceSpotAdapter } from "./binance-spot-adapter";
import { planAthLadder, validateAthTransitionedGrid } from "./ath-ladder";
import { buildPostAthQueue, orderedPostAthSlots } from "./ath-regime";
import { loadAthProfile, refreshAthProfile, type AthProfileRow } from "./ath-profile-server";
import { sumV1DecimalAmounts } from "./robot-v1-audit";
import { V1_RULES, V1_SLOT_COUNT, assertV1ShadowParameters, buildV1Grid, buildV1LocalReentry, evaluateV1Candle, findV1LogicalLevel, quantityForV1SlotBalance, selectV1CandleResidentSlots, validateActiveGrid, v1ClientOrderId, v1IdempotencyKey, type V1Asset, type V1ShadowParameters } from "./robot-v1";
import { STRATEGY_VERSION, calculateStrategyTakeProfit, isStrategyDecisionProven, planStrategyClosedSlot, planStrategyInitialEntry, planStrategyNextEntry, planStrategyPostAthNextEntry, planStrategyTakeProfit, wasStrategyOrderResidentAt, type StrategyCandidate, type StrategyDecision } from "./strategy-engine";
import { persistStrategyDecision, dispatchStrategyDecision, completeStrategyDecision, failStrategyDecision } from "./strategy-decision-server";
import { loadMonthlySlotStatuses } from "./monthly-slot-server";
import { monthlyPeriodKey, type MonthlySlotStatus } from "./monthly-slot-policy";
import type { ExchangeSymbolInfo } from "./types";

type Config = { strategy_version: string | null; strategy_lease_owner: string | null; strategy_lease_until: string | null; id: string; product_id: string; tenant_id: string; user_id: string; asset: V1Asset; symbol: string; capital_usdc: number | string; next_capital_usdc: number | string | null; gain_rate: number | string; entry_spacing: number | string; next_gain_rate: number | string | null; next_entry_spacing: number | string | null; kill_switch: boolean; pause_new_entries: boolean; last_candle_open_at: string | null; last_market_price: number | string | null; last_market_observed_at: string | null; last_engine_at: string | null; last_engine_error: string | null; grid_status: string | null; grid_error: string | null };
type Cycle = { strategy_version: string | null; id: string; status: string; asset: V1Asset; symbol: string; anchor_price: number | string; started_at: string; gain_rate: number | string; entry_spacing: number | string; entry_regime: "NORMAL" | "POST_ATH" | null; ath_transition_key: string | null; ath_period_key: string | null; config_version: number | null; config_snapshot: Record<string, unknown> | null };
type Slot = { id: string; slot_number: number; logical_level: number; operation_sequence: number; entry_state: "NONE" | "ARMED" | "PLANNED"; armed_at: string | null; missed_at: string | null; allocation_usdc: number | string; buy_price: number | string; requested_quantity: number | string; executed_quantity: number | string; average_fill_price: number | string | null; take_profit_price: number | string | null; realized_quote_pnl: number | string | null; sell_fee: number | string; buy_client_order_id: string; sell_client_order_id: string | null; buy_triggered_at: string | null; tp_triggered_at: string | null; status: "PENDING" | "PARTIALLY_FILLED" | "OPEN" | "TP_ACTIVE" | "CLOSED" | "CANCELLED"; operational_rank: number | null; post_ath_group: "PRIMARY" | "RESERVE" | null; post_ath_group_rank: number | null; entry_origin: "GRID" | "REENTRY"; config_version: number | null; config_snapshot: Record<string, unknown> | null };
type SlotAccount = { slot_number: number; initial_balance_usdc: number | string; balance_usdc: number | string; gain_count: number; net_profit_usdc: number | string };
const SLOT_COLUMNS = "id,slot_number,logical_level,operation_sequence,entry_state,armed_at,missed_at,allocation_usdc,buy_price,requested_quantity,executed_quantity,average_fill_price,take_profit_price,realized_quote_pnl,sell_fee,buy_client_order_id,sell_client_order_id,buy_triggered_at,tp_triggered_at,status,operational_rank,post_ath_group,post_ath_group_rank,entry_origin,config_version,config_snapshot";
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
    gross_quote_pnl: values.grossProfit, estimated_quote_fees: values.estimatedFees, net_quote_pnl: values.grossProfit - values.estimatedFees,
    config_version: slot.config_version, config_snapshot: slot.config_snapshot
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


const CYCLE_COLUMNS = "id,status,asset,symbol,anchor_price,started_at,gain_rate,entry_spacing,strategy_version,entry_regime,ath_transition_key,ath_period_key,config_version,config_snapshot";
type Service = ReturnType<typeof createServiceRoleClient>;

function strategyContext(config: Config, cycle: Cycle, observedAt: string) {
  return { asset: config.asset, cycleId: cycle.id, observedAt };
}

function strategyCandidate(slot: Slot, monthly?: MonthlySlotStatus, regime: "NORMAL" | "POST_ATH" = "NORMAL"): StrategyCandidate {
  return {
    id: slot.id, slotNumber: slot.slot_number, operationSequence: slot.operation_sequence,
    buyPrice: asNumber(slot.buy_price, "COINOPS_V1_SLOT_INVALID"), balanceUsdc: asNumber(slot.allocation_usdc, "COINOPS_V1_SLOT_INVALID"),
    operationalRank: regime === "POST_ATH" ? slot.operational_rank ?? monthly?.operationalRank : monthly?.operationalRank,
    monthlyTargetReached: monthly?.monthlyTargetReached,
    postAthGroup: slot.post_ath_group, entryOrigin: slot.entry_origin,
    state: slot.status === "PARTIALLY_FILLED" ? "PARTIALLY_FILLED"
      : slot.status === "OPEN" || slot.status === "TP_ACTIVE" ? "OPEN"
      : slot.status === "CLOSED" || slot.status === "CANCELLED" ? "CLOSED"
      : slot.missed_at ? "MISSED" : slot.entry_state === "ARMED" ? "ARMED" : "PLANNED"
  };
}

async function readSlots(supabase: Service, cycle: Cycle) {
  const { data, error } = await supabase.from("robot_v1_slots").select(SLOT_COLUMNS).eq("cycle_id", cycle.id).order("slot_number");
  if (error) throw error;
  return (data || []) as Slot[];
}

async function applyShadowAthTransition(supabase: Service, config: Config, cycle: Cycle,
  profile: AthProfileRow, filters: ExchangeSymbolInfo, marketPrice: number) {
  const periodKey = monthlyPeriodKey(new Date());
  if (!profile.transition_key || cycle.ath_transition_key === profile.transition_key
    && cycle.entry_regime === profile.regime && cycle.ath_period_key === periodKey) return false;
  const slots = await readSlots(supabase, cycle);
  const accounts = await loadSlotAccounts(supabase, config);
  const monthly = await monthlyStatuses(supabase, config, accounts);
  const regimeChanged = cycle.ath_transition_key !== profile.transition_key;
  const target = planAthLadder(config.asset, profile.regime,
    profile.regime === "POST_ATH" && regimeChanged ? Math.max(Number(profile.ath_price), marketPrice) : marketPrice,
    { gainRate: Number(cycle.gain_rate), normalSpacing: Number(profile.normal_spacing_rate),
      postAthSpacing: Number(profile.post_ath_spacing_rate) }, filters.priceTick,
    slots.map((slot) => {
      const evidence = monthly.find((item) => item.physicalSlotNumber === slot.slot_number);
      if (!evidence) throw new Error("COINOPS_ATH_MONTHLY_EVIDENCE_MISSING");
      return { physicalSlotId: evidence.physicalSlotId, physicalSlotNumber: slot.slot_number,
        lifetimeGainCount: evidence.lifetimeGainCount, monthlyGainCount: evidence.monthlyGainCount,
        entryState: slot.status === "PENDING" ? slot.missed_at ? "MISSED" : slot.entry_state : slot.status,
        status: slot.status, buyPrice: Number(slot.buy_price), entryOrigin: slot.entry_origin,
        operationSequence: slot.operation_sequence };
    }));
  const updates = target.map((decision) => {
    const slot = slots.find((item) => item.slot_number === decision.physicalSlotNumber)!;
    const account = accounts[slot.slot_number - 1]!;
    const reprice = slot.status === "PENDING" && !decision.frozenReason;
    const quantity = reprice ? quantityForV1SlotBalance(Number(account.balance_usdc), decision.nextBuyPrice, filters).quantity : null;
    return { slot, decision, reprice, quantity, account };
  });
  for (const { slot, decision, reprice, quantity, account } of updates) {
    const values = { operational_rank: decision.operationalRank,
      post_ath_group: decision.postAthGroup, post_ath_group_rank: decision.postAthGroupRank,
      ...(reprice ? { buy_price: decision.nextBuyPrice, requested_quantity: quantity,
        allocation_usdc: account.balance_usdc, entry_state: "PLANNED", armed_at: null,
        config_version: cycle.config_version,
        config_snapshot: { ...(cycle.config_snapshot ?? {}), regime: profile.regime,
          entry_spacing: profile.regime === "POST_ATH" ? Number(profile.post_ath_spacing_rate) : Number(profile.normal_spacing_rate),
          ath_transition_key: profile.transition_key } } : {}) };
    const { data, error } = await supabase.from("robot_v1_slots").update(values)
      .eq("id", slot.id).eq("cycle_id", cycle.id).eq("operation_sequence", slot.operation_sequence)
      .eq("status", slot.status).select("id").maybeSingle();
    if (error || !data) throw new Error("COINOPS_ATH_SHADOW_SLOT_TRANSITION_FAILED");
  }
  const key = `${profile.transition_key}:${periodKey}`;
  if (profile.regime === "POST_ATH") {
    await audit(supabase, config, "POST_ATH_PRIMARY_GROUP_BUILT", `${cycle.id}:${key}`,
      { cycleId: cycle.id, next: { count: target.filter((item) => item.postAthGroup === "PRIMARY").length,
        regime: profile.regime, configVersion: profile.config_version } });
    await audit(supabase, config, "POST_ATH_RESERVE_GROUP_BUILT", `${cycle.id}:${key}`,
      { cycleId: cycle.id, next: { count: target.filter((item) => item.postAthGroup === "RESERVE").length,
        regime: profile.regime, configVersion: profile.config_version } });
  }
  const { data, error } = await supabase.from("robot_v1_cycles").update({
    entry_regime: profile.regime, ath_transition_key: profile.transition_key, ath_period_key: periodKey,
    entry_spacing: profile.regime === "POST_ATH" ? profile.post_ath_spacing_rate : profile.normal_spacing_rate,
  }).eq("id", cycle.id).in("status", ACTIVE).select("id").maybeSingle();
  if (error || !data) throw new Error("COINOPS_ATH_SHADOW_CYCLE_TRANSITION_FAILED");
  cycle.entry_regime = profile.regime; cycle.ath_transition_key = profile.transition_key; cycle.ath_period_key = periodKey;
  cycle.entry_spacing = profile.regime === "POST_ATH" ? profile.post_ath_spacing_rate : profile.normal_spacing_rate;
  return true;
}

/** Repair only the proven one-tick floor drift of an unfilled, unarmed virtual
 * reentry. No open position, resident BUY or historical operation is changed. */
async function repairShadowReentryTickDrift(supabase: Service, config: Config, cycle: Cycle,
  slots: Slot[], filters: ExchangeSymbolInfo, parameters: V1ShadowParameters) {
  let repaired = 0;
  for (const slot of slots.filter((row) => row.status === "PENDING" && row.entry_state === "PLANNED"
    && row.operation_sequence > 1 && Number(row.executed_quantity) === 0)) {
    const { data: previous, error } = await supabase.from("robot_v1_slot_operations")
      .select("entry_price,closed_at").eq("cycle_id", cycle.id).eq("slot_id", slot.id)
      .eq("operation_sequence", slot.operation_sequence - 1).maybeSingle();
    if (error) throw error;
    const previousPrice = Number(previous?.entry_price), drift = previousPrice - Number(slot.buy_price);
    if (!previous?.closed_at || !Number.isFinite(drift)
      || Math.abs(drift - filters.priceTick) > filters.priceTick * 1e-5
      || findV1LogicalLevel(Number(cycle.anchor_price), previousPrice, filters, parameters) !== slot.logical_level) continue;
    const account = (await loadSlotAccounts(supabase, config))[slot.slot_number - 1]!;
    const entry = buildV1LocalReentry(slot.slot_number, previousPrice, Number(account.balance_usdc), filters);
    if (entry.buyPrice !== previousPrice) continue;
    const { data: changed, error: updateError } = await supabase.from("robot_v1_slots").update({
      buy_price: entry.buyPrice, requested_quantity: entry.quantity, allocation_usdc: account.balance_usdc,
      observed_at: new Date().toISOString()
    }).eq("id", slot.id).eq("cycle_id", cycle.id).eq("operation_sequence", slot.operation_sequence)
      .eq("status", "PENDING").eq("entry_state", "PLANNED").eq("executed_quantity", 0)
      .eq("buy_price", slot.buy_price).select("id").maybeSingle();
    if (updateError) throw updateError;
    if (!changed?.id) continue;
    repaired += 1;
    await audit(supabase, config, "SHADOW_TICK_DRIFT_REPAIRED", `${cycle.id}:${slot.id}:${slot.operation_sequence}`,
      { cycleId: cycle.id, slotId: slot.id, previous: { buyPrice: slot.buy_price },
        next: { buyPrice: entry.buyPrice, reason: "PREVIOUS_CONFIRMED_ENTRY_TICK_RESTORED", operationSequence: slot.operation_sequence } });
  }
  return repaired;
}

async function monthlyStatuses(supabase: Service, config: Config, accounts: SlotAccount[]) {
  return loadMonthlySlotStatuses(supabase, "SHADOW", { product_id: config.product_id, tenant_id: config.tenant_id,
    user_id: config.user_id, config_id: config.id, asset: config.asset }, accounts.map((account) => ({
    slot_number: account.slot_number, balance_usdc: account.balance_usdc, gain_count: account.gain_count, entry_state: "PLANNED"
  })));
}

async function recoverShadowDecisions(supabase: Service, config: Config) {
  const recoveryDeadline = Date.now() + 5_000;
  const scope = { product_id: config.product_id, tenant_id: config.tenant_id, user_id: config.user_id };
  const { data, error } = await supabase.from("robot_v1_strategy_decisions")
    .select("decision_id,cycle_id,slot_id,operation_sequence,action_type,target_price")
    .eq("product_id", config.product_id).eq("tenant_id", config.tenant_id).eq("user_id", config.user_id)
    .eq("environment", "SHADOW").eq("asset", config.asset).in("result", ["PENDING", "DISPATCHED", "FAILED"])
    .neq("action_type", "WAIT")
    .order("created_at").limit(25);
  if (error) throw error;
  for (const intent of data || []) {
    if (Date.now() >= recoveryDeadline) break;
    const { data: cycle, error: cycleError } = await supabase.from("robot_v1_cycles")
      .select("id,status,completed_at").eq("id", intent.cycle_id).eq("config_id", config.id).maybeSingle();
    if (cycleError) throw cycleError;
    if (!cycle) continue;
    const { data: slot, error: slotError } = intent.slot_id
      ? await supabase.from("robot_v1_slots").select(SLOT_COLUMNS).eq("id", intent.slot_id).eq("cycle_id", cycle.id).maybeSingle()
      : { data: null, error: null };
    if (slotError) throw slotError;
    const { data: archived, error: operationError } = intent.slot_id && intent.operation_sequence != null
      ? await supabase.from("robot_v1_slot_operations").select("operation_sequence,entry_price,take_profit_price,executed_quantity")
        .eq("cycle_id", cycle.id).eq("slot_id", intent.slot_id).eq("operation_sequence", intent.operation_sequence).maybeSingle()
      : { data: null, error: null };
    if (operationError) throw operationError;
    let successorId: string | null = null;
    let successorInitialFilled = false;
    if (intent.action_type === "REANCHOR" && cycle.status === "CYCLE_COMPLETE" && cycle.completed_at) {
      const { data: successor, error: successorError } = await supabase.from("robot_v1_cycles").select("id")
        .eq("config_id", config.id).gte("started_at", cycle.completed_at).neq("id", cycle.id).order("started_at").limit(1).maybeSingle();
      if (successorError) throw successorError;
      if (successor) {
        successorId = successor.id;
        const { data: initial, error: initialError } = await supabase.from("robot_v1_slots").select("executed_quantity,buy_triggered_at,operation_sequence")
          .eq("cycle_id", successor.id).eq("slot_number", 1).maybeSingle();
        if (initialError) throw initialError;
        successorInitialFilled = Boolean(initial && initial.operation_sequence === 1 && Number(initial.executed_quantity) > 0 && initial.buy_triggered_at);
        if (!successorInitialFilled) {
          const { data: completedInitial, error: historyError } = await supabase.from("robot_v1_slot_operations").select("id")
            .eq("cycle_id", successor.id).eq("physical_slot_number", 1).eq("operation_sequence", 1).gt("executed_quantity", 0).maybeSingle();
          if (historyError) throw historyError;
          successorInitialFilled = Boolean(completedInitial);
        }
      }
    }
    if (isStrategyDecisionProven(intent.action_type, intent.target_price === null ? null : Number(intent.target_price), intent.operation_sequence, {
      slot: slot ? { operationSequence: slot.operation_sequence, state: slot.status, entryState: slot.entry_state, buyPrice: Number(slot.buy_price),
        executedQuantity: Number(slot.executed_quantity), buyFilledAt: slot.buy_triggered_at,
        takeProfitPrice: slot.take_profit_price === null ? null : Number(slot.take_profit_price), sellOrderId: slot.sell_client_order_id } : undefined,
      archivedOperation: archived ? { operationSequence: archived.operation_sequence, entryPrice: Number(archived.entry_price),
        takeProfitPrice: Number(archived.take_profit_price), executedQuantity: Number(archived.executed_quantity) } : undefined,
      cycleCompleted: cycle.status === "CYCLE_COMPLETE", successorInitialFilled
    })) await completeStrategyDecision(supabase, scope, "SHADOW", intent.decision_id, {
      recovered_from_ledger: true, recovery_evidence: "EXACT_CYCLE_SLOT_OPERATION_POSTCONDITION",
      slot_id: intent.slot_id, operation_sequence: intent.operation_sequence, current_state: slot?.status ?? cycle.status,
      resident_slot_id: slot?.entry_state === "ARMED" ? slot.id : null,
      resident_target_price: slot?.entry_state === "ARMED" ? Number(slot.buy_price) : null,
      successor_cycle_id: successorId, virtual: true
    });
  }
}

async function applyDecision(supabase: Service, config: Config, strategyDecision: StrategyDecision, sequence: number | undefined,
  apply: () => Promise<Record<string, unknown>>) {
  const scope = { product_id: config.product_id, tenant_id: config.tenant_id, user_id: config.user_id };
  const saved = await persistStrategyDecision(supabase, scope, "SHADOW", strategyDecision, sequence);
  await dispatchStrategyDecision(supabase, scope, "SHADOW", saved.decision_id);
  try {
    const observed = await apply();
    await completeStrategyDecision(supabase, scope, "SHADOW", saved.decision_id, observed);
    return observed;
  } catch (error) {
    await failStrategyDecision(supabase, scope, "SHADOW", saved.decision_id, error instanceof Error ? error.message : "SHADOW_TRANSITION_FAILED");
    throw error;
  }
}

async function ensureTakeProfit(supabase: Service, config: Config, cycle: Cycle, slot: Slot, filters: ExchangeSymbolInfo, observedAt: string) {
  if (slot.status !== "OPEN") return;
  const plan = planStrategyTakeProfit(strategyContext(config, cycle, observedAt), strategyCandidate(slot),
    asNumber(slot.average_fill_price, "COINOPS_V1_SLOT_INVALID"), filters,
    { gainRate: Number(cycle.gain_rate), entrySpacing: Number(cycle.entry_spacing) });
  if (plan.action_type !== "CREATE_TP") return;
  await applyDecision(supabase, config, plan, slot.operation_sequence, async () => {
    const { error } = await supabase.from("robot_v1_slots").update({
      take_profit_price: plan.target_price, take_profit_status: "PENDING", status: "TP_ACTIVE",
      sell_client_order_id: v1ClientOrderId(config.asset, cycle.id, slot.slot_number, "SELL", slot.operation_sequence), observed_at: observedAt
    }).eq("id", slot.id).eq("status", "OPEN").eq("operation_sequence", slot.operation_sequence);
    if (error) throw error;
    return { status: "TP_ACTIVE", target_price: plan.target_price, slot_id: slot.id, virtual: true };
  });
}

async function reconcileSingleArmedEntry(supabase: Service, config: Config, cycle: Cycle, observedFloor: number, observedAt: string, canArm: boolean) {
  const slots = await readSlots(supabase, cycle);
  const monthly = await monthlyStatuses(supabase, config, await loadSlotAccounts(supabase, config));
  const statusFor = (slot: Slot) => monthly.find((status) => status.physicalSlotNumber === slot.slot_number);
  const armed = slots.filter((slot) => slot.status === "PENDING" && slot.entry_state === "ARMED");
  if (armed.length > 1) throw new Error("COINOPS_V1_MULTIPLE_ARMED_BUYS");
  for (const slot of armed.filter((item) => !statusFor(item)?.eligibleForNewEntry)) {
    if (Number(slot.executed_quantity) > 0) continue;
    const { error } = await supabase.from("robot_v1_slots").update({ entry_state: "PLANNED", armed_at: null })
      .eq("id", slot.id).eq("status", "PENDING").eq("entry_state", "ARMED").eq("executed_quantity", 0);
    if (error) throw error;
    slot.entry_state = "PLANNED";
    await audit(supabase, config, "MONTHLY_TARGET_HOLD", `${cycle.id}:${slot.id}:${monthly[0]?.periodKey}`,
      { cycleId: cycle.id, slotId: slot.id, next: { reason: statusFor(slot)?.blockedReason, periodKey: monthly[0]?.periodKey }, observedAt });
  }
  const resident = armed.find((slot) => slot.entry_state === "ARMED");
  if (!canArm) {
    for (const slot of resident ? [resident] : []) {
      const { error } = await supabase.from("robot_v1_slots").update({ entry_state: "PLANNED", armed_at: null })
        .eq("id", slot.id).eq("status", "PENDING").eq("entry_state", "ARMED");
      if (error) throw error;
      await audit(supabase, config, "NEXT_BUY_DISARMED", `${cycle.id}:${slot.id}:${slot.operation_sequence}:${observedAt}`,
        { cycleId: cycle.id, slotId: slot.id, next: { reason: "ENTRIES_PAUSED_OR_GRID_INVALID" }, observedAt });
    }
    return;
  }
  const strategyContextWithKey = { ...strategyContext(config, cycle, observedAt),
    transitionKey: resident ? `${resident.id}:${resident.operation_sequence}:${resident.armed_at}` : "NO_RESIDENT_BUY" };
  const candidates = slots.map((slot) => strategyCandidate(slot, statusFor(slot), cycle.entry_regime ?? "NORMAL"));
  const residentBuy = resident ? { candidateId: resident.id, executedQuantity: Number(resident.executed_quantity) } : null;
  const plan = cycle.entry_regime === "POST_ATH"
    ? planStrategyPostAthNextEntry(strategyContextWithKey, candidates, observedFloor, residentBuy)
    : planStrategyNextEntry(strategyContextWithKey, candidates, observedFloor, residentBuy);
  if (cycle.entry_regime === "POST_ATH" && !candidates.some((item) => item.postAthGroup === "PRIMARY"
    && !item.monthlyTargetReached && ["PLANNED", "ARMED", "PARTIALLY_FILLED"].includes(item.state))) {
    await audit(supabase, config, "POST_ATH_PRIMARY_EXHAUSTED",
      `${cycle.id}:${cycle.ath_transition_key}:${cycle.ath_period_key}`,
      { cycleId: cycle.id, next: { regime: "POST_ATH", periodKey: cycle.ath_period_key }, observedAt });
    if (candidates.find((item) => item.id === plan.nextCandidateId)?.postAthGroup === "RESERVE")
      await audit(supabase, config, "POST_ATH_RESERVE_ACTIVATED",
        `${cycle.id}:${cycle.ath_transition_key}:${cycle.ath_period_key}`,
        { cycleId: cycle.id, next: { slotId: plan.nextCandidateId, periodKey: cycle.ath_period_key }, observedAt });
  }
  await applyDecision(supabase, config, plan.decision, slots.find((slot) => slot.id === plan.nextCandidateId)?.operation_sequence, async () => {
    for (const missedId of plan.missedCandidateIds) {
      const slot = slots.find((item) => item.id === missedId)!;
      const { data: missed, error } = await supabase.from("robot_v1_slots").update({ entry_state: "PLANNED", missed_at: observedAt })
        .eq("id", slot.id).eq("status", "PENDING").is("missed_at", null).neq("entry_state", "ARMED").select("id").maybeSingle();
      if (error) throw error;
      if (missed?.id) await audit(supabase, config, "MISSED_LEVEL_DURING_REARM", `${cycle.id}:${slot.id}:${slot.operation_sequence}`,
        { cycleId: cycle.id, slotId: slot.id, next: { slotNumber: slot.slot_number, buyPrice: slot.buy_price, observedFloor, reason: "NO_RESIDENT_BUY_AT_CROSSING" }, observedAt });
    }
    if (plan.decision.action_type === "WAIT") return {
      status: plan.decision.expected_next_state, reason: plan.decision.reason, missed: plan.missedCandidateIds,
      market_price: observedFloor, resident_slot_id: resident?.id ?? null, resident_target_price: resident ? Number(resident.buy_price) : null,
      priority_validated: plan.decision.reason === "HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT"
    };
    const next = slots.find((slot) => slot.id === plan.nextCandidateId);
    if (!next) throw new Error("COINOPS_STRATEGY_NEXT_ENTRY_MISSING");
    if (plan.decision.action_type === "CANCEL_REPLACE_NEXT_BUY" && resident) {
      const current = resident;
      const { error } = await supabase.from("robot_v1_slots").update({ entry_state: "PLANNED", armed_at: null })
        .eq("id", current.id).eq("status", "PENDING").eq("entry_state", "ARMED").eq("executed_quantity", 0);
      if (error) throw error;
      await audit(supabase, config, "NEXT_BUY_DISARMED", `${cycle.id}:${current.id}:${current.operation_sequence}:higher-reentry`,
        { cycleId: cycle.id, slotId: current.id, next: { reason: "HIGHER_LOCAL_REENTRY_PRIORITY", replacementSlotNumber: next.slot_number }, observedAt });
    }
    const { data: armedRow, error } = await supabase.from("robot_v1_slots").update({ entry_state: "ARMED", armed_at: observedAt })
      .eq("id", next.id).eq("status", "PENDING").is("missed_at", null).in("entry_state", ["NONE", "PLANNED"]).select("id").maybeSingle();
    if (error) throw error;
    if (armedRow?.id) {
      await audit(supabase, config, "NEXT_BUY_ARMED", `${cycle.id}:${next.id}:${next.operation_sequence}`,
        { cycleId: cycle.id, slotId: next.id, next: { slotNumber: next.slot_number, logicalLevel: next.logical_level, buyPrice: next.buy_price, observedFloor }, observedAt });
      if (next.operation_sequence > 1) await audit(supabase, config, "SLOT_REENTRY_ARMED", `${cycle.id}:${next.id}:${next.operation_sequence}`,
        { cycleId: cycle.id, slotId: next.id, next: { physicalSlotNumber: next.slot_number, operationSequence: next.operation_sequence, reentryPrice: next.buy_price, localRecycleVsGlobalReset: "LOCAL_REENTRY" }, observedAt });
    }
    return { status: "ARMED", slot_id: next.id, target_price: Number(next.buy_price), observed_floor: observedFloor, missed: plan.missedCandidateIds,
      market_price: observedFloor, resident_slot_id: next.id, resident_target_price: Number(next.buy_price), priority_validated: true };
  });
}

async function initializeShadowCycle(supabase: Service, adapter: BinanceSpotAdapter, config: Config, cycle: Cycle) {
  const [filters, market] = await Promise.all([adapter.getSymbolInfo(cycle.symbol), adapter.getMarketPrice(cycle.symbol)]);
  let slots = await readSlots(supabase, cycle);
  const parameters = { gainRate: Number(cycle.gain_rate), entrySpacing: Number(cycle.entry_spacing) };
  if (!slots.length) {
    const accounts = await loadSlotAccounts(supabase, config);
    const monthly = await monthlyStatuses(supabase, config, accounts);
    const postQueue = cycle.entry_regime === "POST_ATH" ? buildPostAthQueue(config.asset,
      monthly.map((status) => ({ physicalSlotId: status.physicalSlotId,
        physicalSlotNumber: status.physicalSlotNumber, lifetimeGainCount: status.lifetimeGainCount,
        monthlyGainCount: status.monthlyGainCount, entryState: "PLANNED" }))) : null;
    const groupByNumber = new Map(postQueue?.map((item) => [item.physicalSlotNumber, item]) ?? []);
    const physicalOrder = [...monthly].sort((left, right) => cycle.entry_regime === "POST_ATH"
      ? (groupByNumber.get(left.physicalSlotNumber)?.operationalRank ?? 26 + left.physicalSlotNumber)
        - (groupByNumber.get(right.physicalSlotNumber)?.operationalRank ?? 26 + right.physicalSlotNumber)
      : (left.operationalRank ?? 26 + left.physicalSlotNumber)
        - (right.operationalRank ?? 26 + right.physicalSlotNumber));
    const balances = physicalOrder.map((status) => Number(accounts[status.physicalSlotNumber - 1]!.balance_usdc));
    const capital = Number(sumV1DecimalAmounts(accounts.map((account) => account.balance_usdc)));
    const grid = buildV1Grid(config.asset, capital, Number(cycle.anchor_price), filters, parameters, balances);
    const { error } = await supabase.from("robot_v1_slots").insert(grid.map((slot) => ({
      product_id: config.product_id, tenant_id: config.tenant_id, user_id: config.user_id, cycle_id: cycle.id,
      slot_number: physicalOrder[slot.logicalLevel - 1]!.physicalSlotNumber, logical_level: slot.logicalLevel, symbol: cycle.symbol, allocation_usdc: balances[slot.logicalLevel - 1],
      entry_state: "PLANNED", entry_origin: "GRID", armed_at: null,
      config_version: cycle.config_version, config_snapshot: cycle.config_snapshot,
      operational_rank: cycle.entry_regime === "POST_ATH"
        ? groupByNumber.get(physicalOrder[slot.logicalLevel - 1]!.physicalSlotNumber)?.operationalRank ?? null
        : physicalOrder[slot.logicalLevel - 1]!.operationalRank,
      post_ath_group: groupByNumber.get(physicalOrder[slot.logicalLevel - 1]!.physicalSlotNumber)?.postAthGroup ?? null,
      post_ath_group_rank: groupByNumber.get(physicalOrder[slot.logicalLevel - 1]!.physicalSlotNumber)?.postAthGroupRank ?? null,
      buy_price: slot.buyPrice, requested_quantity: slot.quantity, executed_quantity: 0,
      average_fill_price: null, buy_status: "PENDING", take_profit_price: null, take_profit_status: "NONE", status: "PENDING",
      buy_client_order_id: v1ClientOrderId(config.asset, cycle.id, physicalOrder[slot.logicalLevel - 1]!.physicalSlotNumber, "BUY"),
      idempotency_key: v1IdempotencyKey(cycle.id, physicalOrder[slot.logicalLevel - 1]!.physicalSlotNumber, "BUY"), observed_at: market.observedAt
    })));
    if (error) throw error;
    slots = await readSlots(supabase, cycle);
  }
  if (slots.length !== V1_SLOT_COUNT) throw new Error("COINOPS_STRATEGY_SLOT_COUNT_INVALID");
  const monthly = await monthlyStatuses(supabase, config, await loadSlotAccounts(supabase, config));
  let initial = slots.find((slot) => slot.logical_level === 1)!;
  const initialStatus = monthly.find((status) => status.physicalSlotNumber === initial.slot_number)!;
  if (initialStatus.eligibleForNewEntry && initial.status === "PENDING" && initial.operation_sequence === 1 && !initial.buy_triggered_at) {
    const plan = planStrategyInitialEntry(strategyContext(config, cycle, market.observedAt),
      strategyCandidate(initial, initialStatus, cycle.entry_regime ?? "NORMAL"));
    if (plan.action_type !== "OPEN_INITIAL_MARKET") throw new Error("COINOPS_STRATEGY_INITIAL_STATE_INVALID");
    const { quantity } = quantityForV1SlotBalance(Number(initial.allocation_usdc), market.price, filters);
    await applyDecision(supabase, config, plan, 1, async () => {
      const { error } = await supabase.from("robot_v1_slots").update({
        requested_quantity: quantity, executed_quantity: quantity, average_fill_price: market.price, buy_status: "FILLED",
        buy_trigger_price: Number(initial.buy_price), buy_trigger_observed_price: market.price, buy_triggered_at: market.observedAt,
        status: "OPEN", entry_state: "NONE", armed_at: null, observed_at: market.observedAt
      }).eq("id", initial.id).eq("status", "PENDING").eq("operation_sequence", 1).is("buy_triggered_at", null);
      if (error) throw error;
      return { status: "OPEN", fill_price: market.price, quantity, slot_id: initial.id, virtual: true };
    });
    await audit(supabase, config, "INITIAL_POSITION_OPENED", `${cycle.id}:${initial.slot_number}`,
      { cycleId: cycle.id, slotId: initial.id, next: { slotNumber: initial.slot_number, operationalRank: initialStatus.operationalRank, fillPrice: market.price, observedPrice: market.price }, observedAt: market.observedAt });
    initial = (await readSlots(supabase, cycle)).find((slot) => slot.id === initial.id)!;
  }
  await ensureTakeProfit(supabase, config, cycle, initial, filters, market.observedAt);
  await reconcileSingleArmedEntry(supabase, config, cycle, market.price, market.observedAt, !config.kill_switch && !config.pause_new_entries);
  const { error } = await supabase.from("robot_v1_cycles").update({ status: "GRID_ACTIVE" }).eq("id", cycle.id).eq("status", "STARTING");
  if (error) throw error;
  cycle.status = "GRID_ACTIVE";
}

async function startInitialShadowCycle(supabase: Service, adapter: BinanceSpotAdapter, config: Config, now: Date) {
  const parameters = assertV1ShadowParameters({ gainRate: Number(config.gain_rate), entrySpacing: Number(config.entry_spacing) });
  const profile = await loadAthProfile(supabase, { productId: config.product_id,
    tenantId: config.tenant_id, userId: config.user_id }, "SHADOW", config.asset);
  const activeSpacing = Number(profile.regime === "POST_ATH" ? profile.post_ath_spacing_rate : profile.normal_spacing_rate);
  if (parameters.gainRate !== Number(profile.gain_rate) || parameters.entrySpacing !== activeSpacing)
    throw new Error("COINOPS_ATH_SHADOW_CONFIG_SNAPSHOT_MISMATCH");
  const [filters, market, accounts] = await Promise.all([adapter.getSymbolInfo(config.symbol), adapter.getMarketPrice(config.symbol), loadSlotAccounts(supabase, config)]);
  if (!(await monthlyStatuses(supabase, config, accounts)).some((status) => status.eligibleForNewEntry)) return null;
  const capital = Number(sumV1DecimalAmounts(accounts.map((account) => account.balance_usdc)));
  buildV1Grid(config.asset, capital, market.price, filters, parameters, accounts.map((account) => Number(account.balance_usdc)));
  const { data, error } = await supabase.from("robot_v1_cycles").insert({
    product_id: config.product_id, tenant_id: config.tenant_id, user_id: config.user_id, config_id: config.id, asset: config.asset, symbol: config.symbol,
    execution_mode: "SHADOW", strategy_version: STRATEGY_VERSION, status: "STARTING", anchor_price: market.price,
    slot_notional_usdc: capital / V1_SLOT_COUNT, capital_usdc: capital, gain_rate: parameters.gainRate,
    entry_spacing: parameters.entrySpacing, entry_regime: profile.regime,
    ath_transition_key: profile.transition_key, ath_period_key: monthlyPeriodKey(now),
    config_version: profile.config_version,
    config_snapshot: { gain_rate: parameters.gainRate, normal_spacing_rate: Number(profile.normal_spacing_rate),
      post_ath_spacing_rate: Number(profile.post_ath_spacing_rate), regime: profile.regime,
      ath_price: profile.ath_price, ath_source: profile.ath_source }, started_at: now.toISOString()
  }).select(CYCLE_COLUMNS).single();
  if (error?.code === "23505") return null;
  if (error) throw error;
  const cycle = data as Cycle;
  await audit(supabase, config, "CYCLE_STARTED", cycle.id, { cycleId: cycle.id,
    next: { asset: config.asset, symbol: config.symbol, capital, slots: V1_SLOT_COUNT, anchorPrice: market.price, gainRate: parameters.gainRate, entrySpacing: parameters.entrySpacing, strategyVersion: STRATEGY_VERSION } });
  await initializeShadowCycle(supabase, adapter, config, cycle);
  return cycle;
}

/** Archive/credit first, then decide LOCAL versus GLOBAL from the same physical
 * state. Called after each candle, so a valid higher reentry is never delayed
 * until the end of a historical candle batch. */
async function settleClosedSlots(supabase: Service, config: Config, cycle: Cycle, filters: ExchangeSymbolInfo, observedAt: string) {
  const slots = await readSlots(supabase, cycle);
  const closed = slots.filter((slot) => slot.status === "CLOSED");
  if (!closed.length) return { terminal: false, updated: 0, decisions: [] as StrategyDecision[] };
  for (const slot of closed) await archiveClosedShadowOperation(supabase, config, cycle, slot, {
    closedAt: slot.tp_triggered_at || observedAt,
    grossProfit: Number((asSignedNumber(slot.realized_quote_pnl, "COINOPS_V1_SLOT_INVALID") + Number(slot.sell_fee)).toFixed(12)), estimatedFees: Number(slot.sell_fee)
  });
  const accounts = await loadSlotAccounts(supabase, config);
  const monthly = await monthlyStatuses(supabase, config, accounts);
  const candidates = slots.map((slot) => ({ ...strategyCandidate(slot, monthly.find((status) => status.physicalSlotNumber === slot.slot_number)),
    balanceUsdc: Number(accounts[slot.slot_number - 1]!.balance_usdc) }));
  const terminalPlan = planStrategyClosedSlot(strategyContext(config, cycle, observedAt), candidates, closed[0]!.id);
  if (terminalPlan.mode === "GLOBAL_RESET") return { terminal: true, updated: 0, decisions: terminalPlan.decisions };
  let updated = 0;
  for (const closedSlot of closed) {
    const plan = planStrategyClosedSlot(strategyContext(config, cycle, observedAt), candidates, closedSlot.id);
    if (plan.mode === "MONTHLY_HOLD") {
      await audit(supabase, config, "MONTHLY_TARGET_HOLD", `${cycle.id}:${closedSlot.id}:${monthly[0]?.periodKey}`,
        { cycleId: cycle.id, slotId: closedSlot.id, next: { reason: monthly.find((status) => status.physicalSlotNumber === closedSlot.slot_number)?.blockedReason, periodKey: monthly[0]?.periodKey }, observedAt });
      continue;
    }
    const nextSequence = closedSlot.operation_sequence + 1;
    const account = accounts[closedSlot.slot_number - 1]!;
    const entry = buildV1LocalReentry(closedSlot.slot_number, Number(closedSlot.buy_price), Number(account.balance_usdc), filters);
    await applyDecision(supabase, config, plan.decisions[0]!, nextSequence, async () => {
      const { data, error } = await supabase.from("robot_v1_slots").update({
        operation_sequence: nextSequence, allocation_usdc: account.balance_usdc, buy_price: entry.buyPrice,
        requested_quantity: entry.quantity, executed_quantity: 0, average_fill_price: null, buy_status: "PENDING",
        entry_state: "PLANNED", entry_origin: "REENTRY", armed_at: null, missed_at: null, buy_trigger_price: null, buy_trigger_observed_price: null, buy_triggered_at: null,
        config_version: cycle.config_version,
        config_snapshot: { ...(cycle.config_snapshot ?? {}), regime: cycle.entry_regime,
          entry_spacing: Number(cycle.entry_spacing), ath_transition_key: cycle.ath_transition_key },
        take_profit_price: null, take_profit_status: "NONE", tp_trigger_observed_price: null, tp_triggered_at: null,
        realized_quote_pnl: null, buy_fee: 0, sell_fee: 0, status: "PENDING",
        buy_client_order_id: v1ClientOrderId(config.asset, cycle.id, closedSlot.slot_number, "BUY", nextSequence), sell_client_order_id: null,
        observed_at: observedAt, updated_at: new Date().toISOString(), idempotency_key: v1IdempotencyKey(cycle.id, closedSlot.slot_number, "BUY", nextSequence)
      }).eq("id", closedSlot.id).eq("status", "CLOSED").eq("operation_sequence", closedSlot.operation_sequence).select("id").maybeSingle();
      if (error) throw error;
      if (data?.id) updated += 1;
      return { status: "PLANNED", slot_id: closedSlot.id, target_price: entry.buyPrice, balance_usdc: Number(account.balance_usdc), operation_sequence: nextSequence };
    });
    await audit(supabase, config, "SLOT_RECYCLED", `${cycle.id}:${closedSlot.id}:${nextSequence}`,
      { cycleId: cycle.id, slotId: closedSlot.id, previous: { operationSequence: closedSlot.operation_sequence, status: "CLOSED", entryPrice: closedSlot.buy_price },
        next: { operationSequence: nextSequence, logicalLevel: closedSlot.logical_level, buyPrice: entry.buyPrice, reason: "LOCAL_REENTRY_SAME_PRICE", balanceUsdc: account.balance_usdc }, observedAt });
    await audit(supabase, config, "SLOT_REENTRY_PLANNED", `${cycle.id}:${closedSlot.id}:${nextSequence}`,
      { cycleId: cycle.id, slotId: closedSlot.id, previous: { previousEntryPrice: closedSlot.buy_price },
        next: { physicalSlotNumber: closedSlot.slot_number, operationSequence: nextSequence, reentryPrice: entry.buyPrice, balanceAfter: account.balance_usdc,
          gainCountAfter: account.gain_count, otherOpenPositions: plan.otherOpenPositions, localRecycleVsGlobalReset: "LOCAL_REENTRY" }, observedAt });
  }
  return { terminal: false, updated, decisions: [] as StrategyDecision[] };
}

async function applyQueuedShadowProfile(supabase: ReturnType<typeof createServiceRoleClient>, adapter: BinanceSpotAdapter, config: Config) {
  const profile = await loadAthProfile(supabase, { productId: config.product_id,
    tenantId: config.tenant_id, userId: config.user_id }, "SHADOW", config.asset);
  const targetGain = Number(profile.next_gain_rate ?? config.next_gain_rate ?? profile.gain_rate);
  const targetNormal = Number(profile.next_normal_spacing_rate ??
    (profile.regime === "NORMAL" ? config.next_entry_spacing : null) ?? profile.normal_spacing_rate);
  const targetPost = Number(profile.next_post_ath_spacing_rate ??
    (profile.regime === "POST_ATH" ? config.next_entry_spacing : null) ?? profile.post_ath_spacing_rate);
  const targetSpacing = profile.regime === "POST_ATH" ? targetPost : targetNormal;
  const profilePending = profile.next_config_version !== null;
  if (config.next_capital_usdc === null && config.next_gain_rate === null && config.next_entry_spacing === null
    && Number(config.gain_rate) === targetGain && Number(config.entry_spacing) === targetSpacing && !profilePending) return config;
  if (Number(config.next_gain_rate ?? config.gain_rate) !== targetGain
    || Number(config.next_entry_spacing ?? config.entry_spacing) !== targetSpacing) {
    const { error } = await supabase.from("robot_v1_configs").update({
      next_gain_rate: targetGain, next_entry_spacing: targetSpacing,
    }).eq("id", config.id).eq("tenant_id", config.tenant_id);
    if (error) throw new Error("COINOPS_ATH_SHADOW_NEXT_PROFILE_QUEUE_FAILED");
    config = { ...config, next_gain_rate: targetGain, next_entry_spacing: targetSpacing };
  }
  const capital = asNumber(config.next_capital_usdc ?? config.capital_usdc, "COINOPS_V1_CAPITAL_INVALID");
  const parameters = assertV1ShadowParameters({ gainRate: asNumber(config.next_gain_rate ?? config.gain_rate, "COINOPS_V1_PARAMETERS_INVALID"), entrySpacing: asNumber(config.next_entry_spacing ?? config.entry_spacing, "COINOPS_V1_PARAMETERS_INVALID") });
  const accounts = await loadSlotAccounts(supabase, config);
  const delta = (capital - asNumber(config.capital_usdc, "COINOPS_V1_CAPITAL_INVALID")) / 25;
  const balances = accounts.map((account) => asNumber(account.balance_usdc, "COINOPS_V1_SLOT_ACCOUNT_INVALID") + delta);
  if (capital > 2500 || balances.some((balance) => balance <= 0 || balance > 100)) throw new Error("COINOPS_V1_NEXT_PROFILE_INVALID");
  const [filters, market] = await Promise.all([adapter.getSymbolInfo(V1_RULES[config.asset].symbol), adapter.getMarketPrice(V1_RULES[config.asset].symbol)]);
  buildV1Grid(config.asset, capital, market.price, filters, parameters, balances);
  const { data, error } = await supabase.rpc("apply_robot_v1_shadow_next_profile", { p_config_id: config.id });
  if (error || !data) throw new Error("COINOPS_V1_NEXT_PROFILE_APPLY_FAILED");
  if (profilePending || targetGain !== Number(profile.gain_rate)
    || targetNormal !== Number(profile.normal_spacing_rate) || targetPost !== Number(profile.post_ath_spacing_rate)) {
    const nextVersion = profile.next_config_version ?? profile.config_version + 1;
    const { error: profileError } = await supabase.from("robot_v1_ath_profiles").update({
      config_version: nextVersion, gain_rate: targetGain,
      normal_spacing_rate: targetNormal, post_ath_spacing_rate: targetPost,
      next_config_version: null, next_gain_rate: null, next_normal_spacing_rate: null,
      next_post_ath_spacing_rate: null, updated_at: new Date().toISOString(),
    }).eq("id", profile.id).eq("tenant_id", config.tenant_id).eq("config_version", profile.config_version);
    if (profileError) throw new Error("COINOPS_ATH_SHADOW_PROFILE_ACTIVATE_FAILED");
    const { error: eventError } = await supabase.from("robot_v1_ath_events").upsert({
      profile_id: profile.id, product_id: config.product_id, tenant_id: config.tenant_id,
      user_id: config.user_id, environment: "SHADOW", asset: config.asset,
      event_key: `STRATEGY_CONFIG_ACTIVATED:${nextVersion}`, event_type: "STRATEGY_CONFIG_ACTIVATED",
      details: { config_version: nextVersion, gain_rate: targetGain,
        normal_spacing_rate: targetNormal, post_ath_spacing_rate: targetPost },
    }, { onConflict: "profile_id,event_key", ignoreDuplicates: true });
    if (eventError) throw new Error("COINOPS_ATH_SHADOW_CONFIG_AUDIT_FAILED");
  }
  return { ...config, capital_usdc: capital, gain_rate: parameters.gainRate, entry_spacing: parameters.entrySpacing, next_capital_usdc: null, next_gain_rate: null, next_entry_spacing: null, last_candle_open_at: null };
}


/** One-minute Shadow simulation with durable shared decisions and a config
 * lease. Production transport is GET-only; missed historical levels remain
 * evidence and never become fabricated exchange fills. */
export async function runConfiguredRobotV1Shadow(now = new Date()) {
  const supabase = createServiceRoleClient();
  const tenantId = getCoinOpsServiceTenantId();
  const { data, error } = await supabase.from("robot_v1_configs")
    .select("id,product_id,tenant_id,user_id,asset,symbol,capital_usdc,next_capital_usdc,gain_rate,entry_spacing,next_gain_rate,next_entry_spacing,kill_switch,pause_new_entries,last_candle_open_at,last_market_price,last_market_observed_at,last_engine_at,last_engine_error,grid_status,grid_error,strategy_version,strategy_lease_owner,strategy_lease_until")
    .eq("tenant_id", tenantId).eq("execution_mode", "SHADOW").order("asset");
  if (error) throw error;
  const configs = (data || []) as Config[];
  if (!configs.length) return { status: "NOT_CONFIGURED" as const, cyclesStarted: 0, slotsUpdated: 0, candlesProcessed: 0 };
  const adapter = BinanceSpotAdapter.fromEnvironment();
  let cyclesStarted = 0, slotsUpdated = 0, candlesProcessed = 0;
  const errors: Array<{ asset: string; code: string }> = [];
  for (let config of configs) {
    const leaseOwner = randomUUID();
    const started = Date.now();
    const deadline = started + 20_000;
    const observationStartedAt = new Date(started).toISOString();
    const countersBefore = { cyclesStarted, slotsUpdated, candlesProcessed };
    let leaseAcquired = false;
    let observationStatus: "COMPLETED" | "FAILED" | "SKIPPED" = "COMPLETED";
    let observationError: unknown = null;
    let observationCycleId: string | null = null;
    try {
      const { data: leased, error: leaseError } = await supabase.from("robot_v1_configs").update({
        strategy_lease_owner: leaseOwner, strategy_lease_until: new Date(started + 90_000).toISOString()
      }).eq("id", config.id).or(`strategy_lease_until.is.null,strategy_lease_until.lt.${observationStartedAt}`).select("id").maybeSingle();
      if (leaseError) throw leaseError;
      if (!leased) { observationStatus = "SKIPPED"; continue; }
      leaseAcquired = true;
      await recoverShadowDecisions(supabase, config);
      const rule = V1_RULES[config.asset];
      if (config.symbol !== rule.symbol) throw new Error("COINOPS_V1_CONFIG_SYMBOL_INVALID");
      const { data: cycleData, error: cycleError } = await supabase.from("robot_v1_cycles").select(CYCLE_COLUMNS)
        .eq("config_id", config.id).in("status", ACTIVE).maybeSingle();
      if (cycleError) throw cycleError;
      let cycle = cycleData as Cycle | null;
      const { error: versionError } = await supabase.from("robot_v1_configs").update({ strategy_version: STRATEGY_VERSION })
        .eq("id", config.id).eq("strategy_lease_owner", leaseOwner);
      if (versionError) throw versionError;
      if (!cycle && !config.kill_switch && !config.pause_new_entries) {
        const sourceMarket = await adapter.getMarketPrice(rule.symbol);
        await refreshAthProfile(supabase, { productId: config.product_id,
          tenantId: config.tenant_id, userId: config.user_id }, "SHADOW", config.asset, sourceMarket);
        config = await applyQueuedShadowProfile(supabase, adapter, config);
        cycle = await startInitialShadowCycle(supabase, adapter, config, new Date());
        if (cycle) cyclesStarted += 1;
      }
      if (!cycle) { observationStatus = "SKIPPED"; continue; }
      observationCycleId = cycle.id;
      if (cycle.strategy_version !== STRATEGY_VERSION) {
        const { error: adoptError } = await supabase.from("robot_v1_cycles").update({ strategy_version: STRATEGY_VERSION }).eq("id", cycle.id).in("status", ACTIVE);
        if (adoptError) throw adoptError;
      }
      if (cycle.status === "STARTING" && !config.kill_switch && !config.pause_new_entries) await initializeShadowCycle(supabase, adapter, config, cycle);
      const [filters, market] = await Promise.all([adapter.getSymbolInfo(rule.symbol), adapter.getMarketPrice(rule.symbol)]);
      let cycleParameters = assertV1ShadowParameters({ gainRate: Number(cycle.gain_rate), entrySpacing: Number(cycle.entry_spacing) });
      let healthSlots = await readSlots(supabase, cycle);
      // Complete a previously persisted BUY before processing later candles.
      for (const slot of healthSlots) await ensureTakeProfit(supabase, config, cycle, slot, filters, new Date().toISOString());
      healthSlots = await readSlots(supabase, cycle);
      const athProfile = await refreshAthProfile(supabase, { productId: config.product_id,
        tenantId: config.tenant_id, userId: config.user_id }, "SHADOW", config.asset, market);
      if (await applyShadowAthTransition(supabase, config, cycle, athProfile, filters, market.price)) {
        healthSlots = await readSlots(supabase, cycle);
        cycleParameters = assertV1ShadowParameters({ gainRate: Number(cycle.gain_rate), entrySpacing: Number(cycle.entry_spacing) });
      }
      const repairedTickDrift = cycle.ath_transition_key ? 0
        : await repairShadowReentryTickDrift(supabase, config, cycle, healthSlots, filters, cycleParameters);
      if (repairedTickDrift) healthSlots = await readSlots(supabase, cycle);
      const gridValidation = cycle.ath_transition_key
        ? validateAthTransitionedGrid(healthSlots.map((slot) => ({ physicalSlotNumber: slot.slot_number,
          buyPrice: Number(slot.buy_price), status: slot.status, operationalRank: slot.operational_rank })), filters.priceTick)
        : validateActiveGrid(Number(cycle.anchor_price), filters, cycleParameters, healthSlots.map((slot) => ({
          slotNumber: slot.slot_number, logicalLevel: slot.logical_level, buyPrice: Number(slot.buy_price),
          status: slot.status === "CLOSED" || slot.status === "CANCELLED" ? "PENDING" : slot.status
        })));
      const gridError = gridValidation.valid ? null : `GRADE ${config.asset} INVÁLIDA: ${gridValidation.errors.join(", ")}`;
      let resumeAfterRepair = false;
      if (repairedTickDrift && gridValidation.valid && config.pause_new_entries && config.grid_status === "INVALID"
        && /^GRADE (BTC|SOL) INVÁLIDA: PRICE_OFF_LADDER_\d+$/.test(config.grid_error || "") && !config.kill_switch) {
        const { data: lastControl, error: controlError } = await supabase.from("robot_v1_audit_events")
          .select("event_type").eq("config_id", config.id).in("event_type", ["PAUSED", "RESUMED", "SHADOW_STARTED"])
          .order("observed_at", { ascending: false }).limit(1).maybeSingle();
        if (controlError) throw controlError;
        resumeAfterRepair = Boolean(lastControl && lastControl.event_type !== "PAUSED");
      }
      const { error: healthError } = await supabase.from("robot_v1_configs").update({
        last_market_price: market.price, last_market_observed_at: market.observedAt, last_engine_at: new Date().toISOString(), last_engine_error: gridError,
        grid_status: gridValidation.valid ? "VALID" : "INVALID", grid_error: gridError,
        ...(gridValidation.valid ? resumeAfterRepair ? { pause_new_entries: false } : {} : { pause_new_entries: true })
      }).eq("id", config.id).eq("strategy_lease_owner", leaseOwner);
      if (healthError) throw healthError;
      if (resumeAfterRepair) {
        config.pause_new_entries = false;
        await audit(supabase, config, "SHADOW_GRID_AUTO_RESUMED", `${cycle.id}:TICK_DRIFT_REPAIRED`,
          { cycleId: cycle.id, next: { reason: "ONLY_AUTO_PAUSE_FROM_PROVEN_TICK_DRIFT", repairedSlots: repairedTickDrift } });
      }
      if (!gridValidation.valid) await audit(supabase, config, "GRID_INVALID", `${cycle.id}:${gridValidation.errors.join("|")}`,
        { cycleId: cycle.id, next: { errors: gridValidation.errors, action: "NEW_ENTRIES_PAUSED" }, observedAt: new Date().toISOString() });
      const canArm = gridValidation.valid && !config.kill_switch && !config.pause_new_entries;
      const accounts = await loadSlotAccounts(supabase, config);
      for (const slot of healthSlots.filter((item) => item.status === "PENDING" && item.entry_state !== "ARMED")) {
        const account = accounts[slot.slot_number - 1]!;
        const { quantity } = quantityForV1SlotBalance(Number(account.balance_usdc), Number(slot.buy_price), filters);
        if (quantity === Number(slot.requested_quantity) && sumV1DecimalAmounts([slot.allocation_usdc]) === sumV1DecimalAmounts([account.balance_usdc])) continue;
        const { error: quantityError } = await supabase.from("robot_v1_slots").update({ requested_quantity: quantity, allocation_usdc: account.balance_usdc })
          .eq("id", slot.id).eq("status", "PENDING").neq("entry_state", "ARMED").eq("operation_sequence", slot.operation_sequence);
        if (quantityError) throw quantityError;
        await audit(supabase, config, "SLOT_BALANCE_UPDATED", `${cycle.id}:${slot.id}:${slot.operation_sequence}:${account.balance_usdc}`,
          { cycleId: cycle.id, slotId: slot.id, previous: { allocationUsdc: slot.allocation_usdc },
            next: { requestedQuantity: quantity, allocationUsdc: account.balance_usdc, reason: "PENDING_SHADOW_NOTIONAL_RECONCILED" }, observedAt: new Date().toISOString() });
      }
      const startAt = Math.max(Date.parse(cycle.started_at), config.last_candle_open_at ? Date.parse(config.last_candle_open_at) + 60_000 : 0);
      const candles = (await adapter.getCandles(rule.symbol, "1m", startAt))
        .filter((candle) => Date.parse(candle.closeTime) <= now.getTime()).sort((left, right) => Date.parse(left.openTime) - Date.parse(right.openTime));
      if (candles.length === 1000 && startAt < Date.parse(candles[0]!.openTime)) await audit(supabase, config, "DATA_GAP", `${cycle.id}:${candles[0]!.openTime}`,
        { cycleId: cycle.id, previous: { requestedStart: new Date(startAt).toISOString() }, next: { firstAvailable: candles[0]!.openTime } });
      let terminal = false;
      let terminalDecisions: StrategyDecision[] = [];
      let processed = 0;
      for (const candle of candles) {
        if (Date.now() >= deadline) break;
        const { error: candleError } = await supabase.from("robot_v1_market_candles").upsert({
          product_id: config.product_id, tenant_id: config.tenant_id, user_id: config.user_id, config_id: config.id, cycle_id: cycle.id, symbol: rule.symbol,
          candle_open_at: candle.openTime, candle_close_at: candle.closeTime, open_price: candle.open, high_price: candle.high, low_price: candle.low, close_price: candle.close
        }, { onConflict: "config_id,candle_open_at", ignoreDuplicates: true });
        if (candleError) throw candleError;
        const slots = await readSlots(supabase, cycle);
        const residentSlots = selectV1CandleResidentSlots(slots.filter((slot) =>
          // A replay cannot use the same candle's high for a TP created by its BUY.
          slot.status !== "TP_ACTIVE" || wasStrategyOrderResidentAt(slot.buy_triggered_at, candle.openTime)
        ).map((slot) => ({ slotNumber: slot.slot_number, status: slot.status, entryState: slot.entry_state, armedAt: slot.armed_at,
          missedAt: slot.missed_at, buyPrice: Number(slot.buy_price), averageFillPrice: slot.average_fill_price === null ? null : Number(slot.average_fill_price),
          takeProfitPrice: slot.take_profit_price === null ? null : Number(slot.take_profit_price) })), candle.openTime);
        const transitions = evaluateV1Candle(config.asset, candle, residentSlots, filters, cycleParameters);
        for (const transition of transitions) {
          const slot = slots.find((item) => item.slot_number === transition.slotNumber);
          if (!slot) continue;
          if (transition.kind === "BUY_TRIGGERED" && canArm) {
            const quantity = Number(slot.requested_quantity);
            const { data: filled, error: fillError } = await supabase.from("robot_v1_slots").update({
              executed_quantity: quantity, average_fill_price: transition.fillPrice, buy_status: "FILLED",
              buy_trigger_price: Number(slot.buy_price), buy_trigger_observed_price: transition.observedPrice, buy_triggered_at: candle.closeTime,
              status: "OPEN", entry_state: "NONE", armed_at: null, observed_at: candle.closeTime
            }).eq("id", slot.id).eq("status", "PENDING").eq("entry_state", "ARMED").eq("operation_sequence", slot.operation_sequence).select("id").maybeSingle();
            if (fillError) throw fillError;
            if (!filled?.id) continue;
            Object.assign(slot, { status: "OPEN", average_fill_price: transition.fillPrice, executed_quantity: quantity, buy_triggered_at: candle.closeTime });
            await ensureTakeProfit(supabase, config, cycle, slot, filters, candle.closeTime);
            const target = calculateStrategyTakeProfit(transition.fillPrice, filters.priceTick, cycleParameters);
            await audit(supabase, config, "BUY_TRIGGERED", `${cycle.id}:${slot.id}:${candle.openTime}`,
              { cycleId: cycle.id, slotId: slot.id, next: { triggerPrice: slot.buy_price, observedLow: transition.observedPrice, fillPrice: transition.fillPrice, takeProfitPrice: target }, observedAt: candle.closeTime });
            if (candle.high >= target) await audit(supabase, config, "INTRABAR_AMBIGUOUS", `${cycle.id}:${slot.id}:${candle.openTime}`,
              { cycleId: cycle.id, slotId: slot.id, next: { reason: "BUY_AND_TP_IN_SAME_CANDLE", observedHigh: candle.high }, observedAt: candle.closeTime });
            slotsUpdated += 1;
          }
          if (transition.kind === "TP_TRIGGERED") {
            const grossProfit = Number(((Number(slot.take_profit_price) - Number(slot.average_fill_price)) * Number(slot.executed_quantity)).toFixed(12));
            const { data: closed, error: closeError } = await supabase.from("robot_v1_slots").update({
              take_profit_status: "FILLED", status: "CLOSED", sell_fee: 0, tp_trigger_observed_price: transition.observedPrice,
              tp_triggered_at: candle.closeTime, realized_quote_pnl: grossProfit, observed_at: candle.closeTime
            }).eq("id", slot.id).eq("status", "TP_ACTIVE").eq("operation_sequence", slot.operation_sequence).select("id").maybeSingle();
            if (closeError) throw closeError;
            if (!closed?.id) continue;
            await archiveClosedShadowOperation(supabase, config, cycle, slot, { closedAt: candle.closeTime, grossProfit, estimatedFees: 0 });
            await audit(supabase, config, "TP_TRIGGERED", `${cycle.id}:${slot.id}:${candle.openTime}`,
              { cycleId: cycle.id, slotId: slot.id, next: { targetPrice: slot.take_profit_price, observedHigh: transition.observedPrice, grossProfit, estimatedFees: 0, netProfit: grossProfit }, observedAt: candle.closeTime });
            slotsUpdated += 1;
          }
        }
        // Complete local recycling before advancing the candle checkpoint.
        // Replayed work remains guarded by physical operation sequence and CAS.
        // The low applies to candidates that existed during the candle. New
        // reentries born from its TP see the close, never the earlier low.
        await reconcileSingleArmedEntry(supabase, config, cycle, candle.low, candle.closeTime, canArm);
        const settled = await settleClosedSlots(supabase, config, cycle, filters, candle.closeTime);
        slotsUpdated += settled.updated;
        terminal = settled.terminal;
        terminalDecisions = settled.decisions;
        if (!terminal && settled.updated > 0) await reconcileSingleArmedEntry(supabase, config, cycle, candle.close, candle.closeTime, canArm);
        const { error: checkpointError } = await supabase.from("robot_v1_configs").update({ last_candle_open_at: candle.openTime })
          .eq("id", config.id).eq("strategy_lease_owner", leaseOwner);
        if (checkpointError) throw checkpointError;
        processed += 1;
        candlesProcessed += 1;
        // Reanchor only from a fresh market snapshot, never a fabricated old cycle.
        if (terminal) break;
      }
      const backlogComplete = processed === candles.length && candles.length < 1000;
      if (!terminal && backlogComplete) {
        const settled = await settleClosedSlots(supabase, config, cycle, filters, market.observedAt);
        slotsUpdated += settled.updated;
        terminal = settled.terminal;
        terminalDecisions = settled.decisions;
        if (!terminal) await reconcileSingleArmedEntry(supabase, config, cycle, market.price, market.observedAt, canArm);
      }
      if (terminal) {
        const previousCycle = cycle;
        const completion = terminalDecisions.find((item) => item.action_type === "COMPLETE_CYCLE")!;
        await applyDecision(supabase, config, completion, undefined, async () => {
          const current = await readSlots(supabase, previousCycle);
          if (current.some((slot) => ["OPEN", "TP_ACTIVE", "PARTIALLY_FILLED"].includes(slot.status))) throw new Error("COINOPS_STRATEGY_POSITION_REMAINS_OPEN");
          const { error: cancelError } = await supabase.from("robot_v1_slots").update({
            status: "CANCELLED", buy_status: "CANCELLED", take_profit_status: "CANCELLED", entry_state: "NONE", armed_at: null, observed_at: new Date().toISOString()
          }).eq("cycle_id", previousCycle.id).eq("status", "PENDING").eq("executed_quantity", 0);
          if (cancelError) throw cancelError;
          const { error: completeError } = await supabase.from("robot_v1_cycles").update({
            status: "CYCLE_COMPLETE", completed_at: new Date().toISOString(), completion_reason: "AUTO_RESET_NO_OPEN_SHADOW_POSITIONS"
          }).eq("id", previousCycle.id).in("status", ACTIVE);
          if (completeError) throw completeError;
          const { error: checkpointError } = await supabase.from("robot_v1_configs").update({ last_candle_open_at: null })
            .eq("id", config.id).eq("strategy_lease_owner", leaseOwner);
          if (checkpointError) throw checkpointError;
          return { status: "COMPLETED", cycle_id: previousCycle.id, cancelled_owned_pending_buys: true };
        });
        await audit(supabase, config, "CYCLE_COMPLETED", previousCycle.id, { cycleId: previousCycle.id,
          next: { reason: "AUTO_RESET_NO_OPEN_SHADOW_POSITIONS", strategyVersion: STRATEGY_VERSION }, observedAt: new Date().toISOString() });
        if (!config.kill_switch && !config.pause_new_entries) {
          const reanchor = terminalDecisions.find((item) => item.action_type === "REANCHOR")!;
          await applyDecision(supabase, config, reanchor, undefined, async () => {
            config = await applyQueuedShadowProfile(supabase, adapter, { ...config, last_candle_open_at: null });
            const next = await startInitialShadowCycle(supabase, adapter, config, new Date());
            if (next) {
              cyclesStarted += 1;
              await audit(supabase, config, "CYCLE_RESTARTED", `${previousCycle.id}:${next.id}`,
                { cycleId: next.id, previous: { cycleId: previousCycle.id }, next: { cycleId: next.id, anchorFrom: "CURRENT_READ_ONLY_MARKET_PRICE" }, observedAt: new Date().toISOString() });
            }
            return { status: "READY_FOR_INITIAL_MARKET", previous_cycle_id: previousCycle.id, next_cycle_id: next?.id ?? null, current_market_reanchor: true };
          });
        }
      }
    } catch (error) {
      observationStatus = "FAILED";
      observationError = error;
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "COINOPS_SHADOW_ENGINE_FAILED";
      errors.push({ asset: config.asset, code });
      if (leaseAcquired) await supabase.from("robot_v1_configs").update({ last_engine_at: new Date().toISOString(), last_engine_error: code })
        .eq("id", config.id).eq("strategy_lease_owner", leaseOwner);
    } finally {
      if (leaseAcquired) {
        try { await recoverShadowDecisions(supabase, config); } catch { errors.push({ asset: config.asset, code: "COINOPS_SHADOW_DECISION_RECOVERY_FAILED" }); }
        const { error: releaseError } = await supabase.from("robot_v1_configs").update({ strategy_lease_owner: null, strategy_lease_until: null })
          .eq("id", config.id).eq("strategy_lease_owner", leaseOwner);
        if (releaseError) errors.push({ asset: config.asset, code: "COINOPS_SHADOW_LEASE_RELEASE_FAILED" });
      }
      try {
        await recordRuntimeObservation({
          scope: { productId: config.product_id, tenantId: config.tenant_id, userId: config.user_id },
          source: "SHADOW_ENGINE", environment: "SHADOW", asset: config.asset, symbol: config.symbol,
          reference: `${config.id}:${observationStartedAt}`, startedAt: observationStartedAt, finishedAt: new Date().toISOString(),
          status: observationStatus, error: observationError,
          metrics: { config_id: config.id, cycle_id: observationCycleId, strategy_version: STRATEGY_VERSION,
            cycles_started: cyclesStarted - countersBefore.cyclesStarted, slots_updated: slotsUpdated - countersBefore.slotsUpdated,
            candles_processed: candlesProcessed - countersBefore.candlesProcessed,
            gain_rate: config.gain_rate, entry_spacing: config.entry_spacing, capital_usdc: config.capital_usdc,
            kill_switch: config.kill_switch, pause_new_entries: config.pause_new_entries }
        });
      } catch {
        errors.push({ asset: config.asset, code: "COINOPS_SHADOW_OBSERVATION_FAILED" });
      }
    }
  }
  return { status: errors.length ? "PARTIAL" as const : "COMPLETED" as const, cyclesStarted, slotsUpdated, candlesProcessed, errors };
}
