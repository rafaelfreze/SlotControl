import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { liveQuoteBalanceCheck } from "./live-quote-balance.ts";

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
  engineId?: string; resident?: boolean; prepared?: boolean; provenUnsent?: boolean; stale?: boolean; unverifiedResident?: boolean } = {}) {
  const calls: string[] = [];
  const events: Array<{ type: string; details: Record<string, unknown> }> = [];
  const writes: Array<{ table: string; data: Record<string, unknown>; filters: Record<string, unknown> }> = [];
  const asset = options.asset ?? "SOL", quote = options.quote ?? "BRL";
  const scope = { operator_id: "operator", exchange_account_id: "account", trading_engine_id: options.engineId ?? "engine-a",
    product_id: "product", tenant_id: "tenant", user_id: "user", symbol: `${asset}${quote}`, quote_asset: quote };
  const run = { ...scope, id: `run-${scope.trading_engine_id}`, asset, entry_regime: "NORMAL", engine: { id: scope.trading_engine_id } };
  const slot = { ...scope, id: "slot-4", slot_number: options.initial ? 1 : 4, operational_rank: 1,
    entry_state: "PLANNED", position_quantity: 0, operation_sequence: 1, target_buy_price: 562 };
  const resident = { ...scope, id: "buy", slot_id: slot.id, side: "BUY", purpose: "ENTRY", revision: 1,
    status: options.prepared ? "PREPARED" : "NEW", executed_quantity: 0, cumulative_quote: 0,
    reserved_notional_brl: 10.678, price: 562, exchange_order_id: options.prepared ? null : "own-buy",
    client_order_id: "owned-buy", operation_sequence: 1, requested_quantity: .019,
    account_order_unsent_receipt: options.provenUnsent ? { request_nonce: "verified-under-lease" } : null };
  const ledger = { slots: [slot], accounts: [{ slot_number: slot.slot_number, balance_brl: 11 }],
    orders: options.resident || options.prepared ? [resident] : options.initial ? [] : [{ side: "BUY", status: "FILLED", executed_quantity: .018 }] };
  const state = { ...scope, observed_at: new Date(Date.now() - (options.stale ? 31_000 : 0)).toISOString(),
    balances: [{ asset: quote, free: options.free ?? .0043 }], price: { price: 580 },
    filters: { minNotional: 5, minQuantity: .001, maxQuantity: 100, quantityStep: .001 },
    open_orders: options.resident && !options.unverifiedResident
      ? [{ id: "own-buy", side: "BUY", status: "NEW", executedQuantity: 0, clientOrderId: "owned-buy", price: 562 }] : [] };
  let warning: { code: string; resolved_at: string | null } | null = null;
  const service = { from(table: string) {
    assert.ok(["robot_v1_live_alerts", "robot_v1_strategy_decisions"].includes(table));
    const filters: Record<string, unknown> = {}; let data: Record<string, unknown> | null = null;
    const response = () => {
      if (data) {
        assert.equal(filters.trading_engine_id ?? data.trading_engine_id, scope.trading_engine_id);
        writes.push({ table, data, filters: { ...filters } });
        warning = { code: String(data.code ?? warning?.code), resolved_at: data.resolved_at as string | null };
      }
      return { error: null, data: table === "robot_v1_strategy_decisions"
        ? { result: options.provenUnsent ? "PENDING" : "DISPATCHED", dispatched_at: options.provenUnsent ? null : new Date().toISOString(),
          exchange_ack_at: null, completed_at: null } : warning };
    };
    const chain = { select: () => chain, eq: (k: string, v: unknown) => { filters[k] = v; return chain; },
      is: (k: string, v: unknown) => { filters[k] = v; return chain; },
      upsert: (v: Record<string, unknown>) => { data = v; return chain; },
      update: (v: Record<string, unknown>) => { data = v; return chain; },
      maybeSingle: async () => response(), then: (done: (v: unknown) => unknown) => Promise.resolve(response()).then(done) };
    return chain;
  } };
  const dependencies: Record<string, unknown> = {
    "./live-quote-balance": { liveQuoteBalanceCheck },
    "./live-executor-transport": { readLiveExecutorState: async () => state,
      readLiveExecutorOrder: async () => ({ order: null }) },
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
    validateRunEngine=async()=>{}; scopedPreparation=async()=>({live_enabled:true,kill_switch:false,max_order_notional_brl:11,max_total_exposure_brl:275});
    runRows=async()=>fixture.ledger; configUpdatePending=async()=>false;
    assertLiveOrderPrice=()=>{}; assertExchangeMatchesLedger=async()=>[];
    entryBlocked=()=>false; quoteCap=async()=>275; exposure=async()=>({SOL:0,BTC:0,global:0});
    monthly=async()=>[{physicalSlotNumber:fixture.slot.slot_number,operationalRank:1,eligibleForNewEntry:true}];
    candidate=()=>({});
    event=async(_service,_run,_key,type,_slot,details)=>fixture.events.push({type,details});
    prepareOrder=async()=>{fixture.calls.push('prepare');return {};};
    updateSlot=async()=>fixture.calls.push('slot-update'); reconcileOrder=async()=>fixture.calls.push('dispatch');
    renewLease=async()=>{}; appliedCapitalSources=async()=>[];
    cancelOwnedEntry=async()=>{fixture.calls.push('cancel');return true;};
    exports.execute=()=>armNextEntry(fixture.service,fixture.run,fixture.ledger,fixture.state);
  `)((name: string) => dependencies[name] ?? {}, exports, { service, run, ledger, state, slot, resident, calls, events });
  // arm fixture stops at dispatch; reconcile fixture executes the real pre-POST hold.
  const realReconcile = exports.reconcile as () => Promise<unknown>;
  return { execute: exports.execute as () => Promise<string>, reconcile: realReconcile, calls, events, writes, state, scope, resident };
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

test("stale balance and ambiguous PREPARED never become a funding hold or release an old claim", async () => {
  const stale = fixture({ stale: true });
  await assert.rejects(stale.execute(), /QUOTE_BALANCE_UNAVAILABLE/);
  assert.deepEqual(stale.calls, []);
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
