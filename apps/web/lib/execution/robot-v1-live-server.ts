import { randomUUID } from "node:crypto";

import { planAthLadder } from "./ath-ladder";
import { loadAthProfile, refreshAthProfile, type AthProfileRow } from "./ath-profile-server";
import { buildLiveSizing, parseLiveRules, type LiveConfig, type RawLiveSymbol } from "./live-preparation";
import { readLiveExecutorState, readLiveExecutorOrder, readLiveExecutorTrades,
  createLiveExecutorOrder, cancelLiveExecutorOrder, type LiveOrder,
  type LiveTrade, type LiveExecutorState } from "./live-executor-transport";
import { loadLiveExecutorStatus } from "./live-executor-health";
import { loadMonthlySlotStatuses } from "./monthly-slot-server";
import { monthlyPeriodKey } from "./monthly-slot-policy";
import { liveClientOrderId, liveExposure, liveUncoveredQuantity,
  LIVE_ACTIVE_ORDER_STATUSES, LIVE_TERMINAL_ORDER_STATUSES } from "./robot-v1-live-cycle";
import { STRATEGY_VERSION, planStrategyInitialEntry, planStrategyNextEntry,
  planStrategyPostAthNextEntry, planStrategyTakeProfit, planStrategyClosedSlot,
  type StrategyCandidate, type StrategyDecision } from "./strategy-engine";
import { persistStrategyDecision, dispatchStrategyDecision,
  completeStrategyDecision, failStrategyDecision } from "./strategy-decision-server";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "../supabase/env";
import { createServiceRoleClient } from "../supabase/service-role";
import type { V1Asset } from "./robot-v1";
import type { ExchangeSymbolInfo } from "./types";

type Service = ReturnType<typeof createServiceRoleClient>;
type Symbol = "BTCBRL" | "SOLBRL";
type Scope = { product_id: string; tenant_id: string; user_id: string };
type Preparation = Scope & { asset: V1Asset; symbol: Symbol; slot_count: number;
  configured_live_capital_brl: number | string; max_order_notional_brl: number | string;
  max_total_exposure_brl: number | string; monthly_target: number;
  live_enabled: boolean; kill_switch: boolean; config_version: number };
type Run = Scope & { id: string; asset: V1Asset; symbol: Symbol; status: string;
  anchor_price: number | string; slot_notional_brl: number | string; gain_rate: number | string;
  entry_spacing: number | string; entry_regime: "NORMAL" | "POST_ATH";
  config_version: number; config_snapshot: Record<string, unknown>; strategy_version: string;
  ath_transition_key: string | null; ath_period_key: string | null;
  last_error: string | null; lease_owner: string | null; lease_until: string | null;
  last_reconciled_at: string | null; previous_run_id: string | null };
type Slot = Scope & { id: string; run_id: string; slot_number: number; entry_state: string;
  target_buy_price: number | string; entry_reference_price: number | string;
  operation_sequence: number; entry_origin: "GRID" | "REENTRY";
  operational_rank: number | null; post_ath_group: "PRIMARY" | "RESERVE" | null;
  post_ath_group_rank: number | null; position_quantity: number | string;
  position_committed_brl: number | string; missed_at: string | null;
  last_credited_sell_client_order_id: string | null };
type Account = Scope & { asset: V1Asset; slot_number: number; balance_brl: number | string;
  contribution_brl: number | string; market_pnl_brl: number | string;
  manual_gain_brl: number | string; fees_brl: number | string; gain_count: number;
  dust_quantity: number | string; dust_cost_brl: number | string };
type Order = Scope & { id: string; run_id: string; slot_id: string; slot_number: number;
  operation_sequence: number; side: "BUY" | "SELL"; purpose: "INITIAL" | "ENTRY" | "TP";
  revision: number; client_order_id: string; exchange_order_id: string | null;
  status: string; requested_quantity: number | string | null;
  requested_quote: number | string | null; price: number | string | null;
  reserved_notional_brl: number | string; executed_quantity: number | string;
  cumulative_quote: number | string; fee_base: number | string;
  fee_quote: number | string; fee_other: Array<{ asset: string; amount: number }>;
  trades_reconciled: boolean; submission_guarded_at: string | null;
  strategy_decision_id: string | null };

type Ledger = Awaited<ReturnType<typeof runRows>>;

const PUBLIC_SPOT = "https://data-api.binance.vision";
const amount = (value: number | string | null | undefined) => Number(value ?? 0);
const floorStep = (value: number, step: number) => Number((Math.floor((value + 1e-10) / step) * step).toFixed(12));
const owned = (run: Run) => ({ product_id: run.product_id, tenant_id: run.tenant_id, user_id: run.user_id });
const context = (run: Run, transitionKey?: string) => ({ asset: run.asset, cycleId: run.id,
  observedAt: new Date().toISOString(), quoteAsset: "BRL" as const, transitionKey });

function assertScope() {
  if (getSupabaseDataSchema() !== "coinops" || !getCoinOpsServiceTenantId())
    throw new Error("COINOPS_LIVE_SCHEMA_SCOPE_INVALID");
}

async function publicRules(symbol: Symbol) {
  const response = await fetch(`${PUBLIC_SPOT}/api/v3/exchangeInfo?symbol=${symbol}`,
    { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("COINOPS_LIVE_FILTERS_UNAVAILABLE");
  const raw = (await response.json() as { symbols?: RawLiveSymbol[] }).symbols?.find((item) => item.symbol === symbol);
  if (!raw) throw new Error("COINOPS_LIVE_FILTERS_UNAVAILABLE");
  return parseLiveRules(raw);
}

async function scopedPreparation(service: Service, userId: string, asset: V1Asset): Promise<Preparation> {
  const result = await service.from("robot_v1_live_preparations").select("*")
    .eq("tenant_id", getCoinOpsServiceTenantId()).eq("user_id", userId).eq("asset", asset).single();
  if (result.error || !result.data || result.data.symbol !== `${asset}BRL`)
    throw new Error("COINOPS_LIVE_PREPARATION_UNAVAILABLE");
  return result.data as Preparation;
}

async function runRows(service: Service, run: Run) {
  const [s, o, a] = await Promise.all([
    service.from("robot_v1_live_slots").select("*").eq("run_id", run.id).eq("tenant_id", run.tenant_id).order("slot_number"),
    service.from("robot_v1_live_orders").select("*").eq("run_id", run.id).eq("tenant_id", run.tenant_id).order("created_at"),
    service.from("robot_v1_live_slot_accounts").select("*").eq("product_id", run.product_id)
      .eq("tenant_id", run.tenant_id).eq("user_id", run.user_id).eq("asset", run.asset).order("slot_number"),
  ]);
  if (s.error || o.error || a.error || s.data?.length !== 25 || a.data?.length !== 25)
    throw new Error("COINOPS_LIVE_LEDGER_INCOMPLETE");
  return { slots: s.data as Slot[], orders: o.data as Order[], accounts: a.data as Account[] };
}

async function event(service: Service, run: Run, key: string, type: string,
  slotNumber: number | null, details: Record<string, unknown> = {}) {
  const result = await service.from("robot_v1_live_events").upsert({ run_id: run.id, ...owned(run),
    event_key: key, event_type: type, slot_number: slotNumber, details },
  { onConflict: "run_id,event_key", ignoreDuplicates: true });
  if (result.error) throw new Error("COINOPS_LIVE_EVENT_PERSIST_FAILED");
}

function candidate(slot: Slot, account: Account, rank: number | null,
  reached: boolean): StrategyCandidate {
  return { id: slot.id, slotNumber: slot.slot_number, operationSequence: slot.operation_sequence,
    buyPrice: amount(slot.target_buy_price), balanceQuote: amount(account.balance_brl),
    operationalRank: slot.post_ath_group ? slot.operational_rank : rank,
    monthlyTargetReached: reached, postAthGroup: slot.post_ath_group,
    entryOrigin: slot.entry_origin,
    state: slot.missed_at ? "MISSED" : ["OPEN", "CLOSED", "ARMED"].includes(slot.entry_state)
      ? slot.entry_state as "OPEN" | "CLOSED" | "ARMED" : "PLANNED" };
}

async function monthly(service: Service, run: Run, slots: Slot[], accounts: Account[]) {
  return loadMonthlySlotStatuses(service, "REAL", { ...owned(run), asset: run.asset }, slots.map((slot) => {
    const account = accounts.find((row) => row.slot_number === slot.slot_number);
    if (!account) throw new Error("COINOPS_LIVE_ACCOUNT_MISSING");
    return { slot_number: slot.slot_number, balance_brl: account.balance_brl,
      gain_count: account.gain_count, entry_state: slot.entry_state };
  }));
}

async function renewLease(service: Service, run: Run) {
  const until = new Date(Date.now() + 90_000).toISOString();
  const result = await service.from("robot_v1_live_runs").update({ lease_until: until })
    .eq("id", run.id).eq("tenant_id", run.tenant_id).eq("lease_owner", run.lease_owner)
    .gt("lease_until", new Date().toISOString()).select("id").maybeSingle();
  if (result.error || !result.data) throw new Error("COINOPS_LIVE_LEASE_LOST");
  run.lease_until = until;
}

async function claim(service: Service, runId: string): Promise<Run | null> {
  const owner = randomUUID();
  const now = new Date();
  const result = await service.from("robot_v1_live_runs")
    .update({ lease_owner: owner, lease_until: new Date(now.getTime() + 90_000).toISOString() })
    .eq("id", runId).eq("tenant_id", getCoinOpsServiceTenantId()).in("status", ["ACTIVE", "PAUSED"])
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`).select("*").maybeSingle();
  if (result.error) throw new Error("COINOPS_LIVE_LEASE_FAILED");
  return result.data as Run | null;
}

async function release(service: Service, run: Run, error: string | null) {
  const result = await service.from("robot_v1_live_runs").update({ lease_owner: null,
    lease_until: null, last_reconciled_at: new Date().toISOString(), last_error: error })
    .eq("id", run.id).eq("tenant_id", run.tenant_id).eq("lease_owner", run.lease_owner);
  if (result.error) throw new Error("COINOPS_LIVE_LEASE_RELEASE_FAILED");
}

async function preventNewBuys(service: Service, run: Run, code: string) {
  const result = await service.from("robot_v1_live_preparations").update({ kill_switch: true })
    .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id)
    .eq("user_id", run.user_id).eq("asset", run.asset);
  if (result.error) throw new Error("COINOPS_LIVE_KILL_SWITCH_PERSIST_FAILED");
  const alert = await service.from("robot_v1_live_alerts").upsert({ ...owned(run), asset: run.asset,
    alert_key: `LIVE_RUN:${run.id}:CRITICAL`, severity: "CRITICAL", code,
    details: { run_id: run.id }, last_seen_at: new Date().toISOString(), resolved_at: null },
  { onConflict: "product_id,tenant_id,user_id,alert_key" });
  if (alert.error) throw new Error("COINOPS_LIVE_ALERT_PERSIST_FAILED");
}

async function updateSlot(service: Service, run: Run, slot: Slot, values: Record<string, unknown>) {
  const result = await service.from("robot_v1_live_slots").update(values)
    .eq("id", slot.id).eq("run_id", run.id).eq("tenant_id", run.tenant_id).select("*").single();
  if (result.error || !result.data) throw new Error("COINOPS_LIVE_SLOT_UPDATE_FAILED");
  Object.assign(slot, result.data);
}

async function updateOrder(service: Service, run: Run, order: Order, values: Record<string, unknown>) {
  const result = await service.from("robot_v1_live_orders").update(values)
    .eq("id", order.id).eq("run_id", run.id).eq("tenant_id", run.tenant_id).select("*").single();
  if (result.error || !result.data) throw new Error("COINOPS_LIVE_ORDER_UPDATE_FAILED");
  Object.assign(order, result.data);
}

async function exposure(service: Service, run: Run) {
  const runs = await service.from("robot_v1_live_runs").select("id,asset")
    .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id).eq("user_id", run.user_id)
    .in("status", ["ACTIVE", "PAUSED"]);
  if (runs.error || !runs.data) throw new Error("COINOPS_LIVE_EXPOSURE_UNAVAILABLE");
  const ids = runs.data.map((item) => item.id);
  if (!ids.length) return { BTC: 0, SOL: 0, global: 0 };
  const [slots, orders] = await Promise.all([
    service.from("robot_v1_live_slots").select("run_id,position_committed_brl").in("run_id", ids),
    service.from("robot_v1_live_orders").select("run_id,side,status,reserved_notional_brl,cumulative_quote")
      .in("run_id", ids),
  ]);
  if (slots.error || orders.error || !slots.data || !orders.data)
    throw new Error("COINOPS_LIVE_EXPOSURE_UNAVAILABLE");
  const assetByRun = new Map(runs.data.map((item) => [item.id, item.asset as V1Asset]));
  return liveExposure(slots.data.map((slot) => ({ asset: assetByRun.get(slot.run_id)!,
    committedBrl: amount(slot.position_committed_brl) })),
  orders.data.map((order) => ({ asset: assetByRun.get(order.run_id)!,
    side: order.side as "BUY" | "SELL", status: order.status,
    executed_quantity: 0, fee_base: 0,
    reserved_notional_brl: order.reserved_notional_brl, cumulative_quote: order.cumulative_quote })));
}

async function assertExchangeMatchesLedger(run: Run, orders: Order[], state: LiveExecutorState,
  dispatchingClientOrderId: string | null = null) {
  if (state.symbol !== run.symbol || Date.now() - Date.parse(state.observed_at) > 30_000
    || !state.price.price || Date.now() - Date.parse(state.price.observedAt) > 30_000)
    throw new Error("COINOPS_LIVE_EXCHANGE_SNAPSHOT_STALE");
  const own = state.open_orders.filter((item) => item.clientOrderId?.startsWith(`COR1-${run.asset}-`));
  const ledger = new Map(orders.filter((item) => LIVE_ACTIVE_ORDER_STATUSES.has(item.status))
    .map((item) => [item.client_order_id, item]));
  for (const observed of own) {
    const entry = ledger.get(observed.clientOrderId ?? "");
    if (!entry || entry.side !== observed.side || entry.exchange_order_id !== observed.id)
      throw new Error("COINOPS_LIVE_UNRECONCILED_EXCHANGE_ORDER");
    ledger.delete(observed.clientOrderId!);
  }
  for (const pending of ledger.values()) {
    if (pending.submission_guarded_at !== null && pending.client_order_id !== dispatchingClientOrderId)
      throw new Error("COINOPS_LIVE_EXCHANGE_ORDER_MISSING");
  }
  return own.map((item) => item.clientOrderId!);
}

async function prepareOrder(service: Service, run: Run, slot: Slot, decision: StrategyDecision,
  side: "BUY" | "SELL", purpose: Order["purpose"], revision: number,
  quantity: number | null, quote: number | null, price: number | null) {
  await persistStrategyDecision(service, owned(run), "REAL", decision, slot.operation_sequence);
  const clientId = liveClientOrderId(run.id, run.asset, slot.slot_number, slot.operation_sequence, side, revision);
  await renewLease(service, run);
  const result = await service.rpc("prepare_robot_v1_live_order", {
    p_run_id: run.id, p_slot_id: slot.id, p_side: side, p_purpose: purpose,
    p_revision: revision, p_client_order_id: clientId, p_quantity: quantity,
    p_quote: quote, p_price: price, p_decision_id: decision.decision_id,
    p_lease_owner: run.lease_owner,
  });
  const order = (Array.isArray(result.data) ? result.data[0] : result.data) as Order | null;
  if (result.error || !order || order.client_order_id !== clientId || order.run_id !== run.id)
    throw new Error("COINOPS_LIVE_ORDER_PREPARE_FAILED");
  await event(service, run, `${clientId}:PREPARED`, "ORDER_PREPARED", slot.slot_number,
    { side, purpose, revision, decision_id: decision.decision_id });
  return order;
}

async function reconcileOrder(service: Service, run: Run, order: Order) {
  if (order.trades_reconciled && LIVE_TERMINAL_ORDER_STATUSES.has(order.status)) return order;
  let observed = (await readLiveExecutorOrder(run.symbol, order.client_order_id, order.exchange_order_id)).order;
  if (!observed) {
    if (order.submission_guarded_at !== null || order.status !== "PREPARED")
      throw new Error("COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN");
    const health = await loadLiveExecutorStatus();
    if (order.side === "BUY" && health.gate !== "LIVE_EXECUTOR_ACTIVE") return order;
    if (order.side === "SELL" && !["LIVE_EXECUTOR_ACTIVE", "LIVE_EXECUTOR_PROTECTED"].includes(health.gate))
      throw new Error("COINOPS_LIVE_TP_EXECUTOR_UNAVAILABLE");
    const guard = await service.from("robot_v1_live_orders")
      .update({ submission_guarded_at: new Date().toISOString() })
      .eq("id", order.id).eq("run_id", run.id).eq("status", "PREPARED")
      .is("submission_guarded_at", null).select("submission_guarded_at").maybeSingle();
    if (guard.error || !guard.data) throw new Error("COINOPS_LIVE_SUBMISSION_GUARD_FAILED");
    order.submission_guarded_at = guard.data.submission_guarded_at;
    const state = await readLiveExecutorState(run.symbol);
    const rows = await runRows(service, run);
    const expectedOwnedOpenIds = await assertExchangeMatchesLedger(run, rows.orders, state,
      order.client_order_id);
    const caps = await service.from("robot_v1_live_preparations")
      .select("max_total_exposure_brl,kill_switch,live_enabled")
      .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id)
      .eq("user_id", run.user_id).eq("asset", run.asset).single();
    const global = await service.from("robot_v1_live_global_caps")
      .select("max_total_live_exposure_brl").eq("product_id", run.product_id)
      .eq("tenant_id", run.tenant_id).eq("user_id", run.user_id).single();
    if (caps.error || !caps.data || global.error || !global.data
      || order.side === "BUY" && (!caps.data.live_enabled || caps.data.kill_switch))
      throw new Error("COINOPS_LIVE_WRITE_GATE_BLOCKED");
    const pre = await exposure(service, run);
    // The prepared order is already reserved in SQL; the transport receives
    // exposure before this order so the same hard cap is checked twice.
    const reserve = order.side === "BUY" ? amount(order.reserved_notional_brl) - amount(order.cumulative_quote) : 0;
    const buy = rows.orders.find((item) => item.slot_id === order.slot_id
      && item.operation_sequence === order.operation_sequence && item.side === "BUY"
      && amount(item.executed_quantity) > 0 && item.exchange_order_id);
    const input = { symbol: run.symbol, clientOrderId: order.client_order_id,
      side: order.side, purpose: order.purpose, type: order.purpose === "INITIAL" ? "MARKET" : "LIMIT",
      ...(order.purpose === "INITIAL" ? { quoteOrderQty: String(order.requested_quote) }
        : { quantity: String(order.requested_quantity), price: String(order.price) }),
      expectedOwnedOpenIds, assetCapBrl: amount(caps.data.max_total_exposure_brl),
      globalCapBrl: amount(global.data.max_total_live_exposure_brl),
      assetExposureBeforeBrl: pre[run.asset] - reserve,
      globalExposureBeforeBrl: pre.global - reserve,
      ...(order.side === "SELL" ? { sourceBuyClientOrderId: buy?.client_order_id,
        sourceBuyOrderId: buy?.exchange_order_id } : {}) };
    if (order.side === "SELL" && !buy) throw new Error("COINOPS_LIVE_TP_BUY_SOURCE_MISSING");
    await renewLease(service, run);
    await dispatchStrategyDecision(service, owned(run), "REAL", order.strategy_decision_id!);
    observed = (await createLiveExecutorOrder(input)).order;
  }
  if (observed.clientOrderId !== order.client_order_id || observed.symbol !== run.symbol
    || observed.side !== order.side) throw new Error("COINOPS_LIVE_ORDER_OWNERSHIP_MISMATCH");
  const withTrades = await readLiveExecutorTrades(run.symbol, order.client_order_id, observed.orderId);
  if (!withTrades.order || !withTrades.trades) throw new Error("COINOPS_LIVE_ORDER_TRADES_UNAVAILABLE");
  const state = await readLiveExecutorState(run.symbol);
  await renewLease(service, run);
  const synced = await service.rpc("sync_robot_v1_live_order", {
    p_order_id: order.id, p_exchange_order_id: observed.orderId,
    p_status: withTrades.order.status, p_executed_quantity: withTrades.order.executedQuantity,
    p_cumulative_quote: withTrades.order.cumulativeQuoteQuantity,
    p_trades: withTrades.trades, p_bnb_brl_price: state.bnb_brl_price?.price ?? null,
    p_bnb_brl_observed_at: state.bnb_brl_price?.observedAt ?? null,
    p_lease_owner: run.lease_owner,
  });
  const saved = (Array.isArray(synced.data) ? synced.data[0] : synced.data) as Order | null;
  if (synced.error || !saved || saved.id !== order.id) throw new Error("COINOPS_LIVE_ORDER_RECONCILIATION_FAILED");
  Object.assign(order, saved);
  if (order.strategy_decision_id && (amount(order.executed_quantity) > 0 || order.status === "NEW"))
    await completeStrategyDecision(service, owned(run), "REAL", order.strategy_decision_id!,
      { exchange_order_id: order.exchange_order_id, status: order.status,
        executed_quantity: amount(order.executed_quantity) }, true);
  return order;
}

function symbolFilters(state: LiveExecutorState): ExchangeSymbolInfo {
  return { symbol: state.symbol, baseAsset: state.symbol.slice(0, -3), quoteAsset: "BRL",
    minQuantity: state.filters.minQuantity, maxQuantity: state.filters.maxQuantity,
    quantityStep: state.filters.quantityStep, minNotional: state.filters.minNotional,
    priceTick: state.filters.priceTick };
}

function operationOrders(orders: Order[], slot: Slot) {
  return orders.filter((order) => order.slot_id === slot.id
    && order.operation_sequence === slot.operation_sequence);
}

async function cancelOwnedEntry(service: Service, run: Run, order: Order) {
  if (order.side !== "BUY" || !order.exchange_order_id
    || !["NEW", "PARTIALLY_FILLED"].includes(order.status))
    throw new Error("COINOPS_LIVE_BUY_NOT_CANCELABLE");
  await renewLease(service, run);
  const result = await cancelLiveExecutorOrder({ symbol: run.symbol,
    clientOrderId: order.client_order_id, orderId: order.exchange_order_id });
  if (result.order.status !== "CANCELED") throw new Error("COINOPS_LIVE_BUY_CANCEL_UNCERTAIN");
  await reconcileOrder(service, run, order);
  if (order.status !== "CANCELED") throw new Error("COINOPS_LIVE_BUY_CANCEL_UNRECONCILED");
}

async function ensureTakeProfits(service: Service, run: Run, ledger: Ledger,
  state: LiveExecutorState) {
  const filters = symbolFilters(state);
  for (const slot of ledger.slots) {
    let orders = operationOrders(ledger.orders, slot);
    let buys = orders.filter((item) => item.side === "BUY" && amount(item.executed_quantity) > 0);
    if (!buys.length) continue;
    for (const buy of buys.filter((item) => item.status === "PARTIALLY_FILLED"))
      await cancelOwnedEntry(service, run, buy);
    orders = operationOrders(ledger.orders, slot);
    buys = orders.filter((item) => item.side === "BUY" && amount(item.executed_quantity) > 0);
    if (buys.some((item) => LIVE_ACTIVE_ORDER_STATUSES.has(item.status)))
      throw new Error("COINOPS_LIVE_BUY_FILL_NOT_TERMINAL");
    const sells = orders.filter((item) => item.side === "SELL");
    if (sells.filter((item) => LIVE_ACTIVE_ORDER_STATUSES.has(item.status)).length > 1)
      throw new Error("COINOPS_LIVE_DUPLICATE_ACTIVE_TP");
    const uncovered = liveUncoveredQuantity(orders, filters.quantityStep);
    if (uncovered === 0) continue;
    if (sells.some((item) => LIVE_ACTIVE_ORDER_STATUSES.has(item.status)))
      throw new Error("COINOPS_LIVE_TP_PARTIAL_COVERAGE");
    const buyQuantity = buys.reduce((sum, item) => sum + amount(item.executed_quantity), 0);
    const buyQuote = buys.reduce((sum, item) => sum + amount(item.cumulative_quote), 0);
    if (!buyQuantity || slot.entry_state !== "OPEN") throw new Error("COINOPS_LIVE_POSITION_MISSING");
    const revision = Math.max(0, ...ledger.orders.filter((item) => item.slot_id === slot.id
      && item.side === "SELL").map((item) => item.revision)) + 1;
    const status = (await monthly(service, run, ledger.slots, ledger.accounts))
      .find((item) => item.physicalSlotNumber === slot.slot_number);
    if (!status) throw new Error("COINOPS_LIVE_MONTHLY_STATUS_MISSING");
    const tp = planStrategyTakeProfit(context(run, `TP:${revision}`),
      { ...candidate(slot, ledger.accounts.find((item) => item.slot_number === slot.slot_number)!,
        status.operationalRank, status.monthlyTargetReached), state: "OPEN" },
      buyQuote / buyQuantity, filters,
      { gainRate: amount(run.gain_rate), entrySpacing: amount(run.entry_spacing) });
    const price = tp.target_price;
    if (tp.action_type !== "CREATE_TP" || price === null
      || uncovered * price + 1e-8 < state.filters.minNotional)
      throw new Error("COINOPS_LIVE_TP_FILTER_UNPROTECTABLE");
    const order = await prepareOrder(service, run, slot, tp, "SELL", "TP", revision,
      uncovered, null, price);
    ledger.orders.push(order);
    await reconcileOrder(service, run, order);
  }
}

async function creditClosedSlots(service: Service, run: Run, ledger: Ledger,
  state: LiveExecutorState) {
  for (const slot of ledger.slots.filter((item) => item.entry_state === "OPEN")) {
    const orders = operationOrders(ledger.orders, slot);
    const tp = orders.find((item) => item.side === "SELL" && item.status === "FILLED"
      && item.trades_reconciled && item.client_order_id !== slot.last_credited_sell_client_order_id);
    if (!tp) continue;
    if (orders.some((item) => LIVE_ACTIVE_ORDER_STATUSES.has(item.status))) continue;
    if (amount(slot.position_quantity) >= state.filters.quantityStep) continue;
    await renewLease(service, run);
    const result = await service.rpc("credit_robot_v1_live_closed_slot", {
      p_run_id: run.id, p_slot_id: slot.id, p_operation_sequence: slot.operation_sequence,
      p_tp_client_order_id: tp.client_order_id,
      p_quantity_step: state.filters.quantityStep, p_lease_owner: run.lease_owner,
    });
    const account = (Array.isArray(result.data) ? result.data[0] : result.data) as Account | null;
    if (result.error || !account || account.slot_number !== slot.slot_number)
      throw new Error("COINOPS_LIVE_CREDIT_FAILED");
    Object.assign(ledger.accounts.find((item) => item.slot_number === slot.slot_number)!, account);
    await updateSlot(service, run, slot, { entry_state: "CLOSED" });
  }
}

async function recycleClosedSlots(service: Service, run: Run, ledger: Ledger) {
  const statuses = await monthly(service, run, ledger.slots, ledger.accounts);
  const candidates = ledger.slots.map((slot) => {
    const account = ledger.accounts.find((item) => item.slot_number === slot.slot_number)!;
    const status = statuses.find((item) => item.physicalSlotNumber === slot.slot_number)!;
    return candidate(slot, account, status.operationalRank, status.monthlyTargetReached);
  });
  for (const slot of ledger.slots.filter((item) => item.entry_state === "CLOSED")) {
    const plan = planStrategyClosedSlot(context(run), candidates, slot.id);
    if (plan.mode !== "LOCAL_REENTRY") continue;
    const nextSequence = slot.operation_sequence + 1;
    const decision = plan.decisions[0];
    await persistStrategyDecision(service, owned(run), "REAL", decision, nextSequence);
    await dispatchStrategyDecision(service, owned(run), "REAL", decision.decision_id);
    await updateSlot(service, run, slot, { entry_state: "PLANNED", entry_origin: "REENTRY",
      operation_sequence: nextSequence, target_buy_price: slot.entry_reference_price,
      missed_at: null });
    await event(service, run, `REENTRY:${slot.id}:${nextSequence}`, "LOCAL_REENTRY_PLANNED",
      slot.slot_number, { previous_entry_price: amount(slot.entry_reference_price),
        operation_sequence: nextSequence });
    await completeStrategyDecision(service, owned(run), "REAL", decision.decision_id,
      { state: "PLANNED", operation_sequence: nextSequence });
    const updated = candidates.find((item) => item.id === slot.id)!;
    updated.state = "PLANNED";
    updated.operationSequence = nextSequence;
  }
}

async function refreshRealAthProfile(service: Service, run: Run) {
  const response = await fetch(`${PUBLIC_SPOT}/api/v3/ticker/price?symbol=${run.asset}USDC`,
    { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("COINOPS_LIVE_ATH_PRICE_UNAVAILABLE");
  const quote = await response.json() as { price?: string };
  const price = Number(quote.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error("COINOPS_LIVE_ATH_PRICE_INVALID");
  return refreshAthProfile(service, { productId: run.product_id, tenantId: run.tenant_id,
    userId: run.user_id }, "REAL", run.asset, { price, observedAt: new Date().toISOString() });
}

async function activateQueuedRealProfile(service: Service, run: Run, profile: AthProfileRow) {
  if (profile.next_config_version === null && profile.next_gain_rate === null
    && profile.next_normal_spacing_rate === null && profile.next_post_ath_spacing_rate === null)
    return profile;
  const gain = Number(profile.next_gain_rate ?? profile.gain_rate);
  const normal = Number(profile.next_normal_spacing_rate ?? profile.normal_spacing_rate);
  const post = Number(profile.next_post_ath_spacing_rate ?? profile.post_ath_spacing_rate);
  if ([gain, normal, post].some((rate) => !Number.isFinite(rate) || rate < 0.001 || rate > 0.2))
    throw new Error("COINOPS_LIVE_NEXT_PROFILE_INVALID");
  const version = profile.next_config_version ?? profile.config_version + 1;
  await renewLease(service, run);
  const result = await service.from("robot_v1_ath_profiles").update({ config_version: version,
    gain_rate: gain, normal_spacing_rate: normal, post_ath_spacing_rate: post,
    next_config_version: null, next_gain_rate: null,
    next_normal_spacing_rate: null, next_post_ath_spacing_rate: null,
    updated_at: new Date().toISOString() })
    .eq("id", profile.id).eq("tenant_id", run.tenant_id).eq("user_id", run.user_id)
    .eq("environment", "REAL").eq("asset", run.asset)
    .eq("config_version", profile.config_version).eq("updated_at", profile.updated_at)
    .select("*").maybeSingle();
  if (result.error || !result.data) throw new Error("COINOPS_LIVE_PROFILE_ACTIVATION_FAILED");
  const activated = result.data as AthProfileRow;
  const audit = await service.from("robot_v1_ath_events").upsert({
    profile_id: activated.id, product_id: run.product_id, tenant_id: run.tenant_id,
    user_id: run.user_id, environment: "REAL", asset: run.asset,
    event_key: `STRATEGY_CONFIG_ACTIVATED:${version}`,
    event_type: "STRATEGY_CONFIG_ACTIVATED",
    details: { config_version: version, gain_rate: gain,
      normal_spacing_rate: normal, post_ath_spacing_rate: post },
  }, { onConflict: "profile_id,event_key", ignoreDuplicates: true });
  if (audit.error) throw new Error("COINOPS_LIVE_PROFILE_AUDIT_FAILED");
  return activated;
}

async function applyAthTransition(service: Service, run: Run, ledger: Ledger,
  state: LiveExecutorState) {
  const profile = await refreshRealAthProfile(service, run);
  const period = monthlyPeriodKey(new Date());
  if (run.entry_regime === profile.regime && run.ath_transition_key === profile.transition_key
    && run.ath_period_key === period) return false;
  const active = ledger.orders.find((item) => item.side === "BUY"
    && LIVE_ACTIVE_ORDER_STATUSES.has(item.status));
  if (active) {
    if (active.status === "PREPARED" || amount(active.executed_quantity) > 0)
      throw new Error("COINOPS_LIVE_ATH_BUY_RECONCILIATION_REQUIRED");
    await cancelOwnedEntry(service, run, active);
    const resident = ledger.slots.find((item) => item.id === active.slot_id)!;
    await updateSlot(service, run, resident, { entry_state: "PLANNED" });
  }
  const statuses = await monthly(service, run, ledger.slots, ledger.accounts);
  const decisions = planAthLadder(run.asset, profile.regime, state.price.price,
    { gainRate: amount(run.gain_rate), normalSpacing: amount(profile.normal_spacing_rate),
      postAthSpacing: amount(profile.post_ath_spacing_rate) }, state.filters.priceTick,
    ledger.slots.map((slot) => {
      const status = statuses.find((item) => item.physicalSlotNumber === slot.slot_number)!;
      return { physicalSlotId: status.physicalSlotId, physicalSlotNumber: slot.slot_number,
        lifetimeGainCount: status.lifetimeGainCount, monthlyGainCount: status.monthlyGainCount,
        entryState: slot.entry_state, blocked: Boolean(slot.missed_at),
        status: slot.entry_state === "PLANNED" || slot.entry_state === "ARMED" ? "PENDING"
          : slot.entry_state === "MISSED" ? "CANCELLED" : slot.entry_state,
        buyPrice: amount(slot.target_buy_price), entryOrigin: slot.entry_origin,
        operationSequence: slot.operation_sequence };
    }));
  const prep = await scopedPreparation(service, run.user_id, run.asset);
  for (const item of decisions) {
    const slot = ledger.slots.find((row) => row.slot_number === item.physicalSlotNumber)!;
    if (!item.frozenReason && slot.entry_state === "PLANNED") {
      const account = ledger.accounts.find((row) => row.slot_number === slot.slot_number)!;
      const quantity = floorStep(Math.min(amount(account.balance_brl), amount(prep.max_order_notional_brl))
        / item.nextBuyPrice, state.filters.quantityStep);
      if (quantity < state.filters.minQuantity || quantity > state.filters.maxQuantity
        || quantity * item.nextBuyPrice < state.filters.minNotional)
        throw new Error("COINOPS_LIVE_ATH_FILTER_INVALID");
    }
  }
  for (const item of decisions) {
    const slot = ledger.slots.find((row) => row.slot_number === item.physicalSlotNumber)!;
    await updateSlot(service, run, slot, { operational_rank: item.operationalRank,
      post_ath_group: item.postAthGroup, post_ath_group_rank: item.postAthGroupRank,
      ...(!item.frozenReason && slot.entry_state === "PLANNED"
        ? { target_buy_price: item.nextBuyPrice, entry_reference_price: item.nextBuyPrice } : {}) });
  }
  await renewLease(service, run);
  const result = await service.from("robot_v1_live_runs").update({
    entry_regime: profile.regime, entry_spacing: profile.regime === "POST_ATH"
      ? profile.post_ath_spacing_rate : profile.normal_spacing_rate,
    ath_transition_key: profile.transition_key, ath_period_key: period,
  }).eq("id", run.id).eq("tenant_id", run.tenant_id).eq("lease_owner", run.lease_owner)
    .select("*").single();
  if (result.error || !result.data) throw new Error("COINOPS_LIVE_ATH_TRANSITION_FAILED");
  Object.assign(run, result.data);
  await event(service, run, `ATH_TRANSITION:${profile.transition_key ?? "NORMAL"}:${period}`,
    "ATH_TRANSITION", null, { regime: profile.regime, transition_key: profile.transition_key,
      primary: decisions.filter((item) => item.postAthGroup === "PRIMARY").length,
      reserve: decisions.filter((item) => item.postAthGroup === "RESERVE").length });
  return true;
}

async function restartClosedCycle(service: Service, run: Run, ledger: Ledger,
  state: LiveExecutorState) {
  if (!ledger.orders.some((item) => item.side === "BUY")
    || ledger.slots.some((item) => amount(item.position_quantity) >= state.filters.quantityStep)) return null;
  const statuses = await monthly(service, run, ledger.slots, ledger.accounts);
  const eligible = statuses.some((item) => item.eligibleForNewEntry);
  if (!eligible) return null;
  const closed = ledger.slots.filter((item) => item.entry_state === "CLOSED")
    .sort((a, b) => b.slot_number - a.slot_number)[0];
  if (!closed) throw new Error("COINOPS_LIVE_RESET_CLOSE_MISSING");
  const active = ledger.orders.find((item) => item.side === "BUY"
    && LIVE_ACTIVE_ORDER_STATUSES.has(item.status));
  if (active) {
    if (active.status === "PREPARED") throw new Error("COINOPS_LIVE_RESET_PREPARED_BUY");
    if (amount(active.executed_quantity) > 0) throw new Error("COINOPS_LIVE_RESET_PARTIAL_BUY");
    await cancelOwnedEntry(service, run, active);
    const oldSlot = ledger.slots.find((item) => item.id === active.slot_id)!;
    await updateSlot(service, run, oldSlot, { entry_state: "PLANNED" });
  }
  const latest = await runRows(service, run);
  if (latest.orders.some((item) => LIVE_ACTIVE_ORDER_STATUSES.has(item.status))
    || latest.slots.some((item) => amount(item.position_quantity) > 0))
    throw new Error("COINOPS_LIVE_RESET_OLD_ORDERS_ACTIVE");
  const profile = await activateQueuedRealProfile(service, run,
    await refreshRealAthProfile(service, run));
  const gain = amount(profile.gain_rate);
  const spacing = amount(profile.regime === "POST_ATH"
    ? profile.post_ath_spacing_rate : profile.normal_spacing_rate);
  const planned = planAthLadder(run.asset, profile.regime, state.price.price,
    { gainRate: gain, normalSpacing: amount(profile.normal_spacing_rate),
      postAthSpacing: amount(profile.post_ath_spacing_rate) }, state.filters.priceTick,
    latest.slots.map((slot) => {
      const month = statuses.find((item) => item.physicalSlotNumber === slot.slot_number)!;
      return { physicalSlotId: month.physicalSlotId, physicalSlotNumber: slot.slot_number,
        lifetimeGainCount: month.lifetimeGainCount, monthlyGainCount: month.monthlyGainCount,
        entryState: "PLANNED", status: "PENDING", buyPrice: amount(slot.target_buy_price),
        entryOrigin: "GRID" as const, operationSequence: 1 };
    }));
  const accounts = new Map(latest.accounts.map((item) => [item.slot_number, item]));
  const prep = await scopedPreparation(service, run.user_id, run.asset);
  for (const item of planned.filter((item) => item.operationalRank !== null)) {
    const balance = amount(accounts.get(item.physicalSlotNumber)?.balance_brl);
    const quantity = floorStep(Math.min(balance, amount(prep.max_order_notional_brl))
      / item.nextBuyPrice, state.filters.quantityStep);
    if (quantity < state.filters.minQuantity || quantity * item.nextBuyPrice < state.filters.minNotional)
      throw new Error("COINOPS_LIVE_RESET_FILTER_INVALID");
  }
  const candidates = latest.slots.map((slot) => {
    const account = accounts.get(slot.slot_number)!;
    const rank = statuses.find((item) => item.physicalSlotNumber === slot.slot_number)!;
    return candidate(slot, account, rank.operationalRank, rank.monthlyTargetReached);
  });
  const plan = planStrategyClosedSlot(context(run), candidates, closed.id);
  if (plan.mode !== "GLOBAL_RESET") throw new Error("COINOPS_LIVE_RESET_STRATEGY_MISMATCH");
  for (const decision of plan.decisions) {
    await persistStrategyDecision(service, owned(run), "REAL", decision, closed.operation_sequence);
    await dispatchStrategyDecision(service, owned(run), "REAL", decision.decision_id);
  }
  const resetKey = `RESET:${run.id}:${closed.last_credited_sell_client_order_id ?? closed.id}`;
  const snapshot = { gain_rate: gain, normal_spacing_rate: amount(profile.normal_spacing_rate),
    post_ath_spacing_rate: amount(profile.post_ath_spacing_rate), regime: profile.regime,
    ath_price: profile.ath_price, ath_source: profile.ath_source };
  await renewLease(service, run);
  const result = await service.rpc("restart_robot_v1_live_cycle", {
    p_old_run_id: run.id, p_reset_key: resetKey, p_anchor_price: state.price.price,
    p_gain_rate: gain, p_entry_spacing: spacing, p_regime: profile.regime,
    p_config_version: profile.config_version, p_config_snapshot: snapshot,
    p_transition_key: profile.transition_key, p_period_key: monthlyPeriodKey(new Date()),
    p_plans: planned.map((item) => ({ slot_number: item.physicalSlotNumber,
      target_buy_price: item.nextBuyPrice, operational_rank: item.operationalRank,
      post_ath_group: item.postAthGroup, post_ath_group_rank: item.postAthGroupRank })),
    p_lease_owner: run.lease_owner,
  });
  const successor = (Array.isArray(result.data) ? result.data[0] : result.data) as Run | null;
  if (result.error || !successor || successor.previous_run_id !== run.id)
    throw new Error("COINOPS_LIVE_RESET_FAILED");
  for (const decision of plan.decisions) await completeStrategyDecision(service, owned(run),
    "REAL", decision.decision_id, { next_cycle_id: successor.id, state: "COMPLETED" });
  return successor.id;
}

async function assertAllPositionsProtected(run: Run, ledger: Ledger,
  state: LiveExecutorState) {
  for (const slot of ledger.slots.filter((item) => amount(item.position_quantity) >= state.filters.quantityStep)) {
    const orders = operationOrders(ledger.orders, slot);
    const activeTp = orders.filter((item) => item.side === "SELL"
      && ["NEW", "PARTIALLY_FILLED"].includes(item.status));
    if (activeTp.length !== 1 || liveUncoveredQuantity(orders, state.filters.quantityStep) > 0)
      throw new Error("COINOPS_LIVE_OPEN_WITHOUT_RESIDENT_TP");
  }
  await assertExchangeMatchesLedger(run, ledger.orders, state);
}

async function armNextEntry(service: Service, run: Run, ledger: Ledger,
  state: LiveExecutorState) {
  const prep = await scopedPreparation(service, run.user_id, run.asset);
  if (!prep.live_enabled || prep.kill_switch) return "KILL_SWITCH";
  if ((await loadLiveExecutorStatus()).gate !== "LIVE_EXECUTOR_ACTIVE")
    return "EXECUTOR_NOT_ACTIVE";
  const global = await service.from("robot_v1_live_global_caps")
    .select("max_total_live_exposure_brl").eq("product_id", run.product_id)
    .eq("tenant_id", run.tenant_id).eq("user_id", run.user_id).single();
  if (global.error || !global.data) throw new Error("COINOPS_LIVE_GLOBAL_CAP_UNAVAILABLE");
  const deployed = await exposure(service, run);
  const spendable = (balance: number, reclaimed = 0) => Math.max(0, Math.min(balance,
    amount(prep.max_order_notional_brl), amount(prep.max_total_exposure_brl) - deployed[run.asset] + reclaimed,
    amount(global.data.max_total_live_exposure_brl) - deployed.global + reclaimed));
  const status = await monthly(service, run, ledger.slots, ledger.accounts);
  const ranks = new Map(status.map((item) => [item.physicalSlotNumber, item]));
  const activeBuys = ledger.orders.filter((item) => item.side === "BUY"
    && LIVE_ACTIVE_ORDER_STATUSES.has(item.status));
  if (activeBuys.length > 1) throw new Error("COINOPS_LIVE_DUPLICATE_ACTIVE_BUY");
  const first = !ledger.orders.some((item) => item.side === "BUY");
  if (first) {
    const selected = ledger.slots.filter((item) => ranks.get(item.slot_number)?.eligibleForNewEntry)
      .sort((a, b) => amount(a.operational_rank) - amount(b.operational_rank))[0];
    if (!selected || selected.operational_rank !== 1) throw new Error("COINOPS_LIVE_INITIAL_RANK_INVALID");
    const account = ledger.accounts.find((item) => item.slot_number === selected.slot_number)!;
    const quote = Number(spendable(amount(account.balance_brl)).toFixed(8));
    if (quote < state.filters.minNotional) return "CAPACITY_HOLD";
    const decision = planStrategyInitialEntry(context(run),
      { ...candidate(selected, account, selected.operational_rank, false), balanceQuote: quote });
    if (decision.action_type !== "OPEN_INITIAL_MARKET") throw new Error("COINOPS_LIVE_INITIAL_DECISION_INVALID");
    const order = await prepareOrder(service, run, selected, decision, "BUY", "INITIAL", 1,
      null, quote, null);
    ledger.orders.push(order);
    await updateSlot(service, run, selected, { entry_state: "ARMED" });
    await reconcileOrder(service, run, order);
    return "INITIAL_SUBMITTED";
  }
  const active = activeBuys[0];
  if (active && amount(active.executed_quantity) > 0) return "BUY_PARTIAL";
  const candidates = ledger.slots.map((slot) => {
    const account = ledger.accounts.find((row) => row.slot_number === slot.slot_number)!;
    const rank = ranks.get(slot.slot_number)!;
    const value = { ...candidate(slot, account, rank.operationalRank, rank.monthlyTargetReached),
      balanceQuote: Math.min(amount(account.balance_brl), amount(prep.max_order_notional_brl)) };
    if (active?.slot_id === slot.id) value.state = "ARMED";
    return value;
  });
  const contextKey = `QUEUE:${ledger.orders.filter((item) => item.side === "BUY").length}`;
  const observedFloor = state.price.price;
  const resident = active ? { candidateId: active.slot_id, executedQuantity: amount(active.executed_quantity) } : null;
  const planned = run.entry_regime === "POST_ATH"
    ? planStrategyPostAthNextEntry(context(run, contextKey), candidates, observedFloor, resident)
    : planStrategyNextEntry(context(run, contextKey), candidates, observedFloor, resident);
  for (const missedId of planned.missedCandidateIds) {
    const slot = ledger.slots.find((item) => item.id === missedId)!;
    if (slot.missed_at) continue;
    await updateSlot(service, run, slot, { entry_state: "MISSED", missed_at: new Date().toISOString() });
    await event(service, run, `MISSED:${slot.id}:${slot.operation_sequence}`,
      "MISSED_LEVEL", slot.slot_number,
      { target_price: amount(slot.target_buy_price), observed_floor: observedFloor,
        reason: "NO_RESIDENT_BUY_AT_OBSERVATION" });
  }
  if (planned.decision.action_type === "WAIT") return planned.decision.reason;
  const selected = ledger.slots.find((item) => item.id === planned.nextCandidateId);
  if (!selected) throw new Error("COINOPS_LIVE_NEXT_SLOT_MISSING");
  await persistStrategyDecision(service, owned(run), "REAL", planned.decision,
    selected.operation_sequence);
  if (active) {
    if (active.status === "PREPARED") throw new Error("COINOPS_LIVE_PREPARED_BUY_UNRESOLVED");
    await cancelOwnedEntry(service, run, active);
    const previous = ledger.slots.find((item) => item.id === active.slot_id)!;
    await updateSlot(service, run, previous, { entry_state: "PLANNED" });
  }
  const reclaimed = active ? Math.max(0, amount(active.reserved_notional_brl) - amount(active.cumulative_quote)) : 0;
  const quantity = floorStep(spendable(amount(ledger.accounts.find((item) => item.slot_number === selected.slot_number)!.balance_brl), reclaimed)
    / amount(selected.target_buy_price), state.filters.quantityStep);
  if (quantity * amount(selected.target_buy_price) < state.filters.minNotional) return "CAPACITY_HOLD";
  if (quantity < state.filters.minQuantity || quantity > state.filters.maxQuantity)
    throw new Error("COINOPS_LIVE_NEXT_ENTRY_FILTER_INVALID");
  const revision = Math.max(0, ...ledger.orders.filter((item) => item.slot_id === selected.id
    && item.side === "BUY").map((item) => item.revision)) + 1;
  const order = await prepareOrder(service, run, selected, planned.decision, "BUY", "ENTRY",
    revision, quantity, null, amount(selected.target_buy_price));
  ledger.orders.push(order);
  await updateSlot(service, run, selected, { entry_state: "ARMED" });
  await reconcileOrder(service, run, order);
  return "NEXT_BUY_ARMED";
}

/** Reconcile first, protect every OPEN fill, then consider exactly one BUY. */
export async function advanceLiveRun(runId: string, source = "LIVE_CRON") {
  assertScope();
  const service = createServiceRoleClient();
  const run = await claim(service, runId);
  if (!run) return { status: "BUSY_OR_INACTIVE" };
  let errorCode: string | null = null;
  try {
    if (run.symbol !== `${run.asset}BRL` || run.strategy_version !== STRATEGY_VERSION)
      throw new Error("COINOPS_LIVE_RUN_IDENTITY_INVALID");
    let ledger = await runRows(service, run);
    for (const order of ledger.orders) await reconcileOrder(service, run, order);
    ledger = await runRows(service, run);
    let state = await readLiveExecutorState(run.symbol);
    await ensureTakeProfits(service, run, ledger, state);
    state = await readLiveExecutorState(run.symbol);
    await creditClosedSlots(service, run, ledger, state);
    const refreshed = await runRows(service, run);
    await recycleClosedSlots(service, run, refreshed);
    const current = await runRows(service, run);
    state = await readLiveExecutorState(run.symbol);
    await assertAllPositionsProtected(run, current, state);
    const successor = await restartClosedCycle(service, run, current, state);
    if (successor) return { status: "RESTARTED", nextRunId: successor };
    await applyAthTransition(service, run, current, state);
    const entered = await runRows(service, run);
    state = await readLiveExecutorState(run.symbol);
    const next = await armNextEntry(service, run, entered, state);
    // A MARKET can fill in the same invocation. Protect it before returning.
    if (next === "INITIAL_SUBMITTED" || next === "NEXT_BUY_ARMED") {
      const after = await runRows(service, run);
      state = await readLiveExecutorState(run.symbol);
      await ensureTakeProfits(service, run, after, state);
      state = await readLiveExecutorState(run.symbol);
      await assertAllPositionsProtected(run, after, state);
    }
    await event(service, run, `RECONCILED:${new Date().toISOString().slice(0, 16)}`,
      "RECONCILED", null, { source, next, strategy_version: STRATEGY_VERSION });
    return { status: "OK", next };
  } catch (error) {
    errorCode = error instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_LIVE_RECONCILIATION_FAILED";
    await preventNewBuys(service, run, errorCode);
    throw new Error(errorCode);
  } finally {
    await release(service, run, errorCode);
  }
}

/** Six-hour audit reuses the same ledger/reconciliation invariants. It never
 * creates or cancels orders; critical findings turn off new BUYs in SQL. */
export async function auditLiveRun(runId: string) {
  assertScope();
  const service = createServiceRoleClient();
  const lookup = await service.from("robot_v1_live_runs").select("*").eq("id", runId)
    .eq("tenant_id", getCoinOpsServiceTenantId()).single();
  if (lookup.error || !lookup.data) throw new Error("COINOPS_LIVE_MONITOR_RUN_UNAVAILABLE");
  const run = lookup.data as Run;
  if (run.status !== "ACTIVE" && run.status !== "PAUSED") return { status: "INACTIVE" };
  if (run.lease_until && Date.parse(run.lease_until) > Date.now()) return { status: "LEASE_BUSY" };
  try {
    const health = await loadLiveExecutorStatus();
    if (!health.health?.healthy || !["LIVE_EXECUTOR_ACTIVE", "LIVE_EXECUTOR_PROTECTED"].includes(health.gate))
      throw new Error("COINOPS_LIVE_MONITOR_EXECUTOR_UNHEALTHY");
    const ledger = await runRows(service, run);
    const state = await readLiveExecutorState(run.symbol);
    await assertAllPositionsProtected(run, ledger, state);
    if (ledger.orders.some((order) => LIVE_TERMINAL_ORDER_STATUSES.has(order.status)
      && !order.trades_reconciled))
      throw new Error("COINOPS_LIVE_MONITOR_UNRECONCILED_FILL");
    await monthly(service, run, ledger.slots, ledger.accounts);
    await exposure(service, run);
    for (const account of ledger.accounts) {
      const expected = amount(account.contribution_brl) + amount(account.market_pnl_brl)
        + amount(account.manual_gain_brl) - amount(account.fees_brl) - amount(account.dust_cost_brl);
      if (Math.abs(expected - amount(account.balance_brl)) > 0.00000001)
        throw new Error("COINOPS_LIVE_MONITOR_BALANCE_MISMATCH");
    }
    const ownBuys = ledger.orders.filter((item) => item.side === "BUY"
      && LIVE_ACTIVE_ORDER_STATUSES.has(item.status));
    if (ownBuys.length > 1) throw new Error("COINOPS_LIVE_MONITOR_DUPLICATE_BUY");
    if (run.last_error || !run.last_reconciled_at
      || Date.now() - Date.parse(run.last_reconciled_at) > 10 * 60_000)
      throw new Error("COINOPS_LIVE_MONITOR_RECONCILIATION_STALE");
    const prep = await scopedPreparation(service, run.user_id, run.asset);
    if (prep.live_enabled && !prep.kill_switch && health.gate !== "LIVE_EXECUTOR_ACTIVE")
      throw new Error("COINOPS_LIVE_MONITOR_FLAGS_DIVERGED");
    await event(service, run, `MONITOR:${new Date().toISOString().slice(0, 13)}`,
      "LIVE_MONITOR_PASS", null, { own_open_orders: state.open_orders.filter((item) =>
        item.clientOrderId?.startsWith(`COR1-${run.asset}-`)).length,
        open_positions: ledger.slots.filter((item) => item.entry_state === "OPEN").length,
        active_buy_count: ownBuys.length, slot_count: ledger.slots.length });
    return { status: "PASS", asset: run.asset, openPositions: ledger.slots.filter((item) =>
      item.entry_state === "OPEN").length, activeBuyCount: ownBuys.length };
  } catch (error) {
    const code = error instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_LIVE_MONITOR_FAILED";
    await preventNewBuys(service, run, code);
    return { status: "CRITICAL", asset: run.asset, code };
  }
}

/** Stages the 25-slot BRL cycle while both kill switches remain ON. */
export async function prepareLiveCycle(userId: string, asset: V1Asset) {
  assertScope();
  const service = createServiceRoleClient();
  const prep = await scopedPreparation(service, userId, asset);
  if (prep.live_enabled || !prep.kill_switch) throw new Error("COINOPS_LIVE_PREPARATION_FLAGS_INVALID");
  const existing = await service.from("robot_v1_live_runs").select("*")
    .eq("product_id", prep.product_id).eq("tenant_id", prep.tenant_id).eq("user_id", prep.user_id)
    .eq("asset", asset).in("status", ["PREPARING", "ACTIVE", "PAUSED"]).maybeSingle();
  if (existing.error) throw new Error("COINOPS_LIVE_RUN_LOOKUP_FAILED");
  if (existing.data && existing.data.status !== "PREPARING") return existing.data.id as string;
  const profile = await loadAthProfile(service, { productId: prep.product_id,
    tenantId: prep.tenant_id, userId }, "REAL", asset);
  const state = await readLiveExecutorState(prep.symbol);
  const rules = await publicRules(prep.symbol);
  const global = await service.from("robot_v1_live_global_caps").select("max_total_live_exposure_brl")
    .eq("product_id", prep.product_id).eq("tenant_id", prep.tenant_id)
    .eq("user_id", prep.user_id).single();
  if (global.error || !global.data) throw new Error("COINOPS_LIVE_GLOBAL_CAP_UNAVAILABLE");
  const config: LiveConfig = { ...prep, gain_rate: profile.gain_rate,
    normal_spacing_rate: profile.normal_spacing_rate, post_ath_spacing_rate: profile.post_ath_spacing_rate,
    regime: profile.regime, updated_at: profile.updated_at };
  const anchor = existing.data ? amount(existing.data.anchor_price) : state.price.price;
  const sizing = buildLiveSizing(rules, anchor, config,
    amount(global.data.max_total_live_exposure_brl), state.price.observedAt);
  const brlFree = state.balances.find((row) => row.asset === "BRL")?.free;
  if (sizing.validSlots !== 25 || sizing.dryRun.strategyVersion !== STRATEGY_VERSION
    || brlFree === undefined || brlFree < sizing.configuredCapitalBrl
    || state.open_orders.some((order) => order.clientOrderId?.startsWith(`COR1-${asset}-`)))
    throw new Error("COINOPS_LIVE_PREPARATION_GATE_FAILED");
  const snapshot = { gain_rate: Number(profile.gain_rate), normal_spacing_rate: Number(profile.normal_spacing_rate),
    post_ath_spacing_rate: Number(profile.post_ath_spacing_rate), regime: profile.regime,
    ath_price: profile.ath_price, ath_source: profile.ath_source };
  const inserted = existing.data ? { data: existing.data, error: null }
    : await service.from("robot_v1_live_runs").insert({
    product_id: prep.product_id, tenant_id: prep.tenant_id, user_id: prep.user_id,
    asset, symbol: prep.symbol, status: "PREPARING", anchor_price: anchor,
    slot_notional_brl: sizing.configuredCapitalBrl / 25,
    gain_rate: profile.gain_rate, entry_spacing: profile.regime === "POST_ATH"
      ? profile.post_ath_spacing_rate : profile.normal_spacing_rate,
    entry_regime: profile.regime, config_version: profile.config_version,
    config_snapshot: snapshot, strategy_version: STRATEGY_VERSION,
    ath_transition_key: profile.transition_key, ath_period_key: monthlyPeriodKey(new Date()) })
    .select("*").single();
  if (inserted.error || !inserted.data) throw new Error("COINOPS_LIVE_RUN_CREATE_FAILED");
  const run = inserted.data as Run;
  if (run.asset !== asset || run.symbol !== prep.symbol || run.status !== "PREPARING"
    || amount(run.slot_notional_brl) !== sizing.configuredCapitalBrl / 25
    || run.config_version !== profile.config_version || run.strategy_version !== STRATEGY_VERSION)
    throw new Error("COINOPS_LIVE_PREPARATION_RECOVERY_MISMATCH");
  const payload = sizing.slots.map((slot) => ({ run_id: run.id, ...owned(run),
    slot_number: slot.physicalSlotNumber, target_buy_price: slot.entryPriceBrl,
    entry_reference_price: slot.entryPriceBrl, operational_rank: slot.operationalRank,
    post_ath_group: slot.postAthGroup,
    post_ath_group_rank: slot.postAthGroupRank }));
  const slots = await service.from("robot_v1_live_slots").upsert(payload,
    { onConflict: "run_id,slot_number", ignoreDuplicates: true });
  if (slots.error) throw new Error("COINOPS_LIVE_PLAN_CREATE_FAILED");
  const savedSlots = await service.from("robot_v1_live_slots").select("slot_number,target_buy_price,operational_rank")
    .eq("run_id", run.id).eq("tenant_id", run.tenant_id);
  if (savedSlots.error || savedSlots.data?.length !== 25
    || savedSlots.data.some((saved) => { const planned = payload.find((item) => item.slot_number === saved.slot_number);
      return !planned || amount(saved.target_buy_price) !== planned.target_buy_price
        || saved.operational_rank !== planned.operational_rank; }))
    throw new Error("COINOPS_LIVE_PLAN_RECOVERY_MISMATCH");
  for (let number = 1; number <= 25; number++) {
    const account = await service.from("robot_v1_live_slot_accounts").update({
      contribution_brl: sizing.configuredCapitalBrl / 25,
      balance_brl: sizing.configuredCapitalBrl / 25,
    }).eq("product_id", run.product_id).eq("tenant_id", run.tenant_id)
      .eq("user_id", run.user_id).eq("asset", asset).eq("slot_number", number)
      .eq("balance_brl", 0).eq("contribution_brl", 0).select("slot_number").maybeSingle();
    if (account.error) throw new Error("COINOPS_LIVE_ACCOUNT_SEED_FAILED");
    if (!account.data) {
      const prior = await service.from("robot_v1_live_slot_accounts").select("balance_brl,contribution_brl")
        .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id)
        .eq("user_id", run.user_id).eq("asset", asset).eq("slot_number", number).single();
      if (prior.error || amount(prior.data?.balance_brl) !== sizing.configuredCapitalBrl / 25
        || amount(prior.data?.contribution_brl) !== sizing.configuredCapitalBrl / 25)
        throw new Error("COINOPS_LIVE_ACCOUNT_RECOVERY_MISMATCH");
    }
  }
  await event(service, run, "RUN_PREPARED", "RUN_PREPARED", null,
    { symbol: run.symbol, capital_brl: sizing.configuredCapitalBrl, slot_count: 25,
      config_version: run.config_version, strategy_version: STRATEGY_VERSION });
  return run.id;
}
