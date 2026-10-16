import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as slotTopology from "./engine-slot-topology.ts";
import * as observationRetryBudget from "./live-observation-retry-budget.ts";
import ts from "typescript";
import { completeLedgerRead } from "./complete-ledger-read.ts";
import { readLiveExposure } from "./live-exposure-read.ts";
import { resolveAccountBudgetAlert, AccountBudgetAlertResolutionError } from "./live-account-budget-alert.ts";
import { continueLiveAdvance } from "./live-cycle-continuation.ts";
import { boundedLedgerRead, observeLedgerRows, observeLedgerRecord, assertPhysicalLedger } from "./live-ledger-read.ts";
import * as readErrors from "./live-read-error.ts";
import { AccountOrderNotSubmitted } from "./account-order-unsent-proof.ts";

type Row = Record<string, any>;
type Options = { status?: string; lastTpFill?: boolean; remainingOpen?: boolean; missingTp?: boolean;
  residentBuy?: boolean; fillDuringCancel?: boolean; cancelUnknown?: boolean; busy?: boolean;
  ambiguousBuy?: boolean; gateLost?: boolean; exposureBreach?: boolean; sibling?: boolean; slotCount?: number };

/** In-memory DB and exchange only. Exercise the real public pause/advance
 * orchestrators, with isolated deterministic transport and no LIVE credentials. */
function fixture(options: Options = {}) {
  const count = options.slotCount ?? 25;
  const calls: string[] = [], writes: Array<{ table: string; values: Row; filters: Row }> = [];
  const scope = { product_id: "product", tenant_id: "tenant", user_id: "user", operator_id: "operator",
    exchange_account_id: "account-a", trading_engine_id: "engine-a", symbol: "SOLBRL", quote_asset: "BRL" };
  const run: Row = { ...scope, id: "run-a", asset: "SOL", status: options.status ?? "PAUSED",
    strategy_version: "fixture", last_error: null, last_reconciled_at: new Date().toISOString(),
    lease_owner: null, lease_until: null, gain_rate: .1, entry_spacing: .03, entry_regime: "NORMAL",
    slot_count: count, config_snapshot: { slot_count: count } };
  const engine: Row = { ...scope, id: "engine-a", environment: "REAL", base_asset: "SOL", status: "ACTIVE",
    engine_kill_switch: true, kill_switch: true, global_kill_switch: false, account_kill_switch: false,
    hard_cap_quote: options.exposureBreach ? 5 : count * 11, strategy_config_pending: false,
    executor_shard_id: "executor-02", slot_count: count };
  const prep: Row = { ...scope, id: "prep-a", live_enabled: true, kill_switch: true, max_total_exposure_brl: count * 11, slot_count: count };
  const slots: Row[] = Array.from({ length: count }, (_, index) => ({ ...scope, id: `slot-${index + 1}`, run_id: run.id,
    slot_number: index + 1, entry_state: "PLANNED", operation_sequence: 1, position_quantity: 0,
    position_committed_brl: 0, target_buy_price: 10, entry_reference_price: 10,
    entry_origin: "GRID", operational_rank: index + 1, missed_at: null,
    last_credited_sell_client_order_id: null }));
  const accounts: Row[] = slots.map(slot => ({ ...scope, asset: "SOL", slot_number: slot.slot_number,
    balance_brl: 11, contribution_brl: 11, market_pnl_brl: 0, manual_gain_brl: 0, fees_brl: 0,
    gain_count: 0, dust_quantity: 0, dust_cost_brl: 0 }));
  const orders: Row[] = [];
  const order = (slot: number, side: string, status: string, executed: number): Row => ({ ...scope,
    id: `order-${slot}-${side}`, run_id: run.id, slot_id: slots[slot - 1].id, slot_number: slot,
    operation_sequence: 1, side, purpose: side === "BUY" ? "ENTRY" : "TP", revision: 1,
    client_order_id: `owned:${slot}:${side}`, exchange_order_id: `exchange-${slot}-${side}`,
    status, executed_quantity: executed, cumulative_quote: executed * (side === "BUY" ? 10 : 11),
    requested_quantity: 1, requested_quote: null, price: side === "BUY" ? 10 : 11,
    reserved_notional_brl: side === "BUY" && status !== "FILLED" ? 10 : 0,
    trades_reconciled: true, submission_guarded_at: new Date().toISOString(),
    strategy_decision_id: `decision-${slot}-${side}`, fee_base: 0, fee_quote: 0, fee_other: [],
    config_snapshot: { gain_rate: .1, entry_spacing: .03 }, config_version: 1,
    created_at: "2026-10-01T00:00:00Z" });
  if (options.lastTpFill !== false) {
    slots[0].entry_state = "OPEN";
    orders.push(order(1, "BUY", "FILLED", 1), order(1, "SELL", "FILLED", 1));
  }
  if (options.remainingOpen) {
    Object.assign(slots[1], { entry_state: "OPEN", position_quantity: 1, position_committed_brl: 10 });
    orders.push(order(2, "BUY", "FILLED", 1));
    if (!options.missingTp) orders.push(order(2, "SELL", "NEW", 0));
  }
  if (options.residentBuy || options.ambiguousBuy) {
    slots[2].entry_state = "ARMED";
    orders.push({ ...order(3, "BUY", options.ambiguousBuy ? "UNKNOWN" : "NEW", 0), trades_reconciled: false });
  }
  const siblingScope = { ...scope, trading_engine_id: "engine-b" };
  const siblingRun: Row = { ...run, ...siblingScope, id: "run-b", status: "ACTIVE", slot_count: 25, config_snapshot: { slot_count: 25 } };
  const siblingEngine: Row = { ...engine, ...siblingScope, id: "engine-b", kill_switch: false,
    engine_kill_switch: false, executor_shard_id: "executor-03", slot_count: 25, hard_cap_quote: 275 };
  const siblingSlot: Row = { ...slots[0], ...siblingScope, id: "slot-b", run_id: "run-b", position_committed_brl: 10 };
  const siblingSlots = slots.slice(0, 25).map((slot, index) => index === 0 ? siblingSlot : { ...slot, ...siblingScope,
    id: `slot-b-${index + 1}`, run_id: "run-b", position_committed_brl: 0, position_quantity: 0 });
  const siblingBefore = JSON.stringify([siblingRun, siblingEngine, siblingSlots]);
  const exchangeOrders = new Map(orders.map(row => [row.client_order_id, { ...row }]));
  let credited = 0;
  const active = new Set(["PREPARED", "NEW", "PARTIALLY_FILLED"]);
  const terminal = new Set(["FILLED", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"]);
  const matches = (row: Row, filters: Row) => Object.entries(filters).every(([key, value]) =>
    key.startsWith("in:") ? (value as unknown[]).includes(row[key.slice(3)]) : row[key] === value);
  const resultRow = (row: Row) => structuredClone(row);
  const service = { from(table: string) {
    const filters: Row = {}; let values: Row | null = null, upsert = false, page: [number, number] | null = null;
    let exactCount = false;
    const response = (singular = false) => {
      let rows: Row[];
      if (table === "robot_v1_live_runs") rows = options.sibling ? [run, siblingRun] : [run];
      else if (table === "trading_engines") rows = options.sibling ? [engine, siblingEngine] : [engine];
      else if (table === "robot_v1_live_preparations") rows = [prep];
      else if (table === "robot_v1_live_slots") rows = options.sibling ? [...slots, ...siblingSlots] : slots;
      else if (table === "robot_v1_live_slot_accounts") rows = accounts;
      else if (table === "robot_v1_live_orders") rows = orders;
      else if (table === "operators") rows = [{ ...scope, status: "ACTIVE" }];
      else if (table === "account_quote_caps") rows = [{ ...scope, hard_cap_quote: 2000 }];
      else if (table === "robot_v1_live_alerts" || table === "robot_v1_live_events") rows = [];
      else assert.fail(`Unexpected table ${table}`);
      rows = rows!.filter(row => matches(row, filters));
      if (table === "robot_v1_live_runs" && values?.lease_owner && options.busy) rows = [];
      if (values) {
        writes.push({ table, values: resultRow(values), filters: resultRow(filters) });
        if (upsert) rows = [values];
        else rows.forEach(row => Object.assign(row, values));
        if (table === "trading_engines" && values.kill_switch !== undefined) engine.engine_kill_switch = values.kill_switch;
      }
      const count = rows.length;
      if (page) rows = rows.slice(page[0], page[1] + 1);
      return { data: singular ? rows[0] ? resultRow(rows[0]) : null : rows.map(resultRow), error: null,
        ...(exactCount ? { count } : {}) };
    };
    const query = { select: (_columns?: string, options?: { count?: string }) => {
      exactCount = options?.count === "exact"; return query;
    }, order: () => query, abortSignal: () => query,
      eq: (key: string, value: unknown) => { filters[key] = value; return query; },
      is: (key: string, value: unknown) => { filters[key] = value; return query; },
      in: (key: string, value: unknown[]) => { filters[`in:${key}`] = value; return query; },
      or: () => query, gt: () => query, limit: () => query,
      range: (start: number, end: number) => { page = [start, end]; return query; },
      update: (data: Row) => { values = data; return query; },
      upsert: (data: Row) => { values = data; upsert = true; return query; },
      single: async () => response(true), maybeSingle: async () => response(true),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(response()).then(resolve) };
    return query;
  }, async rpc(name: string, input: Row) {
    calls.push(name);
    assert.equal(input.p_run_id ?? "run-a", "run-a", "no sibling mutation");
    if (name === "credit_robot_v1_live_closed_slot") {
      const slot = slots.find(row => row.id === input.p_slot_id)!;
      const account = accounts.find(row => row.slot_number === slot.slot_number)!;
      if (slot.last_credited_sell_client_order_id !== input.p_tp_client_order_id) {
        credited++;
        account.balance_brl += 1; account.market_pnl_brl += 1; account.gain_count++;
        Object.assign(slot, { entry_state: "CLOSED", position_quantity: 0,
          position_committed_brl: 0, last_credited_sell_client_order_id: input.p_tp_client_order_id });
      }
      return { data: resultRow(account), error: null };
    }
    if (name === "sync_robot_v1_live_order") {
      const row = orders.find(row => row.id === input.p_order_id)!;
      Object.assign(row, { status: input.p_status, exchange_order_id: input.p_exchange_order_id,
        executed_quantity: Number(input.p_executed_quantity),
        cumulative_quote: Number(input.p_cumulative_quote), trades_reconciled: true });
      if (row.side === "BUY" && row.executed_quantity) Object.assign(slots[row.slot_number - 1], {
        entry_state: "OPEN", position_quantity: row.executed_quantity, position_committed_brl: row.cumulative_quote });
      return { data: resultRow(row), error: null };
    }
    if (name === "prepare_robot_v1_live_order") {
      assert.equal(input.p_side, "SELL", "a paused run may prepare only protective TP");
      const slot = slots.find(row => row.id === input.p_slot_id)!;
      const row = { ...order(slot.slot_number, "SELL", "PREPARED", 0), exchange_order_id: null,
        client_order_id: input.p_client_order_id, requested_quantity: input.p_quantity,
        price: input.p_price, submission_guarded_at: null };
      orders.push(row);
      return { data: resultRow(row), error: null };
    }
    assert.fail(`Unexpected financial RPC ${name}`);
  } };
  const observed = (row: Row) => ({ symbol: "SOLBRL", orderId: row.exchange_order_id,
    clientOrderId: row.client_order_id, side: row.side, status: row.status,
    executedQuantity: Number(row.executed_quantity), cumulativeQuoteQuantity: Number(row.cumulative_quote),
    price: Number(row.price), originalQuantity: Number(row.requested_quantity) });
  const state = () => ({ ...scope, observed_at: new Date().toISOString(), supports_unfilled_buy_cancel: true,
    filters: { baseAsset: "SOL", quoteAsset: "BRL", priceTick: .01, quantityStep: .001, minNotional: 1 },
    price: { price: 10, observedAt: new Date().toISOString() },
    open_orders: [...exchangeOrders.values()].filter(row => active.has(row.status)).map(row => ({
      id: row.exchange_order_id, ...observed(row) })) });
  const uncovered = (rows: Row[]) => Math.max(0,
    rows.filter(row => row.side === "BUY").reduce((n, row) => n + Number(row.executed_quantity), 0)
    - rows.filter(row => row.side === "SELL").reduce((n, row) => n + Number(row.executed_quantity)
      + (active.has(row.status) ? Number(row.requested_quantity) - Number(row.executed_quantity) : 0), 0));
  const dependencies: Record<string, unknown> = {
    "./live-observation-retry-budget": observationRetryBudget,
    "./engine-slot-topology": slotTopology,
    "./live-account-budget-alert": { resolveAccountBudgetAlert, AccountBudgetAlertResolutionError },
    "node:crypto": { randomUUID: () => "lease" },
    "../supabase/env": { getSupabaseDataSchema: () => "coinops", getCoinOpsServiceTenantId: () => "tenant" },
    "../supabase/service-role": { createServiceRoleClient: () => service },
    "./live-read-error": readErrors,
    "./live-ledger-read": { boundedLedgerRead, observeLedgerRows, observeLedgerRecord, assertPhysicalLedger },
    "./complete-ledger-read": { completeLedgerRead }, "./live-exposure-read": { readLiveExposure },
    "./live-cycle-continuation": { continueLiveAdvance },
    "./operator-context-server": { resolveOperatorEngine: async (_db: unknown, _scope: unknown, selection: Row) => {
      assert.equal(selection.trading_engine_id, "engine-a");
      return { ...engine, engine_kill_switch: options.gateLost ? false : engine.engine_kill_switch };
    } },
    "./operator-context": { assertRowEngine: (row: Row) => {
      assert.equal(row.trading_engine_id, "engine-a"); assert.equal(row.exchange_account_id, "account-a");
    } },
    "./robot-v1-live-cycle": { LIVE_ACTIVE_ORDER_STATUSES: active, LIVE_TERMINAL_ORDER_STATUSES: terminal,
      liveEngineOrderPrefix: () => "owned:", liveUncoveredQuantity: uncovered,
      liveClientOrderId: (_run: string, _asset: string, slot: number) => `owned:${slot}:SELL` },
    "./strategy-engine": { STRATEGY_VERSION: "fixture", planStrategyTakeProfit: () => ({ action_type: "CREATE_TP", target_price: 11 }),
      planStrategyClosedSlot: () => assert.fail("No recycle/reset decision while PAUSED") },
    "./strategy-price-invariant": { assertStrategyBuyPrice: () => {}, assertStrategyTakeProfitPrice: () => {} },
    "./live-strategy-snapshot": { strategyRatesForOrder: () => ({ gain: .1, spacing: .03 }) },
    "./monthly-slot-server": { loadMonthlySlotStatuses: async () => slots.map(slot => ({ physicalSlotNumber: slot.slot_number,
      operationalRank: slot.slot_number, monthlyTargetReached: false, eligibleForNewEntry: true })) },
    "./strategy-decision-server": { persistStrategyDecision: async () => {}, dispatchStrategyDecision: async () => new Date().toISOString(),
      completeStrategyDecision: async () => {} },
    "./account-order-budget-server": { accountExecutionPolicyRequired: async () => false,
      reserveAccountOrderDispatch: async () => null, acknowledgeAccountOrderDispatch: async () => {},
      AccountOrderBudgetHold: class AccountOrderBudgetHold extends Error {} },
    "./account-order-unsent-proof": { AccountOrderNotSubmitted },
    "./live-reconciliation-shortcut": { unchangedUnfilledResidentOrder: (row: Row, incoming: Row) =>
      row.status === "NEW" && incoming.status === "NEW" && row.executed_quantity === 0 },
    "./live-executor-health": { loadLiveEngineExecutorStatus: async () => ({ gate: "LIVE_EXECUTOR_PROTECTED" }) },
    "./live-executor-transport": {
      readLiveExecutorState: async () => { calls.push("exchange-state"); return state(); },
      readLiveExecutorOrder: async (_run: Row, clientId: string) => ({ order: exchangeOrders.has(clientId)
        ? observed(exchangeOrders.get(clientId)!) : null }),
      readLiveExecutorTrades: async (_run: Row, clientId: string) => ({ order: observed(exchangeOrders.get(clientId)!), trades: [] }),
      cancelLiveExecutorOrder: async (input: Row, selected: Row) => {
        assert.equal(selected.trading_engine_id, "engine-a"); calls.push("cancel-own-buy");
        if (options.cancelUnknown) throw new Error("EXECUTOR_HTTP_503");
        const row = exchangeOrders.get(input.clientOrderId)!;
        assert.equal(row.side, "BUY");
        Object.assign(row, options.fillDuringCancel ? { status: "FILLED", executed_quantity: 1, cumulative_quote: 10 }
          : { status: "CANCELED" });
        return { order: observed(row) };
      },
      createLiveExecutorOrder: async (input: Row, selected: Row) => {
        assert.equal(selected.trading_engine_id, "engine-a"); assert.equal(input.side, "SELL"); calls.push("create-protective-tp");
        const row = orders.find(row => row.client_order_id === input.clientOrderId)!;
        const incoming = { ...row, status: "NEW", exchange_order_id: `tp-new-${row.slot_number}` };
        exchangeOrders.set(row.client_order_id, incoming);
        return { order: observed(incoming) };
      } },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./robot-v1-live-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Row = {};
  new Function("require", "exports", compiled)((name: string) => dependencies[name] ?? {}, exports);
  return { advance: () => exports.advanceLiveRun("run-a"), pause: () => exports.pauseLiveRun("run-a", "user", "SOL"),
    calls, writes, run, slots, accounts, orders, credited: () => credited,
    assertSibling: () => assert.equal(JSON.stringify([siblingRun, siblingEngine, siblingSlots]), siblingBefore) };
}

test("last TP in a paused run credits once and never recycles, resets, creates successor or BUY", async () => {
  const f = fixture();
  assert.deepEqual(await f.advance(), { status: "PAUSED", next: "ENTRIES_PAUSED",
    continuation: [{ runId: "run-a", status: "PAUSED", next: "ENTRIES_PAUSED" }] });
  assert.equal(f.credited(), 1); assert.equal(f.accounts[0].gain_count, 1);
  assert.equal(f.slots[0].entry_state, "CLOSED"); assert.equal(f.slots[0].operation_sequence, 1);
  assert.equal(f.run.status, "PAUSED"); assert.equal(f.run.last_error, null);
  assert.ok(Date.now() - Date.parse(f.run.last_reconciled_at) < 5000);
  await f.advance();
  assert.equal(f.credited(), 1); assert.equal(f.accounts[0].gain_count, 1);
  assert.equal(f.calls.some(call => /restart|prepare|cancel|create/.test(call)), false);
  assert.equal(f.writes.some(write => write.values.kill_switch === false), false);
  const events = f.writes.filter(write => write.table === "robot_v1_live_events");
  assert.ok(events.some(write => write.values.event_type === "RECONCILED" && write.values.details.next === "ENTRIES_PAUSED"));
  assert.ok(events.filter(write => write.values.event_type === "RECONCILED").every(write =>
    write.values.details.protection_verified === true && write.values.details.quantity_step === .001
      && write.values.details.open_positions === 0 && write.values.details.resident_buy_count === 0));
});

test("remaining OPEN TP is retained while another slot closes; same-symbol cross-shard sibling is untouched", async () => {
  const f = fixture({ remainingOpen: true, sibling: true });
  const tp = JSON.stringify(f.orders.find(row => row.slot_number === 2 && row.side === "SELL"));
  assert.equal((await f.advance()).status, "PAUSED");
  assert.equal(f.credited(), 1); assert.equal(f.slots[1].entry_state, "OPEN");
  assert.equal(JSON.stringify(f.orders.find(row => row.slot_number === 2 && row.side === "SELL")), tp);
  f.assertSibling();
  assert.ok(f.writes.filter(write => write.table !== "robot_v1_live_events").every(write =>
    write.filters.id !== "engine-b" && write.filters.id !== "run-b"));
});

test("double pause revalidates ledger and protection under fresh leases without reopening BUY", async () => {
  const f = fixture({ status: "ACTIVE", lastTpFill: false, remainingOpen: true, sibling: true });
  assert.equal((await f.pause()).status, "PAUSED");
  const firstReads = f.calls.filter(call => call === "exchange-state").length;
  assert.equal((await f.pause()).status, "PAUSED");
  assert.ok(f.calls.filter(call => call === "exchange-state").length > firstReads);
  assert.equal(f.writes.filter(write => write.values.status === "PAUSED").length, 1);
  assert.equal(f.writes.some(write => write.values.kill_switch === false), false);
  assert.equal(f.calls.some(call => call.startsWith("create-") || call.startsWith("cancel-")), false);
  assert.equal(f.writes.filter(write => write.values.event_type === "LIVE_PAUSED").length, 2);
  assert.ok(f.writes.filter(write => write.values.event_type === "LIVE_PAUSED").every(write =>
    write.values.details.protection_verified === true && write.values.details.quantity_step === .001
      && write.values.details.open_positions === 1 && write.values.details.resident_buy_count === 0));
  f.assertSibling();
});

test("pausing cancels only own resident BUY and keeps old TP; confirmed fill during cancel wins and gets TP", async () => {
  for (const fillDuringCancel of [false, true]) {
    const f = fixture({ status: "ACTIVE", lastTpFill: false, remainingOpen: true, residentBuy: true, fillDuringCancel });
    assert.equal((await f.pause()).status, "PAUSED");
    assert.equal(f.calls.filter(call => call === "cancel-own-buy").length, 1);
    assert.equal(f.orders.find(row => row.slot_number === 2 && row.side === "SELL")!.status, "NEW");
    assert.equal(f.slots[2].entry_state, fillDuringCancel ? "OPEN" : "PLANNED");
    assert.equal(f.calls.filter(call => call === "create-protective-tp").length, fillDuringCancel ? 1 : 0);
    assert.equal(f.orders.some(row => row.side === "BUY" && row.status === "NEW"), false);
  }
});

test("lease busy never certifies pause and never cancels TP or touches siblings", async () => {
  const f = fixture({ status: "ACTIVE", lastTpFill: false, remainingOpen: true, busy: true, sibling: true });
  await assert.rejects(f.pause(), /COINOPS_LIVE_PAUSE_LEASE_BUSY/);
  assert.equal(f.run.status, "ACTIVE"); assert.equal(f.calls.length, 0);
  assert.equal(f.writes.some(write => write.values.kill_switch === false), false); f.assertSibling();
});

test("ambiguous BUY, lost pause gate and hard cap breach remain fail-closed only on the selected engine", async () => {
  for (const options of [{ ambiguousBuy: true }, { gateLost: true }, { remainingOpen: true, exposureBreach: true }]) {
    const f = fixture({ ...options, sibling: true });
    await assert.rejects(f.advance(), /COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN|COINOPS_LIVE_PAUSE_BUY_UNRESOLVED|COINOPS_LIVE_PAUSE_FLAGS_INVALID|COINOPS_LIVE_HARD_CAP_BREACHED/);
    assert.equal(f.writes.some(write => write.values.kill_switch === false), false);
    assert.ok(f.writes.filter(write => write.table === "trading_engines").every(write => write.filters.id === "engine-a"));
    f.assertSibling();
  }
});

test("uncertain cancellation is never treated as confirmed pause or recreated BUY", async () => {
  const f = fixture({ status: "ACTIVE", lastTpFill: false, remainingOpen: true, residentBuy: true, cancelUnknown: true });
  await assert.rejects(f.pause(), /COINOPS_LIVE_PAUSE_FAILED/);
  assert.equal(f.run.status, "ACTIVE"); assert.equal(f.orders.find(row => row.slot_number === 3)!.status, "NEW");
  assert.equal(f.calls.some(call => call === "create-protective-tp"), false);
  assert.equal(f.writes.some(write => write.values.kill_switch === false), false);
});

for (const count of [25, 50, 75, 100]) test(`${count} physical slots: gain credited once, reinvestment retained and sibling25 cross-shard untouched`, async () => {
  const f = fixture({ slotCount: count, remainingOpen: true, sibling: true });
  const tp = JSON.stringify(f.orders.find(row => row.slot_number === 2 && row.side === "SELL"));
  assert.equal((await f.advance()).status, "PAUSED");
  assert.equal((await f.advance()).status, "PAUSED");
  assert.equal(f.credited(), 1); assert.equal(f.accounts[0].gain_count, 1);
  assert.equal(f.accounts[0].balance_brl, 12); assert.equal(f.slots.length, count);
  assert.equal(JSON.stringify(f.orders.find(row => row.slot_number === 2 && row.side === "SELL")), tp);
  f.assertSibling();
});

for (const count of [50, 100]) test(`${count} slots: resident fill during pause cancellation receives TP and never duplicate BUY`, async () => {
  const f = fixture({ slotCount: count, status: "ACTIVE", lastTpFill: false, remainingOpen: true,
    residentBuy: true, fillDuringCancel: true, sibling: true });
  assert.equal((await f.pause()).status, "PAUSED");
  assert.equal(f.slots[2].entry_state, "OPEN");
  assert.equal(f.calls.filter(call => call === "create-protective-tp").length, 1);
  assert.equal(f.orders.some(row => row.side === "BUY" && row.status === "NEW"), false);
  f.assertSibling();
});
