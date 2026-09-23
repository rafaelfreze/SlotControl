import { randomUUID } from "node:crypto";

import { BinanceSpotTestnetAdapter, type TestnetOrder, type TestnetTrade } from "./binance-spot-testnet-adapter";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "../supabase/env";
import { createServiceRoleClient } from "../supabase/service-role";
import { testnetFillEvents } from "../coinops-reports/testnet-fill-evidence";
import { planTerminalTestnetRestart, TESTNET_ACTIVE_ORDER_STATUSES, testnetClientOrderId, testnetOpenPositionQuantity, testnetResetIdempotencyKey } from "./robot-v1-testnet-cycle";
import { buildV1Grid, V1_RULES, V1_TEST_PROFILE, type V1Asset, type V1Symbol } from "./robot-v1";
import { STRATEGY_VERSION, planStrategyClosedSlot, planStrategyInitialEntry, planStrategyNextEntry, planStrategyTakeProfit, type StrategyCandidate, type StrategyDecision } from "./strategy-engine";
import { persistStrategyDecision, dispatchStrategyDecision, completeStrategyDecision, failStrategyDecision } from "./strategy-decision-server";
import { projectTestnetEntryState, recoverTestnetStrategyDecisions, type RecoverableTestnetDecision } from "./strategy-testnet-recovery";
import { loadMonthlySlotStatuses } from "./monthly-slot-server";
import type { MonthlySlotStatus } from "./monthly-slot-policy";
import type { ExchangeSymbolInfo } from "./types";

type Scope = { productId: string; tenantId: string; userId: string };
type Service = ReturnType<typeof createServiceRoleClient>;
type Run = { id: string; product_id: string; tenant_id: string; user_id: string; asset: V1Asset; status: string; symbol: V1Symbol; anchor_price: number | string; slot_notional_usdc: number | string; gain_rate: number | string; entry_spacing: number | string; next_capital_usdc: number | string | null; next_gain_rate: number | string | null; next_entry_spacing: number | string | null; lease_owner: string | null; lease_until: string | null; previous_run_id: string | null; reset_started_at: string | null; reset_completed_at: string | null; recovery_source: string | null };
type Slot = { id: string; run_id: string; slot_number: number; entry_state: string; target_buy_price: number | string; balance_usdc: number | string; gain_count: number; net_profit_usdc: number | string; missed_at: string | null; operation_sequence: number; entry_origin: "GRID" | "REENTRY"; entry_reference_price: number | string; last_take_profit_price: number | string | null; last_credited_sell_client_order_id: string | null };
type Order = ReturnType<typeof owned> & { id: string; run_id: string; slot_id: string; slot_number: number; side: "BUY" | "SELL"; purpose: "INITIAL" | "ENTRY" | "TP"; revision: number; operation_sequence: number; client_order_id: string; exchange_order_id: string | null; status: string; requested_quantity: number | string | null; requested_quote: number | string | null; price: number | string | null; executed_quantity: number | string; cumulative_quote: number | string; fee_base: number | string; fee_quote: number | string; fee_other: Array<{ asset: string; amount: number }>; trades_reconciled: boolean };
type SymbolFilters = ExchangeSymbolInfo;

const ACTIVE_ORDER = TESTNET_ACTIVE_ORDER_STATUSES;
const terminal = new Set(["FILLED", "CANCELED", "EXPIRED", "REJECTED"]);
const amount = (value: number | string | null) => Number(value || 0);
const rounded = (value: number) => Number(value.toFixed(8));
const floorStep = (value: number, step: number) => rounded(Math.floor((value + 1e-10) / step) * step);
const owned = (run: Run) => ({ product_id: run.product_id, tenant_id: run.tenant_id, user_id: run.user_id });
const context = (run: Run) => ({ asset: run.asset, cycleId: run.id, observedAt: new Date().toISOString() });
function candidate(slot: Slot, monthly?: MonthlySlotStatus): StrategyCandidate {
  return { id: slot.id, slotNumber: slot.slot_number, operationSequence: slot.operation_sequence,
    buyPrice: amount(slot.target_buy_price), balanceUsdc: amount(slot.balance_usdc),
    operationalRank: monthly?.operationalRank, monthlyTargetReached: monthly?.monthlyTargetReached,
    state: slot.missed_at ? "MISSED" : ["OPEN", "CLOSED", "ARMED"].includes(slot.entry_state) ? slot.entry_state as "OPEN" | "CLOSED" | "ARMED" : "PLANNED" };
}
function candidatesWithFills(slots: Slot[], orders: Order[], monthly: readonly MonthlySlotStatus[]) {
  return slots.map((slot) => ({ ...candidate(slot, monthly.find((status) => status.physicalSlotNumber === slot.slot_number)), ...(orders.some((order) => order.slot_id === slot.id
    && order.operation_sequence === slot.operation_sequence && order.side === "BUY"
    && ACTIVE_ORDER.has(order.status) && amount(order.executed_quantity) > 0) ? { state: "PARTIALLY_FILLED" as const } : {}) }));
}
async function intent(service: Service, run: Run, decision: StrategyDecision, sequence?: number) {
  await persistStrategyDecision(service, owned(run), "TESTNET", decision, sequence);
  return decision.decision_id;
}

function assertTestnetEnvironment() {
  if (getSupabaseDataSchema() !== "coinops" || !getCoinOpsServiceTenantId()) throw new Error("COINOPS_TESTNET_SCHEMA_SCOPE_INVALID");
  if (process.env.COINOPS_TESTNET_ENABLED !== "true") throw new Error("COINOPS_TESTNET_DISABLED");
}

async function queryRun(service: Service, runId: string): Promise<Run> {
  const tenantId = getCoinOpsServiceTenantId();
  const { data, error } = await service.from("robot_v1_testnet_runs").select("*").eq("id", runId).eq("tenant_id", tenantId).single();
  if (error || !data) throw new Error("COINOPS_TESTNET_RUN_UNAVAILABLE");
  if (V1_RULES[data.asset as V1Asset]?.symbol !== data.symbol) throw new Error("COINOPS_TESTNET_RUN_SYMBOL_INVALID");
  return data as Run;
}

async function rows(service: Service, run: Run) {
  const [slotResult, orderResult] = await Promise.all([
    service.from("robot_v1_testnet_slots").select("*").eq("run_id", run.id).eq("tenant_id", run.tenant_id).order("slot_number"),
    service.from("robot_v1_testnet_orders").select("*").eq("run_id", run.id).eq("tenant_id", run.tenant_id).order("created_at")
  ]);
  if (slotResult.error || orderResult.error) throw new Error("COINOPS_TESTNET_LEDGER_UNAVAILABLE");
  return { slots: (slotResult.data || []) as Slot[], orders: (orderResult.data || []) as Order[] };
}

async function event(service: Service, run: Run, key: string, type: string, slotNumber: number | null, details: Record<string, string | number | boolean | null> = {}) {
  const { error } = await service.from("robot_v1_testnet_events").upsert({ run_id: run.id, ...owned(run), event_key: key, event_type: type, slot_number: slotNumber, details }, { onConflict: "run_id,event_key", ignoreDuplicates: true });
  if (error) throw new Error("COINOPS_TESTNET_EVENT_PERSIST_FAILED");
}

async function updateOrder(service: Service, run: Run, order: Order, values: Record<string, unknown>) {
  const { error } = await service.from("robot_v1_testnet_orders").update(values).eq("id", order.id).eq("run_id", run.id).eq("tenant_id", run.tenant_id);
  if (error) throw new Error("COINOPS_TESTNET_ORDER_PERSIST_FAILED");
  Object.assign(order, values);
}

async function updateSlot(service: Service, run: Run, slot: Slot, values: Record<string, unknown>) {
  const { error } = await service.from("robot_v1_testnet_slots").update(values).eq("id", slot.id).eq("run_id", run.id).eq("tenant_id", run.tenant_id);
  if (error) throw new Error("COINOPS_TESTNET_SLOT_PERSIST_FAILED");
  Object.assign(slot, values);
}

async function prepareOrder(service: Service, run: Run, slot: Slot, side: "BUY" | "SELL", purpose: Order["purpose"], revision: number, requestedQuantity: number | null, requestedQuote: number | null, price: number | null, decisionId?: string): Promise<Order> {
  const id = testnetClientOrderId(run.id, run.asset, slot.slot_number, side, revision);
  const { data, error } = await service.from("robot_v1_testnet_orders").upsert({
    run_id: run.id, slot_id: slot.id, ...owned(run), slot_number: slot.slot_number, side, purpose, revision,
    operation_sequence: slot.operation_sequence, client_order_id: id, requested_quantity: requestedQuantity, requested_quote: requestedQuote, price, strategy_decision_id: decisionId ?? null
  }, { onConflict: "client_order_id", ignoreDuplicates: true }).select("*").maybeSingle();
  if (error) throw new Error("COINOPS_TESTNET_ORDER_PREPARE_FAILED");
  const validateIdentity = (order: Order) => {
    if (order.product_id !== run.product_id || order.tenant_id !== run.tenant_id || order.user_id !== run.user_id
      || order.run_id !== run.id || order.slot_id !== slot.id || order.slot_number !== slot.slot_number
      || order.side !== side || order.purpose !== purpose || order.revision !== revision
      || order.operation_sequence !== slot.operation_sequence || order.client_order_id !== id
      || amount(order.requested_quantity) !== amount(requestedQuantity)
      || amount(order.requested_quote) !== amount(requestedQuote) || amount(order.price) !== amount(price)) {
      throw new Error("COINOPS_TESTNET_ORDER_IDENTITY_COLLISION");
    }
    return order;
  };
  if (data) return validateIdentity(data as Order);
  const { data: existing, error: existingError } = await service.from("robot_v1_testnet_orders").select("*").eq("client_order_id", id).eq("run_id", run.id).eq("tenant_id", run.tenant_id).single();
  if (existingError || !existing) throw new Error("COINOPS_TESTNET_ORDER_PREPARE_UNKNOWN");
  return validateIdentity(existing as Order);
}

async function claim(service: Service, runId: string) {
  const leaseOwner = randomUUID();
  const now = new Date();
  const until = new Date(now.getTime() + 90_000).toISOString();
  const { data, error } = await service.from("robot_v1_testnet_runs").update({ lease_owner: leaseOwner, lease_until: until })
    .eq("id", runId).eq("tenant_id", getCoinOpsServiceTenantId()).eq("status", "ACTIVE")
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`).select("*").maybeSingle();
  if (error) throw new Error("COINOPS_TESTNET_LEASE_FAILED");
  return data ? { run: data as Run, leaseOwner } : null;
}

async function release(service: Service, run: Run, leaseOwner: string, error: string | null) {
  const result = await service.from("robot_v1_testnet_runs").update({ lease_owner: null, lease_until: null, last_reconciled_at: new Date().toISOString(), last_error: error,
    ...(error ? {} : { strategy_version: STRATEGY_VERSION }) })
    .eq("id", run.id).eq("tenant_id", run.tenant_id).eq("lease_owner", leaseOwner);
  if (result.error) throw new Error("COINOPS_TESTNET_LEASE_RELEASE_FAILED");
}

async function ensurePlan(service: Service, run: Run, filters: SymbolFilters) {
  const slotPayload = Array.from({ length: 25 }, (_, index) => {
    const target = floorStep(amount(run.anchor_price) * Math.pow(1 - amount(run.entry_spacing), index), filters.priceTick);
    return {
      run_id: run.id, ...owned(run), slot_number: index + 1,
      target_buy_price: target, entry_reference_price: target,
      balance_usdc: amount(run.slot_notional_usdc)
    };
  });
  const { error } = await service.from("robot_v1_testnet_slots").upsert(slotPayload, { onConflict: "run_id,slot_number", ignoreDuplicates: true });
  if (error) throw new Error("COINOPS_TESTNET_PLAN_CREATE_FAILED");
}

/** Starts a separate fictitious-money cycle. Shadow configuration is read, never changed. */
export async function startTestnetRun(userId: string, asset: V1Asset) {
  assertTestnetEnvironment();
  if (asset !== "BTC" && asset !== "SOL") throw new Error("COINOPS_TESTNET_ASSET_INVALID");
  const symbol = V1_RULES[asset].symbol;
  const service = createServiceRoleClient();
  const tenantId = getCoinOpsServiceTenantId();
  const { data: strategy, error: scopeError } = await service.from("strategies").select("product_id,tenant_id,user_id").eq("tenant_id", tenantId).eq("user_id", userId).limit(1).maybeSingle();
  if (scopeError || !strategy) throw new Error("COINOPS_TESTNET_SCOPE_UNAVAILABLE");
  const scope: Scope = { productId: strategy.product_id, tenantId: strategy.tenant_id, userId: strategy.user_id };
  const { data: active, error: activeError } = await service.from("robot_v1_testnet_runs").select("id").eq("product_id", scope.productId).eq("tenant_id", scope.tenantId).eq("user_id", scope.userId).eq("asset", asset).in("status", ["ACTIVE", "PAUSED"]).maybeSingle();
  if (activeError) throw new Error("COINOPS_TESTNET_RUN_LOOKUP_FAILED");
  if (active) {
    const run = await queryRun(service, active.id);
    const adapter = BinanceSpotTestnetAdapter.fromEnvironment();
    await ensurePlan(service, run, await adapter.reads.getSymbolInfo(run.symbol));
    await advanceTestnetRun(active.id, "MANUAL_START_RECOVERY");
    return active.id as string;
  }
  const { data: config, error: configError } = await service.from("robot_v1_configs").select("slot_count,execution_mode").eq("product_id", scope.productId).eq("tenant_id", scope.tenantId).eq("user_id", scope.userId).eq("asset", asset).single();
  if (configError || !config || config.execution_mode !== "SHADOW" || config.slot_count !== 25) throw new Error("COINOPS_TESTNET_SHADOW_CONFIG_REQUIRED");
  const adapter = BinanceSpotTestnetAdapter.fromEnvironment();
  const [account, filters, market, openOrders] = await Promise.all([adapter.reads.getAccount(), adapter.reads.getSymbolInfo(symbol), adapter.reads.getMarketPrice(symbol), adapter.reads.getOpenOrders(symbol)]);
  const notional = V1_TEST_PROFILE.capitalUsdc / V1_TEST_PROFILE.slotCount;
  buildV1Grid(asset, V1_TEST_PROFILE.capitalUsdc, market.price, filters, { gainRate: V1_TEST_PROFILE.gainRate, entrySpacing: V1_TEST_PROFILE.entrySpacing });
  const tradePermission = await adapter.checkTradePermission(symbol);
  if (!tradePermission.ok) throw new Error("COINOPS_TESTNET_TRADE_PERMISSION_INVALID");
  const freeUsdc = account.balances.find((balance) => balance.asset === "USDC")?.free ?? 0;
  if (!account.canTrade || !Number.isFinite(notional) || notional < filters.minNotional || freeUsdc < V1_TEST_PROFILE.capitalUsdc) throw new Error("COINOPS_TESTNET_FUNDS_OR_FILTERS_INVALID");
  if (openOrders.some((order) => order.clientOrderId?.startsWith(`COV1-${asset}-`))) throw new Error("COINOPS_TESTNET_UNRECONCILED_OWNED_ORDER");
  const { data: created, error: insertError } = await service.from("robot_v1_testnet_runs").insert({ product_id: scope.productId, tenant_id: scope.tenantId, user_id: scope.userId, asset, symbol, anchor_price: market.price, slot_notional_usdc: notional, gain_rate: V1_TEST_PROFILE.gainRate, entry_spacing: V1_TEST_PROFILE.entrySpacing }).select("*").single();
  if (insertError?.code === "23505") {
    const { data: concurrent } = await service.from("robot_v1_testnet_runs").select("id").eq("product_id", scope.productId).eq("tenant_id", scope.tenantId).eq("user_id", scope.userId).eq("asset", asset).eq("status", "ACTIVE").maybeSingle();
    if (concurrent) { await advanceTestnetRun(concurrent.id, "CONCURRENT_START_RECOVERY"); return concurrent.id as string; }
  }
  if (insertError || !created) throw new Error("COINOPS_TESTNET_RUN_CREATE_FAILED");
  const run = created as Run;
  await ensurePlan(service, run, filters);
  await event(service, run, "RUN_STARTED", "RUN_STARTED", null, { symbol, slotCount: 25, anchorPrice: market.price, slotNotional: notional });
  await advanceTestnetRun(run.id, "MANUAL_START");
  return run.id;
}

function orderRequest(run: Run, order: Order, slot: Slot) {
  if (order.purpose === "INITIAL") return { type: "MARKET" as const, symbol: run.symbol, side: "BUY" as const, quoteOrderQty: String(order.requested_quote), clientOrderId: order.client_order_id, maxNotional: amount(slot.balance_usdc) };
  return { type: "LIMIT" as const, symbol: run.symbol, side: order.side, quantity: String(order.requested_quantity), price: String(order.price), clientOrderId: order.client_order_id, maxNotional: amount(order.requested_quantity) * amount(order.price) + 0.00000001 };
}

function feeTotals(trades: TestnetTrade[], asset: V1Asset) {
  return {
    quantity: trades.reduce((sum, trade) => sum + trade.quantity, 0),
    base: trades.filter((trade) => trade.commissionAsset === asset).reduce((sum, trade) => sum + trade.commission, 0),
    quote: trades.filter((trade) => trade.commissionAsset === "USDC").reduce((sum, trade) => sum + trade.commission, 0),
    other: trades.filter((trade) => ![asset, "USDC"].includes(trade.commissionAsset) && trade.commission > 0).map((trade) => ({ asset: trade.commissionAsset, amount: trade.commission }))
  };
}

async function syncOrder(service: Service, run: Run, slot: Slot, order: Order, adapter: BinanceSpotTestnetAdapter, observedDecision: Record<string, unknown> = {}) {
  if (terminal.has(order.status) && (order.status !== "FILLED" || order.trades_reconciled)) return;
  const decisionId = (order as Order & { strategy_decision_id?: string | null }).strategy_decision_id;
  if (decisionId) await dispatchStrategyDecision(service, owned(run), "TESTNET", decisionId);
  try {
  let actual: TestnetOrder | null = order.status === "PREPARED"
    ? await adapter.ensureOwnedOrder(orderRequest(run, order, slot))
    : await adapter.getOwnedOrder(run.symbol, order.client_order_id).catch((error) => {
      if (error instanceof Error && error.message === "COINOPS_TESTNET_ORDER_RESPONSE_INVALID" && order.exchange_order_id) return null;
      throw error;
    });
  if (!actual && order.exchange_order_id) actual = await adapter.getKnownOrderById(run.symbol, order.client_order_id, order.exchange_order_id);
  if (!actual) throw new Error("COINOPS_TESTNET_PREPARED_ORDER_MISSING");
  if (order.exchange_order_id && order.exchange_order_id !== actual.orderId) throw new Error("COINOPS_TESTNET_ORDER_ID_MISMATCH");
  if (actual.symbol !== run.symbol || actual.side !== order.side) throw new Error("COINOPS_TESTNET_ORDER_SCOPE_MISMATCH");
  let fees = { base: amount(order.fee_base), quote: amount(order.fee_quote), quantity: 0, other: order.fee_other || [] };
  if (actual.executedQuantity > 0) {
    const trades = await adapter.getOwnedTrades(run.symbol, order.client_order_id, actual.orderId);
    fees = feeTotals(trades, run.asset);
    if (fees.quantity + 1e-9 < actual.executedQuantity) throw new Error("COINOPS_TESTNET_TRADES_PENDING");
    // Preserve the fills already returned by this read. No additional exchange
    // request, order, or execution decision is introduced by reporting.
    try {
      const evidence = testnetFillEvents({ productId: run.product_id, tenantId: run.tenant_id, userId: run.user_id }, run.id, slot.slot_number, order.client_order_id, actual.orderId, trades, new Date().toISOString());
      const { error: evidenceError } = await service.from("robot_v1_testnet_events").upsert(evidence, { onConflict: "run_id,event_key", ignoreDuplicates: true });
      if (evidenceError) console.error("COINOPS_TESTNET_FILL_EVIDENCE_PERSIST_FAILED");
    } catch { console.error("COINOPS_TESTNET_FILL_EVIDENCE_PERSIST_FAILED"); }
  }
  const previousStatus = order.status;
  if (previousStatus !== actual.status) {
    await event(service, run, `${order.client_order_id}:${actual.status}`, `${order.side}_${actual.status}`, slot.slot_number,
      { clientOrderId: order.client_order_id, exchangeOrderId: actual.orderId, executedQuantity: actual.executedQuantity, cumulativeQuote: actual.cumulativeQuoteQuantity });
    if (actual.status === "FILLED" && order.purpose === "INITIAL" && run.previous_run_id) {
      await event(service, run, `${order.client_order_id}:INITIAL_REENTRY_FILLED`, "INITIAL_REENTRY_FILLED", slot.slot_number,
        { clientOrderId: order.client_order_id, exchangeOrderId: actual.orderId, initial_reentry_filled: true, recovery_source: run.recovery_source });
    }
  }
  await updateOrder(service, run, order, {
    exchange_order_id: actual.orderId, status: actual.status, executed_quantity: actual.executedQuantity,
    cumulative_quote: actual.cumulativeQuoteQuantity, fee_base: fees.base, fee_quote: fees.quote, fee_other: fees.other,
    trades_reconciled: actual.status === "FILLED"
  });
  if (decisionId && ["REJECTED", "EXPIRED"].includes(actual.status)) {
    await failStrategyDecision(service, owned(run), "TESTNET", decisionId, `COINOPS_TESTNET_ORDER_${actual.status}`);
  } else if (decisionId && ["NEW", "PARTIALLY_FILLED", "FILLED"].includes(actual.status) && (order.purpose !== "INITIAL" || actual.status === "FILLED")) {
    await completeStrategyDecision(service, owned(run), "TESTNET", decisionId, {
      client_order_id: order.client_order_id, exchange_order_id: actual.orderId, order_status: actual.status,
      resident_slot_id: slot.id, resident_target_price: amount(order.price), executed_quantity: actual.executedQuantity,
      cumulative_quote: actual.cumulativeQuoteQuantity, ownership_verified: true,
      ...observedDecision,
    }, true);
  }
  } catch (error) {
    if (decisionId) await failStrategyDecision(service, owned(run), "TESTNET", decisionId, error instanceof Error ? error.message : "COINOPS_STRATEGY_DISPATCH_FAILED");
    throw error;
  }
}

async function monthlyStatuses(service: Service, run: Run, slots: Slot[]) {
  return loadMonthlySlotStatuses(service, "TESTNET", { ...owned(run), asset: run.asset }, slots);
}

async function recoverDecisionAudit(service: Service, run: Run, successorId?: string) {
  const { data, error } = await service.from("robot_v1_strategy_decisions").select("decision_id,cycle_id,slot_id,operation_sequence,action_type,target_price,target_notional,result")
    .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id).eq("user_id", run.user_id)
    .eq("environment", "TESTNET").eq("cycle_id", run.id).neq("result", "COMPLETED");
  if (error) throw new Error("COINOPS_STRATEGY_RECOVERY_READ_FAILED");
  if (!data?.length) return;
  const ledger = await rows(service, run);
  for (const recovered of recoverTestnetStrategyDecisions({ runId: run.id, decisions: data as RecoverableTestnetDecision[], ...ledger, successorId })) {
    await completeStrategyDecision(service, owned(run), "TESTNET", recovered.decisionId, recovered.observed, recovered.exchangeAck);
  }
}

function buysFor(orders: Order[], slot: Slot) { return orders.filter((order) => order.slot_id === slot.id && order.side === "BUY" && order.operation_sequence === slot.operation_sequence); }
function sellsFor(orders: Order[], slot: Slot) { return orders.filter((order) => order.slot_id === slot.id && order.side === "SELL" && order.operation_sequence === slot.operation_sequence); }
function netBought(buys: Order[]) { return buys.reduce((sum, order) => sum + amount(order.executed_quantity) - amount(order.fee_base), 0); }
function soldOrCovered(sells: Order[]) {
  return sells.reduce((sum, order) => sum + amount(order.executed_quantity) + (ACTIVE_ORDER.has(order.status) ? Math.max(0, amount(order.requested_quantity) - amount(order.executed_quantity)) : 0), 0);
}

async function ensureTakeProfits(service: Service, run: Run, slots: Slot[], orders: Order[], filters: SymbolFilters, adapter: BinanceSpotTestnetAdapter) {
  for (const slot of slots) {
    const buys = buysFor(orders, slot);
    if (!buys.some((order) => amount(order.executed_quantity) > 0)) continue;
    const sells = sellsFor(orders, slot);
    const bought = netBought(buys);
    const uncovered = floorStep(bought - soldOrCovered(sells), filters.quantityStep);
    const buyQuantity = buys.reduce((sum, order) => sum + amount(order.executed_quantity), 0);
    const buyQuote = buys.reduce((sum, order) => sum + amount(order.cumulative_quote) + amount(order.fee_quote), 0);
    // Client IDs are scoped to cycle/physical slot/side/revision, not operation
    // sequence. Reentry must advance across all earlier SELLs for this slot.
    const revision = Math.max(0, ...orders.filter((order) => order.run_id === run.id && order.slot_id === slot.id && order.side === "SELL").map((order) => order.revision)) + 1;
    const tpDecision = planStrategyTakeProfit({ ...context(run), transitionKey: `TP:${revision}` }, { ...candidate(slot), state: "OPEN" }, buyQuote / buyQuantity, filters,
      { gainRate: amount(run.gain_rate), entrySpacing: amount(run.entry_spacing) });
    const tpPrice = tpDecision.target_price!;
    if (uncovered >= filters.minQuantity && uncovered * tpPrice >= filters.minNotional) {
      const decisionId = await intent(service, run, tpDecision, slot.operation_sequence);
      const prepared = await prepareOrder(service, run, slot, "SELL", "TP", revision, uncovered, null, tpPrice, decisionId);
      await event(service, run, `${prepared.client_order_id}:PREPARED`, "TP_PREPARED", slot.slot_number, { clientOrderId: prepared.client_order_id, quantity: uncovered, price: tpPrice });
      await syncOrder(service, run, slot, prepared, adapter);
      if (run.previous_run_id) await event(service, run, `${prepared.client_order_id}:NEW_TP_CREATED`, "NEW_TP_CREATED", slot.slot_number,
        { clientOrderId: prepared.client_order_id, new_tp_created: true, recovery_source: run.recovery_source });
      orders.push(prepared);
    }
    if (buys.every((order) => terminal.has(order.status)) && bought - soldOrCovered(sellsFor(orders, slot)) < filters.quantityStep && slot.entry_state !== "CLOSED") {
      await updateSlot(service, run, slot, { entry_state: "OPEN" });
    }
  }
}

async function creditClosedSlots(service: Service, run: Run, slots: Slot[], orders: Order[], filters: SymbolFilters) {
  for (const slot of slots) {
    if (slot.entry_state !== "OPEN") continue;
    const buys = buysFor(orders, slot), sells = sellsFor(orders, slot);
    if (!buys.length || buys.some((order) => order.status !== "FILLED") || !sells.length || sells.some((order) => ACTIVE_ORDER.has(order.status))) continue;
    if (netBought(buys) - sells.reduce((sum, order) => sum + amount(order.executed_quantity), 0) >= filters.quantityStep) continue;
    if ([...buys, ...sells].some((order) => order.fee_other?.length)) throw new Error("COINOPS_TESTNET_UNPRICED_FEE_ASSET");
    const buyCost = buys.reduce((sum, order) => sum + amount(order.cumulative_quote) + amount(order.fee_quote), 0);
    const sellProceeds = sells.reduce((sum, order) => sum + amount(order.cumulative_quote) - amount(order.fee_quote), 0);
    const profit = rounded(sellProceeds - buyCost);
    const nextBalance = rounded(amount(slot.balance_usdc) + profit);
    if (nextBalance <= 0) throw new Error("COINOPS_TESTNET_SLOT_BALANCE_INVALID");
    const terminalTp = [...sells].filter((order) => order.status === "FILLED").sort((a, b) => b.revision - a.revision)[0];
    if (!terminalTp || terminalTp.client_order_id === slot.last_credited_sell_client_order_id) continue;
    await event(service, run, `${terminalTp.client_order_id}:SLOT_TP_FILLED`, "SLOT_TP_FILLED", slot.slot_number, { operationSequence: slot.operation_sequence, previousEntryPrice: amount(slot.entry_reference_price), takeProfitPrice: amount(terminalTp.price), balanceBefore: amount(slot.balance_usdc), balanceAfter: nextBalance, gainCountBefore: slot.gain_count, gainCountAfter: slot.gain_count + (profit > 0 ? 1 : 0) });
    await event(service, run, `${terminalTp.client_order_id}:SLOT_CLOSED`, "SLOT_CLOSED", slot.slot_number, { operationSequence: slot.operation_sequence, profitUsdc: profit, balanceUsdc: nextBalance, gainCount: slot.gain_count + (profit > 0 ? 1 : 0) });
    await updateSlot(service, run, slot, { entry_state: "CLOSED", balance_usdc: nextBalance, gain_count: slot.gain_count + (profit > 0 ? 1 : 0), net_profit_usdc: rounded(amount(slot.net_profit_usdc) + profit), last_take_profit_price: terminalTp.price, last_credited_sell_client_order_id: terminalTp.client_order_id });
  }
}

async function recycleClosedSlotsLocally(service: Service, run: Run, slots: Slot[], orders: Order[]) {
  const closed = slots.filter((slot) => slot.entry_state === "CLOSED");
  const monthly = await monthlyStatuses(service, run, slots);
  let recycled = false;
  for (const slot of closed) {
    const plan = planStrategyClosedSlot(context(run), candidatesWithFills(slots, orders, monthly), slot.id);
    if (plan.mode !== "LOCAL_REENTRY") continue;
    const previousEntryPrice = amount(slot.entry_reference_price || slot.target_buy_price);
    const nextSequence = slot.operation_sequence + 1;
    const decisionId = await intent(service, run, plan.decisions[0], nextSequence);
    await dispatchStrategyDecision(service, owned(run), "TESTNET", decisionId);
    await updateSlot(service, run, slot, {
      entry_state: "PLANNED", entry_origin: "REENTRY", target_buy_price: previousEntryPrice,
      entry_reference_price: previousEntryPrice, operation_sequence: nextSequence, missed_at: null
    });
    await event(service, run, `SLOT_${slot.slot_number}_REENTRY_PLANNED_${nextSequence}`, "SLOT_REENTRY_PLANNED", slot.slot_number, {
      previous_entry_price: previousEntryPrice, reentry_price: previousEntryPrice,
      balance_after: amount(slot.balance_usdc), gain_count_after: slot.gain_count,
      other_open_positions: plan.otherOpenPositions, local_recycle_vs_global_reset: "LOCAL_REENTRY",
      operation_sequence: nextSequence
    });
    await completeStrategyDecision(service, owned(run), "TESTNET", decisionId, { state: "PLANNED", operation_sequence: nextSequence, balance_usdc: amount(slot.balance_usdc), reentry_price: previousEntryPrice });
    recycled = true;
  }
  return recycled;
}

async function armNextBuy(service: Service, run: Run, slots: Slot[], orders: Order[], filters: SymbolFilters, adapter: BinanceSpotTestnetAdapter) {
  let monthly = await monthlyStatuses(service, run, slots);
  if (!orders.some((order) => order.side === "BUY")) {
    const selected = monthly.filter((status) => status.eligibleForNewEntry)
      .sort((left, right) => left.operationalRank! - right.operationalRank!)[0];
    if (!selected) return false;
    const slot = slots.find((item) => item.slot_number === selected.physicalSlotNumber);
    if (!slot) throw new Error("COINOPS_TESTNET_PLAN_INCOMPLETE");
    const { error: rankError } = await service.rpc("rank_robot_v1_testnet_fresh_cycle", {
      p_run_id: run.id, p_price_tick: filters.priceTick
    });
    if (rankError) throw new Error("COINOPS_TESTNET_FRESH_RANK_FAILED");
    const refreshed = await rows(service, run);
    const rankedSlot = refreshed.slots.find((item) => item.id === slot.id);
    if (!rankedSlot) throw new Error("COINOPS_TESTNET_FRESH_RANK_FAILED");
    Object.assign(slot, rankedSlot);
    const initialDecision = planStrategyInitialEntry(context(run), candidate(slot, selected));
    if (initialDecision.action_type !== "OPEN_INITIAL_MARKET") throw new Error("COINOPS_STRATEGY_INITIAL_STATE_INVALID");
    const decisionId = await intent(service, run, initialDecision, slot.operation_sequence);
    const prepared = await prepareOrder(service, run, slot, "BUY", "INITIAL", 1, null, amount(slot.balance_usdc), null, decisionId);
    await event(service, run, `${prepared.client_order_id}:PREPARED`, "INITIAL_BUY_PREPARED", slot.slot_number, { clientOrderId: prepared.client_order_id });
    await updateSlot(service, run, slot, { entry_state: "ARMED" });
    await syncOrder(service, run, slot, prepared, adapter);
    if (run.previous_run_id) await event(service, run, `${prepared.client_order_id}:NEXT_BUY_ARMED`, "NEXT_BUY_ARMED", slot.slot_number,
      { clientOrderId: prepared.client_order_id, next_buy_armed: true, recovery_source: run.recovery_source });
    orders.push(prepared);
    return true;
  }
  const market = await adapter.reads.getMarketPrice(run.symbol);
  const activeBuys = orders.filter((order) => order.side === "BUY" && ACTIVE_ORDER.has(order.status));
  if (activeBuys.length > 1) throw new Error("COINOPS_STRATEGY_MULTIPLE_ARMED_BUYS");
  const activeBuy = activeBuys[0];
  // Repair the materialized slot projection after a crash between cancel /
  // prepare and slot persistence. The exchange-backed order ledger is the
  // authority for residence; a stale ARMED flag must never stall the queue.
  for (const slot of slots) {
    if (activeBuy?.slot_id === slot.id) {
      if (slot.operation_sequence !== activeBuy.operation_sequence || slot.missed_at)
        throw new Error("COINOPS_TESTNET_OWNED_BUY_SEQUENCE_MISMATCH");
    }
    const projected = projectTestnetEntryState(slot, orders);
    if (projected !== slot.entry_state) await updateSlot(service, run, slot, { entry_state: projected });
  }
  // A resident order may predate this month's target. Cancel only an exact
  // CoinOps-owned, unfilled BUY; a partial fill remains protected through TP.
  if (activeBuy && !monthly.find((status) => status.physicalSlotNumber === activeBuy.slot_number)?.eligibleForNewEntry
    && amount(activeBuy.executed_quantity) === 0 && activeBuy.status !== "PARTIALLY_FILLED") {
    if (activeBuy.status === "PREPARED") await updateOrder(service, run, activeBuy, { status: "CANCELED" });
    else {
      if (activeBuy.status !== "NEW" || !activeBuy.exchange_order_id) throw new Error("COINOPS_TESTNET_OWNED_BUY_NOT_CANCELABLE");
      const canceled = await adapter.cancelOwnedOrder(run.symbol, activeBuy.exchange_order_id, activeBuy.client_order_id);
      if (!canceled || canceled.status !== "CANCELED" || canceled.executedQuantity > 0) throw new Error("COINOPS_TESTNET_OWNED_BUY_CANCEL_UNCERTAIN");
      await updateOrder(service, run, activeBuy, { status: "CANCELED", executed_quantity: 0, cumulative_quote: canceled.cumulativeQuoteQuantity });
    }
    const oldSlot = slots.find((slot) => slot.id === activeBuy.slot_id);
    if (oldSlot) await updateSlot(service, run, oldSlot, { entry_state: "PLANNED" });
    await event(service, run, `${activeBuy.client_order_id}:MONTHLY_TARGET_HOLD`, "MONTHLY_TARGET_HOLD", activeBuy.slot_number,
      { clientOrderId: activeBuy.client_order_id, periodKey: monthly[0]?.periodKey ?? null, ownershipVerified: true });
  }
  const resident = activeBuy && ACTIVE_ORDER.has(activeBuy.status) ? activeBuy : undefined;
  monthly = await monthlyStatuses(service, run, slots);
  const candidates = slots.map((slot) => ({ ...candidate(slot, monthly.find((status) => status.physicalSlotNumber === slot.slot_number)), ...(resident?.slot_id === slot.id ? { state: resident.status === "PARTIALLY_FILLED" ? "PARTIALLY_FILLED" as const : "ARMED" as const } : {}) }));
  const plan = planStrategyNextEntry({ ...context(run), transitionKey: `QUEUE:${orders.filter((order) => order.side === "BUY").length}` }, candidates, market.price, resident ? { candidateId: resident.slot_id, executedQuantity: amount(resident.executed_quantity) } : null);
  const decisionId = await intent(service, run, plan.decision, slots.find((slot) => slot.id === plan.decision.slot_id)?.operation_sequence);
  for (const crossed of slots.filter((slot) => plan.missedCandidateIds.includes(slot.id))) {
    let filledAt: string | null = null, collectedAt: string | null = null;
    if (crossed.last_credited_sell_client_order_id) {
      const evidence = await service.from("robot_v1_testnet_events").select("observed_at,details")
        .eq("run_id", run.id).eq("tenant_id", run.tenant_id).eq("event_type", "TESTNET_FILL_OBSERVED")
        .contains("details", { clientOrderId: crossed.last_credited_sell_client_order_id }).order("observed_at", { ascending: false }).limit(1).maybeSingle();
      if (evidence.error) throw new Error("COINOPS_TESTNET_MISSED_EVIDENCE_UNAVAILABLE");
      filledAt = evidence.data?.details?.filledAt ?? null;
      collectedAt = evidence.data?.details?.collectedAt ?? null;
    }
    const latencyMs = filledAt && collectedAt ? Math.max(0, Date.parse(collectedAt) - Date.parse(filledAt)) : null;
    const detectedAt = new Date().toISOString();
    await event(service, run, `SLOT_${crossed.slot_number}_MISSED_${crossed.operation_sequence}`, "MISSED_LEVEL_DURING_REARM", crossed.slot_number, {
      marketPrice: market.price, targetPrice: amount(crossed.target_buy_price), decision_id: decisionId,
      first_cross_at: null, detected_at: detectedAt, order_resident_at: null,
      root_cause: latencyMs !== null && latencyMs > 90_000 ? "DELAYED_TP_RECONCILIATION" : "NO_RESIDENT_BUY_AT_OBSERVATION", strategy_version: STRATEGY_VERSION,
      filled_at: filledAt, collected_at: collectedAt, latency_ms: latencyMs,
      recovery_action: "PRESERVE_HISTORY_NO_RETROACTIVE_MARKET_FILL"
    });
    await updateSlot(service, run, crossed, { entry_state: "MISSED", missed_at: detectedAt });
  }
  if (plan.decision.action_type === "WAIT") {
    await dispatchStrategyDecision(service, owned(run), "TESTNET", decisionId);
    await completeStrategyDecision(service, owned(run), "TESTNET", decisionId, {
      market_price: market.price, resident_slot_id: resident?.slot_id ?? null,
      resident_target_price: resident ? amount(resident.price) : null, reason: plan.decision.reason,
      priority_validated: plan.decision.reason === "HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT",
      missed_count: slots.filter((slot) => slot.missed_at).length,
    });
    return false;
  }
  const desired = slots.find((slot) => slot.id === plan.nextCandidateId);
  if (!desired) throw new Error("COINOPS_STRATEGY_NEXT_SLOT_MISSING");
  await dispatchStrategyDecision(service, owned(run), "TESTNET", decisionId);
  if (resident) {
    const activeSlot = slots.find((slot) => slot.id === resident.slot_id);
    if (!activeSlot) throw new Error("COINOPS_TESTNET_ORDER_SLOT_MISSING");
    if (amount(resident.executed_quantity) > 0 || resident.status === "PARTIALLY_FILLED") throw new Error("COINOPS_TESTNET_ACTIVE_BUY_PARTIAL");
    if (amount(activeSlot.target_buy_price) >= amount(desired.target_buy_price)) return false;
    if (resident.status === "PREPARED") await updateOrder(service, run, resident, { status: "CANCELED" });
    else {
      if (resident.status !== "NEW" || !resident.exchange_order_id) throw new Error("COINOPS_TESTNET_OWNED_BUY_NOT_CANCELABLE");
      const canceled = await adapter.cancelOwnedOrder(run.symbol, resident.exchange_order_id, resident.client_order_id);
      if (!canceled || canceled.status !== "CANCELED" || canceled.executedQuantity > 0) throw new Error("COINOPS_TESTNET_OWNED_BUY_CANCEL_UNCERTAIN");
      await updateOrder(service, run, resident, { status: canceled.status, executed_quantity: canceled.executedQuantity, cumulative_quote: canceled.cumulativeQuoteQuantity });
    }
    await updateSlot(service, run, activeSlot, { entry_state: "PLANNED" });
    await event(service, run, `${resident.client_order_id}:BUY_REPLACED_FOR_REENTRY`, "BUY_REPLACED_FOR_REENTRY", activeSlot.slot_number, { clientOrderId: resident.client_order_id, replacementSlotNumber: desired.slot_number, ownership_verified: true });
  }
  for (const stale of slots.filter((slot) => slot.entry_state === "ARMED" && slot.id !== desired.id)) await updateSlot(service, run, stale, { entry_state: "PLANNED" });
  const price = amount(desired.target_buy_price);
  const quantity = floorStep(amount(desired.balance_usdc) / price, filters.quantityStep);
  if (quantity < filters.minQuantity || quantity > filters.maxQuantity || quantity * price < filters.minNotional) throw new Error("COINOPS_TESTNET_ENTRY_FILTER_INVALID");
  const revision = Math.max(0, ...orders.filter((order) => order.slot_id === desired.id && order.side === "BUY").map((order) => order.revision)) + 1;
  const prepared = await prepareOrder(service, run, desired, "BUY", "ENTRY", revision, quantity, null, price, decisionId);
  await event(service, run, `${prepared.client_order_id}:PREPARED`, "NEXT_BUY_PREPARED", desired.slot_number, { clientOrderId: prepared.client_order_id, quantity, price, operationSequence: desired.operation_sequence });
  await updateSlot(service, run, desired, { entry_state: "ARMED" });
  await syncOrder(service, run, desired, prepared, adapter, { market_price: market.price, priority_validated: true });
  if (desired.entry_origin === "REENTRY") await event(service, run, `${prepared.client_order_id}:SLOT_REENTRY_ARMED`, "SLOT_REENTRY_ARMED", desired.slot_number, { previous_entry_price: amount(desired.entry_reference_price), reentry_price: price, balance_after: amount(desired.balance_usdc), gain_count_after: desired.gain_count, local_recycle_vs_global_reset: "LOCAL_REENTRY", operation_sequence: desired.operation_sequence });
  orders.push(prepared);
  return true;
}

async function restartTerminalCycle(service: Service, run: Run, slots: Slot[], orders: Order[], filters: SymbolFilters, adapter: BinanceSpotTestnetAdapter, recoverySource: string) {
  const reset = planTerminalTestnetRestart(orders, filters.quantityStep);
  if (!reset.shouldRestart || !reset.terminalFill) return null;
  const closed = slots.find((slot) => slot.entry_state === "CLOSED");
  if (!closed) throw new Error("COINOPS_STRATEGY_TERMINAL_CLOSE_REQUIRED");
  const monthly = await monthlyStatuses(service, run, slots);
  const strategyReset = planStrategyClosedSlot(context(run), candidatesWithFills(slots, orders, monthly), closed.id);
  if (strategyReset.mode !== "GLOBAL_RESET") return null;
  if (!monthly.some((status) => status.eligibleForNewEntry)) return null;
  const nextCapital = amount(run.next_capital_usdc ?? amount(run.slot_notional_usdc) * 25);
  const nextGainRate = amount(run.next_gain_rate ?? run.gain_rate);
  const nextSpacing = amount(run.next_entry_spacing ?? run.entry_spacing);
  const nextSlotBalanceDelta = nextCapital / 25 - amount(run.slot_notional_usdc);
  const previewMarket = await adapter.reads.getMarketPrice(run.symbol);
  const nextBalances = slots.map((slot) => amount(slot.balance_usdc) + nextSlotBalanceDelta);
  if (nextCapital > 2500 || nextBalances.some((balance) => balance <= 0 || balance > 100)) throw new Error("COINOPS_TESTNET_NEXT_CAPITAL_INVALID");
  buildV1Grid(run.asset, nextCapital, previewMarket.price, filters, { gainRate: nextGainRate, entrySpacing: nextSpacing }, nextBalances);
  const account = await adapter.reads.getAccount();
  // Only the exact owned pending BUY is refundable; never count unrelated
  // account locks as capital available to this cycle.
  const refundable = reset.activeNextBuy && reset.activeNextBuy.status === "NEW"
    ? amount((reset.activeNextBuy as Order).requested_quantity) * amount((reset.activeNextBuy as Order).price) : 0;
  if ((account.balances.find((balance) => balance.asset === "USDC")?.free ?? 0) + refundable + 1e-8 < nextBalances.reduce((sum, balance) => sum + balance, 0)) throw new Error("COINOPS_TESTNET_NEXT_FUNDS_INVALID");
  const resetStartedAt = new Date().toISOString();
  const resetKey = testnetResetIdempotencyKey(run.id, reset.terminalFill.client_order_id);
  for (const decision of strategyReset.decisions) {
    await intent(service, run, decision, closed.operation_sequence);
    await dispatchStrategyDecision(service, owned(run), "TESTNET", decision.decision_id);
  }
  await event(service, run, `RESET_STARTED:${resetKey}`, "RESET_AFTER_LAST_TP", null, {
    terminalFillClientOrderId: reset.terminalFill.client_order_id, reset_after_last_tp: true, recovery_source: recoverySource
  });

  if (reset.activeNextBuy) {
    const oldBuy = reset.activeNextBuy as Order;
    const oldSlot = slots.find((slot) => slot.slot_number === oldBuy.slot_number);
    if (!oldSlot) throw new Error("COINOPS_TESTNET_ORDER_SLOT_MISSING");
    if (amount(oldBuy.executed_quantity) > 0 || oldBuy.status === "PARTIALLY_FILLED") throw new Error("COINOPS_TESTNET_OLD_BUY_PARTIAL");
    if (oldBuy.status === "PREPARED") {
      await updateOrder(service, run, oldBuy, { status: "CANCELED" });
    } else {
      if (oldBuy.status !== "NEW" || !oldBuy.exchange_order_id) throw new Error("COINOPS_TESTNET_OLD_BUY_NOT_CANCELABLE");
      const canceled = await adapter.cancelOwnedOrder(run.symbol, oldBuy.exchange_order_id, oldBuy.client_order_id);
      if (!canceled || canceled.status !== "CANCELED" || canceled.executedQuantity > 0) throw new Error("COINOPS_TESTNET_OLD_BUY_CANCEL_UNCERTAIN");
      await updateOrder(service, run, oldBuy, { status: canceled.status, executed_quantity: canceled.executedQuantity, cumulative_quote: canceled.cumulativeQuoteQuantity });
    }
    await updateSlot(service, run, oldSlot, { entry_state: "CANCELLED" });
    await event(service, run, `${oldBuy.client_order_id}:OLD_NEXT_BUY_CANCELED`, "OLD_NEXT_BUY_CANCELED", oldBuy.slot_number,
      { clientOrderId: oldBuy.client_order_id, exchangeOrderId: oldBuy.exchange_order_id, old_next_buy_canceled: true, recovery_source: recoverySource });
  }

  const verified = await rows(service, run);
  if (testnetOpenPositionQuantity(verified.orders) + 1e-10 >= filters.quantityStep) throw new Error("COINOPS_TESTNET_POSITION_REAPPEARED");
  if (verified.orders.some((order) => ACTIVE_ORDER.has(order.status))) throw new Error("COINOPS_TESTNET_ACTIVE_OLD_ORDER");
  for (const slot of verified.slots.filter((item) => item.entry_state === "ARMED")) await updateSlot(service, run, slot, { entry_state: "CANCELLED" });
  const market = await adapter.reads.getMarketPrice(run.symbol);
  const { data, error } = await service.rpc("restart_robot_v1_testnet_cycle_v2", {
    p_old_run_id: run.id,
    p_terminal_fill_client_order_id: reset.terminalFill.client_order_id,
    p_anchor_price: market.price,
    p_price_tick: filters.priceTick,
    p_reset_idempotency_key: resetKey,
    p_recovery_source: recoverySource,
    p_reset_started_at: resetStartedAt
  });
  const nextRunId = (Array.isArray(data) ? data[0]?.new_run_id : data?.new_run_id) as string | undefined;
  if (error || !nextRunId) throw new Error("COINOPS_TESTNET_CYCLE_RESTART_FAILED");
  for (const decision of strategyReset.decisions) await completeStrategyDecision(service, owned(run), "TESTNET", decision.decision_id,
    { state: "COMPLETED", next_cycle_id: nextRunId, anchor_price: market.price, old_owned_orders_canceled: true });
  return nextRunId;
}

async function markRestartComplete(service: Service, run: Run, slots: Slot[], orders: Order[]) {
  if (!run.previous_run_id || run.reset_completed_at) return;
  const activeTp = orders.filter((order) => order.side === "SELL" && order.purpose === "TP" && ACTIVE_ORDER.has(order.status));
  const activeNext = orders.filter((order) => order.side === "BUY" && order.purpose === "ENTRY" && ACTIVE_ORDER.has(order.status));
  const initialFilled = orders.some((order) => order.side === "BUY" && order.purpose === "INITIAL" && order.status === "FILLED");
  if (!initialFilled || activeTp.length !== 1 || activeNext.length !== 1
    || slots.filter((slot) => slot.entry_state === "OPEN").length !== 1
    || slots.filter((slot) => slot.entry_state === "ARMED").length !== 1
    || slots.filter((slot) => slot.entry_state === "PLANNED").length !== 23) return;
  const completedAt = new Date().toISOString();
  const resetLatency = run.reset_started_at ? Math.max(0, Date.parse(completedAt) - Date.parse(run.reset_started_at)) : null;
  const { error } = await service.from("robot_v1_testnet_runs").update({ reset_completed_at: completedAt })
    .eq("id", run.id).eq("tenant_id", run.tenant_id).is("reset_completed_at", null);
  if (error) throw new Error("COINOPS_TESTNET_RESET_COMPLETE_PERSIST_FAILED");
  await event(service, run, `RESET_COMPLETED:${run.id}`, "RESET_COMPLETED", null, {
    reset_after_last_tp: true, old_next_buy_canceled: true, new_cycle_started: true,
    initial_reentry_filled: true, new_tp_created: true, next_buy_armed: true,
    reset_latency_ms: resetLatency, recovery_source: run.recovery_source
  });
}

/** Query-before-write reconciliation; safe to call again after restart or timeout. */
export async function advanceTestnetRun(runId: string, recoverySource = "RECONCILIATION", depth = 0): Promise<{ status: string; nextRunId?: string; next?: unknown }> {
  assertTestnetEnvironment();
  if (depth > 2) throw new Error("COINOPS_TESTNET_RESTART_DEPTH_EXCEEDED");
  const service = createServiceRoleClient();
  const lock = await claim(service, runId);
  if (!lock) return { status: "BUSY_OR_INACTIVE" };
  const { run, leaseOwner } = lock;
  const deadline = Date.now() + 45_000;
  let errorCode: string | null = null;
  let nextRunId: string | null = null;
  let result: { status: string; nextRunId?: string } = { status: "OK" };
  try {
    if (V1_RULES[run.asset]?.symbol !== run.symbol) throw new Error("COINOPS_TESTNET_RUN_SYMBOL_INVALID");
    const adapter = BinanceSpotTestnetAdapter.fromEnvironment();
    const filters = await adapter.reads.getSymbolInfo(run.symbol);
    await recoverDecisionAudit(service, run);
    if (run.previous_run_id) {
      const previous = await queryRun(service, run.previous_run_id);
      if (previous.status !== "COMPLETED" || previous.product_id !== run.product_id || previous.user_id !== run.user_id || previous.asset !== run.asset)
        throw new Error("COINOPS_STRATEGY_RECOVERY_SCOPE_INVALID");
      await recoverDecisionAudit(service, previous, run.id);
    }
    for (let iteration = 0; iteration < 4; iteration++) {
      const { slots, orders } = await rows(service, run);
      if (slots.length !== 25) throw new Error("COINOPS_TESTNET_PLAN_INCOMPLETE");
      for (const order of orders) {
        if (Date.now() >= deadline) throw new Error("COINOPS_TESTNET_WORK_BUDGET_EXCEEDED");
        const slot = slots.find((item) => item.id === order.slot_id);
        if (!slot) throw new Error("COINOPS_TESTNET_ORDER_SLOT_MISSING");
        await syncOrder(service, run, slot, order, adapter);
      }
      await ensureTakeProfits(service, run, slots, orders, filters, adapter);
      await creditClosedSlots(service, run, slots, orders, filters);
      await recycleClosedSlotsLocally(service, run, slots, orders);
      nextRunId = await restartTerminalCycle(service, run, slots, orders, filters, adapter, recoverySource);
      if (nextRunId) { result = { status: "RESTARTED", nextRunId }; break; }
      const armed = await armNextBuy(service, run, slots, orders, filters, adapter);
      if (!armed) break;
    }
    await recoverDecisionAudit(service, run, nextRunId ?? undefined);
    if (!nextRunId) {
      const latest = await rows(service, run);
      await markRestartComplete(service, run, latest.slots, latest.orders);
      await event(service, run, `RECONCILED_${new Date().toISOString().slice(0, 16)}`, "RECONCILED", null, { mode: "TESTNET", recovery_source: recoverySource, strategy_version: STRATEGY_VERSION,
        missed_count: latest.slots.filter((slot) => slot.missed_at).length, expected_interval_seconds: 60 });
    }
  } catch (error) {
    errorCode = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "COINOPS_TESTNET_RECONCILIATION_FAILED";
    throw new Error(errorCode);
  } finally { await release(service, run, leaseOwner, errorCode); }
  if (nextRunId) return { ...result, next: await advanceTestnetRun(nextRunId, recoverySource, depth + 1) };
  return result;
}

/** Compatibility entry point: repair must obey the same engine priority and
 * durable decisions, never force a gratuitous same-level cancel/replace. */
export async function replaceOwnedTestnetBuy(runId: string) {
  return advanceTestnetRun(runId, "MANUAL_PRIORITY_REPAIR");
}
