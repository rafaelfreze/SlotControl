import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { liveQuoteBalanceCheck } from "./live-quote-balance.ts";
import { liveBnbFeeBalanceCheck } from "./live-bnb-fee-balance.ts";
import { LiveReadUnavailable, liveFailureEvidence } from "./live-read-error.ts";
import { readLiveExposure } from "./live-exposure-read.ts";
import { resolveAccountBudgetAlert, AccountBudgetAlertResolutionError } from "./live-account-budget-alert.ts";

const now = Date.parse("2026-10-07T13:50:03Z");
const snapshot = (free: number, asset = "BRL") => ({ observed_at: new Date(now).toISOString(), balances: [{ asset, free }] });

test("Jenny incident: physical Spot balance cannot be replaced by logical capital or locked funds", () => {
  assert.equal(liveQuoteBalanceCheck(snapshot(.0043), "BRL", .019 * 562, 0, now).sufficient, false);
  assert.equal(liveQuoteBalanceCheck(snapshot(10.678), "BRL", .019 * 562, 0, now).sufficient, true);
  assert.equal(liveQuoteBalanceCheck(snapshot(10.677), "BRL", .019 * 562, 0, now).sufficient, false);
  assert.equal(liveQuoteBalanceCheck(snapshot(0), "BRL", 10.678, 10.678, now).sufficient, true);
});

test("missing, stale, future, duplicated or malformed balance fails closed; other currency cannot fund BUY", () => {
  for (const state of [snapshot(-1), snapshot(NaN), snapshot(Infinity), snapshot(100, "USDT"),
    { ...snapshot(100), balances: [] }, { ...snapshot(100), balances: [{ asset: "BRL", free: 100 }, { asset: "BRL", free: 100 }] },
    { ...snapshot(100), observed_at: "invalid" }, { ...snapshot(100), observed_at: new Date(now - 30_001).toISOString() },
    { ...snapshot(100), observed_at: new Date(now + 2_001).toISOString() }])
    assert.throws(() => liveQuoteBalanceCheck(state, "BRL", 10, 0, now), /QUOTE_BALANCE_UNAVAILABLE/);
  for (const value of [0, -1, NaN, Infinity])
    assert.throws(() => liveQuoteBalanceCheck(snapshot(100), "BRL", value, 0, now), /QUOTE_BALANCE_UNAVAILABLE/);
  assert.throws(() => liveQuoteBalanceCheck(snapshot(100), "BRL", 10, -1, now), /QUOTE_BALANCE_UNAVAILABLE/);
  assert.equal(liveQuoteBalanceCheck(snapshot(10, "USDT"), "USDT", 10, 0, now).sufficient, true);
});

/** Runs real armNextEntry + hold logic. Every other financial/network boundary
 * is a fixture or rejects; never loads an environment/client or calls Binance. */
function fixture(options: { initial?: boolean; free?: number; asset?: "BTC" | "SOL"; quote?: "BRL" | "USDT";
  engineId?: string; resident?: boolean; prepared?: boolean; provenUnsent?: boolean; stale?: boolean;
  unverifiedResident?: boolean; bnbFree?: number; withTp?: boolean; decisionAmbiguous?: boolean } = {}) {
  const calls: string[] = [];
  const events: Array<{ type: string; details: Record<string, unknown> }> = [];
  const writes: Array<{ table: string; data: Record<string, unknown>; filters: Record<string, unknown> }> = [];
  const asset = options.asset ?? "SOL", quote = options.quote ?? "BRL";
  const scope = { operator_id: "operator", exchange_account_id: "account", trading_engine_id: options.engineId ?? "engine-a",
    product_id: "product", tenant_id: "tenant", user_id: "user", symbol: `${asset}${quote}`, quote_asset: quote };
  const run = { ...scope, id: `run-${scope.trading_engine_id}`, asset, status: "ACTIVE", entry_regime: "NORMAL",
    engine: { id: scope.trading_engine_id } };
  const slot = { ...scope, id: "slot-4", slot_number: options.initial ? 1 : 4, operational_rank: 1,
    entry_state: "PLANNED", position_quantity: 0, operation_sequence: 1, target_buy_price: 562 };
  const resident = { ...scope, id: "buy", run_id: run.id, slot_id: slot.id, side: "BUY", purpose: "ENTRY", revision: 1,
    status: options.prepared ? "PREPARED" : "NEW", executed_quantity: 0, cumulative_quote: 0,
    reserved_notional_brl: 10.678, price: 562, exchange_order_id: options.prepared ? null : "own-buy",
    client_order_id: "owned-buy", operation_sequence: 1, requested_quantity: .019,
    strategy_decision_id: "fixture-decision",
    account_order_unsent_receipt: options.provenUnsent ? { request_nonce: "verified-under-lease" } : null };
  const tp = { ...scope, id: "tp", run_id: run.id, slot_id: "open-slot-2", side: "SELL", purpose: "TP", revision: 1,
    status: "NEW", executed_quantity: 0, cumulative_quote: 0, price: 600, exchange_order_id: "own-tp",
    client_order_id: "owned-tp", operation_sequence: 1, requested_quantity: .02, trades_reconciled: false,
    reserved_notional_brl: 0, strategy_decision_id: "tp-decision", account_order_unsent_receipt: null };
  const ledger = { slots: [slot], accounts: [{ slot_number: slot.slot_number, balance_brl: 11 }],
    orders: options.resident || options.prepared ? [resident] : options.initial ? [] : [{ side: "BUY", status: "FILLED", executed_quantity: .018 }] };
  if (options.withTp) ledger.orders.push(tp);
  const exposureEngine = { ...scope, id: scope.trading_engine_id, base_asset: asset, environment: "REAL",
    hard_cap_quote: 275, executor_shard_id: "executor-02" };
  const exposureSlots = Array.from({ length: 25 }, (_, index) => ({ ...scope, run_id: run.id,
    slot_number: index + 1, id: index + 1 === slot.slot_number ? slot.id : index === 1 ? tp.slot_id : `physical-${index + 1}`,
    position_committed_brl: options.withTp && index === 1 ? 10 : 0 }));
  const exposureOrders = [...(options.resident || options.prepared ? [resident] : []), ...(options.withTp ? [tp] : [])];
  const state = { ...scope, observed_at: new Date(Date.now() - (options.stale ? 31_000 : 0)).toISOString(),
    balances: [{ asset: quote, free: options.free ?? .0043 }, { asset: "BNB", free: options.bnbFree ?? 1 }], price: { price: 580 },
    bnb_quote_price: { symbol: `BNB${quote}`, price: 1000, observedAt: new Date().toISOString() },
    filters: { minNotional: 5, minQuantity: .001, maxQuantity: 100, quantityStep: .001 },
    open_orders: options.resident && !options.unverifiedResident
      ? [{ id: "own-buy", side: "BUY", status: "NEW", executedQuantity: 0, clientOrderId: "owned-buy", price: 562 }] : [] };
  const warnings = new Map<string, { code: string; resolved_at: string | null; first_seen_at?: string }>();
  const service = { from(table: string) {
    assert.ok(["robot_v1_live_alerts", "robot_v1_strategy_decisions", "robot_v1_live_runs", "trading_engines",
      "robot_v1_live_slots", "robot_v1_live_orders", "account_quote_caps"].includes(table));
    const filters: Record<string, unknown> = {}; let data: Record<string, unknown> | null = null;
    let exactCount = false, page: [number, number] | null = null;
    const response = (singular = false) => {
      if (!["robot_v1_live_alerts", "robot_v1_strategy_decisions"].includes(table)) {
        assert.equal(data, null, "funding checks cannot mutate the exposure ledger");
        const all = table === "robot_v1_live_runs" ? [run] : table === "trading_engines" ? [exposureEngine]
          : table === "robot_v1_live_slots" ? exposureSlots : table === "robot_v1_live_orders" ? exposureOrders
          : [{ ...scope, hard_cap_quote: 275 }];
        const rows = all.filter(row => Object.entries(filters).every(([key, value]) => {
          const observed = (row as Record<string, unknown>)[key.startsWith("in:") ? key.slice(3) : key];
          return key.startsWith("in:") ? (value as unknown[]).includes(observed) : observed === value;
        }));
        const selected = page ? rows.slice(page[0], page[1] + 1) : rows;
        return { error: null, data: singular ? selected[0] ?? null : selected,
          ...(exactCount ? { count: rows.length } : {}) };
      }
      if (data) {
        assert.equal(filters.trading_engine_id ?? data.trading_engine_id, scope.trading_engine_id);
        writes.push({ table, data, filters: { ...filters } });
        const alertKey = String(filters.alert_key ?? data.alert_key);
        warnings.set(alertKey, { code: String(data.code ?? warnings.get(alertKey)?.code), resolved_at: data.resolved_at as string | null,
          first_seen_at: String(data.first_seen_at ?? warnings.get(alertKey)?.first_seen_at ?? new Date().toISOString()) });
      }
      return { error: null, data: table === "robot_v1_strategy_decisions"
        ? { result: options.provenUnsent && !options.decisionAmbiguous ? "PENDING" : "DISPATCHED",
          dispatched_at: options.provenUnsent && !options.decisionAmbiguous ? null : new Date().toISOString(),
          exchange_ack_at: null, completed_at: null } : filters.resolved_at === null && warnings.get(String(filters.alert_key))?.resolved_at !== null
          ? null : warnings.get(String(filters.alert_key)) ?? null };
    };
    const chain = { select: (_columns?: string, options?: { count?: string }) => {
      exactCount = options?.count === "exact"; return chain;
    }, eq: (k: string, v: unknown) => { filters[k] = v; return chain; },
      is: (k: string, v: unknown) => { filters[k] = v; return chain; },
      in: (k: string, v: unknown[]) => { filters[`in:${k}`] = v; return chain; },
      order: () => chain, abortSignal: () => chain,
      range: (start: number, end: number) => { page = [start, end]; return chain; },
      upsert: (v: Record<string, unknown>) => { data = v; return chain; },
      update: (v: Record<string, unknown>) => { data = v; return chain; },
      single: async () => response(true), maybeSingle: async () => response(true),
      then: (done: (v: unknown) => unknown) => Promise.resolve(response()).then(done) };
    return chain;
  } };
  const dependencies: Record<string, unknown> = {
    "./live-account-budget-alert": { resolveAccountBudgetAlert, AccountBudgetAlertResolutionError },
    "./live-quote-balance": { liveQuoteBalanceCheck },
    "./live-bnb-fee-balance": { liveBnbFeeBalanceCheck },
    "./live-read-error": { LiveReadUnavailable, liveFailureEvidence },
    "./live-exposure-read": { readLiveExposure },
    "./live-executor-transport": { readLiveExecutorState: async () => state,
      readLiveExecutorOrder: async (_scope: unknown, clientId: string) => ({ order: clientId === tp.client_order_id
        ? { ...tp, clientOrderId: tp.client_order_id, symbol: scope.symbol, orderId: tp.exchange_order_id } : null }) },
    "./live-reconciliation-shortcut": { unchangedUnfilledResidentOrder: (order: { side: string }) => order.side === "SELL" },
    "./live-unsent-entry-recovery": { mayAttestUnsentEntry: () => false },
    "./live-unsent-tp-recovery": { isProvablyUnsentTakeProfit: () => false },
    "./live-executor-health": { loadLiveEngineExecutorStatus: async () => ({ gate: "LIVE_EXECUTOR_ACTIVE" }) },
    "./robot-v1-live-cycle": { LIVE_ACTIVE_ORDER_STATUSES: new Set(["NEW", "PREPARED"]),
      liveClientOrderId: () => "same-id" },
    "./live-entry-capital-refresh": { canRestoreUnfilledEntry: () => false, planLiveEntryCapitalRefresh: () => null },
    "./strategy-engine": { STRATEGY_VERSION: "fixture", planStrategyInitialEntry: () => ({ action_type: "OPEN_INITIAL_MARKET" }),
      planStrategyNextEntry: () => ({ decision: { action_type: "ARM_NEXT_BUY", reason: "fixture" },
        nextCandidateId: slot.id, missedCandidateIds: [] }) },
    "./strategy-decision-server": { persistStrategyDecision: async () => { calls.push("persist-decision"); } },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./robot-v1-live-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", "fixture", compiled + `
    const realReconcileOrder=reconcileOrder;
    exports.reconcile=()=>realReconcileOrder(fixture.service,fixture.run,fixture.resident);
    exports.reconcileTp=()=>realReconcileOrder(fixture.service,fixture.run,fixture.tp);
    validateRunEngine=async()=>{}; scopedPreparation=async()=>({live_enabled:true,kill_switch:false,max_order_notional_brl:11,max_total_exposure_brl:275});
    runRows=async()=>fixture.ledger; configUpdatePending=async()=>false;
    assertLiveOrderPrice=()=>{}; assertExchangeMatchesLedger=async()=>[];
    entryBlocked=()=>false; quoteCap=async()=>275;
    monthly=async()=>[{physicalSlotNumber:fixture.slot.slot_number,operationalRank:1,eligibleForNewEntry:true}];
    candidate=()=>({});
    event=async(_service,_run,_key,type,_slot,details)=>fixture.events.push({type,details});
    prepareOrder=async()=>{fixture.calls.push('prepare');return {};};
    updateSlot=async()=>fixture.calls.push('slot-update'); reconcileOrder=async()=>fixture.calls.push('dispatch');
    renewLease=async()=>{}; appliedCapitalSources=async()=>[];
    cancelOwnedEntry=async()=>{fixture.calls.push('cancel');return true;};
    preventNewBuys=async()=>fixture.calls.push('prevent-new-buys');
    exports.execute=()=>armNextEntry(fixture.service,fixture.run,fixture.ledger,fixture.state);
  `)((name: string) => dependencies[name] ?? {}, exports, { service, run, ledger, state, slot, resident, tp, calls, events });
  // arm fixture stops at dispatch; reconcile fixture executes the real pre-POST hold.
  const realReconcile = exports.reconcile as () => Promise<unknown>;
  return { execute: exports.execute as () => Promise<string>, reconcile: realReconcile,
    reconcileTp: exports.reconcileTp as () => Promise<unknown>, calls, events, writes, warnings, state, scope, resident, tp, ledger };
}

test("BTC/SOL, BRL/USDT initial and NEXT BUY shortage holds before any financial preparation; replenishment retries normal flow", async () => {
  for (const asset of ["BTC", "SOL"] as const) for (const quote of ["BRL", "USDT"] as const)
    for (const initial of [false, true]) for (const engineId of ["engine-a", "engine-b"]) {
      const f = fixture({ asset, quote, initial, engineId });
      assert.equal(await f.execute(), "QUOTE_BALANCE_HOLD");
      assert.equal(f.calls.length, 0);
      assert.equal(f.events[0].type, "ENTRY_QUOTE_BALANCE_HOLD");
      assert.equal(f.writes[0].data.severity, "WARNING");
      assert.equal(f.writes[0].data.trading_engine_id, engineId);
      assert.equal(await f.execute(), "QUOTE_BALANCE_HOLD");
      assert.equal(f.writes.length, 1); assert.equal(f.events.length, 1);
      f.state.balances[0].free = 20; f.state.observed_at = new Date().toISOString();
      assert.equal(await f.execute(), initial ? "INITIAL_SUBMITTED" : "NEXT_BUY_ARMED");
      assert.ok(f.calls.includes("prepare")); assert.ok(f.calls.includes("dispatch"));
      assert.equal(f.events[1].type, "ENTRY_QUOTE_BALANCE_AVAILABLE");
      assert.ok(f.writes.every(w => !w.data.kill_switch));
    }
});

test("replacement reclaims only exact own unfilled resident; never cancels when funding is insufficient", async () => {
  const verified = fixture({ resident: true, free: 0 });
  assert.equal(await verified.execute(), "NEXT_BUY_ARMED");
  assert.ok(verified.calls.includes("cancel"));
  const unverified = fixture({ resident: true, free: 0, unverifiedResident: true });
  assert.equal(await unverified.execute(), "QUOTE_BALANCE_HOLD");
  assert.deepEqual(unverified.calls, []);
});

test("unknown quote balance and ambiguous PREPARED never become a funding hold or release an old claim", async () => {
  // Keep the BNB observation valid to exercise the independent quote guard.
  const unknownQuote = fixture({ free: NaN });
  await assert.rejects(unknownQuote.execute(), /QUOTE_BALANCE_UNAVAILABLE/);
  assert.deepEqual(unknownQuote.calls, []);
  const prepared = fixture({ prepared: true, free: 100 });
  await assert.rejects(prepared.execute(), /PREPARED_BUY_UNRESOLVED/);
  assert.deepEqual(prepared.calls, []); assert.deepEqual(prepared.writes, []);
});

test("certified unsent PREPARED holds its identity without cancel/prepare/dispatch or blocking TP flow", async () => {
  const f = fixture({ prepared: true, provenUnsent: true });
  assert.equal(await f.execute(), "QUOTE_BALANCE_HOLD");
  assert.deepEqual(f.calls, []);
  assert.equal(f.events[0].type, "ENTRY_QUOTE_BALANCE_HOLD");
  assert.equal(await f.execute(), "QUOTE_BALANCE_HOLD");
  assert.equal(f.writes.length, 1);
});

test("real reconciler holds a certified unsent BUY before permits/guard/POST; ambiguous dispatch never becomes HOLD", async () => {
  const f = fixture({ prepared: true, provenUnsent: true });
  Object.assign(f.resident, { submission_guarded_at: "2026-10-07T13:39:45Z", strategy_decision_id: "decision" });
  assert.equal(await f.reconcile(), f.resident);
  assert.equal(f.events[0].type, "ENTRY_QUOTE_BALANCE_HOLD");
  assert.equal(f.calls.length, 0);
  assert.equal(f.resident.client_order_id, "owned-buy");
  assert.equal(f.writes.length, 1);
  const ambiguous = fixture({ prepared: true });
  Object.assign(ambiguous.resident, { submission_guarded_at: "2026-10-07T13:39:45Z", strategy_decision_id: "decision" });
  await assert.rejects(ambiguous.reconcile(), /SUBMISSION_OUTCOME_UNKNOWN/);
  assert.equal(ambiguous.writes.length, 0);
});

test("BNB fee hold before first/NEXT BUY preserves every resident and emits only transitions across engine/currency", async () => {
  for (const asset of ["BTC", "SOL"] as const) for (const quote of ["BRL", "USDT"] as const)
    for (const initial of [true, false]) for (const engineId of ["engine-a", "engine-b"]) {
      const f = fixture({ asset, quote, initial, engineId, free: 100, bnbFree: .00001, withTp: !initial });
      const before = structuredClone(f.tp);
      assert.equal(await f.execute(), "BNB_FEE_BALANCE_HOLD");
      assert.equal(f.calls.length, 0);
      assert.equal(f.events[0].type, "ENTRY_BNB_FEE_BALANCE_HOLD");
      assert.equal(f.writes[0].data.severity, "WARNING");
      assert.equal(f.writes[0].data.trading_engine_id, engineId);
      assert.equal(await f.execute(), "BNB_FEE_BALANCE_HOLD");
      assert.equal(f.events.length, 1); assert.equal(f.writes.length, 1);
      assert.deepEqual(f.tp, before);
      assert.deepEqual(await f.reconcileTp(), f.tp, "resident TP observations do not require BNB funds");
      f.state.balances[1].free = .001;
      f.state.observed_at = f.state.bnb_quote_price.observedAt = new Date().toISOString();
      assert.equal(await f.execute(), initial ? "INITIAL_SUBMITTED" : "NEXT_BUY_ARMED");
      assert.equal(f.events[1].type, "ENTRY_BNB_FEE_BALANCE_AVAILABLE");
      assert.ok(f.calls.includes("prepare")); assert.ok(f.calls.includes("dispatch"));
      assert.deepEqual(f.tp, before);
      assert.ok(f.writes.every((write) => !write.data.kill_switch));
    }
});

test("insufficient BNB never cancels an existing NEXT BUY, even when replacement has funded quote", async () => {
  const f = fixture({ resident: true, free: 100, bnbFree: 0, withTp: true });
  const before = structuredClone(f.resident);
  assert.equal(await f.execute(), "BNB_FEE_BALANCE_HOLD");
  assert.equal(f.calls.filter((call) => call !== "slot-update").length, 0, "resident metadata may reconcile, but no cancel/preparation/dispatch");
  assert.deepEqual(f.resident, before);
  f.state.balances[1].free = .001;
  f.state.observed_at = f.state.bnb_quote_price.observedAt = new Date().toISOString();
  assert.equal(await f.execute(), "NEXT_BUY_ARMED");
  assert.ok(f.calls.includes("cancel"));
});

test("BNB PREPARED hold requires released canonical receipt and pending exact scoped decision", async () => {
  const f = fixture({ prepared: true, provenUnsent: true, free: 100, bnbFree: 0, withTp: true });
  Object.assign(f.resident, { submission_guarded_at: "2026-10-11T17:10:00Z" });
  assert.equal(await f.reconcile(), f.resident);
  assert.equal(await f.execute(), "BNB_FEE_BALANCE_HOLD");
  assert.equal(f.events.length, 1); assert.equal(f.writes.length, 1);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.reconcileTp(), f.tp);
  const ambiguous = fixture({ prepared: true, provenUnsent: true, decisionAmbiguous: true, free: 100, bnbFree: 0 });
  Object.assign(ambiguous.resident, { submission_guarded_at: "2026-10-11T17:10:00Z" });
  await assert.rejects(ambiguous.execute(), /PREPARED_BUY_UNRESOLVED/);
  await assert.rejects(ambiguous.reconcile(), /SUBMISSION_OUTCOME_UNKNOWN/);
  assert.deepEqual(ambiguous.calls, []); assert.deepEqual(ambiguous.writes, []);
});

test("unknown/stale BNB remains a durable read-only BUY checkpoint while TP reconciliation continues", async () => {
  for (const prepared of [false, true]) {
    const f = fixture({ prepared, provenUnsent: prepared, free: 100, bnbFree: 1, withTp: true });
    if (prepared) Object.assign(f.resident, { submission_guarded_at: "2026-10-11T17:10:00Z" });
    const before = structuredClone(f.tp);
    f.state.bnb_quote_price.observedAt = new Date(Date.now() - 30_001).toISOString();
    if (prepared) assert.equal(await f.reconcile(), f.resident);
    assert.equal(await f.execute(), "BNB_FEE_READ_HOLD");
    assert.equal(await f.execute(), "BNB_FEE_READ_HOLD");
    assert.equal(f.writes.length, 1, "repeated observations do not spam alerts or reset the read checkpoint");
    assert.equal(f.events.length, 0, "unknown is not reported as zero or confirmed shortage");
    assert.deepEqual(f.calls, []);
    assert.equal(f.writes[0].data.code, "COINOPS_LIVE_BNB_FEE_BALANCE_UNAVAILABLE");
    assert.equal(f.writes[0].data.trading_engine_id, f.scope.trading_engine_id);
    assert.deepEqual(await f.reconcileTp(), f.tp);
    assert.deepEqual(f.tp, before);
    const checkpointKey = `LIVE_RUN:run-${f.scope.trading_engine_id}:BNB_FEE_READ`;
    f.warnings.get(checkpointKey)!.first_seen_at = new Date(Date.now() - 300_001).toISOString();
    assert.equal(await f.execute(), "BNB_FEE_READ_HOLD");
    assert.deepEqual(f.calls, ["prevent-new-buys"], "persistent outage uses the existing engine-only entry gate, never an order write");
    assert.deepEqual(await f.reconcileTp(), f.tp);
    f.state.observed_at = f.state.bnb_quote_price.observedAt = new Date().toISOString();
    // The fixture gate is deliberately non-mutating; the actual persistent
    // gate is recovered only by the canonical lease/CAS Watchdog runbook.
    if (!prepared) assert.equal(await f.execute(), "NEXT_BUY_ARMED");
    assert.deepEqual(f.tp, before);
    assert.ok(f.writes.every((write) => !write.data.kill_switch));
  }
});
