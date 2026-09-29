import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as cycle from "../execution/robot-v1-live-cycle.ts";
import * as strategy from "../execution/strategy-engine.ts";
import * as capitalRefresh from "../execution/live-entry-capital-refresh.ts";
import * as priceInvariant from "../execution/strategy-price-invariant.ts";
import * as shortcut from "../execution/live-reconciliation-shortcut.ts";
import * as unsentTp from "../execution/live-unsent-tp-recovery.ts";
import * as strategySnapshot from "../execution/live-strategy-snapshot.ts";
import * as athLadder from "../execution/ath-ladder.ts";
import * as monthlyPolicy from "../execution/monthly-slot-policy.ts";
import * as strategyParameterRegistry from "../execution/strategy-parameter-registry.ts";
import * as scope from "../execution/operator-context.ts";

type Row = Record<string, unknown>;
type Runtime = {
  armNextEntry: (service: unknown, run: Row, ledger: unknown, state: Row) => Promise<string>;
  reconcileOrder: (service: unknown, run: Row, order: Row) => Promise<Row>;
  confirmCapitalRefreshes: (service: unknown, run: Row, ledger: unknown) => Promise<void>;
  applyAthTransition: (service: unknown, run: Row, ledger: unknown, state: Row, force: boolean) => Promise<boolean>;
  applyPendingStrategyUpdate: (service: unknown, run: Row, ledger: unknown, state: Row) => Promise<string>;
};
type Options = { asset?: "BTC" | "SOL"; currency?: "BRL" | "USDT"; legacy?: boolean;
  cancel?: "FILLED" | "PARTIALLY_FILLED" | "TIMEOUT_CANCELED" | "TIMEOUT_NEW";
  staleCaps?: boolean; noContribution?: boolean; contributionSource?: "SELECTIVE" | "ALL_SLOTS";
  openContributionOnly?: boolean; crashAfterCancel?: boolean; crashAfterPrepared?: boolean;
  lostCreateResponse?: boolean };

function harness(options: Options = {}) {
  const identity = { product_id: "product-fixture", tenant_id: "tenant-fixture", user_id: "user-fixture",
    operator_id: "operator-fixture", exchange_account_id: "account-fixture", trading_engine_id: "engine-fixture",
    quote_asset: options.currency ?? "USDT" };
  const asset = options.asset ?? "SOL";
  const engine = { ...identity, id: identity.trading_engine_id, base_asset: asset, environment: "REAL",
    symbol: `${asset}${identity.quote_asset}`, status: "ACTIVE", global_kill_switch: false,
    account_kill_switch: false, engine_kill_switch: false, legacy_compatible: options.legacy ?? false,
    hard_cap_quote: 1000, strategy_config_pending: false };
  const run: Row = { ...identity, id: "12345678-1234-1234-1234-123456789abc", asset, symbol: engine.symbol,
    engine, status: "ACTIVE", lease_owner: "lease-fixture", lease_until: new Date(Date.now() + 180_000).toISOString(),
    entry_regime: "NORMAL", entry_spacing: 0.03, gain_rate: 0.05, anchor_price: 110, config_snapshot: {},
    strategy_version: strategy.STRATEGY_VERSION };
  const profile: Row = { ...identity, id: "profile-fixture", asset, environment: "REAL",
    regime: "POST_ATH", config_version: 2, gain_rate: 0.05, normal_spacing_rate: 0.03,
    post_ath_spacing_rate: 0.05, next_config_version: null,
    transition_key: "transition-fixture", updated_at: new Date().toISOString() };
  const slots: Row[] = Array.from({ length: 25 }, (_, index) => ({ ...identity,
    id: `slot-${index + 1}`, run_id: run.id, slot_number: index + 1, operation_sequence: 1,
    entry_state: index === 0 ? "OPEN" : index === 1 ? "ARMED" : "PLANNED",
    entry_origin: "REENTRY", target_buy_price: index === 0 ? 110 : 101 - index,
    entry_reference_price: index === 0 ? 110 : 101 - index, operational_rank: index + 1,
    post_ath_group: null, post_ath_group_rank: null, missed_at: null,
    position_quantity: index === 0 ? 0.1 : 0, position_committed_brl: index === 0 ? 11 : 0 }));
  const accounts: Row[] = slots.map((slot, index) => ({ ...identity, slot_number: slot.slot_number, asset,
    balance_brl: index === 1 && !options.openContributionOnly ? 60 : index === 0 ? 11 : 10,
    contribution_brl: index === 1 && !options.openContributionOnly ? 60 : index === 0 ? 11 : 10,
    market_pnl_brl: 0, manual_gain_brl: 0, fees_brl: 0, gain_count: 0 }));
  function order(slotNumber: number, side: "BUY" | "SELL", values: Row = {}): Row {
    const revision = Number(values.revision ?? 1);
    return { ...identity, id: `order-${slotNumber}-${side}-${revision}`, run_id: run.id,
      slot_id: `slot-${slotNumber}`, slot_number: slotNumber, operation_sequence: 1, side,
      purpose: side === "SELL" ? "TP" : slotNumber === 1 ? "INITIAL" : "ENTRY", revision,
      client_order_id: cycle.liveClientOrderId(String(run.id), asset, slotNumber, 1, side, revision, engine),
      exchange_order_id: `exchange-${slotNumber}-${side}-${revision}`, status: "NEW",
      requested_quantity: 0.1, requested_quote: null, price: slotNumber === 1 ? 115.5 : 100,
      reserved_notional_brl: side === "BUY" ? 10 : 0, executed_quantity: 0, cumulative_quote: 0,
      fee_base: 0, fee_quote: 0, fee_other: [], trades_reconciled: false,
      submission_guarded_at: "2026-09-27T10:00:00.000Z", strategy_decision_id: `decision-${side}-${slotNumber}`,
      created_at: "2026-09-27T10:00:00.000Z", ...values };
  }
  const orders = [order(1, "BUY", { status: "FILLED", executed_quantity: 0.1, cumulative_quote: 11,
    reserved_notional_brl: 11, price: null, trades_reconciled: true }), order(1, "SELL"), order(2, "BUY")];
  const initialOpen = structuredClone({ slot: slots[0], account: accounts[0], tp: orders[1], buy: orders[0] });
  const applied = { ...identity, id: "allocation-new-capital", slot_number: 2, amount_quote: 50,
    status: "APPLIED", applied_at: "2026-09-27T11:00:00.000Z", created_at: "2026-09-27T11:00:00.000Z" };
  const tables: Record<string, Row[]> = {
    operators: [{ ...identity, status: "ACTIVE" }], trading_engines: [engine], robot_v1_live_runs: [run],
    robot_v1_live_slots: slots, robot_v1_live_slot_accounts: accounts, robot_v1_live_orders: orders,
    robot_v1_strategy_decisions: [],
    robot_v1_live_preparations: [{ ...identity, live_enabled: true, kill_switch: false,
      monthly_target: asset === "BTC" ? 7 : 2, max_order_notional_brl: 100, max_total_exposure_brl: 1000 }],
    account_quote_caps: [{ ...identity, hard_cap_quote: 1000 }], robot_v1_live_events: [],
    robot_v1_ath_profiles: [profile],
    strategy_bulk_batches: [], strategy_bulk_engine_updates: [],
    robot_v1_live_selective_contribution_allocations: [
      { ...applied, id: "open-slot-pending", slot_number: 1, status: "PENDING", applied_at: null },
      ...(!options.noContribution && !options.openContributionOnly && options.contributionSource !== "ALL_SLOTS" ? [applied] : []),
    ],
    robot_v1_live_adjustment_items: options.contributionSource === "ALL_SLOTS" ? [applied] : [],
  };
  const writes: Array<{ table: string; values: Row; ids: unknown[] }> = [];
  const calls: Array<{ kind: string; input?: Row }> = [];
  const exchange = new Map<string, Row>();
  for (const row of orders) exchange.set(String(row.client_order_id), {
    symbol: engine.symbol, side: row.side, clientOrderId: row.client_order_id,
    orderId: row.exchange_order_id, status: row.status, price: row.price,
    executedQuantity: row.executed_quantity, cumulativeQuoteQuantity: row.cumulative_quote,
  });
  let failPlanned = options.crashAfterCancel === true;
  let failArmed = options.crashAfterPrepared === true;
  const service = {
    from(table: string) {
      assert.ok(tables[table], `Unexpected database access: ${table}`);
      const predicates: Array<(row: Row) => boolean> = [];
      let update: Row | undefined;
      let insert: Row | undefined;
      let conflict = "id";
      const result = () => {
        const rows = tables[table];
        const matches = rows.filter((row) => predicates.every((predicate) => predicate(row)));
        if (update && failPlanned && table === "robot_v1_live_slots" && update.entry_state === "PLANNED") {
          failPlanned = false;
          return { data: [] as Row[], error: { message: "fixture crash after durable cancel" } };
        }
        if (update && failArmed && table === "robot_v1_live_slots" && update.entry_state === "ARMED") {
          failArmed = false;
          return { data: [] as Row[], error: { message: "fixture crash after durable PREPARED" } };
        }
        if (update) {
          writes.push({ table, values: structuredClone(update), ids: matches.map((row) => row.id) });
          for (const row of matches) Object.assign(row, update);
        }
        if (insert) {
          if (!rows.some((row) => conflict.split(",").every((key) => row[key] === insert![key]))) {
            rows.push(structuredClone(insert));
            writes.push({ table, values: structuredClone(insert), ids: [] });
          }
        }
        return { data: structuredClone(matches), error: null };
      };
      const query = {
        select() { return query; }, order() { return query; }, limit() { return query; },
        eq(key: string, value: unknown) { predicates.push((row) => row[key] === value); return query; },
        is(key: string, value: unknown) { predicates.push((row) => row[key] === value); return query; },
        in(key: string, value: unknown[]) { predicates.push((row) => value.includes(row[key])); return query; },
        gt(key: string, value: string | number) { predicates.push((row) => row[key] != null
          && (typeof value === "number" ? Number(row[key]) > value : String(row[key]) > value)); return query; },
        update(values: Row) { update = values; return query; },
        upsert(values: Row, opts: { onConflict: string }) { insert = values; conflict = opts.onConflict; return query; },
        async single() { const r = result(); return { ...r, data: r.data[0] ?? null }; },
        async maybeSingle() { return query.single(); },
        then(resolve: (value: ReturnType<typeof result>) => unknown) { return Promise.resolve(result()).then(resolve); },
      };
      return query;
    },
    async rpc(name: string, params: Row) {
      calls.push({ kind: name, input: params });
      assert.equal(params.p_lease_owner, run.lease_owner);
      if (name === "prepare_robot_v1_live_order") {
        const existing = orders.find((o) => o.client_order_id === params.p_client_order_id);
        if (existing) return { data: structuredClone(existing), error: null };
        const selected = slots.find((s) => s.id === params.p_slot_id)!;
        const prepared = order(Number(selected.slot_number), "BUY", {
          id: `prepared-${params.p_revision}`, revision: params.p_revision,
          client_order_id: params.p_client_order_id, status: "PREPARED", exchange_order_id: null,
          submission_guarded_at: null, trades_reconciled: false, requested_quantity: params.p_quantity,
          requested_quote: params.p_quote, price: params.p_price,
          reserved_notional_brl: Number(params.p_quantity) * Number(params.p_price),
          strategy_decision_id: params.p_decision_id, created_at: new Date().toISOString(),
        });
        orders.push(prepared);
        return { data: structuredClone(prepared), error: null };
      }
      if (name === "finish_strategy_bulk_engine_update") {
        const item = tables.strategy_bulk_engine_updates.find((row) => row.id === params.p_item_id)!;
        assert.equal(item.status, "APPLYING");
        assert.equal(run.config_version, item.strategy_version_after);
        if (run.entry_regime === "POST_ATH") assert.equal(orders.filter((row) => row.side === "BUY"
          && ["PREPARED", "NEW", "PARTIALLY_FILLED"].includes(String(row.status))).length, 0);
        item.status = "APPLIED";
        engine.strategy_config_pending = false;
        tables.strategy_bulk_batches[0].status = "APPLIED";
        return { data: null, error: null };
      }
      assert.equal(name, "sync_robot_v1_live_order");
      const saved = orders.find((o) => o.id === params.p_order_id)!;
      const trades = params.p_trades as Row[];
      assert.equal(trades.reduce((sum, trade) => sum + Number(trade.quantity), 0), Number(params.p_executed_quantity));
      assert.equal(trades.reduce((sum, trade) => sum + Number(trade.quoteQuantity), 0), Number(params.p_cumulative_quote));
      if (saved.side === "BUY") {
        const slot = slots.find((s) => s.id === saved.slot_id)!;
        slot.position_quantity = Number(slot.position_quantity) + Number(params.p_executed_quantity) - Number(saved.executed_quantity);
        slot.position_committed_brl = Number(slot.position_committed_brl) + Number(params.p_cumulative_quote) - Number(saved.cumulative_quote);
        if (Number(params.p_executed_quantity) > 0) slot.entry_state = "OPEN";
      }
      Object.assign(saved, { exchange_order_id: params.p_exchange_order_id, status: params.p_status,
        executed_quantity: params.p_executed_quantity, cumulative_quote: params.p_cumulative_quote,
        trades_reconciled: cycle.LIVE_TERMINAL_ORDER_STATUSES.has(String(params.p_status)) });
      return { data: structuredClone(saved), error: null };
    },
  };
  const state = (): Row => ({ ...identity, symbol: engine.symbol, observed_at: new Date().toISOString(),
    price: { price: 120, observedAt: new Date().toISOString() },
    filters: { symbol: engine.symbol, baseAsset: asset, quoteAsset: identity.quote_asset, quantityStep: 0.001,
      priceTick: 0.01, minQuantity: 0.001, maxQuantity: 10000, minNotional: 5 },
    balances: [{ asset: identity.quote_asset, free: 1000 }], supports_unfilled_buy_cancel: true,
    execution_caps: { engine: options.staleCaps ? 500 : 1000, account: 1000, max_order: 100 },
    open_orders: [...exchange.values()].filter((o) => ["NEW", "PARTIALLY_FILLED"].includes(String(o.status)))
      .map((o) => ({ ...o, id: o.orderId })),
  });
  const dependencies: Record<string, unknown> = {
    "./robot-v1-live-cycle": cycle, "./strategy-engine": strategy, "./live-entry-capital-refresh": capitalRefresh,
    "./strategy-price-invariant": priceInvariant, "./live-reconciliation-shortcut": shortcut,
    "./live-unsent-tp-recovery": unsentTp,
    "./live-strategy-snapshot": strategySnapshot,
    "./ath-ladder": athLadder, "./monthly-slot-policy": monthlyPolicy,
    "./strategy-parameter-registry": strategyParameterRegistry,
    "./ath-profile-server": { loadAthProfile: async () => profile, refreshAthProfile: async () => profile },
    "./operator-context": scope,
    "../supabase/env": { getSupabaseDataSchema: () => "coinops", getCoinOpsServiceTenantId: () => identity.tenant_id },
    "./operator-context-server": { resolveOperatorEngine: async () => engine },
    "./live-executor-health": { loadLiveEngineExecutorStatus: async () => ({ gate: "LIVE_EXECUTOR_ACTIVE" }) },
    "./monthly-slot-server": { loadMonthlySlotStatuses: async () => slots.map((s) => ({
      physicalSlotId: s.id, physicalSlotNumber: s.slot_number, operationalRank: s.operational_rank,
      lifetimeGainCount: 0, monthlyGainCount: 0,
      monthlyGainTarget: asset === "BTC" ? 7 : 2,
      eligibleForNewEntry: true, monthlyTargetReached: false })) },
    "./strategy-decision-server": {
      persistStrategyDecision: async (_s: unknown, _scope: unknown, _env: unknown, decision: Row) => calls.push({ kind: "decision", input: decision }),
      dispatchStrategyDecision: async () => calls.push({ kind: "dispatch" }),
      completeStrategyDecision: async () => calls.push({ kind: "complete" }),
    },
    "./live-executor-transport": {
      readLiveExecutorState: async () => state(),
      readLiveExecutorOrder: async (_run: unknown, id: string) => {
        calls.push({ kind: "read", input: { id } });
        return { order: structuredClone(exchange.get(id) ?? null) };
      },
      readLiveExecutorTrades: async (_run: unknown, id: string) => {
        const actual = exchange.get(id)!;
        return { order: structuredClone(actual), trades: Number(actual.executedQuantity) > 0 ? [{
          id: "trade-fixture", quantity: actual.executedQuantity, quoteQuantity: actual.cumulativeQuoteQuantity,
          commission: 0, commissionAsset: identity.quote_asset, isBuyer: actual.side === "BUY",
          filledAt: "2026-09-27T11:00:00.000Z",
        }] : [] };
      },
      cancelLiveExecutorOrder: async (input: Row) => {
        calls.push({ kind: "cancel", input });
        assert.equal(input.onlyUnfilled, true);
        const actual = exchange.get(String(input.clientOrderId))!;
        assert.equal(actual.side, "BUY");
        assert.equal(actual.orderId, input.orderId);
        if (options.cancel === "TIMEOUT_NEW") throw new Error("EXECUTOR_HTTP_503");
        actual.status = options.cancel === "FILLED" || options.cancel === "PARTIALLY_FILLED" ? options.cancel : "CANCELED";
        actual.executedQuantity = actual.status === "FILLED" ? 0.1 : actual.status === "PARTIALLY_FILLED" ? 0.04 : 0;
        actual.cumulativeQuoteQuantity = Number(actual.executedQuantity) * 100;
        if (options.cancel === "TIMEOUT_CANCELED") throw new Error("EXECUTOR_HTTP_503");
        return { order: structuredClone(actual) };
      },
      createLiveExecutorOrder: async (input: Row) => {
        calls.push({ kind: "create", input });
        assert.ok(["BUY", "SELL"].includes(String(input.side)));
        assert.ok(["ENTRY", "TP"].includes(String(input.purpose)));
        assert.equal(input.type, "LIMIT");
        assert.ok(!exchange.has(String(input.clientOrderId)), "duplicate exchange write");
        const created = { symbol: input.symbol, clientOrderId: input.clientOrderId, side: input.side,
          orderId: "replacement-exchange", status: "NEW", price: Number(input.price),
          executedQuantity: 0, cumulativeQuoteQuantity: 0 };
        exchange.set(String(input.clientOrderId), created);
        if (options.lostCreateResponse) throw new Error("EXECUTOR_HTTP_503");
        return { order: created };
      },
    },
  };
  const source = readFileSync(new URL("../execution/robot-v1-live-server.ts", import.meta.url), "utf8")
    + "\nexport { armNextEntry, reconcileOrder, confirmCapitalRefreshes, applyAthTransition, applyPendingStrategyUpdate };";
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText;
  const runtime = {} as Runtime;
  const require = createRequire(import.meta.url);
  new Function("require", "exports", compiled)((name: string) => name === "node:crypto" ? require(name) : dependencies[name] ?? {}, runtime);
  const ledger = () => structuredClone({ slots, orders, accounts });
  return { runtime, service, run, slots, accounts, orders, exchange, calls, writes, tables, state, profile,
    async arm() { return runtime.armNextEntry(service, run, ledger(), state()); },
    async confirm() { await runtime.confirmCapitalRefreshes(service, run, ledger()); },
    unchangedOpen() { assert.deepEqual({ slot: slots[0], account: accounts[0], tp: orders[1], buy: orders[0] }, initialOpen); },
  };
}

for (const asset of ["BTC", "SOL"] as const) for (const currency of ["BRL", "USDT"] as const) {
  test(`LIVE ${asset}/${currency}: applied contribution replaces only zero-fill BUY at the same slot/price exactly once`, async () => {
    const h = harness({ asset, currency, legacy: currency === "BRL" });
    const original = structuredClone(h.orders[2]);
    assert.equal(await h.arm(), "NEXT_BUY_ARMED");
    const [created] = h.calls.filter((c) => c.kind === "create");
    assert.equal(created.input?.quantity, "0.6");
    assert.equal(created.input?.price, "100");
    assert.equal(h.orders[2].status, "CANCELED");
    assert.equal(h.orders[3].slot_id, original.slot_id);
    assert.equal(h.orders[3].operation_sequence, original.operation_sequence);
    assert.equal(h.orders[3].revision, 2);
    assert.equal(await h.arm(), "HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT");
    assert.equal(h.calls.filter((c) => c.kind === "create").length, 1);
    assert.equal(h.calls.filter((c) => c.kind === "cancel").length, 1);
    await h.confirm(); await h.confirm();
    assert.equal(h.tables.robot_v1_live_events.filter((e) => e.event_type === "NEXT_BUY_CAPITAL_REFRESH_CONFIRMED").length, 1);
    h.unchangedOpen();
  });
}

test("bulk POST_ATH transition re-reads canceled BUY checkpoint, reprices its GRID slot and preserves OPEN/TP", async () => {
  const h = harness({ asset: "SOL", currency: "BRL" });
  const priorFetch = globalThis.fetch;
  const openBefore = structuredClone({ slot: h.slots[0], buy: h.orders[0], tp: h.orders[1] });
  h.run.entry_regime = "POST_ATH";
  h.run.anchor_price = 100;
  h.run.config_version = 1;
  h.run.config_snapshot = { gain_rate: 0.05, post_ath_spacing_rate: 0.08,
    normal_spacing_rate: 0.03, regime: "POST_ATH", ladder_anchor_price: 100 };
  (h.run.engine as Row).ath_reference_symbol = "SOLUSDC";
  h.slots[1].entry_origin = "GRID";
  h.slots[1].target_buy_price = 100;
  h.slots[1].entry_reference_price = 100;
  h.orders[2].config_version = 1;
  h.orders[2].config_snapshot = structuredClone(h.run.config_snapshot);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ price: "120" }) }) as Response;
  try {
    assert.equal(await h.runtime.applyAthTransition(h.service, h.run,
      { slots: h.slots, orders: h.orders, accounts: h.accounts }, h.state(), true), true);
  } finally { globalThis.fetch = priorFetch; }
  assert.equal(h.orders[2].status, "CANCELED");
  assert.equal(h.slots[1].entry_state, "PLANNED");
  assert.notEqual(h.slots[1].target_buy_price, 100, "canceled resident must not retain old price");
  assert.equal(h.slots[1].target_buy_price, h.slots[1].entry_reference_price);
  assert.equal(h.run.config_version, 2);
  assert.equal((h.run.config_snapshot as Row).post_ath_spacing_rate, 0.05);
  assert.deepEqual({ slot: h.slots[0], buy: h.orders[0], tp: h.orders[1] }, openBefore);
  assert.equal(h.calls.filter((item) => item.kind === "cancel").length, 1);
  assert.equal(h.calls.filter((item) => item.kind === "create").length, 0);
});

function pendingBulkHarness(cancel?: Options["cancel"], crashAfterCancel = false) {
  const h = harness({ asset: "SOL", currency: "BRL", cancel, crashAfterCancel });
  h.run.entry_regime = "POST_ATH";
  h.run.anchor_price = 100;
  h.run.config_version = 1;
  h.run.config_snapshot = { gain_rate: 0.05, post_ath_spacing_rate: 0.08,
    normal_spacing_rate: 0.03, regime: "POST_ATH", ladder_anchor_price: 100 };
  (h.run.engine as Row).ath_reference_symbol = "SOLUSDC";
  h.slots[1].entry_origin = "GRID";
  h.slots[1].target_buy_price = 100;
  h.slots[1].entry_reference_price = 100;
  h.orders[2].config_version = 1;
  h.orders[2].config_snapshot = structuredClone(h.run.config_snapshot);
  h.profile.config_version = 1;
  h.profile.post_ath_spacing_rate = 0.08;
  h.tables.trading_engines[0].strategy_config_pending = true;
  h.tables.strategy_bulk_batches.push({ id: "batch-fixture", status: "PENDING" });
  h.tables.strategy_bulk_engine_updates.push({ id: "item-fixture", batch_id: "batch-fixture",
    operator_id: h.run.operator_id, exchange_account_id: h.run.exchange_account_id,
    trading_engine_id: h.run.trading_engine_id, run_id: h.run.id, profile_id: h.profile.id,
    status: "PENDING", strategy_version_before: 1, strategy_version_after: 2,
    old_values: { post_ath_spacing_rate: 0.08 }, new_values: { post_ath_spacing_rate: 0.05 },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  return h;
}

test("bulk checkpoint applies once, clears only its engine BUY gate after guarded reprice", async () => {
  const h = pendingBulkHarness();
  const priorFetch = globalThis.fetch;
  const openBefore = structuredClone({ slot: h.slots[0], buy: h.orders[0], tp: h.orders[1] });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ price: "120" }) }) as Response;
  try {
    assert.equal(await h.runtime.applyPendingStrategyUpdate(h.service, h.run,
      { slots: h.slots, orders: h.orders, accounts: h.accounts }, h.state()), "APPLIED");
    assert.equal(await h.runtime.applyPendingStrategyUpdate(h.service, h.run,
      { slots: h.slots, orders: h.orders, accounts: h.accounts }, h.state()), "NONE");
  } finally { globalThis.fetch = priorFetch; }
  assert.equal(h.profile.config_version, 2);
  assert.equal(h.run.config_version, 2);
  assert.equal(h.tables.strategy_bulk_engine_updates[0].status, "APPLIED");
  assert.equal(h.tables.strategy_bulk_batches[0].status, "APPLIED");
  assert.equal(h.tables.trading_engines[0].strategy_config_pending, false);
  assert.equal(h.slots[1].entry_state, "PLANNED");
  assert.notEqual(h.slots[1].target_buy_price, 100);
  assert.deepEqual({ slot: h.slots[0], buy: h.orders[0], tp: h.orders[1] }, openBefore);
  assert.equal(h.calls.filter((item) => item.kind === "cancel").length, 1);
  assert.equal(h.calls.filter((item) => item.kind === "create").length, 0);
});

for (const cancel of ["FILLED", "PARTIALLY_FILLED", "TIMEOUT_NEW"] as const) {
  test(`bulk ${cancel} race keeps gate closed and never creates a speculative BUY`, async () => {
    const h = pendingBulkHarness(cancel);
    const priorFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ price: "120" }) }) as Response;
    try {
      await assert.rejects(h.runtime.applyPendingStrategyUpdate(h.service, h.run,
        { slots: h.slots, orders: h.orders, accounts: h.accounts }, h.state()));
    } finally { globalThis.fetch = priorFetch; }
    assert.equal(h.tables.trading_engines[0].strategy_config_pending, true);
    assert.equal(h.tables.strategy_bulk_engine_updates[0].status, "APPLYING");
    assert.equal(h.calls.filter((item) => item.kind === "create").length, 0);
    assert.equal(h.orders[1].status, "NEW", "existing TP is not canceled");
  });
}

test("bulk NORMAL update leaves a compatible resident BUY and existing TP untouched", async () => {
  const h = pendingBulkHarness();
  const before = structuredClone({ open: h.slots[0], buy: h.orders[2], tp: h.orders[1] });
  h.run.entry_regime = "NORMAL";
  h.run.config_snapshot = { ...(h.run.config_snapshot as Row), regime: "NORMAL", entry_spacing: 0.03 };
  h.profile.regime = "NORMAL";
  assert.equal(await h.runtime.applyPendingStrategyUpdate(h.service, h.run,
    { slots: h.slots, orders: h.orders, accounts: h.accounts }, h.state()), "APPLIED");
  assert.equal(h.run.config_version, 2);
  assert.equal(h.profile.post_ath_spacing_rate, 0.05);
  assert.equal(h.tables.trading_engines[0].strategy_config_pending, false);
  assert.deepEqual({ open: h.slots[0], buy: h.orders[2], tp: h.orders[1] }, before);
  assert.equal(h.calls.filter((item) => item.kind === "cancel" || item.kind === "create").length, 0);
});

test("bulk retry recovers only a proven canceled zero-fill ARMED checkpoint after a crash", async () => {
  const h = pendingBulkHarness(undefined, true);
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ price: "120" }) }) as Response;
  try {
    await assert.rejects(h.runtime.applyPendingStrategyUpdate(h.service, h.run,
      { slots: h.slots, orders: h.orders, accounts: h.accounts }, h.state()));
    assert.equal(h.orders[2].status, "CANCELED");
    assert.equal(h.slots[1].entry_state, "ARMED");
    assert.equal(h.tables.trading_engines[0].strategy_config_pending, true);
    assert.equal(await h.runtime.applyPendingStrategyUpdate(h.service, h.run,
      { slots: h.slots, orders: h.orders, accounts: h.accounts }, h.state()), "APPLIED");
  } finally { globalThis.fetch = priorFetch; }
  assert.equal(h.slots[1].entry_state, "PLANNED");
  assert.notEqual(h.slots[1].target_buy_price, 100);
  assert.equal(h.calls.filter((entry) => entry.kind === "cancel").length, 1);
  assert.equal(h.calls.filter((entry) => entry.kind === "create").length, 0);
});

test("bulk POST_ATH update without a resident BUY reprices futures and preserves OPEN/TP", async () => {
  const h = pendingBulkHarness();
  h.orders.splice(2, 1);
  h.slots[1].entry_state = "PLANNED";
  const openBefore = structuredClone({ slot: h.slots[0], buy: h.orders[0], tp: h.orders[1] });
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ price: "120" }) }) as Response;
  try {
    assert.equal(await h.runtime.applyPendingStrategyUpdate(h.service, h.run,
      { slots: h.slots, orders: h.orders, accounts: h.accounts }, h.state()), "APPLIED");
  } finally { globalThis.fetch = priorFetch; }
  assert.notEqual(h.slots[1].target_buy_price, 100);
  assert.equal(h.calls.filter((item) => item.kind === "cancel" || item.kind === "create").length, 0);
  assert.deepEqual({ slot: h.slots[0], buy: h.orders[0], tp: h.orders[1] }, openBefore);
});

test("rollback is a new version on current ledger and never resurrects the canceled BUY", async () => {
  const h = pendingBulkHarness();
  h.run.entry_regime = "NORMAL";
  h.profile.regime = "NORMAL";
  h.run.config_version = 2;
  h.profile.config_version = 2;
  h.profile.post_ath_spacing_rate = 0.05;
  const item = h.tables.strategy_bulk_engine_updates[0];
  item.strategy_version_before = 2;
  item.strategy_version_after = 3;
  item.old_values = { post_ath_spacing_rate: 0.05 };
  item.new_values = { post_ath_spacing_rate: 0.08 };
  assert.equal(await h.runtime.applyPendingStrategyUpdate(h.service, h.run,
    { slots: h.slots, orders: h.orders, accounts: h.accounts }, h.state()), "APPLIED");
  assert.equal(h.profile.config_version, 3);
  assert.equal(h.profile.post_ath_spacing_rate, 0.08);
  assert.equal(h.run.config_version, 3);
  assert.equal(h.calls.filter((entry) => entry.kind === "cancel" || entry.kind === "create").length, 0);
});

for (const cancel of ["FILLED", "PARTIALLY_FILLED"] as const) {
  test(`LIVE cancel race ${cancel}: reconciles execution without marking PLANNED or replacing the position`, async () => {
    const h = harness({ cancel });
    assert.equal(await h.arm(), "ENTRY_FILLED_DURING_REPLACEMENT");
    assert.equal(h.orders[2].status, cancel);
    assert.ok(Number(h.orders[2].executed_quantity) > 0);
    assert.equal(h.slots[1].entry_state, "OPEN");
    assert.equal(h.calls.filter((c) => c.kind === "create").length, 0);
    assert.equal(h.writes.filter((w) => w.table === "robot_v1_live_slots").length, 0);
    h.unchangedOpen();
  });
}

test("LIVE crash after durable zero-fill cancel resumes from the same physical slot checkpoint", async () => {
  const h = harness({ crashAfterCancel: true });
  await assert.rejects(h.arm(), /COINOPS_LIVE_SLOT_UPDATE_FAILED/);
  assert.equal(h.orders[2].status, "CANCELED");
  assert.equal(h.orders[2].trades_reconciled, true);
  assert.equal(h.slots[1].entry_state, "ARMED");
  assert.equal(h.calls.filter((c) => c.kind === "create").length, 0);
  assert.equal(await h.arm(), "NEXT_BUY_ARMED");
  assert.equal(h.orders[3].slot_id, "slot-2");
  assert.equal(h.orders[3].requested_quantity, 0.6);
  assert.equal(h.calls.filter((c) => c.kind === "cancel").length, 1);
  await h.confirm();
  assert.equal(h.tables.robot_v1_live_events.filter((e) => e.event_type === "NEXT_BUY_CAPITAL_REFRESH_CONFIRMED").length, 1);
  h.unchangedOpen();
});

test("LIVE cancellation 503 with confirmed CANCELED resumes; 503 with NEW preserves resident BUY", async () => {
  const canceled = harness({ cancel: "TIMEOUT_CANCELED" });
  assert.equal(await canceled.arm(), "NEXT_BUY_ARMED");
  assert.equal(canceled.calls.filter((c) => c.kind === "cancel").length, 1);
  const uncertain = harness({ cancel: "TIMEOUT_NEW" });
  await assert.rejects(uncertain.arm(), /EXECUTOR_HTTP_503/);
  assert.equal(uncertain.orders[2].status, "NEW");
  assert.equal(uncertain.calls.filter((c) => c.kind === "create").length, 0);
  assert.equal(uncertain.writes.filter((w) => w.table === "robot_v1_live_slots").length, 0);
  uncertain.unchangedOpen(); canceled.unchangedOpen();
});

test("LIVE crash after PREPARED restores the resident slot state and accepts a later applied contribution", async () => {
  const h = harness({ crashAfterPrepared: true });
  await assert.rejects(h.arm(), /COINOPS_LIVE_SLOT_UPDATE_FAILED/);
  assert.equal(h.orders[3].status, "PREPARED");
  assert.equal(h.orders[3].submission_guarded_at, null);
  assert.equal(h.slots[1].entry_state, "PLANNED");
  assert.equal(h.calls.filter((c) => c.kind === "create").length, 0);
  // The official advance loop reconciles PREPARED before calling armNextEntry.
  await h.runtime.reconcileOrder(h.service, h.run, h.orders[3]);
  assert.equal(await h.arm(), "HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT");
  assert.equal(h.slots[1].entry_state, "ARMED");
  h.accounts[1].balance_brl = 70;
  h.accounts[1].contribution_brl = 70;
  h.tables.robot_v1_live_selective_contribution_allocations.push({
    ...h.tables.robot_v1_live_selective_contribution_allocations[1],
    id: "later-allocation", amount_quote: 10,
    applied_at: new Date(Date.parse(String(h.orders[3].created_at)) + 1).toISOString(),
  });
  assert.equal(await h.arm(), "NEXT_BUY_ARMED");
  assert.equal(h.orders[4].requested_quantity, 0.7);
  assert.equal(h.orders[4].revision, 3);
  h.unchangedOpen();
});

for (const observation of ["MISSING", "WRONG_ID", "WRONG_PRICE", "PARTIAL", "STALE"] as const) {
  test(`LIVE crash recovery refuses to restore ARMED from ${observation} resident evidence`, async () => {
    const h = harness({ crashAfterPrepared: true });
    await assert.rejects(h.arm(), /COINOPS_LIVE_SLOT_UPDATE_FAILED/);
    await h.runtime.reconcileOrder(h.service, h.run, h.orders[3]);
    const beforeCreates = h.calls.filter((c) => c.kind === "create").length;
    const state = h.state();
    const clientId = h.orders[3].client_order_id;
    if (observation === "STALE") state.observed_at = new Date(Date.now() - 31_000).toISOString();
    else state.open_orders = (state.open_orders as Row[])
      .filter((o) => observation !== "MISSING" || o.clientOrderId !== clientId)
      .map((o) => o.clientOrderId !== clientId ? o : observation === "WRONG_ID" ? { ...o, id: "unrelated-order" }
        : observation === "WRONG_PRICE" ? { ...o, price: 99 }
          : observation === "PARTIAL" ? { ...o, executedQuantity: 0.01 } : o);
    assert.equal(await h.runtime.armNextEntry(h.service, h.run,
      structuredClone({ slots: h.slots, orders: h.orders, accounts: h.accounts }), state),
    "HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT");
    assert.equal(h.slots[1].entry_state, "PLANNED");
    assert.equal(h.calls.filter((c) => c.kind === "create").length, beforeCreates);
    h.unchangedOpen();
  });
}

test("LIVE lost replacement response queries the guarded PREPARED client ID and never submits a second BUY", async () => {
  const h = harness({ lostCreateResponse: true });
  assert.equal(await h.arm(), "NEXT_BUY_ARMED");
  const replacement = h.orders[3];
  assert.ok(replacement.submission_guarded_at);
  assert.equal(replacement.status, "NEW");
  const createIndex = h.calls.findIndex((c) => c.kind === "create");
  assert.equal(h.calls[createIndex + 1].kind, "read");
  assert.equal(h.calls[createIndex + 1].input?.id, replacement.client_order_id);
  assert.equal(await h.arm(), "HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT");
  assert.equal(h.calls.filter((c) => c.kind === "create").length, 1);
  h.unchangedOpen();
});

test("LIVE guarded PREPARED missing on exchange is unknown, not permission to retry a write", async () => {
  const h = harness();
  const prepared: Row = { ...h.orders[2], status: "PREPARED", exchange_order_id: null };
  h.exchange.delete(String(prepared.client_order_id));
  await assert.rejects(h.runtime.reconcileOrder(h.service, h.run, prepared), /COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN/);
  assert.deepEqual(h.calls.map((c) => c.kind), ["read"]);
  h.unchangedOpen();
});

test("LIVE old guarded TP with exact PENDING decision uses the original client ID once", async () => {
  const h = harness();
  const tp = h.orders[1];
  tp.status = "PREPARED";
  tp.exchange_order_id = null;
  tp.submission_guarded_at = new Date(Date.now() - 4 * 60_000).toISOString();
  h.exchange.delete(String(tp.client_order_id));
  h.tables.robot_v1_strategy_decisions.push({ ...h.run,
    id: "decision-row", decision_id: tp.strategy_decision_id,
    cycle_id: h.run.id, slot_id: tp.slot_id,
    operation_sequence: tp.operation_sequence, action_type: "CREATE_TP",
    environment: "REAL", result: "PENDING", dispatched_at: null,
    exchange_ack_at: null, completed_at: null });
  const recovered = await h.runtime.reconcileOrder(h.service, h.run, tp);
  assert.equal(recovered.status, "NEW");
  assert.equal(h.calls.filter((call) => call.kind === "create").length, 1);
  assert.equal(h.calls.find((call) => call.kind === "create")?.input?.clientOrderId,
    tp.client_order_id);
  assert.equal(h.writes.filter((write) => write.table === "robot_v1_live_orders"
    && write.values.submission_guarded_at).length, 0, "immutable guard stays untouched");
  await h.runtime.reconcileOrder(h.service, h.run, tp);
  assert.equal(h.calls.filter((call) => call.kind === "create").length, 1);
});

test("LIVE guarded TP with dispatched decision remains blocked", async () => {
  const h = harness();
  const tp = h.orders[1];
  tp.status = "PREPARED";
  tp.exchange_order_id = null;
  tp.submission_guarded_at = new Date(Date.now() - 4 * 60_000).toISOString();
  h.exchange.delete(String(tp.client_order_id));
  h.tables.robot_v1_strategy_decisions.push({ ...h.run,
    id: "decision-row", decision_id: tp.strategy_decision_id,
    cycle_id: h.run.id, slot_id: tp.slot_id,
    operation_sequence: tp.operation_sequence, action_type: "CREATE_TP",
    environment: "REAL", result: "DISPATCHED", dispatched_at: tp.submission_guarded_at,
    exchange_ack_at: null, completed_at: null });
  await assert.rejects(h.runtime.reconcileOrder(h.service, h.run, tp),
    /COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN/);
  assert.equal(h.calls.filter((call) => call.kind === "create").length, 0);
});

for (const options of [{ staleCaps: true }, { noContribution: true }, { openContributionOnly: true }]) {
  test(`LIVE keeps the resident BUY when preflight/source/pending-only cannot authorize refresh: ${JSON.stringify(options)}`, async () => {
    const h = harness(options);
    assert.equal(await h.arm(), "HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT");
    assert.equal(h.calls.filter((c) => ["cancel", "create"].includes(c.kind)).length, 0);
    assert.equal(h.orders[2].requested_quantity, 0.1);
    h.unchangedOpen();
  });
}

test("LIVE existing all-slots contribution reuses the same resizing path and source audit", async () => {
  const h = harness({ contributionSource: "ALL_SLOTS" });
  assert.equal(await h.arm(), "NEXT_BUY_ARMED");
  const event = h.tables.robot_v1_live_events.find((e) => e.event_type === "NEXT_BUY_CAPITAL_REFRESH_PLANNED")!;
  assert.deepEqual((event.details as Row).capital_sources, ["adjustment:allocation-new-capital"]);
  h.unchangedOpen();
});
