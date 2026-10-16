import { randomUUID } from "node:crypto";
import { LiveReadUnavailable, liveFailureEvidence } from "./live-read-error";
import { boundedLedgerRead, observeLedgerRows, observeLedgerRecord, assertPhysicalLedger } from "./live-ledger-read";

import { planAthLadder } from "./ath-ladder";
import { loadAthProfile, refreshAthProfile, type AthProfileRow } from "./ath-profile-server";
import { buildLiveSizing, parseLiveRules, type LiveConfig, type RawLiveSymbol } from "./live-preparation";
import { readLiveExecutorState, readLiveExecutorOrder, readLiveExecutorTrades, readLiveExecutorOrderObservation,
  createLiveExecutorOrder, cancelLiveExecutorOrder, proveLiveExecutorUnsentOrder, type LiveOrder,
  type LiveTrade, type LiveExecutorState } from "./live-executor-transport";
import { loadLiveEngineExecutorStatus } from "./live-executor-health";
import { verifiedReadRecoveryAlert, operatorRecoveryAlert, isPermissionStateReadRecovery, assertPermissionReadRecoveryOrders,
  isAccountBudgetAlertRecovery, isCapitalAuditReadRecovery, type ReadRecoveryAlert } from "./live-read-recovery";
import { resolveAccountBudgetAlert, AccountBudgetAlertResolutionError } from "./live-account-budget-alert";
import { loadMonthlySlotStatuses } from "./monthly-slot-server";
import { monthlyPeriodKey } from "./monthly-slot-policy";
import { liveClientOrderId, liveEngineOrderPrefix, liveUncoveredQuantity,
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
import { resolveOperatorEngine } from "./operator-context-server";
import { assertStrategyBuyPrice, assertStrategyTakeProfitPrice } from "./strategy-price-invariant";
import { unchangedUnfilledResidentOrder } from "./live-reconciliation-shortcut";
import { isProvablyUnsentTakeProfit } from "./live-unsent-tp-recovery";
import { isConfirmedFilledSnapshotRace } from "./live-order-snapshot-race";
import { continueLiveAdvance, type LiveAdvanceResult } from "./live-cycle-continuation";
import { planLiveEntryCapitalRefresh, canRestoreUnfilledEntry } from "./live-entry-capital-refresh";
import { strategyRatesForOrder } from "./live-strategy-snapshot";
import { assertRowEngine, type EngineContext, type EngineSelection } from "./operator-context";
import { strategyParameter, strategyParameterAffectsCurrentLadder,
  type StrategyApplyPolicy, type StrategyParameterKey } from "./strategy-parameter-registry";
import type { ExecutorEngineScope } from "./live-executor-transport";
import { readLiveExposure } from "./live-exposure-read";
import { completeLedgerRead } from "./complete-ledger-read";
import { accountExecutionPolicyRequired, reserveAccountOrderDispatch, acknowledgeAccountOrderDispatch,
  AccountOrderBudgetHold } from "./account-order-budget-server";
import { AccountOrderNotSubmitted } from "./account-order-unsent-proof";
import { mayAttestUnsentEntry } from "./live-unsent-entry-recovery";
import { liveQuoteBalanceCheck } from "./live-quote-balance";
import { liveBnbFeeBalanceCheck } from "./live-bnb-fee-balance";
import { configuredEngineSlotCount, hasCompletePhysicalSlotSet } from "./engine-slot-topology";
import { withLiveObservationRetryBudget } from "./live-observation-retry-budget";

type Service = ReturnType<typeof createServiceRoleClient>;
type Symbol = string;
type EngineScope = ExecutorEngineScope & { engine?: EngineContext };
type LedgerScope = Pick<ExecutorEngineScope, "operator_id" | "exchange_account_id" | "trading_engine_id" | "quote_asset">;
type Scope = { product_id: string; tenant_id: string; user_id: string };
type Preparation = Scope & EngineScope & { asset: V1Asset; symbol: Symbol; slot_count: number;
  configured_live_capital_brl: number | string; max_order_notional_brl: number | string;
  max_total_exposure_brl: number | string; monthly_target: number;
  live_enabled: boolean; kill_switch: boolean; config_version: number };
type Run = Scope & EngineScope & { id: string; asset: V1Asset; symbol: Symbol; status: string; slot_count?: number;
  execution_source?: string;
  anchor_price: number | string; slot_notional_brl: number | string; gain_rate: number | string;
  entry_spacing: number | string; entry_regime: "NORMAL" | "POST_ATH";
  config_version: number; config_snapshot: Record<string, unknown>; strategy_version: string;
  ath_transition_key: string | null; ath_period_key: string | null;
  last_error: string | null; lease_owner: string | null; lease_until: string | null;
  last_reconciled_at: string | null; previous_run_id: string | null;
  reconciliation_checkpoint?: Record<string, unknown> | null };
type Slot = Scope & LedgerScope & { id: string; run_id: string; slot_number: number; entry_state: string;
  target_buy_price: number | string; entry_reference_price: number | string;
  operation_sequence: number; entry_origin: "GRID" | "REENTRY";
  operational_rank: number | null; post_ath_group: "PRIMARY" | "RESERVE" | null;
  post_ath_group_rank: number | null; position_quantity: number | string;
  position_committed_brl: number | string; missed_at: string | null;
  last_credited_sell_client_order_id: string | null };
type Account = Scope & LedgerScope & { asset: V1Asset; slot_number: number; balance_brl: number | string;
  contribution_brl: number | string; market_pnl_brl: number | string;
  manual_gain_brl: number | string; fees_brl: number | string; gain_count: number;
  dust_quantity: number | string; dust_cost_brl: number | string };
type Order = Scope & LedgerScope & { id: string; run_id: string; slot_id: string; slot_number: number;
  operation_sequence: number; side: "BUY" | "SELL"; purpose: "INITIAL" | "ENTRY" | "TP";
  revision: number; client_order_id: string; exchange_order_id: string | null;
  status: string; requested_quantity: number | string | null;
  requested_quote: number | string | null; price: number | string | null;
  reserved_notional_brl: number | string; executed_quantity: number | string;
  cumulative_quote: number | string; fee_base: number | string;
  fee_quote: number | string; fee_other: Array<{ asset: string; amount: number }>;
  trades_reconciled: boolean; submission_guarded_at: string | null;
  account_order_unsent_receipt?: { request_nonce: string } | null;
  strategy_decision_id: string | null; config_version: number;
  config_snapshot: Record<string, unknown>; created_at: string };

type Ledger = Awaited<ReturnType<typeof runRows>>;
type BulkUpdate = { id: string; batch_id: string; run_id: string; profile_id: string;
  operator_id: string; exchange_account_id: string; trading_engine_id: string;
  strategy_version_before: number; strategy_version_after: number;
  parameter_key?: StrategyParameterKey; apply_policy?: StrategyApplyPolicy;
  requires_order_reconciliation?: boolean;
  old_values: Record<string, number | string>;
  new_values: Record<string, number | string>; status: string };

const PUBLIC_SPOT = "https://data-api.binance.vision";
// A reconciliation may perform several sequential Binance GETs and database
// checks. Keep the lease beyond one bounded serverless invocation; every
// dispatch still renews and asserts ownership immediately before its write.
const LIVE_LEASE_MS = 180_000;
const amount = (value: number | string | null | undefined) => Number(value ?? 0);
const floorStep = (value: number, step: number) => Number((Math.floor((value + 1e-10) / step) * step).toFixed(12));
const owned = (run: Run) => ({ product_id: run.product_id, tenant_id: run.tenant_id, user_id: run.user_id,
  operator_id: run.operator_id, exchange_account_id: run.exchange_account_id, trading_engine_id: run.trading_engine_id,
  quote_asset: run.quote_asset });
const athScope = (run: Run | Preparation) => ({ productId: run.product_id, tenantId: run.tenant_id, userId: run.user_id,
  operatorId: run.operator_id, exchangeAccountId: run.exchange_account_id, tradingEngineId: run.trading_engine_id });
async function validateRunEngine(service: Service, run: Run) {
  const engine = await resolveOperatorEngine(service, run, { environment: "REAL",
    trading_engine_id: run.trading_engine_id, exchange_account_id: run.exchange_account_id, symbol: run.symbol });
  assertRowEngine(run, engine);
  if (engine.base_asset !== run.asset) throw new Error("COINOPS_LIVE_ENGINE_ASSET_MISMATCH");
  if (configuredEngineSlotCount(engine) !== configuredEngineSlotCount({ slot_count: run.slot_count, config: run.config_snapshot }))
    throw new Error("COINOPS_ENGINE_SLOT_COUNT_MISMATCH");
  run.engine = engine;
  return engine;
}
async function quoteCap(service: Service, run: Run | Preparation) {
  const row = await boundedLedgerRead((deadline, attempt) => observeLedgerRecord<{ hard_cap_quote: number | string }>("quote_cap",
    service.from("account_quote_caps").select("hard_cap_quote")
    .eq("operator_id", run.operator_id).eq("exchange_account_id", run.exchange_account_id)
    .eq("quote_asset", run.quote_asset).abortSignal(deadline).single(),
    deadline, attempt, "COINOPS_LIVE_GLOBAL_CAP_UNAVAILABLE"));
  if (!(Number(row.hard_cap_quote) > 0))
    throw new Error("COINOPS_LIVE_GLOBAL_CAP_UNAVAILABLE");
  return Number(row.hard_cap_quote);
}
function entryBlocked(run: Run) {
  return !run.engine || run.engine.status !== "ACTIVE" || run.engine.global_kill_switch
    || run.engine.account_kill_switch || run.engine.engine_kill_switch;
}
async function configUpdatePending(service: Service, run: Run) {
  const row = await boundedLedgerRead((deadline, attempt) => observeLedgerRecord<{ strategy_config_pending: boolean }>("config_gate",
    service.from("trading_engines").select("strategy_config_pending")
    .eq("id", run.trading_engine_id).eq("operator_id", run.operator_id)
    .eq("exchange_account_id", run.exchange_account_id).abortSignal(deadline).single(),
    deadline, attempt, "COINOPS_BULK_GATE_UNAVAILABLE"));
  if (typeof row.strategy_config_pending !== "boolean") throw new Error("COINOPS_BULK_GATE_UNAVAILABLE");
  return row.strategy_config_pending;
}
const context = (run: Run, transitionKey?: string) => ({ asset: run.asset, cycleId: run.id,
  observedAt: new Date().toISOString(), quoteAsset: run.quote_asset, transitionKey, slotCount: configuredEngineSlotCount(run.engine ?? run) });

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

async function scopedPreparation(service: Service, userId: string, asset: V1Asset, selection?: EngineSelection): Promise<Preparation> {
  const owner = await boundedLedgerRead((deadline, attempt) => observeLedgerRecord<Scope>("operator",
    service.from("operators").select("product_id,tenant_id,user_id")
    .eq("tenant_id", getCoinOpsServiceTenantId()).eq("user_id", userId).eq("status", "ACTIVE")
    .abortSignal(deadline).single(), deadline, attempt, "COINOPS_LIVE_OPERATOR_UNAVAILABLE"));
  const engine = await resolveOperatorEngine(service, owner, selection ?? { environment: "REAL", asset });
  const row = await boundedLedgerRead((deadline, attempt) => observeLedgerRecord<Preparation>("preparation",
    service.from("robot_v1_live_preparations").select("*")
    .eq("tenant_id", getCoinOpsServiceTenantId()).eq("user_id", userId)
    .eq("trading_engine_id", engine.trading_engine_id).abortSignal(deadline).single(),
    deadline, attempt, "COINOPS_LIVE_PREPARATION_UNAVAILABLE"));
  assertRowEngine(row, engine);
  if (configuredEngineSlotCount(row) !== configuredEngineSlotCount(engine))
    throw new Error("COINOPS_ENGINE_SLOT_COUNT_MISMATCH");
  return { ...row, engine } as Preparation;
}

async function runRows(service: Service, run: Run) {
  return boundedLedgerRead(async (deadline, attempt) => {
    const [s, o, a] = await Promise.allSettled([
      observeLedgerRows<Slot>("slots", service.from("robot_v1_live_slots").select("*")
        .eq("run_id", run.id).eq("tenant_id", run.tenant_id).eq("trading_engine_id", run.trading_engine_id)
        .order("slot_number").abortSignal(deadline), deadline, attempt),
      completeLedgerRead<Order>(async (start, end) => ({ error: null,
        data: await observeLedgerRows<Order>("orders", service.from("robot_v1_live_orders").select("*")
          .eq("run_id", run.id).eq("tenant_id", run.tenant_id).eq("trading_engine_id", run.trading_engine_id)
          .order("created_at").order("id").range(start, end).abortSignal(deadline), deadline, attempt) }),
      "COINOPS_LIVE_LEDGER_INCOMPLETE"),
      observeLedgerRows<Account>("slot_accounts", service.from("robot_v1_live_slot_accounts").select("*")
        .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id).eq("user_id", run.user_id)
        .eq("trading_engine_id", run.trading_engine_id).order("slot_number").abortSignal(deadline), deadline, attempt),
    ]);
    // Wait for every bounded observation: a transient response must not hide
    // a simultaneous permission/schema failure from another ledger table.
    for (const result of [s, o, a]) if (result.status === "rejected"
      && !(result.reason instanceof LiveReadUnavailable)) throw result.reason;
    if (s.status === "rejected") throw s.reason;
    if (o.status === "rejected") throw o.reason;
    if (a.status === "rejected") throw a.reason;
    const slots = s.value, orders = o.value, accounts = a.value;
    if (!run.engine) throw new Error("COINOPS_LIVE_ENGINE_UNRESOLVED");
    const slotCount = configuredEngineSlotCount(run.engine);
    assertPhysicalLedger(slots, slotCount); assertPhysicalLedger(accounts, slotCount);
    for (const row of [...slots, ...orders, ...accounts]) assertRowEngine(row, run.engine);
    return { slots, orders, accounts };
  });
}

async function event(service: Service, run: Run, key: string, type: string,
  slotNumber: number | null, details: Record<string, unknown> = {}) {
  const result = await service.from("robot_v1_live_events").upsert({ run_id: run.id, ...owned(run),
    event_key: key, event_type: type, slot_number: slotNumber, details },
  { onConflict: "run_id,event_key", ignoreDuplicates: true });
  if (result.error) throw new Error("COINOPS_LIVE_EVENT_PERSIST_FAILED");
}

async function flowOwner(service: Service, run: Run, kind: "GAIN" | "FILL", clientId: string,
  slot: number, quantity?: number) {
  try {
    await event(service, run, `FLOW_OWNER:${kind}:${clientId}:${quantity ?? "gain"}`, "TRADING_FLOW_OWNER", slot,
      { kind, client_order_id: clientId, ...(quantity !== undefined ? { executed_quantity: quantity } : {}),
        source: run.execution_source?.startsWith("WATCHDOG") ? "WATCHDOG" : run.execution_source ? "ENGINE" : "UNKNOWN" });
  } catch {
    // Missing attribution is UNKNOWN in the SLO, not 0% dependency. Telemetry
    // failure must never interrupt protection after an already persisted fill.
    console.error(JSON.stringify({ event: "COINOPS_FLOW_ATTRIBUTION_FAILED", engine_id: run.trading_engine_id, run_id: run.id }));
  }
}

function candidate(slot: Slot, account: Account, rank: number | null,
  reached: boolean, eligible: boolean): StrategyCandidate {
  return { id: slot.id, slotNumber: slot.slot_number, operationSequence: slot.operation_sequence,
    buyPrice: amount(slot.target_buy_price), balanceQuote: amount(account.balance_brl),
    operationalRank: rank === null ? null : slot.post_ath_group ? slot.operational_rank ?? rank : rank,
    monthlyTargetReached: reached, monthlyEntryEligible: eligible, postAthGroup: slot.post_ath_group,
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
  const until = new Date(Date.now() + LIVE_LEASE_MS).toISOString();
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
    .update({ lease_owner: owner, lease_until: new Date(now.getTime() + LIVE_LEASE_MS).toISOString() })
    .eq("id", runId).eq("tenant_id", getCoinOpsServiceTenantId()).in("status", ["ACTIVE", "PAUSED"])
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`).select("*").maybeSingle();
  if (result.error) throw new Error("COINOPS_LIVE_LEASE_FAILED");
  return result.data as Run | null;
}

async function release(service: Service, run: Run, error: string | null, reconciled = true) {
  const result = await service.from("robot_v1_live_runs").update({ lease_owner: null,
    lease_until: null, ...(reconciled ? { last_reconciled_at: new Date().toISOString(),
      ...(run.reconciliation_checkpoint ? { reconciliation_checkpoint: null } : {}) } : {}), last_error: error })
    .eq("id", run.id).eq("tenant_id", run.tenant_id).eq("lease_owner", run.lease_owner);
  if (result.error) throw new Error("COINOPS_LIVE_LEASE_RELEASE_FAILED");
}

async function closeNewBuyGates(service: Service, run: Run) {
  const gate = await service.from("trading_engines").update({ kill_switch: true })
    .eq("id", run.trading_engine_id).eq("operator_id", run.operator_id)
    .eq("exchange_account_id", run.exchange_account_id);
  if (gate.error) throw new Error("COINOPS_LIVE_ENGINE_KILL_SWITCH_PERSIST_FAILED");
  const result = await service.from("robot_v1_live_preparations").update({ kill_switch: true })
    .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id)
    .eq("user_id", run.user_id).eq("trading_engine_id", run.trading_engine_id);
  if (result.error) throw new Error("COINOPS_LIVE_KILL_SWITCH_PERSIST_FAILED");
}

async function preventNewBuys(service: Service, run: Run, code: string, evidence: Record<string, unknown> = {}) {
  await closeNewBuyGates(service, run);
  const alert = await service.from("robot_v1_live_alerts").upsert({ ...owned(run), asset: run.asset,
    alert_key: `LIVE_RUN:${run.id}:CRITICAL`, severity: "CRITICAL", code,
    details: { ...evidence, run_id: run.id }, last_seen_at: new Date().toISOString(), resolved_at: null },
  { onConflict: "trading_engine_id,alert_key" });
  if (alert.error) throw new Error("COINOPS_LIVE_ALERT_PERSIST_FAILED");
}

const TRANSIENT_EXECUTOR_READ_CODES = new Set([
  "EXECUTOR_UNAVAILABLE", "EXECUTOR_BINANCE_READ_UNAVAILABLE", "EXECUTOR_BINANCE_RATE_LIMITED",
  "EXECUTOR_HTTP_502", "EXECUTOR_HTTP_503", "EXECUTOR_HTTP_504",
]);

/** A failed observation never authorizes a new order. Keep the run retryable
 * while the exchange is briefly unavailable; only a prolonged outage locks
 * this engine. Neither path changes a sibling engine or an existing TP. */
async function holdTransientExecutorRead(service: Service, run: Run, evidence: Record<string, unknown> = {}) {
  const ledgerRead = evidence.root_code === "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE";
  const feeRead = evidence.root_code === "COINOPS_LIVE_BNB_FEE_BALANCE_UNAVAILABLE";
  const alertKey = `LIVE_RUN:${run.id}:${feeRead ? "BNB_FEE_READ" : "TRANSIENT_EXECUTOR_READ"}`;
  const previous = await service.from("robot_v1_live_alerts").select("first_seen_at")
    .eq("trading_engine_id", run.trading_engine_id).eq("alert_key", alertKey)
    .is("resolved_at", null).maybeSingle();
  if (previous.error) throw new Error("COINOPS_LIVE_TRANSIENT_ALERT_READ_FAILED");
  if (previous.data && Date.now() - Date.parse(previous.data.first_seen_at) > 5 * 60_000) {
    await preventNewBuys(service, run, ledgerRead ? "COINOPS_LIVE_LEDGER_READ_STALE"
      : "COINOPS_LIVE_EXECUTOR_READ_STALE", evidence);
    return false;
  }
  // A fee-only checkpoint must survive successful TP/fill reconciliation. It
  // is resolved only by a valid fresh fee observation, not by a healthy tick.
  if (feeRead && previous.data) return true;
  const alert = await service.from("robot_v1_live_alerts").upsert({ ...owned(run), asset: run.asset,
    alert_key: alertKey, severity: "WARNING", code: feeRead ? "COINOPS_LIVE_BNB_FEE_BALANCE_UNAVAILABLE"
      : ledgerRead ? "COINOPS_LIVE_TRANSIENT_LEDGER_READ"
      : "COINOPS_LIVE_TRANSIENT_EXECUTOR_READ",
    details: { ...evidence, run_id: run.id }, first_seen_at: previous.data?.first_seen_at ?? new Date().toISOString(),
    last_seen_at: new Date().toISOString(), resolved_at: null },
  { onConflict: "trading_engine_id,alert_key" });
  if (alert.error) throw new Error("COINOPS_LIVE_TRANSIENT_ALERT_PERSIST_FAILED");
  return true;
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
  return readLiveExposure(service, run);
}

async function assertExchangeMatchesLedger(run: Run, orders: Order[], state: LiveExecutorState,
  dispatchingClientOrderId: string | null = null) {
  if (state.symbol !== run.symbol || Date.now() - Date.parse(state.observed_at) > 30_000
    || !state.price.price || Date.now() - Date.parse(state.price.observedAt) > 30_000)
    throw new Error("COINOPS_LIVE_EXCHANGE_SNAPSHOT_STALE");
  if (!run.engine) throw new Error("COINOPS_LIVE_ENGINE_UNRESOLVED");
  assertRowEngine(state, run.engine);
  const own = state.open_orders.filter((item) => item.clientOrderId?.startsWith(liveEngineOrderPrefix(run.engine!)));
  const ledger = new Map(orders.filter((item) => LIVE_ACTIVE_ORDER_STATUSES.has(item.status))
    .map((item) => [item.client_order_id, item]));
  for (const observed of own) {
    const entry = ledger.get(observed.clientOrderId ?? "");
    if (!entry || entry.side !== observed.side || entry.exchange_order_id !== observed.id)
      throw new Error("COINOPS_LIVE_UNRECONCILED_EXCHANGE_ORDER");
    ledger.delete(observed.clientOrderId!);
  }
  for (const pending of ledger.values()) {
    if (pending.submission_guarded_at !== null && pending.client_order_id !== dispatchingClientOrderId
      && !(pending.status === "PREPARED" && pending.exchange_order_id === null
        && amount(pending.executed_quantity) === 0 && amount(pending.cumulative_quote) === 0
        && pending.account_order_unsent_receipt?.request_nonce)) {
      // openOrders is a snapshot, not proof of a lost order. Verify the exact
      // persisted Binance ID before deciding whether this is an ordinary fill.
      if (pending.exchange_order_id) {
        const observed = (await readLiveExecutorOrder(run, pending.client_order_id,
          pending.exchange_order_id)).order;
        if (observed?.status === "FILLED") {
          const evidence = await readLiveExecutorTrades(run, pending.client_order_id,
            pending.exchange_order_id);
          if (isConfirmedFilledSnapshotRace(pending, run.symbol, observed,
            evidence.order, evidence.trades))
            throw new Error("COINOPS_LIVE_FILLED_DURING_SNAPSHOT");
        }
      }
      throw new Error("COINOPS_LIVE_EXCHANGE_ORDER_MISSING");
    }
  }
  return own.map((item) => item.clientOrderId!);
}

async function prepareOrder(service: Service, run: Run, slot: Slot, decision: StrategyDecision,
  side: "BUY" | "SELL", purpose: Order["purpose"], revision: number,
  quantity: number | null, quote: number | null, price: number | null) {
  await persistStrategyDecision(service, owned(run), "REAL", decision, slot.operation_sequence);
  if (!run.engine) throw new Error("COINOPS_LIVE_ENGINE_UNRESOLVED");
  const clientId = liveClientOrderId(run.id, run.asset, slot.slot_number, slot.operation_sequence, side, revision, run.engine);
  await renewLease(service, run);
  const result = await service.rpc("prepare_robot_v1_live_order", {
    p_run_id: run.id, p_slot_id: slot.id, p_side: side, p_purpose: purpose,
    p_revision: revision, p_client_order_id: clientId, p_quantity: quantity,
    p_quote: quote, p_price: price, p_decision_id: decision.decision_id,
    p_lease_owner: run.lease_owner,
  });
  const order = (Array.isArray(result.data) ? result.data[0] : result.data) as Order | null;
  if (result.error || !order || order.client_order_id !== clientId || order.run_id !== run.id)
    throw new Error(result.error?.message?.includes("COINOPS_STRATEGY_CONFIG_UPDATE_PENDING")
      ? "COINOPS_STRATEGY_CONFIG_UPDATE_PENDING" : "COINOPS_LIVE_ORDER_PREPARE_FAILED");
  await event(service, run, `${clientId}:PREPARED`, "ORDER_PREPARED", slot.slot_number,
    { side, purpose, revision, decision_id: decision.decision_id });
  return order;
}

function assertLiveOrderPrice(run: Run, ledger: Ledger, order: Order, tick: number,
  observedPrice?: number | null) {
  if (order.purpose === "INITIAL") return;
  const slot = ledger.slots.find((item) => item.id === order.slot_id);
  if (!slot || !order.price) throw new Error("COINOPS_STRATEGY_PRICE_INVARIANT_FAILED");
  const check = (price: number) => {
    if (order.side === "BUY") {
      const rates = strategyRatesForOrder(order, run);
      assertStrategyBuyPrice({ price, referencePrice: amount(slot.entry_reference_price),
        anchorPrice: rates.anchor, spacing: rates.spacing, tick, entryOrigin: slot.entry_origin,
        slotCount: configuredEngineSlotCount(run.engine ?? run) });
    } else {
      const buys = ledger.orders.filter((item) => item.slot_id === slot.id
        && item.operation_sequence === order.operation_sequence && item.side === "BUY"
        && amount(item.executed_quantity) > 0);
      const quantity = buys.reduce((sum, item) => sum + amount(item.executed_quantity), 0);
      if (!quantity) throw new Error("COINOPS_STRATEGY_PRICE_INVARIANT_FAILED");
      const averageFillPrice = buys.reduce((sum, item) => sum + amount(item.cumulative_quote), 0) / quantity;
      const rates = strategyRatesForOrder(order, run);
      assertStrategyTakeProfitPrice({ price, averageFillPrice,
        gainRate: rates.gain, spacing: rates.spacing, tick });
    }
  };
  check(amount(order.price));
  if (observedPrice !== undefined && observedPrice !== null) check(observedPrice);
}

function assertLiveResidentPrices(run: Run, ledger: Ledger, state: LiveExecutorState) {
  for (const order of ledger.orders.filter((item) => LIVE_ACTIVE_ORDER_STATUSES.has(item.status))) {
    const observed = state.open_orders.find((item) => item.clientOrderId === order.client_order_id);
    // A missing order may have filled since the snapshot; reconcile it first.
    // A resident price mismatch is deterministic and must stop new dispatches.
    assertLiveOrderPrice(run, ledger, order, state.filters.priceTick, observed?.price);
  }
}

type ReconciliationFeeValuation = { scope_key: string;
  quote: { symbol: string; price: number; observedAt: string } | null; refresh?: Promise<void> };
const RECONCILIATION_FEE_QUOTE_MAX_AGE_MS = 60_000;
function reconciliationFeeScope(run: Run) {
  return JSON.stringify([run.id, run.operator_id, run.exchange_account_id,
    run.trading_engine_id, run.symbol, run.quote_asset, run.engine?.executor_shard_id ?? null]);
}
/** Invocation-local fee conversion only. Never retain balances, open orders,
 * filters or a state snapshot that could authorize a later exchange write. */
function createReconciliationFeeValuation(run: Run, state?: LiveExecutorState): ReconciliationFeeValuation {
  const quote = state?.bnb_quote_price ?? state?.bnb_brl_price;
  return { scope_key: reconciliationFeeScope(run), quote: quote ? { ...quote } : null };
}
function observeReconciliationFeeValuation(run: Run, state: LiveExecutorState, context: ReconciliationFeeValuation) {
  if (context.scope_key !== reconciliationFeeScope(run))
    throw new Error("COINOPS_LIVE_FEE_VALUATION_SCOPE_MISMATCH");
  // Capture only a quote from a mandatory fresh financial observation. The
  // context never retains that observation or authorizes another dispatch.
  const quote = state.bnb_quote_price ?? state.bnb_brl_price;
  context.quote = quote ? { ...quote } : null;
}
async function readReconciliationFeeValuation(run: Run, trades: LiveTrade[], context: ReconciliationFeeValuation) {
  if (context.scope_key !== reconciliationFeeScope(run))
    throw new Error("COINOPS_LIVE_FEE_VALUATION_SCOPE_MISMATCH");
  // The canonical SQL requires a quote for every BNB-denominated fee row,
  // including a zero commission. Other assets cannot invent a BNB valuation.
  if (!trades.some(trade => trade.commissionAsset === "BNB")) return null;
  const fresh = () => {
    const quote = context.quote, now = Date.now(), observedAt = Date.parse(quote?.observedAt ?? "");
    return quote?.symbol === `BNB${run.quote_asset}` && Number.isFinite(quote.price) && quote.price > 0
      && Number.isFinite(observedAt) && observedAt >= now - RECONCILIATION_FEE_QUOTE_MAX_AGE_MS
      && observedAt <= now + 5_000;
  };
  if (!fresh()) {
    // Refresh through the same scoped, authenticated observation. This does
    // not retry the sync RPC or relax its own independent freshness guard.
    // Independent ACKed TP observations share one in-flight quote refresh.
    context.refresh ??= (async () => {
      const state = await readLiveExecutorState(run);
      const quote = state.bnb_quote_price ?? state.bnb_brl_price;
      context.quote = quote ? { ...quote } : null;
    })();
    const refresh = context.refresh;
    try { await refresh; }
    finally { if (context.refresh === refresh) context.refresh = undefined; }
  }
  if (!fresh()) throw new Error("COINOPS_LIVE_BNB_FEE_PRICE_STALE");
  return context.quote;
}

async function reconcileOrder(service: Service, run: Run, order: Order,
  feeValuation?: ReconciliationFeeValuation) {
  if (feeValuation && feeValuation.scope_key !== reconciliationFeeScope(run))
    throw new Error("COINOPS_LIVE_FEE_VALUATION_SCOPE_MISMATCH");
  if (order.trades_reconciled && LIVE_TERMINAL_ORDER_STATUSES.has(order.status)) return order;
  // Creation/protection callers do not always have the phase-wide context.
  // For large engines they still need only a BNB quote, and no quote at all
  // when an acknowledged NEW TP has no trades. Preserve the legacy25 path.
  if (!feeValuation && configuredEngineSlotCount(run.engine ?? run) > 25)
    feeValuation = createReconciliationFeeValuation(run);
  // A coherent, owned order+fills observation avoids querying the same exact
  // order again in a second HTTP context. No financial snapshot is cached.
  // Legacy25 remains on its previous query/trades protocol.
  const coherentObservation = configuredEngineSlotCount(run.engine ?? run) > 25;
  const orderObservation = coherentObservation
    ? await readLiveExecutorOrderObservation(run, order.client_order_id, order.exchange_order_id) : null;
  let observed = orderObservation ? orderObservation.order
    : (await readLiveExecutorOrder(run, order.client_order_id, order.exchange_order_id)).order;
  if (observed && unchangedUnfilledResidentOrder(order, observed, run.symbol)) return order;
  if (!observed) {
    if (order.status !== "PREPARED") throw new Error("COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN");
    if (order.submission_guarded_at !== null) {
      const decision = await service.from("robot_v1_strategy_decisions")
        .select("decision_id,cycle_id,slot_id,operation_sequence,action_type,result,dispatched_at,exchange_ack_at,completed_at")
        .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id).eq("user_id", run.user_id)
        .eq("operator_id", run.operator_id).eq("exchange_account_id", run.exchange_account_id)
        .eq("trading_engine_id", run.trading_engine_id).eq("environment", "REAL")
        .eq("decision_id", order.strategy_decision_id ?? "").maybeSingle();
      let certifiedUnsent = Boolean(order.account_order_unsent_receipt?.request_nonce
        && decision.data?.result === "PENDING" && decision.data.dispatched_at === null
        && decision.data.exchange_ack_at === null && decision.data.completed_at === null);
      if (!decision.error && !certifiedUnsent && mayAttestUnsentEntry(order, decision.data)) {
        const recoveryHealth = await loadLiveEngineExecutorStatus(run);
        if (["LIVE_EXECUTOR_ACTIVE", "LIVE_EXECUTOR_PROTECTED"].includes(recoveryHealth.gate)
          && recoveryHealth.health?.unsent_recovery_protocol === 1) {
          await renewLease(service, run);
          try { await proveLiveExecutorUnsentOrder(run, order.client_order_id, order.strategy_decision_id!, decision.data!.dispatched_at!); }
          catch (error) {
            if (!(error instanceof AccountOrderNotSubmitted)) throw new Error("COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN");
            await renewLease(service, run);
            const released = await service.rpc("release_proven_unsent_account_order", {
              p_operator_id: run.operator_id, p_account_id: run.exchange_account_id, p_engine_id: run.trading_engine_id,
              p_client_order_id: order.client_order_id, p_lease_owner: run.lease_owner,
              p_dispatched_at: decision.data!.dispatched_at, p_proof: error.receipt });
            if (released.error || released.data !== true) throw new Error("COINOPS_ACCOUNT_ORDER_UNSENT_UNPROVEN");
            order.account_order_unsent_receipt = error.receipt;
            certifiedUnsent = true;
          }
        }
      }
      if (decision.error || !certifiedUnsent && !isProvablyUnsentTakeProfit(order, decision.data, Date.now()))
        throw new Error("COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN");
    }
    await validateRunEngine(service, run);
    if (order.side === "BUY" && (entryBlocked(run) || await configUpdatePending(service, run))) return order;
    const health = await loadLiveEngineExecutorStatus(run);
    if (order.side === "BUY" && health.gate !== "LIVE_EXECUTOR_ACTIVE") return order;
    if (order.side === "SELL" && !["LIVE_EXECUTOR_ACTIVE", "LIVE_EXECUTOR_PROTECTED"].includes(health.gate))
      throw new Error("COINOPS_LIVE_TP_EXECUTOR_UNAVAILABLE");
    const state = await readLiveExecutorState(run);
    if (feeValuation) observeReconciliationFeeValuation(run, state, feeValuation);
    const rows = await runRows(service, run);
    assertLiveOrderPrice(run, rows, order, state.filters.priceTick);
    const expectedOwnedOpenIds = await assertExchangeMatchesLedger(run, rows.orders, state,
      order.client_order_id);
    if (order.side === "BUY") {
      const slot = rows.slots.find(item => item.id === order.slot_id);
      if (!slot) throw new Error("COINOPS_LIVE_ORDER_SLOT_MISSING");
      if (await holdEntryForBnbFeeBalance(service, run, slot, state)) return order;
      if (await holdEntryForQuoteBalance(service, run, slot, state,
        order.purpose === "INITIAL" ? amount(order.requested_quote)
          : amount(order.requested_quantity) * amount(order.price))) return order;
    }
    const caps = await service.from("robot_v1_live_preparations")
      .select("max_total_exposure_brl,kill_switch,live_enabled")
      .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id)
      .eq("user_id", run.user_id).eq("trading_engine_id", run.trading_engine_id).single();
    const globalCap = await quoteCap(service, run);
    if (caps.error || !caps.data
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
      globalCapBrl: globalCap,
      assetExposureBeforeBrl: pre[run.asset] - reserve,
      globalExposureBeforeBrl: pre.global - reserve,
      ...(order.side === "SELL" ? { sourceBuyClientOrderId: buy?.client_order_id,
        sourceBuyOrderId: buy?.exchange_order_id } : {}) };
    if (order.side === "SELL" && !buy) throw new Error("COINOPS_LIVE_TP_BUY_SOURCE_MISSING");
    await renewLease(service, run);
    const required = await accountExecutionPolicyRequired(service, run) || health.health?.account_order_budget_enforced === true;
    const budget = await reserveAccountOrderDispatch(service, run, order.client_order_id, order.side, run.lease_owner, required);
    if (order.submission_guarded_at === null) {
      const guard = await service.from("robot_v1_live_orders")
        .update({ submission_guarded_at: new Date().toISOString() })
        .eq("id", order.id).eq("run_id", run.id).eq("status", "PREPARED")
        .is("submission_guarded_at", null).select("submission_guarded_at").maybeSingle();
      if (guard.error || !guard.data) throw new Error("COINOPS_LIVE_SUBMISSION_GUARD_FAILED");
      order.submission_guarded_at = guard.data.submission_guarded_at;
    }
    let dispatchedAt: string;
    if (order.account_order_unsent_receipt) {
      const claimed = await service.rpc("claim_proven_unsent_account_order", { p_operator_id: run.operator_id,
        p_account_id: run.exchange_account_id, p_engine_id: run.trading_engine_id,
        p_client_order_id: order.client_order_id, p_lease_owner: run.lease_owner,
        p_proof_nonce: order.account_order_unsent_receipt.request_nonce });
      if (claimed.error || typeof claimed.data !== "string") throw new Error("COINOPS_ACCOUNT_ORDER_UNSENT_UNPROVEN");
      dispatchedAt = claimed.data;
      order.account_order_unsent_receipt = null;
    } else dispatchedAt = await dispatchStrategyDecision(service, owned(run), "REAL", order.strategy_decision_id!);
    try { observed = (await createLiveExecutorOrder(input, run, order.strategy_decision_id!, undefined, undefined, budget)).order; }
    catch (error) {
      if (!(error instanceof AccountOrderNotSubmitted)) throw error;
      await renewLease(service, run);
      const reset = await service.rpc("release_proven_unsent_account_order", { p_operator_id: run.operator_id,
        p_account_id: run.exchange_account_id, p_engine_id: run.trading_engine_id,
        p_client_order_id: order.client_order_id, p_lease_owner: run.lease_owner,
        p_dispatched_at: dispatchedAt, p_proof: error.receipt });
      if (reset.error || reset.data !== true) throw new Error("COINOPS_ACCOUNT_ORDER_UNSENT_UNPROVEN");
      order.account_order_unsent_receipt = error.receipt;
      if (order.side === "BUY") {
        const fresh = await readLiveExecutorState(run);
        const slot = rows.slots.find(item => item.id === order.slot_id);
        if (!slot) throw new Error("COINOPS_LIVE_ORDER_SLOT_MISSING");
        if (await holdEntryForBnbFeeBalance(service, run, slot, fresh)) return order;
        if (await holdEntryForQuoteBalance(service, run, slot, fresh,
          order.purpose === "INITIAL" ? amount(order.requested_quote)
            : amount(order.requested_quantity) * amount(order.price))) return order;
      }
      throw new AccountOrderBudgetHold("COINOPS_ACCOUNT_ORDER_NOT_SUBMITTED", order.client_order_id, order.side);
    }
  }
  if (observed.clientOrderId !== order.client_order_id || observed.symbol !== run.symbol
    || observed.side !== order.side) throw new Error("COINOPS_LIVE_ORDER_OWNERSHIP_MISMATCH");
  const withTrades = coherentObservation
    ? orderObservation?.order ? orderObservation
      : await readLiveExecutorOrderObservation(run, order.client_order_id, observed.orderId)
    : await readLiveExecutorTrades(run, order.client_order_id, observed.orderId);
  if (!withTrades.order || !withTrades.trades) throw new Error("COINOPS_LIVE_ORDER_TRADES_UNAVAILABLE");
  if (withTrades.order.orderId !== observed.orderId || withTrades.order.clientOrderId !== order.client_order_id
    || withTrades.order.symbol !== run.symbol || withTrades.order.side !== order.side)
    throw new Error("COINOPS_LIVE_ORDER_OWNERSHIP_MISMATCH");
  const feeQuote = feeValuation
    ? await readReconciliationFeeValuation(run, withTrades.trades, feeValuation)
    : (await readLiveExecutorState(run)).bnb_brl_price;
  await renewLease(service, run);
  const synced = await service.rpc("sync_robot_v1_live_order", {
    p_order_id: order.id, p_exchange_order_id: observed.orderId,
    p_status: withTrades.order.status, p_executed_quantity: withTrades.order.executedQuantity,
    p_cumulative_quote: withTrades.order.cumulativeQuoteQuantity,
    p_trades: withTrades.trades, p_bnb_brl_price: feeQuote?.price ?? null,
    p_bnb_brl_observed_at: feeQuote?.observedAt ?? null,
    p_lease_owner: run.lease_owner,
  });
  const saved = (Array.isArray(synced.data) ? synced.data[0] : synced.data) as Order | null;
  if (synced.error || !saved || saved.id !== order.id) throw new Error("COINOPS_LIVE_ORDER_RECONCILIATION_FAILED");
  if (amount(saved.executed_quantity) > amount(order.executed_quantity))
    await flowOwner(service, run, "FILL", order.client_order_id, order.slot_number, amount(saved.executed_quantity));
  Object.assign(order, saved);
  await acknowledgeAccountOrderDispatch(service, run, order.client_order_id, run.lease_owner);
  if (order.strategy_decision_id && (amount(order.executed_quantity) > 0 || order.status === "NEW"))
    await completeStrategyDecision(service, owned(run), "REAL", order.strategy_decision_id!,
      { exchange_order_id: order.exchange_order_id, status: order.status,
        executed_quantity: amount(order.executed_quantity) }, true);
  return order;
}

/** Observe/sync independent, already-acknowledged SELLs concurrently. These
 * rows cannot enter reconcileOrder's PREPARED/create path. Stop scheduling on
 * failure and drain all in-flight SQL before releasing the single run lease. */
async function reconcileAcknowledgedSellOrders(service: Service, run: Run, orders: Order[],
  feeValuation: ReconciliationFeeValuation) {
  const acknowledged = orders.filter(order => order.side === "SELL" && order.exchange_order_id !== null
    && order.status !== "PREPARED"
    && !(order.trades_reconciled && LIVE_TERMINAL_ORDER_STATUSES.has(order.status)));
  if (new Set(acknowledged.map(order => order.id)).size !== acknowledged.length)
    throw new Error("COINOPS_LIVE_DUPLICATE_ORDER_ID");
  let next = 0, failed = false, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(4, acknowledged.length) }, async () => {
    while (!failed) {
      const index = next++;
      if (index >= acknowledged.length) return;
      try { await reconcileOrder(service, run, acknowledged[index], feeValuation); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }));
  if (failed) throw failure;
  return new Set(acknowledged.map(order => order.id));
}

function symbolFilters(state: LiveExecutorState): ExchangeSymbolInfo {
  return { symbol: state.symbol, baseAsset: state.filters.baseAsset, quoteAsset: state.filters.quoteAsset,
    minQuantity: state.filters.minQuantity, maxQuantity: state.filters.maxQuantity,
    quantityStep: state.filters.quantityStep, minNotional: state.filters.minNotional,
    priceTick: state.filters.priceTick };
}

function operationOrders(orders: Order[], slot: Slot) {
  return orders.filter((order) => order.slot_id === slot.id
    && order.operation_sequence === slot.operation_sequence);
}

async function cancelOwnedEntry(service: Service, run: Run, order: Order, onlyUnfilled = false,
  feeValuation?: ReconciliationFeeValuation) {
  if (order.side !== "BUY" || !order.exchange_order_id
    || !["NEW", "PARTIALLY_FILLED"].includes(order.status))
    throw new Error("COINOPS_LIVE_BUY_NOT_CANCELABLE");
  await renewLease(service, run);
  try {
    const result = await cancelLiveExecutorOrder({ symbol: run.symbol,
      clientOrderId: order.client_order_id, orderId: order.exchange_order_id,
      ...(onlyUnfilled ? { onlyUnfilled: true } : {}) }, run);
    if (!onlyUnfilled && result.order.status !== "CANCELED") throw new Error("COINOPS_LIVE_BUY_CANCEL_UNCERTAIN");
  } catch (error) {
    if (!onlyUnfilled) throw error;
    // A timeout is not a failed cancellation. Read the SAME order; never send
    // another cancel/create based on the error alone.
    await reconcileOrder(service, run, order, feeValuation);
    if (order.status !== "CANCELED" && amount(order.executed_quantity) === 0) throw error;
  }
  await reconcileOrder(service, run, order, feeValuation);
  if (onlyUnfilled && amount(order.executed_quantity) > 0) return false;
  if (order.status !== "CANCELED") throw new Error("COINOPS_LIVE_BUY_CANCEL_UNRECONCILED");
  return amount(order.executed_quantity) === 0 && amount(order.cumulative_quote) === 0 && order.trades_reconciled;
}

async function retireNeverSubmittedEntry(service: Service, run: Run, order: Order) {
  if (order.side !== "BUY" || order.status !== "PREPARED" || order.exchange_order_id
    || order.submission_guarded_at || amount(order.executed_quantity) > 0
    || !await configUpdatePending(service, run))
    throw new Error("COINOPS_BULK_PREPARED_BUY_AMBIGUOUS");
  const observed = await readLiveExecutorOrder(run, order.client_order_id, null);
  if (observed.order) throw new Error("COINOPS_LIVE_FILLED_DURING_SNAPSHOT");
  await renewLease(service, run);
  const retired = await service.from("robot_v1_live_orders")
    .update({ status: "CANCELED", trades_reconciled: true, reserved_notional_brl: 0 })
    .eq("id", order.id).eq("run_id", run.id).eq("trading_engine_id", run.trading_engine_id)
    .eq("status", "PREPARED").is("submission_guarded_at", null)
    .is("exchange_order_id", null).eq("executed_quantity", 0)
    .select("id,status").maybeSingle();
  if (retired.error || !retired.data) throw new Error("COINOPS_BULK_PREPARED_BUY_CONFLICT");
  order.status = "CANCELED";
  await event(service, run, `CONFIG_PREPARED_BUY_RETIRED:${order.client_order_id}`,
    "CONFIG_PREPARED_BUY_RETIRED", order.slot_number, { client_order_id: order.client_order_id });
}

async function ensureTakeProfits(service: Service, run: Run, ledger: Ledger,
  state: LiveExecutorState, feeValuation?: ReconciliationFeeValuation) {
  const filters = symbolFilters(state);
  // One complete immutable-gain observation per protection phase, not one per TP.
  let statuses: Awaited<ReturnType<typeof monthly>> | undefined;
  for (const slot of ledger.slots) {
    let orders = operationOrders(ledger.orders, slot);
    let buys = orders.filter((item) => item.side === "BUY" && amount(item.executed_quantity) > 0);
    if (!buys.length) continue;
    for (const buy of buys.filter((item) => item.status === "PARTIALLY_FILLED"))
      await cancelOwnedEntry(service, run, buy, false, feeValuation);
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
    statuses ??= await monthly(service, run, ledger.slots, ledger.accounts);
    const status = statuses
      .find((item) => item.physicalSlotNumber === slot.slot_number);
    if (!status) throw new Error("COINOPS_LIVE_MONTHLY_STATUS_MISSING");
    const tp = planStrategyTakeProfit(context(run, `TP:${revision}`),
      { ...candidate(slot, ledger.accounts.find((item) => item.slot_number === slot.slot_number)!,
        status.operationalRank, status.monthlyTargetReached, status.eligibleForNewEntry), state: "OPEN" },
      buyQuote / buyQuantity, filters,
      { gainRate: strategyRatesForOrder(buys[0], run).gain,
        entrySpacing: strategyRatesForOrder(buys[0], run).spacing });
    const price = tp.target_price;
    if (tp.action_type !== "CREATE_TP" || price === null
      || uncovered * price + 1e-8 < state.filters.minNotional)
      throw new Error("COINOPS_LIVE_TP_FILTER_UNPROTECTABLE");
    const order = await prepareOrder(service, run, slot, tp, "SELL", "TP", revision,
      uncovered, null, price);
    ledger.orders.push(order);
    await reconcileOrder(service, run, order, feeValuation);
  }
}

async function creditClosedSlots(service: Service, run: Run, ledger: Ledger,
  state: { filters: Pick<LiveExecutorState["filters"], "quantityStep"> }, yieldAfterCompletedSlot?: () => Promise<boolean>) {
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
    await flowOwner(service, run, "GAIN", tp.client_order_id, slot.slot_number);
    Object.assign(ledger.accounts.find((item) => item.slot_number === slot.slot_number)!, account);
    await updateSlot(service, run, slot, { entry_state: "CLOSED" });
    if (await yieldAfterCompletedSlot?.()) return true;
  }
  return false;
}

async function recycleClosedSlots(service: Service, run: Run, ledger: Ledger,
  yieldAfterCompletedSlot?: () => Promise<boolean>) {
  const statuses = await monthly(service, run, ledger.slots, ledger.accounts);
  const candidates = ledger.slots.map((slot) => {
    const account = ledger.accounts.find((item) => item.slot_number === slot.slot_number)!;
    const status = statuses.find((item) => item.physicalSlotNumber === slot.slot_number)!;
    return candidate(slot, account, status.operationalRank, status.monthlyTargetReached, status.eligibleForNewEntry);
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
    if (await yieldAfterCompletedSlot?.()) return true;
  }
  return false;
}

async function refreshRealAthProfile(service: Service, run: Run) {
  // The legacy Rafael ATH baseline is explicitly USDC even for BRL execution.
  // Switching its unit during scope migration would manufacture a new ATH.
  if (!run.engine?.ath_reference_symbol) throw new Error("COINOPS_LIVE_ATH_REFERENCE_MISSING");
  const response = await fetch(`${PUBLIC_SPOT}/api/v3/ticker/price?symbol=${run.engine.ath_reference_symbol}`,
    { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("COINOPS_LIVE_ATH_PRICE_UNAVAILABLE");
  const quote = await response.json() as { price?: string };
  const price = Number(quote.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error("COINOPS_LIVE_ATH_PRICE_INVALID");
  return refreshAthProfile(service, athScope(run), "REAL", run.asset, { price, observedAt: new Date().toISOString() });
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
    .eq("environment", "REAL").eq("trading_engine_id", run.trading_engine_id)
    .eq("config_version", profile.config_version).eq("updated_at", profile.updated_at)
    .select("*").maybeSingle();
  if (result.error || !result.data) throw new Error("COINOPS_LIVE_PROFILE_ACTIVATION_FAILED");
  const activated = result.data as AthProfileRow;
  const audit = await service.from("robot_v1_ath_events").upsert({
    profile_id: activated.id, ...owned(run), environment: "REAL", asset: run.asset,
    event_key: `STRATEGY_CONFIG_ACTIVATED:${version}`,
    event_type: "STRATEGY_CONFIG_ACTIVATED",
    details: { config_version: version, gain_rate: gain,
      normal_spacing_rate: normal, post_ath_spacing_rate: post },
  }, { onConflict: "profile_id,event_key", ignoreDuplicates: true });
  if (audit.error) throw new Error("COINOPS_LIVE_PROFILE_AUDIT_FAILED");
  return activated;
}

async function applyAthTransition(service: Service, run: Run, ledger: Ledger,
  state: LiveExecutorState, force = false) {
  const profile = await refreshRealAthProfile(service, run);
  const period = monthlyPeriodKey(new Date());
  if (!force && run.entry_regime === profile.regime && run.ath_transition_key === profile.transition_key
    && run.ath_period_key === period) return false;
  const active = ledger.orders.find((item) => item.side === "BUY"
    && LIVE_ACTIVE_ORDER_STATUSES.has(item.status));
  if (active) {
    if (active.status === "PREPARED" && force) await retireNeverSubmittedEntry(service, run, active);
    else if (active.status === "PREPARED" || amount(active.executed_quantity) > 0)
      throw new Error("COINOPS_LIVE_ATH_BUY_RECONCILIATION_REQUIRED");
    else if (!await cancelOwnedEntry(service, run, active, true))
      throw new Error("COINOPS_LIVE_FILLED_DURING_SNAPSHOT");
    const resident = ledger.slots.find((item) => item.id === active.slot_id)!;
    await updateSlot(service, run, resident, { entry_state: "PLANNED" });
    // Re-read the durable slot/order checkpoint before planning. The original
    // in-memory ledger still says ARMED and would retain the old BUY price.
    ledger = await runRows(service, run);
  }
  if (force) {
    // A worker may have crashed after a zero-fill cancel but before recording
    // PLANNED. Recover only that exact durable checkpoint; never infer that a
    // missing/partial/uncertain order authorizes a replacement BUY.
    for (const slot of ledger.slots.filter((item) => item.entry_state === "ARMED")) {
      const prior = ledger.orders.filter((item) => item.slot_id === slot.id && item.side === "BUY"
        && item.operation_sequence === slot.operation_sequence)
        .sort((left, right) => right.revision - left.revision)[0];
      if (!prior || prior.status !== "CANCELED" || !prior.trades_reconciled
        || amount(prior.executed_quantity) > 0 || amount(prior.cumulative_quote) > 0)
        throw new Error("COINOPS_BULK_ARMED_BUY_AMBIGUOUS");
      await updateSlot(service, run, slot, { entry_state: "PLANNED" });
    }
    ledger = await runRows(service, run);
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
    }), statuses[0]!.monthlyGainTarget, configuredEngineSlotCount(run.engine!));
  const prep = await scopedPreparation(service, run.user_id, run.asset, { environment: "REAL", ...run });
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
    if (item.frozenReason === "OPEN_OR_TP") continue;
    await updateSlot(service, run, slot, { operational_rank: item.operationalRank,
      post_ath_group: item.postAthGroup, post_ath_group_rank: item.postAthGroupRank,
      ...(!item.frozenReason && slot.entry_state === "PLANNED"
        ? { target_buy_price: item.nextBuyPrice, entry_reference_price: item.nextBuyPrice } : {}) });
  }
  await renewLease(service, run);
  const result = await service.from("robot_v1_live_runs").update({
    entry_regime: profile.regime, entry_spacing: profile.regime === "POST_ATH"
      ? profile.post_ath_spacing_rate : profile.normal_spacing_rate,
    config_version: profile.config_version,
    config_snapshot: { ...run.config_snapshot, ladder_anchor_price: state.price.price,
      gain_rate: Number(run.gain_rate), normal_spacing_rate: Number(profile.normal_spacing_rate),
      post_ath_spacing_rate: Number(profile.post_ath_spacing_rate), regime: profile.regime,
      monthly_target: statuses[0]!.monthlyGainTarget,
      entry_spacing: profile.regime === "POST_ATH"
        ? Number(profile.post_ath_spacing_rate) : Number(profile.normal_spacing_rate) },
    ath_transition_key: profile.transition_key, ath_period_key: period,
  }).eq("id", run.id).eq("tenant_id", run.tenant_id).eq("lease_owner", run.lease_owner)
    .select("*").single();
  if (result.error || !result.data) throw new Error("COINOPS_LIVE_ATH_TRANSITION_FAILED");
  Object.assign(run, result.data);
  await event(service, run, `ATH_TRANSITION:${profile.transition_key ?? "NORMAL"}:${period}`,
    "ATH_TRANSITION", null, { regime: profile.regime, transition_key: profile.transition_key,
      config_version: profile.config_version,
      primary: decisions.filter((item) => item.postAthGroup === "PRIMARY").length,
      reserve: decisions.filter((item) => item.postAthGroup === "RESERVE").length });
  return true;
}

/** The only LIVE consumer of bulk edits. It runs after reconciliation and TP
 * protection under this run's lease. A pending BUY gate remains closed until
 * both the profile and current ladder have been reconciled. */
async function applyPendingStrategyUpdate(service: Service, run: Run, ledger: Ledger,
  state: LiveExecutorState): Promise<"NONE" | "APPLIED"> {
  const rows = await boundedLedgerRead((deadline, attempt) => observeLedgerRows<BulkUpdate>("bulk_checkpoint",
    service.from("strategy_bulk_engine_updates").select("*")
    .eq("trading_engine_id", run.trading_engine_id).eq("run_id", run.id)
    .in("status", ["PENDING", "APPLYING"]).order("created_at", { ascending: true }).limit(1)
    .abortSignal(deadline), deadline, attempt));
  if (!rows.length) return "NONE";
  const item = rows[0];
  // Rows admitted by the immediately previous post-ATH-only release receive
  // these exact defaults in the additive migration. Keep the runtime tolerant
  // during the zero-downtime deploy window as well.
  const parameterKey = item.parameter_key ?? "post_ath_spacing_rate";
  const definition = strategyParameter(parameterKey);
  const applyPolicy = item.apply_policy ?? definition.applyPolicy;
  const requiresOrderReconciliation = item.requires_order_reconciliation
    ?? definition.requiresOrderReconciliation;
  if (item.operator_id !== run.operator_id || item.exchange_account_id !== run.exchange_account_id
    || item.trading_engine_id !== run.trading_engine_id || item.run_id !== run.id
    || item.strategy_version_after !== item.strategy_version_before + 1
    || applyPolicy !== definition.applyPolicy
    || requiresOrderReconciliation !== definition.requiresOrderReconciliation
    || !await configUpdatePending(service, run))
    throw new Error("COINOPS_BULK_SCOPE_OR_GATE_INVALID");
  const desired = Number(item.new_values[parameterKey]);
  const previous = Number(item.old_values[parameterKey]);
  const minimum = definition.type === "PERCENT" ? definition.min / 100 : definition.min;
  const maximum = definition.type === "PERCENT" ? definition.max / 100 : definition.max;
  if (!Number.isFinite(desired) || !Number.isFinite(previous) || desired < minimum || desired > maximum
    || definition.type === "INTEGER" && !Number.isInteger(desired))
    throw new Error("COINOPS_BULK_VALUE_INVALID");
  if (item.status === "PENDING") {
    const started = await service.from("strategy_bulk_engine_updates")
      .update({ status: "APPLYING", updated_at: new Date().toISOString() })
      .eq("id", item.id).eq("status", "PENDING").select("id").maybeSingle();
    if (started.error || !started.data) throw new Error("COINOPS_BULK_CLAIM_FAILED");
    const batch = await service.from("strategy_bulk_batches").update({ status: "APPLYING",
      updated_at: new Date().toISOString() }).eq("id", item.batch_id).eq("status", "PENDING");
    if (batch.error) throw new Error("COINOPS_BULK_BATCH_STATUS_FAILED");
  }
  let profile = await loadAthProfile(service, athScope(run), "REAL", run.asset);
  if (profile.id !== item.profile_id) throw new Error("COINOPS_BULK_PROFILE_SCOPE_INVALID");
  if (profile.config_version === item.strategy_version_before) {
    if (profile.next_config_version !== null)
      throw new Error("COINOPS_BULK_PROFILE_CONFLICT");
    const profileRecord = profile as unknown as Record<string, unknown>;
    if (definition.storage.table === "PROFILE"
      && Math.abs(Number(profileRecord[definition.storage.column]) - previous) > 1e-8)
      throw new Error("COINOPS_BULK_PROFILE_CONFLICT");
    if (definition.storage.table === "PREPARATION") {
      const currentPreparation = await service.from("robot_v1_live_preparations").select("monthly_target")
        .eq("trading_engine_id", run.trading_engine_id).eq("operator_id", run.operator_id).single();
      if (currentPreparation.error || !currentPreparation.data
        || ![previous, desired].some((value) => Number(currentPreparation.data.monthly_target) === value))
        throw new Error("COINOPS_BULK_PREPARATION_CONFIG_CONFLICT");
      if (Number(currentPreparation.data.monthly_target) !== desired) {
        const changed = await service.from("robot_v1_live_preparations").update({ monthly_target: desired,
          updated_at: new Date().toISOString() }).eq("trading_engine_id", run.trading_engine_id)
          .eq("operator_id", run.operator_id).eq("monthly_target", previous).select("id").maybeSingle();
        if (changed.error || !changed.data) throw new Error("COINOPS_BULK_PREPARATION_CONFIG_CONFLICT");
      }
    }
    await renewLease(service, run);
    const profileUpdate: Record<string, unknown> = { config_version: item.strategy_version_after,
      updated_at: new Date().toISOString() };
    if (definition.storage.table === "PROFILE") profileUpdate[definition.storage.column] = desired;
    const updated = await service.from("robot_v1_ath_profiles").update(profileUpdate)
      .eq("id", item.profile_id).eq("trading_engine_id", run.trading_engine_id)
      .eq("config_version", item.strategy_version_before).eq("updated_at", profile.updated_at)
      .select("id").maybeSingle();
    if (updated.error || !updated.data) throw new Error("COINOPS_BULK_PROFILE_UPDATE_CONFLICT");
    profile = await loadAthProfile(service, athScope(run), "REAL", run.asset);
  }
  const preparation = definition.storage.table === "PREPARATION"
    ? await service.from("robot_v1_live_preparations").select("monthly_target")
      .eq("trading_engine_id", run.trading_engine_id).eq("operator_id", run.operator_id).single()
    : { data: null, error: null };
  if (preparation.error) throw new Error("COINOPS_BULK_PREPARATION_CONFIG_CONFLICT");
  const stored = definition.storage.table === "PROFILE"
    ? Number((profile as unknown as Record<string, unknown>)[definition.storage.column])
    : Number(preparation.data?.monthly_target);
  if (profile.config_version !== item.strategy_version_after || Math.abs(stored - desired) > 1e-8)
    throw new Error("COINOPS_BULK_VERSION_MISMATCH");
  const affectsCurrentLadder = strategyParameterAffectsCurrentLadder(definition, run.entry_regime);
  if (affectsCurrentLadder) {
    // The official ladder owns zero-fill cancellation, fill-wins and future GRID
    // prices. Existing OPEN, partial positions and TP slots stay frozen.
    await applyAthTransition(service, run, ledger, state, true);
  } else if (definition.applyPolicy !== "NEXT_CYCLE_ONLY") {
    await renewLease(service, run);
    const saved = await service.from("robot_v1_live_runs").update({
      config_version: item.strategy_version_after,
      config_snapshot: { ...run.config_snapshot, [parameterKey]: desired,
        source_config_version: item.strategy_version_after },
    }).eq("id", run.id).eq("trading_engine_id", run.trading_engine_id)
      .eq("lease_owner", run.lease_owner).select("*").single();
    if (saved.error || !saved.data) throw new Error("COINOPS_BULK_RUN_VERSION_FAILED");
    Object.assign(run, saved.data);
  }
  const finished = await service.rpc("finish_strategy_bulk_engine_update", {
    p_item_id: item.id, p_lease_owner: run.lease_owner,
  });
  if (finished.error) throw new Error("COINOPS_BULK_FINISH_FAILED");
  try {
    await event(service, run, `STRATEGY_BULK_APPLIED:${item.id}`, "STRATEGY_BULK_APPLIED", null,
      { batch_id: item.batch_id, strategy_version_before: item.strategy_version_before,
        strategy_version_after: item.strategy_version_after,
        parameter_key: parameterKey, apply_policy: applyPolicy,
        value_before: previous, value_after: desired });
  } catch {
    // The batch/item rows are the durable atomic audit. A redundant event
    // write must never turn an already-applied strategy into a trading stop.
    console.error("COINOPS_BULK_OPTIONAL_EVENT_FAILED", { batchId: item.batch_id,
      engineId: run.trading_engine_id });
  }
  return "APPLIED";
}

async function markBulkUpdateBlocked(service: Service, run: Run, code: string) {
  const rows = await service.from("strategy_bulk_engine_updates")
    .update({ status: "BLOCKED_SAFE", error_code: code, updated_at: new Date().toISOString() })
    .eq("run_id", run.id).eq("trading_engine_id", run.trading_engine_id)
    .in("status", ["PENDING", "APPLYING"]).select("batch_id");
  if (rows.error) throw new Error("COINOPS_BULK_BLOCK_PERSIST_FAILED");
  for (const row of rows.data ?? []) {
    const siblings = await service.from("strategy_bulk_engine_updates").select("status")
      .eq("batch_id", row.batch_id);
    if (siblings.error || !siblings.data) throw new Error("COINOPS_BULK_BATCH_STATUS_FAILED");
    const batch = await service.from("strategy_bulk_batches")
      .update({ status: siblings.data.some((item) => item.status === "APPLIED") ? "PARTIAL" : "BLOCKED_SAFE",
        updated_at: new Date().toISOString() }).eq("id", row.batch_id);
    if (batch.error) throw new Error("COINOPS_BULK_BATCH_STATUS_FAILED");
  }
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
    }), statuses[0]!.monthlyGainTarget, configuredEngineSlotCount(run.engine!));
  const accounts = new Map(latest.accounts.map((item) => [item.slot_number, item]));
  const prep = await scopedPreparation(service, run.user_id, run.asset, { environment: "REAL", ...run });
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
    return candidate(slot, account, rank.operationalRank, rank.monthlyTargetReached, rank.eligibleForNewEntry);
  });
  const plan = planStrategyClosedSlot(context(run), candidates, closed.id);
  if (plan.mode !== "GLOBAL_RESET") throw new Error("COINOPS_LIVE_RESET_STRATEGY_MISMATCH");
  for (const decision of plan.decisions) {
    await persistStrategyDecision(service, owned(run), "REAL", decision, closed.operation_sequence);
    await dispatchStrategyDecision(service, owned(run), "REAL", decision.decision_id);
  }
  const resetKey = `RESET:${run.id}:${closed.last_credited_sell_client_order_id ?? closed.id}`;
  const snapshot = { gain_rate: gain, ladder_anchor_price: state.price.price,
    slot_count: configuredEngineSlotCount(run.engine!),
    normal_spacing_rate: amount(profile.normal_spacing_rate),
    post_ath_spacing_rate: amount(profile.post_ath_spacing_rate), regime: profile.regime,
    monthly_target: statuses[0]!.monthlyGainTarget,
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
  if (result.error) {
    const cause = /COINOPS_LIVE_RESET_[A-Z0-9_]+/.exec(result.error.message)?.[0];
    throw new Error(cause ?? "COINOPS_LIVE_RESET_FAILED");
  }
  if (!successor || successor.previous_run_id !== run.id)
    throw new Error("COINOPS_LIVE_RESET_RESULT_INVALID");
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

const LARGE_ENGINE_RECONCILIATION_SLICE_MS = 120_000;
/** Yield only after exact exchange/ledger protection proof and complete
 * financial operations. SQL independently fences the lease, derives monotonic
 * progress and bounds its episode. The ledger remains the resumable cursor. */
async function checkpointLargeEngineProgress(service: Service, run: Run, startedAt: number,
  phase: "CREDIT_SLOTS" | "RECYCLE_SLOTS", concentratedSettlement = false) {
  if (run.status === "PAUSED" || configuredEngineSlotCount(run.engine ?? run) <= 25
    || !concentratedSettlement && Date.now() - startedAt < LARGE_ENGINE_RECONCILIATION_SLICE_MS) return false;
  await renewLease(service, run);
  const ledger = await runRows(service, run);
  const state = await readLiveExecutorState(run);
  await assertAllPositionsProtected(run, ledger, state);
  // The canonical sync keeps PARTIALLY_FILLED non-terminal. Its resident TP
  // may still have a completely accounted executed portion; only SQL can
  // prove those immutable fill rows/sums and exact ownership. Never promote
  // the terminal flag or treat a partial BUY as a safe checkpoint.
  if (ledger.orders.some(order => amount(order.executed_quantity) > 0 && !order.trades_reconciled
    && !(order.side === "SELL" && order.purpose === "TP" && order.status === "PARTIALLY_FILLED")))
    throw new Error("COINOPS_LIVE_RECONCILIATION_PROGRESS_UNSETTLED");
  await renewLease(service, run);
  const recorded = await service.rpc("record_live_reconciliation_checkpoint", {
    p_run_id: run.id, p_lease_owner: run.lease_owner, p_phase: phase,
    p_quantity_step: state.filters.quantityStep,
  });
  if (recorded.error) {
    const code = recorded.error.message.match(/\bCOINOPS_LIVE_LARGE_ENGINE_PROGRESS_(?:SCOPE_DENIED|LEASE_DENIED|UNSAFE|INVALID|STALE)\b/)?.[0];
    throw new Error(code ?? "COINOPS_LIVE_LARGE_ENGINE_PROGRESS_UNSAFE");
  }
  const checkpoint = recorded.data as Record<string, unknown> | null;
  if (checkpoint?.contract !== "LARGE_ENGINE_PROGRESS_V1"
    || checkpoint.run_id !== run.id || checkpoint.operator_id !== run.operator_id
    || checkpoint.exchange_account_id !== run.exchange_account_id
    || checkpoint.trading_engine_id !== run.trading_engine_id || checkpoint.symbol !== run.symbol
    || checkpoint.quote_asset !== run.quote_asset || checkpoint.executor_shard_id !== run.engine?.executor_shard_id
    || checkpoint.slot_count !== configuredEngineSlotCount(run.engine ?? run))
    throw new Error("COINOPS_LIVE_LARGE_ENGINE_PROGRESS_UNSAFE");
  run.reconciliation_checkpoint = checkpoint;
  return true;
}

/** A deliberate pause is a BUY gate, not a stop of the protection worker.
 * Certification is engine-scoped and requires fresh exchange agreement; a
 * pending/ambiguous BUY or stale gate must never become a hidden healthy pause. */
async function assertPausedProtection(service: Service, run: Run, ledger: Ledger,
  state: LiveExecutorState) {
  if (!Number.isFinite(state.filters.quantityStep) || state.filters.quantityStep <= 0)
    throw new Error("COINOPS_LIVE_QUANTITY_STEP_INVALID");
  await validateRunEngine(service, run);
  const prep = await scopedPreparation(service, run.user_id, run.asset, { environment: "REAL", ...run });
  if (!prep.live_enabled || !prep.kill_switch || !run.engine!.engine_kill_switch)
    throw new Error("COINOPS_LIVE_PAUSE_FLAGS_INVALID");
  if (ledger.orders.some((order) => order.side === "BUY"
    && !LIVE_TERMINAL_ORDER_STATUSES.has(order.status)))
    throw new Error("COINOPS_LIVE_PAUSE_BUY_UNRESOLVED");
  if (ledger.orders.some((order) => amount(order.executed_quantity) > 0 && !order.trades_reconciled))
    throw new Error("COINOPS_LIVE_PAUSE_FILL_UNRECONCILED");
  await assertAllPositionsProtected(run, ledger, state);
  await exposure(service, run);
}

async function appliedCapitalSources(service: Service, run: Run, order: Order) {
  const scopeQuery = (table: string) => service.from(table).select("id")
    .eq("operator_id", run.operator_id).eq("exchange_account_id", run.exchange_account_id)
    .eq("trading_engine_id", run.trading_engine_id).eq("slot_number", order.slot_number)
    .eq("quote_asset", run.quote_asset).gt("amount_quote", 0);
  const [selective, allSlots] = await Promise.all([
    scopeQuery("robot_v1_live_selective_contribution_allocations").eq("status", "APPLIED")
      .gt("applied_at", order.created_at),
    scopeQuery("robot_v1_live_adjustment_items").gt("created_at", order.created_at),
  ]);
  if (selective.error || allSlots.error) throw new Error("COINOPS_LIVE_CAPITAL_SOURCE_UNAVAILABLE");
  return [...(selective.data ?? []).map((r) => `allocation:${r.id}`),
    ...(allSlots.data ?? []).map((r) => `adjustment:${r.id}`)];
}

type CapitalRefreshEvent = Scope & LedgerScope & { id: string; run_id: string; observed_at: string;
  event_type: string; slot_number: number | null; details: { refresh_key?: string;
    old_client_order_id?: string; new_client_order_id?: string; new_quantity?: number;
    price?: number; [key: string]: unknown } };

/** Only observation retries here: discard every partial page on a transient
 * GET, preserve hard provider failures and never repeat a confirmation write
 * or the trading step that produced the audit. Full scope uses the official
 * event index and keeps same-account/symbol engines on other shards isolated. */
async function readCapitalRefreshEvents(service: Service, run: Run) {
  return boundedLedgerRead(async (deadline, attempt) => {
    const rows = await completeLedgerRead<CapitalRefreshEvent>(async (start, end) => ({ error: null,
      data: await observeLedgerRows<CapitalRefreshEvent>("capital_refresh_events",
        service.from("robot_v1_live_events")
          .select("id,run_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,quote_asset,observed_at,event_type,slot_number,details")
          .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id).eq("user_id", run.user_id)
          .eq("operator_id", run.operator_id).eq("exchange_account_id", run.exchange_account_id)
          .eq("trading_engine_id", run.trading_engine_id).eq("quote_asset", run.quote_asset).eq("run_id", run.id)
          .in("event_type", ["NEXT_BUY_CAPITAL_REFRESH_PLANNED", "NEXT_BUY_CAPITAL_REFRESH_CONFIRMED"])
          .order("observed_at").order("id").range(start, end).abortSignal(deadline), deadline, attempt),
    }), "COINOPS_LIVE_CAPITAL_AUDIT_INCOMPLETE");
    if (!run.engine) throw new Error("COINOPS_LIVE_ENGINE_UNRESOLVED");
    for (const row of rows) {
      assertRowEngine(row, run.engine);
      if (row.product_id !== run.product_id || row.tenant_id !== run.tenant_id || row.user_id !== run.user_id
        || row.run_id !== run.id || !["NEXT_BUY_CAPITAL_REFRESH_PLANNED", "NEXT_BUY_CAPITAL_REFRESH_CONFIRMED"].includes(row.event_type)
        || !Number.isFinite(Date.parse(row.observed_at)) || !row.details || typeof row.details !== "object"
        || Array.isArray(row.details)) throw new Error("COINOPS_LIVE_CAPITAL_AUDIT_INCOMPLETE");
    }
    return rows;
  });
}

/** Audit completion is recoverable after a crash: the order ledger, not the
 * presence/absence of an event, is the authoritative cancellation checkpoint. */
async function confirmCapitalRefreshes(service: Service, run: Run, ledger: Ledger) {
  const rows = await readCapitalRefreshEvents(service, run);
  const confirmed = new Set(rows.filter((r) => r.event_type.endsWith("CONFIRMED"))
    .map((r) => r.details?.refresh_key));
  for (const row of rows) {
    const d = row.details;
    if (row.event_type !== "NEXT_BUY_CAPITAL_REFRESH_PLANNED" || !d || confirmed.has(d.refresh_key)) continue;
    const old = ledger.orders.find((o) => o.client_order_id === d.old_client_order_id);
    const next = ledger.orders.find((o) => o.client_order_id === d.new_client_order_id);
    if (!old || !next || old.side !== "BUY" || next.side !== "BUY" || next.purpose !== "ENTRY"
      || old.slot_id !== next.slot_id || old.operation_sequence !== next.operation_sequence
      || old.status !== "CANCELED" || amount(old.executed_quantity) !== 0 || !old.trades_reconciled
      || !next.exchange_order_id || !["NEW", "PARTIALLY_FILLED", "FILLED"].includes(next.status)
      || amount(next.requested_quantity) !== d.new_quantity || amount(next.price) !== d.price) continue;
    await event(service, run, `CAPITAL_REFRESH:${d.refresh_key}:CONFIRMED`, "NEXT_BUY_CAPITAL_REFRESH_CONFIRMED",
      row.slot_number, { ...d, old_status: old.status, old_executed_quantity: 0, new_status: next.status,
        exchange_reconciled_at: new Date().toISOString() });
  }
}

async function holdEntryForBnbFeeBalance(service: Service, run: Run, slot: Slot, state: LiveExecutorState) {
  let evidence: ReturnType<typeof liveBnbFeeBalanceCheck>;
  try { evidence = liveBnbFeeBalanceCheck(state, run.quote_asset); }
  catch (error) {
    if (!(error instanceof LiveReadUnavailable) || error.code !== "COINOPS_LIVE_BNB_FEE_BALANCE_UNAVAILABLE") throw error;
    await holdTransientExecutorRead(service, run, liveFailureEvidence(error, "OBSERVE_BNB_FEE", run.execution_source ?? "LIVE_CRON"));
    // Fail closed for this BUY, but keep reconciling resident TP and fills.
    return "BNB_FEE_READ_HOLD" as const;
  }
  const readKey = `LIVE_RUN:${run.id}:BNB_FEE_READ`;
  const readCheckpoint = await service.from("robot_v1_live_alerts").select("code,resolved_at")
    .eq("trading_engine_id", run.trading_engine_id).eq("exchange_account_id", run.exchange_account_id)
    .eq("alert_key", readKey).is("resolved_at", null).maybeSingle();
  if (readCheckpoint.error) throw new Error("COINOPS_LIVE_BNB_FEE_BALANCE_ALERT_UNAVAILABLE");
  if (readCheckpoint.data?.resolved_at === null) {
    const resolved = await service.from("robot_v1_live_alerts").update({ resolved_at: new Date().toISOString() })
      .eq("trading_engine_id", run.trading_engine_id).eq("exchange_account_id", run.exchange_account_id)
      .eq("alert_key", readKey).eq("code", "COINOPS_LIVE_BNB_FEE_BALANCE_UNAVAILABLE").is("resolved_at", null);
    if (resolved.error) throw new Error("COINOPS_LIVE_BNB_FEE_BALANCE_ALERT_RESOLVE_FAILED");
  }
  const alertKey = `LIVE_RUN:${run.id}:BNB_FEE_BALANCE`;
  const prior = await service.from("robot_v1_live_alerts").select("code,resolved_at")
    .eq("trading_engine_id", run.trading_engine_id).eq("exchange_account_id", run.exchange_account_id)
    .eq("alert_key", alertKey).maybeSingle();
  if (prior.error) throw new Error("COINOPS_LIVE_BNB_FEE_BALANCE_ALERT_UNAVAILABLE");
  if (!evidence.sufficient) {
    if (!prior.data || prior.data.resolved_at !== null) {
      await event(service, run, `BNB_FEE_BALANCE_HOLD:${slot.id}:${slot.operation_sequence}:${state.observed_at}`,
        "ENTRY_BNB_FEE_BALANCE_HOLD", slot.slot_number, evidence);
      const saved = await service.from("robot_v1_live_alerts").upsert({ ...owned(run), asset: run.asset,
        alert_key: alertKey, severity: "WARNING", code: "COINOPS_LIVE_BNB_FEE_RESERVE_MISSING",
        details: { run_id: run.id, slot_number: slot.slot_number, ...evidence },
        last_seen_at: new Date().toISOString(), resolved_at: null }, { onConflict: "trading_engine_id,alert_key" });
      if (saved.error) throw new Error("COINOPS_LIVE_BNB_FEE_BALANCE_ALERT_PERSIST_FAILED");
    }
    return "BNB_FEE_BALANCE_HOLD" as const;
  }
  if (prior.data?.resolved_at === null) {
    const resolved = await service.from("robot_v1_live_alerts").update({ resolved_at: new Date().toISOString() })
      .eq("trading_engine_id", run.trading_engine_id).eq("exchange_account_id", run.exchange_account_id)
      .eq("alert_key", alertKey).eq("code", "COINOPS_LIVE_BNB_FEE_RESERVE_MISSING").is("resolved_at", null);
    if (resolved.error) throw new Error("COINOPS_LIVE_BNB_FEE_BALANCE_ALERT_RESOLVE_FAILED");
    await event(service, run, `BNB_FEE_BALANCE_AVAILABLE:${slot.id}:${slot.operation_sequence}:${state.observed_at}`,
      "ENTRY_BNB_FEE_BALANCE_AVAILABLE", slot.slot_number, evidence);
  }
  return null;
}

async function preparedEntryHasReleasedReceipt(service: Service, run: Run, order: Order) {
  if (!order.account_order_unsent_receipt?.request_nonce || !order.strategy_decision_id) return false;
  const decision = await service.from("robot_v1_strategy_decisions")
    .select("result,dispatched_at,exchange_ack_at,completed_at")
    .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id).eq("user_id", run.user_id)
    .eq("operator_id", run.operator_id).eq("exchange_account_id", run.exchange_account_id)
    .eq("trading_engine_id", run.trading_engine_id).eq("environment", "REAL")
    .eq("decision_id", order.strategy_decision_id).maybeSingle();
  return !decision.error && decision.data?.result === "PENDING" && decision.data.dispatched_at === null
    && decision.data.exchange_ack_at === null && decision.data.completed_at === null;
}

async function holdEntryForQuoteBalance(service: Service, run: Run, slot: Slot,
  state: LiveExecutorState, requiredQuote: number, reclaimedQuote = 0) {
  const evidence = liveQuoteBalanceCheck(state, run.quote_asset, requiredQuote, reclaimedQuote);
  const alertKey = `LIVE_RUN:${run.id}:QUOTE_BALANCE`;
  const prior = await service.from("robot_v1_live_alerts").select("code,resolved_at")
    .eq("trading_engine_id", run.trading_engine_id).eq("exchange_account_id", run.exchange_account_id)
    .eq("alert_key", alertKey).maybeSingle();
  if (prior.error) throw new Error("COINOPS_LIVE_QUOTE_BALANCE_ALERT_UNAVAILABLE");
  if (!evidence.sufficient) {
    if (!prior.data || prior.data.resolved_at !== null) {
      await event(service, run, `QUOTE_BALANCE_HOLD:${slot.id}:${slot.operation_sequence}:${state.observed_at}`,
        "ENTRY_QUOTE_BALANCE_HOLD", slot.slot_number, evidence);
      const saved = await service.from("robot_v1_live_alerts").upsert({ ...owned(run), asset: run.asset,
        alert_key: alertKey, severity: "WARNING", code: "COINOPS_LIVE_QUOTE_BALANCE_INSUFFICIENT",
        details: { run_id: run.id, slot_number: slot.slot_number, ...evidence },
        last_seen_at: new Date().toISOString(), resolved_at: null }, { onConflict: "trading_engine_id,alert_key" });
      if (saved.error) throw new Error("COINOPS_LIVE_QUOTE_BALANCE_ALERT_PERSIST_FAILED");
    }
    return true;
  }
  if (prior.data?.resolved_at === null) {
    const resolved = await service.from("robot_v1_live_alerts").update({ resolved_at: new Date().toISOString() })
      .eq("trading_engine_id", run.trading_engine_id).eq("exchange_account_id", run.exchange_account_id)
      .eq("alert_key", alertKey).eq("code", "COINOPS_LIVE_QUOTE_BALANCE_INSUFFICIENT").is("resolved_at", null);
    if (resolved.error) throw new Error("COINOPS_LIVE_QUOTE_BALANCE_ALERT_RESOLVE_FAILED");
    await event(service, run, `QUOTE_BALANCE_AVAILABLE:${slot.id}:${slot.operation_sequence}:${state.observed_at}`,
      "ENTRY_QUOTE_BALANCE_AVAILABLE", slot.slot_number, evidence);
  }
  return false;
}

async function armNextEntry(service: Service, run: Run, ledger: Ledger,
  state: LiveExecutorState) {
  await validateRunEngine(service, run);
  const prep = await scopedPreparation(service, run.user_id, run.asset, { environment: "REAL", ...run });
  if (!prep.live_enabled || prep.kill_switch || entryBlocked(run)) return "KILL_SWITCH";
  if ((await loadLiveEngineExecutorStatus(run)).gate !== "LIVE_EXECUTOR_ACTIVE")
    return "EXECUTOR_NOT_ACTIVE";
  const globalCap = await quoteCap(service, run);
  const deployed = await exposure(service, run);
  const spendable = (balance: number, reclaimed = 0) => Math.max(0, Math.min(balance,
    amount(prep.max_order_notional_brl), amount(prep.max_total_exposure_brl) - deployed[run.asset] + reclaimed,
    globalCap - deployed.global + reclaimed));
  const status = await monthly(service, run, ledger.slots, ledger.accounts);
  const ranks = new Map(status.map((item) => [item.physicalSlotNumber, item]));
  const activeBuys = ledger.orders.filter((item) => item.side === "BUY"
    && LIVE_ACTIVE_ORDER_STATUSES.has(item.status));
  if (activeBuys.length > 1) throw new Error("COINOPS_LIVE_DUPLICATE_ACTIVE_BUY");
  for (const slot of ledger.slots) {
    if (canRestoreUnfilledEntry(slot, operationOrders(ledger.orders, slot))) {
      await renewLease(service, run);
      await updateSlot(service, run, slot, { entry_state: "PLANNED" });
    }
  }
  const first = !ledger.orders.some((item) => item.side === "BUY");
  if (first) {
    const selected = ledger.slots.filter((item) => ranks.get(item.slot_number)?.eligibleForNewEntry)
      .sort((a, b) => amount(a.operational_rank) - amount(b.operational_rank))[0];
    if (!selected || selected.operational_rank !== 1) throw new Error("COINOPS_LIVE_INITIAL_RANK_INVALID");
    const account = ledger.accounts.find((item) => item.slot_number === selected.slot_number)!;
    const quote = Number(spendable(amount(account.balance_brl)).toFixed(8));
    if (quote < state.filters.minNotional) return "CAPACITY_HOLD";
    const feeHold = await holdEntryForBnbFeeBalance(service, run, selected, state);
    if (feeHold) return feeHold;
    if (await holdEntryForQuoteBalance(service, run, selected, state, quote)) return "QUOTE_BALANCE_HOLD";
    const selectedStatus = ranks.get(selected.slot_number)!;
    const decision = planStrategyInitialEntry(context(run),
      { ...candidate(selected, account, selected.operational_rank,
        selectedStatus.monthlyTargetReached, selectedStatus.eligibleForNewEntry), balanceQuote: quote });
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
  const reclaimed = active ? Math.max(0, amount(active.reserved_notional_brl) - amount(active.cumulative_quote)) : 0;
  const activeSlot = ledger.slots.find((s) => s.id === active?.slot_id);
  if (active?.status === "PREPARED") {
    // The reconciler verified/released the exact unsent receipt under lease.
    // Keep its identity and continue TP/fill reconciliation while cash is absent.
    if (activeSlot && await preparedEntryHasReleasedReceipt(service, run, active)) {
      const feeHold = await holdEntryForBnbFeeBalance(service, run, activeSlot, state);
      if (feeHold) return feeHold;
      if (await holdEntryForQuoteBalance(service, run, activeSlot, state,
        active.purpose === "INITIAL" ? amount(active.requested_quote)
          : amount(active.requested_quantity) * amount(active.price))) return "QUOTE_BALANCE_HOLD";
    }
    throw new Error("COINOPS_LIVE_PREPARED_BUY_UNRESOLVED");
  }
  const observedActive = state.open_orders.find((o) => o.clientOrderId === active?.client_order_id
    && o.id === active?.exchange_order_id && o.side === "BUY" && o.status === "NEW"
    && o.executedQuantity === 0 && o.price === amount(active?.price));
  if (active?.status === "NEW" && active.purpose === "ENTRY" && active.exchange_order_id
    && observedActive && Math.abs(Date.now() - Date.parse(state.observed_at)) <= 30_000
    && activeSlot?.entry_state === "PLANNED"
    && amount(activeSlot.position_quantity) === 0 && active.operation_sequence === activeSlot.operation_sequence
    && operationOrders(ledger.orders, activeSlot).every((o) => o.side === "BUY" && amount(o.executed_quantity) === 0)) {
    // PREPARED was persisted before the ARMED update when a process died.
    // Restore only a confirmed resident of this exact current operation.
    await renewLease(service, run);
    await updateSlot(service, run, activeSlot, { entry_state: "ARMED" });
  }
  const activeAccount = ledger.accounts.find((a) => a.slot_number === activeSlot?.slot_number);
  const refresh = active && activeSlot && activeAccount ? planLiveEntryCapitalRefresh({
    order: active, slotState: activeSlot.entry_state, positionQuantity: amount(activeSlot.position_quantity),
    balance: amount(activeAccount.balance_brl), price: amount(activeSlot.target_buy_price),
    ...state.filters, spendable: spendable(amount(activeAccount.balance_brl), reclaimed),
    freeQuoteAfterCancel: (state.balances.find((b) => b.asset === run.quote_asset)?.free ?? 0) + reclaimed,
    engineCap: amount(prep.max_total_exposure_brl), accountCap: globalCap, maxOrder: amount(prep.max_order_notional_brl),
    supportsUnfilledCancel: state.supports_unfilled_buy_cancel, executorCaps: state.execution_caps,
  }) : null;
  const capitalSources = refresh?.status === "REPLACE" && active
    ? await appliedCapitalSources(service, run, active) : [];
  const candidates = ledger.slots.map((slot) => {
    const account = ledger.accounts.find((row) => row.slot_number === slot.slot_number)!;
    const rank = ranks.get(slot.slot_number)!;
    const value = { ...candidate(slot, account, rank.operationalRank, rank.monthlyTargetReached, rank.eligibleForNewEntry),
      balanceQuote: Math.min(amount(account.balance_brl), amount(prep.max_order_notional_brl)) };
    if (active?.slot_id === slot.id) value.state = "ARMED";
    return value;
  });
  const contextKey = `QUEUE:${ledger.orders.filter((item) => item.side === "BUY").length}`;
  const observedFloor = state.price.price;
  const resident = active ? { candidateId: active.slot_id, executedQuantity: amount(active.executed_quantity),
    ...(refresh?.status === "REPLACE" && capitalSources.length ? { capitalRefresh: {
      quantityBefore: amount(active.requested_quantity), quantityAfter: refresh.quantity, notional: refresh.notional,
    } } : {}) } : null;
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
  const quantity = floorStep(spendable(amount(ledger.accounts.find((item) => item.slot_number === selected.slot_number)!.balance_brl), reclaimed)
    / amount(selected.target_buy_price), state.filters.quantityStep);
  if (quantity * amount(selected.target_buy_price) < state.filters.minNotional) return "CAPACITY_HOLD";
  if (quantity < state.filters.minQuantity || quantity > state.filters.maxQuantity)
    throw new Error("COINOPS_LIVE_NEXT_ENTRY_FILTER_INVALID");
  // Check before preparing/guarding/dispatching or canceling any resident BUY.
  // Locked quote is not cash; reclaim only the exact verified own unfilled BUY.
  const verifiedReclaim = active?.status === "NEW" && observedActive && amount(active.executed_quantity) === 0
    ? reclaimed : 0;
  const feeHold = await holdEntryForBnbFeeBalance(service, run, selected, state);
  if (feeHold) return feeHold;
  if (await holdEntryForQuoteBalance(service, run, selected, state,
    quantity * amount(selected.target_buy_price), verifiedReclaim)) return "QUOTE_BALANCE_HOLD";
  await persistStrategyDecision(service, owned(run), "REAL", planned.decision,
    selected.operation_sequence);
  const revision = Math.max(0, ...ledger.orders.filter((item) => item.slot_id === selected.id
    && item.side === "BUY").map((item) => item.revision)) + 1;
  if (active && refresh?.status === "REPLACE"
    && planned.decision.reason === "APPLIED_CONTRIBUTION_UPDATES_RESIDENT_BUY") {
    const nextClientId = liveClientOrderId(run.id, run.asset, selected.slot_number,
      selected.operation_sequence, "BUY", revision, run.engine);
    const refreshKey = `${active.client_order_id}:${nextClientId}:${refresh.quantity}`;
    await event(service, run, `CAPITAL_REFRESH:${refreshKey}:PLANNED`, "NEXT_BUY_CAPITAL_REFRESH_PLANNED",
      selected.slot_number, { refresh_key: refreshKey, old_client_order_id: active.client_order_id,
        new_client_order_id: nextClientId, old_quantity: amount(active.requested_quantity),
        new_quantity: refresh.quantity, price: amount(selected.target_buy_price),
        old_notional_quote: amount(active.reserved_notional_brl), new_notional_quote: refresh.notional,
        slot_balance_quote: amount(activeAccount!.balance_brl), quote_asset: run.quote_asset,
        operation_sequence: selected.operation_sequence, capital_sources: capitalSources });
  }
  if (active) {
    if (active.status === "PREPARED") throw new Error("COINOPS_LIVE_PREPARED_BUY_UNRESOLVED");
    const canceledEmpty = await cancelOwnedEntry(service, run, active, state.supports_unfilled_buy_cancel === true);
    // A fill racing the cancel wins. Do not mark its slot PLANNED, reclaim its
    // capital, or send a supplemental BUY. The same official flow protects it.
    if (!canceledEmpty) return "ENTRY_FILLED_DURING_REPLACEMENT";
    const previous = ledger.slots.find((item) => item.id === active.slot_id)!;
    await renewLease(service, run);
    await updateSlot(service, run, previous, { entry_state: "PLANNED" });
  }
  const order = await prepareOrder(service, run, selected, planned.decision, "BUY", "ENTRY",
    revision, quantity, null, amount(selected.target_buy_price));
  ledger.orders.push(order);
  await updateSlot(service, run, selected, { entry_state: "ARMED" });
  try {
    await reconcileOrder(service, run, order);
  } catch (error) {
    if (planned.decision.reason !== "APPLIED_CONTRIBUTION_UPDATES_RESIDENT_BUY" || !order.submission_guarded_at) throw error;
    // Query the persisted ID after a lost response; submission_guarded_at
    // prevents a second dispatch when the outcome cannot be proven.
    await reconcileOrder(service, run, order);
  }
  return "NEXT_BUY_ARMED";
}

/** Reconcile first, protect every OPEN fill, then consider exactly one BUY. */
async function advanceLiveRunOnce(runId: string, source: string): Promise<LiveAdvanceResult> {
  assertScope();
  const service = createServiceRoleClient();
  const run = await claim(service, runId);
  if (!run) return { status: "BUSY_OR_INACTIVE" };
  run.execution_source = source;
  const startedAt = Date.now();
  let errorCode: string | null = null;
  let reconciliationComplete = false;
  let stage = "LOAD_LEDGER";
  try {
    await validateRunEngine(service, run);
    if (run.symbol !== `${run.asset}${run.quote_asset}` || run.strategy_version !== STRATEGY_VERSION)
      throw new Error("COINOPS_LIVE_RUN_IDENTITY_INVALID");
    return await withLiveObservationRetryBudget(run, async () => {
    let ledger = await runRows(service, run);
    // Logical slots are not concurrent BUYs. A large engine protects the
    // entry it just observed before spending another entry/retry envelope.
    // Ledger facts (not a process-local flag) remain the crash-safe cursor.
    const entryQuantitiesBefore = new Map(ledger.orders.filter(order => order.side === "BUY")
      .map(order => [order.id, amount(order.executed_quantity)]));
    const acknowledgedTpIdsBefore = new Set(ledger.orders.filter(order => order.side === "SELL"
      && order.exchange_order_id !== null && order.status !== "PREPARED").map(order => order.id));
    stage = "RECONCILE_ORDERS";
    const reconciliationState = await readLiveExecutorState(run);
    assertLiveResidentPrices(run, ledger, reconciliationState);
    const feeValuation = configuredEngineSlotCount(run.engine ?? run) > 25
      ? createReconciliationFeeValuation(run, reconciliationState) : undefined;
    const settledSellsBefore = ledger.orders.filter(order => order.side === "SELL" && order.trades_reconciled
      && LIVE_TERMINAL_ORDER_STATUSES.has(order.status)).length;
    const reconciledSellIds = feeValuation
      ? await reconcileAcknowledgedSellOrders(service, run, ledger.orders, feeValuation) : new Set<string>();
    for (const order of ledger.orders)
      if (!reconciledSellIds.has(order.id)) await reconcileOrder(service, run, order, feeValuation);
    const concentratedSettlement = Boolean(feeValuation && ledger.orders.filter(order => order.side === "SELL"
      && order.trades_reconciled && LIVE_TERMINAL_ORDER_STATUSES.has(order.status)).length - settledSellsBefore > 25);
    ledger = await runRows(service, run);
    stage = "READ_STATE";
    let state = await readLiveExecutorState(run);
    assertLiveResidentPrices(run, ledger, state);
    stage = "PROTECT_TP";
    await ensureTakeProfits(service, run, ledger, state, feeValuation);
    const entryProtectedThisPass = Boolean(feeValuation && (
      ledger.orders.some(order => order.side === "BUY"
        && amount(order.executed_quantity) > (entryQuantitiesBefore.get(order.id) ?? 0))
      || ledger.orders.some(order => order.side === "SELL" && order.exchange_order_id !== null
        && order.status !== "PREPARED" && !acknowledgedTpIdsBefore.has(order.id))));
    stage = "CREDIT_SLOTS";
    const yieldForProgress = async (phase: "CREDIT_SLOTS" | "RECYCLE_SLOTS", concentratedSettlement = false) => {
      const previousStage = stage;
      stage = "RECONCILIATION_PROGRESS";
      try { return await checkpointLargeEngineProgress(service, run, startedAt, phase, concentratedSettlement); }
      finally { stage = previousStage; }
    };
    // This is a normal, persisted reconciliation boundary, not a pause or a
    // completed/fresh reconciliation. It cannot continue immediately into a
    // second BUY: the next normal invocation resumes the same ledger under a
    // fresh lease. The checkpoint independently proves every resident TP and
    // settled fill before yielding; ambiguity still fails closed.
    if (await yieldForProgress("CREDIT_SLOTS", concentratedSettlement || entryProtectedThisPass))
      return { status: "RETRY", code: "COINOPS_LIVE_RECONCILIATION_PROGRESS" };
    // Credit consumes only the just-observed quantity step to classify the
    // already-settled residual. It cannot authorize an order. Keep the legacy
    // read unchanged; every subsequent entry/protection write still reads fresh.
    if (!feeValuation) state = await readLiveExecutorState(run);
    if (await creditClosedSlots(service, run, ledger, state, () => yieldForProgress("CREDIT_SLOTS")))
      return { status: "RETRY", code: "COINOPS_LIVE_RECONCILIATION_PROGRESS" };
    const refreshed = await runRows(service, run);
    if (run.status === "PAUSED") {
      // Existing TP/fills/gains continue through the authoritative reconciler.
      // CLOSED remains CLOSED: no reentry decision, ATH edit or successor is
      // planned until the owner explicitly resumes this same engine.
      stage = "ASSERT_PAUSED_PROTECTION";
      state = await readLiveExecutorState(run);
      await assertPausedProtection(service, run, refreshed, state);
      stage = "AUDIT_EVENT";
      await event(service, run, `RECONCILED:${new Date().toISOString().slice(0, 16)}`,
        "RECONCILED", null, { source, next: "ENTRIES_PAUSED", strategy_version: STRATEGY_VERSION,
          protection_verified: true, quantity_step: state.filters.quantityStep,
          open_positions: refreshed.slots.filter(slot => amount(slot.position_quantity) >= state.filters.quantityStep).length,
          resident_buy_count: 0 });
      reconciliationComplete = true;
      return { status: "PAUSED", next: "ENTRIES_PAUSED" };
    }
    stage = "RECYCLE_SLOTS";
    if (await recycleClosedSlots(service, run, refreshed, () => yieldForProgress("RECYCLE_SLOTS")))
      return { status: "RETRY", code: "COINOPS_LIVE_RECONCILIATION_PROGRESS" };
    const current = await runRows(service, run);
    stage = "ASSERT_PROTECTION";
    state = await readLiveExecutorState(run);
    await assertAllPositionsProtected(run, current, state);
    stage = "CONFIG_UPDATE";
    await applyPendingStrategyUpdate(service, run, current, state);
    if (await configUpdatePending(service, run)) return { status: "RETRY", code: "COINOPS_STRATEGY_CONFIG_UPDATE_PENDING" };
    const configured = await runRows(service, run);
    stage = "RESTART_CYCLE";
    const successor = await restartClosedCycle(service, run, configured, state);
    if (successor) return { status: "RESTARTED", nextRunId: successor };
    stage = "ATH_TRANSITION";
    await applyAthTransition(service, run, configured, state);
    const entered = await runRows(service, run);
    stage = "ARM_ENTRY";
    state = await readLiveExecutorState(run);
    if (await configUpdatePending(service, run)) return { status: "RETRY", code: "COINOPS_STRATEGY_CONFIG_UPDATE_PENDING" };
    const next = await armNextEntry(service, run, entered, state);
    // A MARKET can fill in the same invocation. Protect it before returning.
    if (next === "INITIAL_SUBMITTED" || next === "NEXT_BUY_ARMED" || next === "ENTRY_FILLED_DURING_REPLACEMENT") {
      stage = "ASSERT_NEW_POSITION";
      const after = await runRows(service, run);
      state = await readLiveExecutorState(run);
      await ensureTakeProfits(service, run, after, state, feeValuation);
      state = await readLiveExecutorState(run);
      await assertAllPositionsProtected(run, after, state);
      // In a new large-engine cycle, INITIAL_SUBMITTED would otherwise cause
      // the continuation coordinator to enter again immediately and submit a
      // second BUY in the same outer call. End only after its TP/ledger proof;
      // the next normal lease resumes the unchanged canonical strategy.
      if (feeValuation && after.orders.some(order => order.side === "BUY"
        && amount(order.executed_quantity) > (entryQuantitiesBefore.get(order.id) ?? 0))
        && await yieldForProgress("CREDIT_SLOTS", true))
        return { status: "RETRY", code: "COINOPS_LIVE_RECONCILIATION_PROGRESS" };
    }
    const finalLedger = await runRows(service, run);
    stage = "CONFIRM_CAPITAL_REFRESH";
    await confirmCapitalRefreshes(service, run, finalLedger);
    stage = "RESOLVE_ACCOUNT_BUDGET_ALERT";
    await resolveAccountBudgetAlert(service, run, finalLedger.orders, next,
      { renewLease: () => renewLease(service, run) });
    stage = "AUDIT_EVENT";
    await event(service, run, `RECONCILED:${new Date().toISOString().slice(0, 16)}`,
      "RECONCILED", null, { source, next, strategy_version: STRATEGY_VERSION });
    if (run.previous_run_id && !entryBlocked(run)) {
      const healed = await runRows(service, run);
      const residentBuys = healed.orders.filter((order) => order.side === "BUY"
        && LIVE_ACTIVE_ORDER_STATUSES.has(order.status));
      if (healed.slots.some((slot) => amount(slot.position_quantity) > 0)
        && residentBuys.length === 1
        && !healed.orders.some((order) => amount(order.executed_quantity) > 0
          && !order.trades_reconciled)) {
        const resolved = await service.from("robot_v1_live_alerts")
          .update({ resolved_at: new Date().toISOString() })
          .eq("trading_engine_id", run.trading_engine_id)
          .eq("exchange_account_id", run.exchange_account_id)
          .eq("code", "COINOPS_LIVE_RESET_FAILED").is("resolved_at", null);
        if (resolved.error) throw new Error("COINOPS_LIVE_RESET_ALERT_RESOLUTION_FAILED");
        await event(service, run, `RESET_RECOVERED:${run.previous_run_id}`,
          "RESET_RECOVERED", null, { previous_run_id: run.previous_run_id,
            open_positions: healed.slots.filter((slot) => amount(slot.position_quantity) > 0).length,
            resident_buy_count: residentBuys.length });
      }
    }
    const held = await service.from("robot_v1_live_alerts")
      .update({ resolved_at: new Date().toISOString() })
      .eq("trading_engine_id", run.trading_engine_id)
      .eq("alert_key", `LIVE_RUN:${run.id}:TRANSIENT_EXECUTOR_READ`)
      .is("resolved_at", null);
    if (held.error) throw new Error("COINOPS_LIVE_TRANSIENT_ALERT_RESOLUTION_FAILED");
    reconciliationComplete = true;
    return { status: "OK", next } as LiveAdvanceResult;
    });
  } catch (error) {
    if (error instanceof Error && error.message === "COINOPS_LIVE_FILLED_DURING_SNAPSHOT") {
      // The next official tick starts at RECONCILE_ORDERS and credits the fill
      // exactly once. No alert, kill switch, or second strategy implementation.
      return { status: "RETRY", code: error.message };
    }
    if (error instanceof Error && error.message === "COINOPS_STRATEGY_CONFIG_UPDATE_PENDING")
      return { status: "RETRY", code: error.message };
    if (error instanceof AccountOrderBudgetHold) {
      const observationDetails = error.observationFailure ? { observation_failure: error.observationFailure } : {};
      await event(service, run, `ACCOUNT_ORDER_HOLD:${error.clientOrderId}:${monthlyPeriodKey(new Date())}`,
        "ACCOUNT_ORDER_BUDGET_HOLD", null, { code: error.message, side: error.side, client_order_id: error.clientOrderId,
          ...observationDetails });
      const alert = await service.from("robot_v1_live_alerts").upsert({ ...owned(run), asset: run.asset,
        alert_key: `LIVE_RUN:${run.id}:ACCOUNT_ORDER_BUDGET`, severity: error.side === "SELL" ? "CRITICAL" : "WARNING",
        code: error.message, details: { run_id: run.id, side: error.side, client_order_id: error.clientOrderId,
          ...observationDetails },
        last_seen_at: new Date().toISOString(), resolved_at: null }, { onConflict: "trading_engine_id,alert_key" });
      if (alert.error) throw new Error("COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_PERSIST_FAILED");
      // No transport dispatch happened, or an authenticated no-POST receipt
      // atomically released its exact marker. Existing makers remain untouched.
      return { status: "RETRY", code: error.message };
    }
    if (stage === "CONFIG_UPDATE" && error instanceof Error
      && TRANSIENT_EXECUTOR_READ_CODES.has(error.message)) {
      const pending = await service.from("strategy_bulk_engine_updates").select("updated_at")
        .eq("run_id", run.id).eq("trading_engine_id", run.trading_engine_id)
        .in("status", ["PENDING", "APPLYING"]).limit(1).maybeSingle();
      if (!pending.error && pending.data
        && Date.now() - Date.parse(pending.data.updated_at) < 10 * 60_000)
        return { status: "RETRY", code: "COINOPS_BULK_TRANSIENT_EXECUTOR_READ" };
    }
    if (error instanceof LiveReadUnavailable || ["RECONCILE_ORDERS", "READ_STATE"].includes(stage)
      && error instanceof Error && TRANSIENT_EXECUTOR_READ_CODES.has(error.message)) {
      const ledgerRead = error instanceof LiveReadUnavailable && error.code === "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE";
      const retryCode = ledgerRead ? "COINOPS_LIVE_TRANSIENT_LEDGER_READ" : "COINOPS_LIVE_TRANSIENT_EXECUTOR_READ";
      errorCode = retryCode;
      if (await holdTransientExecutorRead(service, run, liveFailureEvidence(error, stage, source))) {
        // The warning row is the durable retry checkpoint. A short 502/503 is
        // not a failed run and must not be promoted by the watchdog through
        // last_error while the official reconciler remains retryable.
        errorCode = null;
        return { status: "RETRY", code: retryCode };
      }
      errorCode = ledgerRead ? "COINOPS_LIVE_LEDGER_READ_STALE" : "COINOPS_LIVE_EXECUTOR_READ_STALE";
      throw new Error(errorCode);
    }
    errorCode = error instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(error.message)
      ? error.message : `COINOPS_LIVE_${stage}_FAILED`;
    if (stage === "CONFIG_UPDATE") await markBulkUpdateBlocked(service, run, errorCode);
    await preventNewBuys(service, run, errorCode, { ...liveFailureEvidence(error, stage, source),
      ...(error instanceof AccountBudgetAlertResolutionError ? {
        metadata_path: error.path, metadata_attempts: error.attempts, http_status: error.httpStatus,
        ...(error.providerCode ? { provider_code: error.providerCode } : {}),
      } : {}) });
    throw new Error(errorCode);
  } finally {
    await release(service, run, errorCode, reconciliationComplete);
  }
}

/** Advance through a gain rollover until the successor has a protected MARKET
 * fill and its single NEXT BUY. Each step owns a fresh lease and all financial
 * writes remain inside advanceLiveRunOnce's existing reconciler. */
export async function advanceLiveRun(runId: string, source = "LIVE_CRON") {
  return continueLiveAdvance(runId, source, advanceLiveRunOnce);
}

/** Six-hour audit reuses the same ledger/reconciliation invariants. It never
 * creates or cancels orders; critical findings turn off new BUYs in SQL. */
export async function auditLiveRun(runId: string) {
  assertScope();
  const service = createServiceRoleClient();
  const lookup = await service.from("robot_v1_live_runs").select("*").eq("id", runId)
    .eq("tenant_id", getCoinOpsServiceTenantId()).single();
  if (lookup.error || !lookup.data) throw new Error("COINOPS_LIVE_MONITOR_RUN_UNAVAILABLE");
  if (!["ACTIVE", "PAUSED"].includes(lookup.data.status)) return { status: "INACTIVE" };
  // A one-time lease observation cannot fence an audit against a cron that
  // starts during the external reads. Share the reconciler's actual lease,
  // and use the row returned by that claim, not the earlier snapshot.
  const run = await claim(service, runId);
  if (!run) return { status: "LEASE_BUSY" };
  try {
    await validateRunEngine(service, run);
    const health = await loadLiveEngineExecutorStatus(run);
    if (!health.health?.healthy || !["LIVE_EXECUTOR_ACTIVE", "LIVE_EXECUTOR_PROTECTED"].includes(health.gate))
      throw new Error("COINOPS_LIVE_MONITOR_EXECUTOR_UNHEALTHY");
    const ledger = await runRows(service, run);
    const state = await readLiveExecutorState(run);
    await assertExchangeMatchesLedger(run, ledger.orders, state);
    assertLiveResidentPrices(run, ledger, state);
    await assertAllPositionsProtected(run, ledger, state);
    if (ledger.orders.some((order) => LIVE_TERMINAL_ORDER_STATUSES.has(order.status)
      && !order.trades_reconciled))
      throw new Error("COINOPS_LIVE_MONITOR_UNRECONCILED_FILL");
    const monthlyStatuses = await monthly(service, run, ledger.slots, ledger.accounts);
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
    const configPending = await configUpdatePending(service, run);
    if (!ledger.slots.some((item) => amount(item.position_quantity) > 0)
      && ownBuys.length === 0 && monthlyStatuses.some((item) => item.eligibleForNewEntry)
      && run.status === "ACTIVE" && !run.engine?.engine_kill_switch && !configPending)
      throw new Error("COINOPS_LIVE_MONITOR_ORPHANED_ENGINE");
    if (run.last_error || !run.last_reconciled_at
      || Date.now() - Date.parse(run.last_reconciled_at) > 10 * 60_000)
      throw new Error("COINOPS_LIVE_MONITOR_RECONCILIATION_STALE");
    const prep = await scopedPreparation(service, run.user_id, run.asset, { environment: "REAL", ...run });
    if (prep.live_enabled && !prep.kill_switch && !entryBlocked(run) && health.gate !== "LIVE_EXECUTOR_ACTIVE")
      throw new Error("COINOPS_LIVE_MONITOR_FLAGS_DIVERGED");
    await event(service, run, `MONITOR:${new Date().toISOString().slice(0, 13)}`,
      "LIVE_MONITOR_PASS", null, { own_open_orders: state.open_orders.filter((item) =>
        item.clientOrderId?.startsWith(liveEngineOrderPrefix(run.engine!))).length,
        open_positions: ledger.slots.filter((item) => item.entry_state === "OPEN").length,
        active_buy_count: ownBuys.length, slot_count: ledger.slots.length });
    return { status: "PASS", asset: run.asset, openPositions: ledger.slots.filter((item) =>
      item.entry_state === "OPEN").length, activeBuyCount: ownBuys.length };
  } catch (error) {
    if (error instanceof Error && error.message === "COINOPS_LIVE_FILLED_DURING_SNAPSHOT")
      return { status: "RETRY", asset: run.asset, code: error.message };
    // The monitor never authorizes trading. A failed registry observation is
    // retried by the normal cron; it is not evidence of invalid permissions.
    if (error instanceof LiveReadUnavailable
      && ["COINOPS_OPERATOR_REGISTRY_READ_TIMEOUT", "COINOPS_OPERATOR_REGISTRY_READ_UNAVAILABLE"].includes(error.code))
      return { status: "RETRY", asset: run.asset, code: error.message };
    const code = error instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_LIVE_MONITOR_FAILED";
    await renewLease(service, run);
    if (code === "COINOPS_LIVE_MONITOR_RECONCILIATION_STALE") {
      // Staleness/last_error is a secondary observation, not a new financial
      // cause. Keep the original incident fingerprint and recovery evidence.
      // This never acknowledges it, opens a gate, or reports healthy.
      const existing = await service.from("robot_v1_live_alerts").select("code")
        .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id)
        .eq("user_id", run.user_id).eq("operator_id", run.operator_id)
        .eq("exchange_account_id", run.exchange_account_id)
        .eq("trading_engine_id", run.trading_engine_id)
        .eq("alert_key", `LIVE_RUN:${run.id}:CRITICAL`).eq("severity", "CRITICAL")
        .is("resolved_at", null).abortSignal(AbortSignal.timeout(5_000)).maybeSingle();
      if (existing.error) throw new Error("COINOPS_LIVE_MONITOR_INCIDENT_READ_FAILED");
      if (existing.data) {
        // A crash between gate opening and incident CAS may leave this
        // inconsistent. Fail closed, retaining the original cause verbatim.
        if (!run.engine?.engine_kill_switch) {
          await renewLease(service, run);
          await closeNewBuyGates(service, run);
        }
        return { status: "CRITICAL", asset: run.asset,
          code: existing.data.code, secondary_code: code };
      }
    }
    await renewLease(service, run);
    await preventNewBuys(service, run, code);
    return { status: "CRITICAL", asset: run.asset, code };
  } finally {
    // An audit is not a completed reconciliation and must not manufacture
    // freshness or erase the execution worker's error checkpoint.
    await release(service, run, run.last_error, false);
  }
}

/** Stop new entries for one engine, never a whole Binance account. Resident
 * TPs remain in place; the paused run stays in the reconciliation worker. */
export async function pauseLiveRun(runId: string, userId: string, asset: V1Asset) {
  assertScope();
  const service = createServiceRoleClient();
  const lookup = await service.from("robot_v1_live_runs").select("*").eq("id", runId)
    .eq("tenant_id", getCoinOpsServiceTenantId()).eq("user_id", userId).single();
  if (lookup.error || !lookup.data || lookup.data.asset !== asset
    || !["ACTIVE", "PAUSED"].includes(lookup.data.status))
    throw new Error("COINOPS_LIVE_PAUSE_RUN_DENIED");
  // First close the SQL BUY gate. A concurrent cron may finish its current
  // protected operation, but no new entry may start after this update.
  const gate = await service.from("robot_v1_live_preparations")
    .update({ kill_switch: true }).eq("trading_engine_id", lookup.data.trading_engine_id)
    .eq("exchange_account_id", lookup.data.exchange_account_id).eq("user_id", userId)
    .eq("live_enabled", true).select("id").single();
  if (gate.error || !gate.data) throw new Error("COINOPS_LIVE_PAUSE_GATE_FAILED");
  const engineGate = await service.from("trading_engines").update({ kill_switch: true })
    .eq("id", lookup.data.trading_engine_id).eq("exchange_account_id", lookup.data.exchange_account_id)
    .select("id").single();
  if (engineGate.error || !engineGate.data) throw new Error("COINOPS_LIVE_PAUSE_GATE_FAILED");
  const run = await claim(service, runId);
  if (!run) throw new Error("COINOPS_LIVE_PAUSE_LEASE_BUSY");
  let errorCode: string | null = null;
  try {
    await validateRunEngine(service, run);
    let ledger = await runRows(service, run);
    for (const order of ledger.orders) await reconcileOrder(service, run, order);
    ledger = await runRows(service, run);
    const cancelState = await readLiveExecutorState(run);
    for (const order of ledger.orders.filter((item) => item.side === "BUY"
      && ["NEW", "PARTIALLY_FILLED"].includes(item.status))) {
      await cancelOwnedEntry(service, run, order,
        order.status === "NEW" && cancelState.supports_unfilled_buy_cancel === true);
      const slot = ledger.slots.find((item) => item.id === order.slot_id);
      if (slot && Number(order.executed_quantity) === 0)
        await updateSlot(service, run, slot, { entry_state: "PLANNED" });
    }
    ledger = await runRows(service, run);
    let state = await readLiveExecutorState(run);
    await ensureTakeProfits(service, run, ledger, state);
    ledger = await runRows(service, run);
    state = await readLiveExecutorState(run);
    await assertPausedProtection(service, run, ledger, state);
    if (run.status !== "PAUSED") {
      const paused = await service.from("robot_v1_live_runs").update({ status: "PAUSED" })
        .eq("id", run.id).eq("lease_owner", run.lease_owner).eq("status", "ACTIVE")
        .select("id,status").single();
      if (paused.error || paused.data?.status !== "PAUSED")
        throw new Error("COINOPS_LIVE_PAUSE_STATE_FAILED");
    }
    await event(service, run, `PAUSED:${new Date().toISOString()}`, "LIVE_PAUSED", null,
      { source: "OPERATOR_CONTROL", canceled_buy_count: ledger.orders.filter((item) =>
        item.side === "BUY" && item.status === "CANCELED").length,
        protection_verified: true, quantity_step: state.filters.quantityStep,
        open_positions: ledger.slots.filter(slot => amount(slot.position_quantity) >= state.filters.quantityStep).length,
        resident_buy_count: 0 });
    return { status: "PAUSED", asset, cycle_id: run.id };
  } catch (error) {
    errorCode = error instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_LIVE_PAUSE_FAILED";
    await preventNewBuys(service, run, errorCode);
    throw new Error(errorCode);
  } finally { await release(service, run, errorCode); }
}

/** Operator recovery is read-only against Binance. The SQL BUY gate opens only
 * after a fresh exchange/ledger match, protected positions and hard caps. */
async function readVerifiedRecoveryIncident(service: Service, run: Run, expected?: ReadRecoveryAlert) {
  const alerts = await service.from("robot_v1_live_alerts")
    .select("alert_key,code,first_seen_at,last_seen_at,details")
    .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id).eq("user_id", run.user_id)
    .eq("operator_id", run.operator_id).eq("exchange_account_id", run.exchange_account_id)
    .eq("trading_engine_id", run.trading_engine_id).eq("severity", "CRITICAL").is("resolved_at", null);
  if (alerts.error) throw new Error("COINOPS_LIVE_RECOVERY_ALERT_LOOKUP_FAILED");
  return verifiedReadRecoveryAlert(run.status, run.id, alerts.data ?? [], expected);
}

async function readOperatorRecoveryIncident(service: Service, run: Run, expected?: ReadRecoveryAlert | null) {
  const alerts = await service.from("robot_v1_live_alerts")
    .select("alert_key,code,first_seen_at,last_seen_at,details")
    .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id).eq("user_id", run.user_id)
    .eq("operator_id", run.operator_id).eq("exchange_account_id", run.exchange_account_id)
    .eq("trading_engine_id", run.trading_engine_id).eq("severity", "CRITICAL").is("resolved_at", null);
  if (alerts.error) throw new Error("COINOPS_LIVE_RECOVERY_ALERT_LOOKUP_FAILED");
  return operatorRecoveryAlert(run.status, run.id, alerts.data ?? [], expected);
}

/** Recovery is not a way to approve or skip an actual strategy edit. Look
 * across this engine's runs: a queued successor edit also keeps BUY closed. */
async function assertNoPendingStrategyUpdate(service: Service, run: Run) {
  if (await configUpdatePending(service, run)) throw new Error("COINOPS_STRATEGY_CONFIG_UPDATE_PENDING");
  const updates = await boundedLedgerRead((deadline, attempt) => observeLedgerRows("bulk_checkpoint",
    service.from("strategy_bulk_engine_updates").select("id")
      .eq("operator_id", run.operator_id).eq("exchange_account_id", run.exchange_account_id)
      .eq("trading_engine_id", run.trading_engine_id)
      .in("status", ["PENDING", "APPLYING", "BLOCKED_SAFE"]).limit(1).abortSignal(deadline), deadline, attempt));
  if (updates.length) throw new Error("COINOPS_STRATEGY_CONFIG_UPDATE_PENDING");
}

async function assertLateReconciledFill(service: Service, run: Run, incident: ReadRecoveryAlert) {
  const detected = Date.parse(incident.first_seen_at ?? "");
  if (!Number.isFinite(detected)) throw new Error("COINOPS_LIVE_RECOVERY_FILL_EVIDENCE_MISSING");
  const fills = await service.from("robot_v1_live_fills")
    .select("order_id,filled_at,collected_at")
    .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id)
    .eq("user_id", run.user_id).eq("operator_id", run.operator_id)
    .eq("exchange_account_id", run.exchange_account_id)
    .eq("trading_engine_id", run.trading_engine_id)
    .eq("symbol", run.symbol)
    .gte("filled_at", new Date(detected - 90_000).toISOString())
    .lte("filled_at", new Date(detected + 90_000).toISOString()).limit(10);
  if (fills.error || !fills.data?.length)
    throw new Error("COINOPS_LIVE_RECOVERY_FILL_EVIDENCE_MISSING");
  const late = fills.data.filter((fill) => Date.parse(fill.collected_at) > detected)
    .map((fill) => fill.order_id);
  if (!late.length) throw new Error("COINOPS_LIVE_RECOVERY_FILL_EVIDENCE_MISSING");
  const orders = await service.from("robot_v1_live_orders")
    .select("id,client_order_id,status,trades_reconciled")
    .eq("run_id", run.id).eq("trading_engine_id", run.trading_engine_id)
    .in("id", late);
  if (orders.error || !orders.data?.some((order) => order.status === "FILLED"
    && order.trades_reconciled && order.client_order_id.startsWith(liveEngineOrderPrefix(run.engine!))))
    throw new Error("COINOPS_LIVE_RECOVERY_FILL_EVIDENCE_MISSING");
}

/** Never infer that a legacy permission denial was transient. Fresh exchange
 * protection and settled pre-incident orders prove only that resuming is safe
 * now. Reject any recent financial intent or unacknowledged dispatch. */
async function assertSettledPermissionReadRecovery(service: Service, run: Run, incident: ReadRecoveryAlert,
  ledger: Ledger, state: LiveExecutorState) {
  const cutoff = assertPermissionReadRecoveryOrders(incident, ledger.orders, state.open_orders,
    liveEngineOrderPrefix(run.engine!));
  const decisions = await service.from("robot_v1_strategy_decisions").select("id")
    .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id).eq("user_id", run.user_id)
    .eq("operator_id", run.operator_id).eq("exchange_account_id", run.exchange_account_id)
    .eq("trading_engine_id", run.trading_engine_id).eq("environment", "REAL")
    .in("action_type", ["OPEN_INITIAL_MARKET", "CREATE_TP", "ARM_NEXT_BUY", "CANCEL_REPLACE_NEXT_BUY"])
    .or(`created_at.gte.${cutoff},dispatched_at.gte.${cutoff},result.neq.COMPLETED,result.is.null`)
    .limit(1).abortSignal(AbortSignal.timeout(5_000));
  const dispatch = await service.from("account_order_budget_reservations").select("client_order_id")
    .eq("operator_id", run.operator_id).eq("exchange_account_id", run.exchange_account_id)
    .eq("trading_engine_id", run.trading_engine_id).is("acknowledged_at", null).limit(1).abortSignal(AbortSignal.timeout(5_000));
  if (decisions.error || dispatch.error) throw new Error("COINOPS_LIVE_PERMISSION_RECOVERY_PROOF_UNAVAILABLE");
  if (!Array.isArray(decisions.data) || !Array.isArray(dispatch.data)
    || decisions.data.length || dispatch.data.length) throw new Error("COINOPS_LIVE_PERMISSION_RECOVERY_UNPROVEN");
}

/** Explicit recovery is not approval of an ambiguous dispatch. A complete
 * openOrders snapshot alone cannot prove that an unknown BUY was never sent. */
async function assertSettledOperatorRecovery(service: Service, run: Run, ledger: Ledger) {
  if (ledger.orders.some(order => !order.client_order_id.startsWith(liveEngineOrderPrefix(run.engine!))
    || !["NEW", "PARTIALLY_FILLED"].includes(order.status) && !LIVE_TERMINAL_ORDER_STATUSES.has(order.status)
    || amount(order.executed_quantity) > 0 && !order.trades_reconciled))
    throw new Error("COINOPS_LIVE_OPERATOR_RECOVERY_UNSETTLED");
  const decisions = await service.from("robot_v1_strategy_decisions").select("id")
    .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id).eq("user_id", run.user_id)
    .eq("operator_id", run.operator_id).eq("exchange_account_id", run.exchange_account_id)
    .eq("trading_engine_id", run.trading_engine_id).eq("environment", "REAL")
    .in("action_type", ["OPEN_INITIAL_MARKET", "CREATE_TP", "ARM_NEXT_BUY", "CANCEL_REPLACE_NEXT_BUY"])
    .or("result.neq.COMPLETED,result.is.null").limit(1).abortSignal(AbortSignal.timeout(5_000));
  const dispatch = await service.from("account_order_budget_reservations").select("client_order_id")
    .eq("operator_id", run.operator_id).eq("exchange_account_id", run.exchange_account_id)
    .eq("trading_engine_id", run.trading_engine_id).is("acknowledged_at", null)
    .limit(1).abortSignal(AbortSignal.timeout(5_000));
  if (decisions.error || dispatch.error) throw new Error("COINOPS_LIVE_OPERATOR_RECOVERY_PROOF_UNAVAILABLE");
  if (!Array.isArray(decisions.data) || !Array.isArray(dispatch.data)
    || decisions.data.length || dispatch.data.length) throw new Error("COINOPS_LIVE_OPERATOR_RECOVERY_UNSETTLED");
}

export async function resumeLiveRun(runId: string, userId: string, asset: V1Asset,
  source: "OPERATOR_CONTROL" | "VERIFIED_READ_RECOVERY" = "OPERATOR_CONTROL") {
  assertScope();
  const service = createServiceRoleClient();
  const run = await claim(service, runId);
  if (!run) throw new Error("COINOPS_LIVE_RESUME_LEASE_BUSY");
  let unlocked = false;
  let errorCode: string | null = null;
  let recoveryIncident: ReadRecoveryAlert | undefined;
  try {
    await validateRunEngine(service, run);
    if (run.user_id !== userId || run.asset !== asset || !["ACTIVE", "PAUSED"].includes(run.status)
      || run.symbol !== `${asset}${run.quote_asset}` || run.strategy_version !== STRATEGY_VERSION
      || run.last_error || !run.last_reconciled_at
      || Date.now() - Date.parse(run.last_reconciled_at) > 10 * 60_000)
      throw new Error("COINOPS_LIVE_RESUME_RUN_NOT_READY");
    if (source === "VERIFIED_READ_RECOVERY")
      recoveryIncident = await readVerifiedRecoveryIncident(service, run);
    else recoveryIncident = await readOperatorRecoveryIncident(service, run) ?? undefined;
    const budgetAlertRecovery = Boolean(recoveryIncident
      && isAccountBudgetAlertRecovery(recoveryIncident.code, recoveryIncident.details));
    const capitalAuditRecovery = Boolean(recoveryIncident
      && isCapitalAuditReadRecovery(recoveryIncident.code, recoveryIncident.details));
    await assertNoPendingStrategyUpdate(service, run);
    if (recoveryIncident?.code === "COINOPS_LIVE_EXCHANGE_ORDER_MISSING")
      await assertLateReconciledFill(service, run, recoveryIncident);
    const health = await loadLiveEngineExecutorStatus(run);
    if (!["LIVE_EXECUTOR_ACTIVE", "LIVE_EXECUTOR_PROTECTED"].includes(health.gate))
      throw new Error("COINOPS_LIVE_RESUME_EXECUTOR_NOT_ACTIVE");
    const prep = await scopedPreparation(service, userId, asset, { environment: "REAL", ...run });
    if (!prep.live_enabled || !prep.kill_switch)
      throw new Error("COINOPS_LIVE_RESUME_FLAGS_INVALID");
    if (run.engine!.global_kill_switch || run.engine!.account_kill_switch
      || run.engine!.status !== "ACTIVE")
      throw new Error("COINOPS_LIVE_PARENT_KILL_SWITCH");
    const ledger = await runRows(service, run);
    const state = await readLiveExecutorState(run);
    await assertAllPositionsProtected(run, ledger, state);
    if (source === "OPERATOR_CONTROL" || budgetAlertRecovery || capitalAuditRecovery)
      await assertSettledOperatorRecovery(service, run, ledger);
    const bnbFeeReadRecovery = recoveryIncident?.details?.root_code === "COINOPS_LIVE_BNB_FEE_BALANCE_UNAVAILABLE";
    // Protection agreement does not prove that the BUY-only fee observation
    // recovered. Unknown fees cannot reopen a gate and immediately flap it.
    // A known shortage may resume safely into the normal fee-balance HOLD.
    if (bnbFeeReadRecovery) liveBnbFeeBalanceCheck(state, run.quote_asset);
    if (recoveryIncident && isPermissionStateReadRecovery(recoveryIncident.code, recoveryIncident.details))
      await assertSettledPermissionReadRecovery(service, run, recoveryIncident, ledger, state);
    if (ledger.orders.some((order) => LIVE_TERMINAL_ORDER_STATUSES.has(order.status)
      && !order.trades_reconciled)
      || ledger.orders.filter((order) => order.side === "BUY"
        && LIVE_ACTIVE_ORDER_STATUSES.has(order.status)).length > 1)
      throw new Error("COINOPS_LIVE_RESUME_LEDGER_UNRECONCILED");
    await monthly(service, run, ledger.slots, ledger.accounts);
    const globalCap = await quoteCap(service, run);
    const deployed = await exposure(service, run);
    if (deployed[asset] > amount(prep.max_total_exposure_brl) + 1e-8
      || deployed.global > globalCap + 1e-8)
      throw new Error("COINOPS_LIVE_RESUME_HARD_CAP_EXCEEDED");
    if (budgetAlertRecovery) {
      const metadata = await resolveAccountBudgetAlert(service, run, ledger.orders, "VERIFIED_METADATA_RECOVERY",
        { renewLease: () => renewLease(service, run) });
      if (metadata.status === "DEFERRED") throw new Error("COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_RECOVERY_UNPROVEN");
    }
    // A healthy order snapshot does not prove that the failed audit GET now
    // works. This reread is observation-only: pending plans may reflect a
    // legitimate fill/cancel race and never authorize an order or audit write.
    if (capitalAuditRecovery) await readCapitalRefreshEvents(service, run);
    // Recheck after the external reads: a new/changed critical condition must
    // never inherit approval from the earlier cron observation.
    if (source === "VERIFIED_READ_RECOVERY")
      await readVerifiedRecoveryIncident(service, run, recoveryIncident);
    else await readOperatorRecoveryIncident(service, run, recoveryIncident ?? null);
    await assertNoPendingStrategyUpdate(service, run);
    if (source === "OPERATOR_CONTROL" || budgetAlertRecovery || capitalAuditRecovery)
      await assertSettledOperatorRecovery(service, run, ledger);
    if (bnbFeeReadRecovery) liveBnbFeeBalanceCheck(state, run.quote_asset);
    await renewLease(service, run);
    const updated = await service.from("robot_v1_live_preparations")
      .update({ kill_switch: false })
      .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id)
      .eq("user_id", run.user_id).eq("trading_engine_id", run.trading_engine_id)
      .eq("live_enabled", true).eq("kill_switch", true)
      .select("id,kill_switch").maybeSingle();
    if (updated.error || !updated.data || updated.data.kill_switch)
      throw new Error("COINOPS_LIVE_RESUME_GATE_UPDATE_FAILED");
    unlocked = true;
    const engineGate = await service.from("trading_engines").update({ kill_switch: false })
      .eq("id", run.trading_engine_id).eq("operator_id", run.operator_id)
      .eq("exchange_account_id", run.exchange_account_id).eq("strategy_config_pending", false)
      .select("id").single();
    if (engineGate.error || !engineGate.data) throw new Error("COINOPS_LIVE_RESUME_ENGINE_GATE_FAILED");
    if (run.status === "PAUSED") {
      const resumed = await service.from("robot_v1_live_runs").update({ status: "ACTIVE" })
        .eq("id", run.id).eq("lease_owner", run.lease_owner).eq("status", "PAUSED")
        .select("id,status").single();
      if (resumed.error || resumed.data?.status !== "ACTIVE")
        throw new Error("COINOPS_LIVE_RESUME_STATE_FAILED");
    }
    let alertUpdate = service.from("robot_v1_live_alerts")
      .update({ resolved_at: new Date().toISOString() })
      .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id)
      .eq("user_id", run.user_id).eq("alert_key", `LIVE_RUN:${run.id}:CRITICAL`)
      .eq("operator_id", run.operator_id).eq("exchange_account_id", run.exchange_account_id)
      .eq("trading_engine_id", run.trading_engine_id)
      .is("resolved_at", null);
    if (recoveryIncident) alertUpdate = alertUpdate.eq("code", recoveryIncident.code)
      .eq("last_seen_at", recoveryIncident.last_seen_at).eq("first_seen_at", recoveryIncident.first_seen_at);
    // All captured diagnostic identity participates in the final CAS, for
    // both automatic read recovery and explicit operator control.
    if (recoveryIncident) {
      for (const key of ["stage", "root_code", "read_path", "metadata_path"] as const)
        alertUpdate = recoveryIncident.details?.[key] === undefined || recoveryIncident.details[key] === null
          ? alertUpdate.is(`details->>${key}`, null)
          : alertUpdate.eq(`details->>${key}`, recoveryIncident.details[key]);
    }
    const alert = await alertUpdate.select("id");
    if (alert.error) throw new Error("COINOPS_LIVE_RESUME_ALERT_UPDATE_FAILED");
    if (recoveryIncident && alert.data?.length !== 1)
      throw new Error("COINOPS_LIVE_RECOVERY_INCIDENT_CHANGED");
    await event(service, run, `RESUMED:${new Date().toISOString()}`, "LIVE_RESUMED",
      null, { executor_version: health.health?.version, source,
        recovered_alert_code: recoveryIncident?.code ?? null });
    return { status: "RESUMED", asset, cycle_id: run.id,
      recovered_alert_code: recoveryIncident?.code ?? null,
      recovered_alert_last_seen_at: recoveryIncident?.last_seen_at ?? null };
  } catch (error) {
    errorCode = error instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_LIVE_RESUME_FAILED";
    if (unlocked) await preventNewBuys(service, run, errorCode);
    throw new Error(errorCode);
  } finally {
    await release(service, run, errorCode);
  }
}

/** Stages the engine's immutable physical topology while both kill switches remain ON. */
export async function prepareLiveCycle(userId: string, asset: V1Asset, selection?: EngineSelection) {
  assertScope();
  const service = createServiceRoleClient();
  const prep = await scopedPreparation(service, userId, asset, selection);
  const slotCount = configuredEngineSlotCount(prep.engine!);
  if (prep.live_enabled || !prep.kill_switch) throw new Error("COINOPS_LIVE_PREPARATION_FLAGS_INVALID");
  const existing = await service.from("robot_v1_live_runs").select("*")
    .eq("product_id", prep.product_id).eq("tenant_id", prep.tenant_id).eq("user_id", prep.user_id)
    .eq("trading_engine_id", prep.trading_engine_id).in("status", ["PREPARING", "ACTIVE", "PAUSED"]).maybeSingle();
  if (existing.error) throw new Error("COINOPS_LIVE_RUN_LOOKUP_FAILED");
  if (existing.data && existing.data.status !== "PREPARING") return existing.data.id as string;
  const profile = await loadAthProfile(service, athScope(prep), "REAL", asset);
  const state = await readLiveExecutorState(prep);
  const rules = await publicRules(prep.symbol);
  const globalCap = await quoteCap(service, prep);
  const config: LiveConfig = { ...prep, gain_rate: profile.gain_rate,
    normal_spacing_rate: profile.normal_spacing_rate, post_ath_spacing_rate: profile.post_ath_spacing_rate,
    regime: profile.regime, updated_at: profile.updated_at };
  const anchor = existing.data ? amount(existing.data.anchor_price) : state.price.price;
  const sizing = buildLiveSizing(rules, anchor, config,
    globalCap, state.price.observedAt, Date.now(), { engineCap: Number(prep.engine!.hard_cap_quote),
      orderCap: Number(prep.max_order_notional_brl), accountCap: globalCap, quoteAsset: prep.quote_asset });
  const brlFree = state.balances.find((row) => row.asset === prep.quote_asset)?.free;
  if (sizing.validSlots !== slotCount || sizing.dryRun.strategyVersion !== STRATEGY_VERSION
    || brlFree === undefined || brlFree < sizing.configuredCapitalBrl
    || state.open_orders.some((order) => order.clientOrderId?.startsWith(liveEngineOrderPrefix(prep.engine!))))
    throw new Error("COINOPS_LIVE_PREPARATION_GATE_FAILED");
  const snapshot = { gain_rate: Number(profile.gain_rate), ladder_anchor_price: anchor, slot_count: slotCount,
    normal_spacing_rate: Number(profile.normal_spacing_rate),
    post_ath_spacing_rate: Number(profile.post_ath_spacing_rate), regime: profile.regime,
    monthly_target: prep.monthly_target,
    ath_price: profile.ath_price, ath_source: profile.ath_source };
  // This run-level average is a numeric(20,8) reference, not the funded
  // per-slot allocation. Compare at the database scale on insert and replay;
  // actual balances still use sizing.slots' exact whole-cent distribution.
  const slotNotionalReference = Number((sizing.configuredCapitalBrl / slotCount).toFixed(8));
  const inserted = existing.data ? { data: existing.data, error: null }
    : await service.from("robot_v1_live_runs").insert({
    product_id: prep.product_id, tenant_id: prep.tenant_id, user_id: prep.user_id,
    operator_id: prep.operator_id, exchange_account_id: prep.exchange_account_id, trading_engine_id: prep.trading_engine_id, quote_asset: prep.quote_asset,
    asset, symbol: prep.symbol, status: "PREPARING", anchor_price: anchor, slot_count: slotCount,
    slot_notional_brl: slotNotionalReference,
    gain_rate: profile.gain_rate, entry_spacing: profile.regime === "POST_ATH"
      ? profile.post_ath_spacing_rate : profile.normal_spacing_rate,
    entry_regime: profile.regime, config_version: profile.config_version,
    config_snapshot: snapshot, strategy_version: STRATEGY_VERSION,
    ath_transition_key: profile.transition_key, ath_period_key: monthlyPeriodKey(new Date()) })
    .select("*").single();
  if (inserted.error || !inserted.data) throw new Error("COINOPS_LIVE_RUN_CREATE_FAILED");
  const run = inserted.data as Run;
  await validateRunEngine(service, run);
  if (run.asset !== asset || run.symbol !== prep.symbol || run.status !== "PREPARING"
    || amount(run.slot_notional_brl) !== slotNotionalReference
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
  if (savedSlots.error || !savedSlots.data || !hasCompletePhysicalSlotSet(savedSlots.data.map(slot => slot.slot_number), slotCount)
    || savedSlots.data.some((saved) => { const planned = payload.find((item) => item.slot_number === saved.slot_number);
      return !planned || amount(saved.target_buy_price) !== planned.target_buy_price
        || saved.operational_rank !== planned.operational_rank; }))
    throw new Error("COINOPS_LIVE_PLAN_RECOVERY_MISMATCH");
  const seeded = await service.rpc("seed_robot_v1_live_slot_accounts", { p_run_id: run.id,
    p_slot_capitals: [...sizing.slots].sort((a, b) => a.physicalSlotNumber - b.physicalSlotNumber).map(slot => slot.capitalBrl) });
  if (seeded.error || seeded.data?.seeded_count !== slotCount)
    throw new Error("COINOPS_LIVE_ACCOUNT_SEED_FAILED");
  const prepared = await runRows(service, run);
  if (prepared.accounts.some(account => {
    const capital = sizing.slots.find(slot => slot.physicalSlotNumber === account.slot_number)?.capitalBrl;
    return capital === undefined || amount(account.balance_brl) !== capital || amount(account.contribution_brl) !== capital;
  })) throw new Error("COINOPS_LIVE_ACCOUNT_RECOVERY_MISMATCH");
  await event(service, run, "RUN_PREPARED", "RUN_PREPARED", null,
    { symbol: run.symbol, capital_brl: sizing.configuredCapitalBrl, slot_count: slotCount,
      config_version: run.config_version, strategy_version: STRATEGY_VERSION });
  return run.id;
}
