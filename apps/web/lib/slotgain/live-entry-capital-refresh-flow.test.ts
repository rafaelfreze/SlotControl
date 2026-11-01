import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import * as slotTopology from "../execution/engine-slot-topology.ts";
import ts from "typescript";
import * as cycle from "../execution/robot-v1-live-cycle.ts";
import * as strategy from "../execution/strategy-engine.ts";
import * as capitalRefresh from "../execution/live-entry-capital-refresh.ts";
import * as priceInvariant from "../execution/strategy-price-invariant.ts";
import * as shortcut from "../execution/live-reconciliation-shortcut.ts";
import * as unsentTp from "../execution/live-unsent-tp-recovery.ts";
import * as unsentEntry from "../execution/live-unsent-entry-recovery.ts";
import * as unsentProof from "../execution/account-order-unsent-proof.ts";
import * as strategySnapshot from "../execution/live-strategy-snapshot.ts";
import * as monthlyGridRecovery from "../execution/monthly-grid-recovery.ts";
import * as marketPolicy from "../execution/market-entry-policy.ts";
import * as partialRecovery from "../execution/partial-entry-recovery.ts";
import * as athLadder from "../execution/ath-ladder.ts";
import * as monthlyPolicy from "../execution/monthly-slot-policy.ts";
import * as liveAudit from "../execution/live-audit-event.ts";
import * as strategyParameterRegistry from "../execution/strategy-parameter-registry.ts";
import * as scope from "../execution/operator-context.ts";
import * as engineExposure from "../execution/engine-exposure.ts";
import * as ledgerRead from "../execution/complete-ledger-read.ts";
import * as liveLedgerRead from "../execution/live-ledger-read.ts";
import * as liveReadRecovery from "../execution/live-read-recovery.ts";
import * as liveReadError from "../execution/live-read-error.ts";
import * as liveBudgetAlert from "../execution/live-account-budget-alert.ts";
import { readLiveExposure } from "../execution/live-exposure-read.ts";
import { liveBnbFeeBalanceCheck } from "../execution/live-bnb-fee-balance.ts";
import { liveQuoteBalanceCheck } from "../execution/live-quote-balance.ts";

type Row = Record<string, unknown>;
type Runtime = {
  authorizePartialEntryRecovery:(runId:string,slot:number,operation:number,userId:string,asset:"BTC"|"SOL")=>Promise<Row>;
  progressPartialEntryRecovery:(service:unknown,run:Row,ledger:unknown,state:Row)=>Promise<boolean>;
  authorizeMissedMarketEntry:(runId:string,slot:number,operation:number,userId:string,asset:"BTC"|"SOL")=>Promise<Row>;
  finalizeMarketEntryReferences:(service:unknown,run:Row,ledger:unknown,state:Row)=>Promise<void>;
  hydrateRetainedGridContexts: (service: unknown, run: Row, ledger: unknown, state: Row) => Promise<void>;
  repairMonthlyGridProvenance: (service: unknown, run: Row, ledger: unknown, state: Row) => Promise<boolean>;
  ensureTakeProfits: (service: unknown, run: Row, ledger: unknown, state: Row) => Promise<void>;
  assertLiveOrderPrice: (run: Row, ledger: unknown, order: Row, tick: number) => void;
  armNextEntry: (service: unknown, run: Row, ledger: unknown, state: Row) => Promise<string>;
  reconcileOrder: (service: unknown, run: Row, order: Row) => Promise<Row>;
  confirmCapitalRefreshes: (service: unknown, run: Row, ledger: unknown) => Promise<void>;
  applyAthTransition: (service: unknown, run: Row, ledger: unknown, state: Row, force: boolean) => Promise<boolean>;
  applyPendingStrategyUpdate: (service: unknown, run: Row, ledger: unknown, state: Row) => Promise<string>;
};
type Options = { asset?: "BTC" | "SOL"; currency?: "BRL" | "USDT"; legacy?: boolean;
  forbidObservation?:boolean;
  cancel?: "FILLED" | "PARTIALLY_FILLED" | "TIMEOUT_CANCELED" | "TIMEOUT_NEW";
  staleCaps?: boolean; noContribution?: boolean; contributionSource?: "SELECTIVE" | "ALL_SLOTS";
  openContributionOnly?: boolean; crashAfterCancel?: boolean; crashAfterPrepared?: boolean;
  lostCreateResponse?: boolean; slotCount?: number; monthlyCounts?:Record<number,number>; allocationTimeout?:boolean; marketProtocol?:boolean; marketFill?:boolean;
  unitOrderCap?:number; orderCapAlignment?:boolean; lostOrderCapResponse?:boolean; lostOrderCapRpcResponse?:boolean };

function harness(options: Options = {}) {
  const count = options.slotCount ?? 25;
  const identity = { product_id: "product-fixture", tenant_id: "tenant-fixture", user_id: "user-fixture",
    operator_id: "operator-fixture", exchange_account_id: "account-fixture", trading_engine_id: "engine-fixture",
    quote_asset: options.currency ?? "USDT" };
  const asset = options.asset ?? "SOL";
  const engine = { ...identity, id: identity.trading_engine_id, base_asset: asset, environment: "REAL",
    symbol: `${asset}${identity.quote_asset}`, status: "ACTIVE", global_kill_switch: false,
    account_kill_switch: false, engine_kill_switch: false, legacy_compatible: options.legacy ?? false,
    is_legacy_default:options.legacy??false,
    hard_cap_quote: 1000, strategy_config_pending: false, slot_count: count,executor_shard_id:"executor-01" };
  const run: Row = { ...identity, id: "12345678-1234-1234-1234-123456789abc", asset, symbol: engine.symbol,
    engine, status: "ACTIVE", lease_owner: "lease-fixture", lease_until: new Date(Date.now() + 180_000).toISOString(),
    entry_regime: "NORMAL", entry_spacing: 0.03, gain_rate: 0.05, anchor_price: 110,
    slot_count: count, config_snapshot: { slot_count: count,entry_priority_policy:monthlyPolicy.ENTRY_PRIORITY_POLICY },
    strategy_version: strategy.STRATEGY_VERSION };
  const profile: Row = { ...identity, id: "profile-fixture", asset, environment: "REAL",
    regime: "POST_ATH", config_version: 2, gain_rate: 0.05, normal_spacing_rate: 0.03,
    post_ath_spacing_rate: 0.05, next_config_version: null,
    transition_key: "transition-fixture", updated_at: new Date().toISOString() };
  const slots: Row[] = Array.from({ length: count }, (_, index) => ({ ...identity,
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
      monthly_target: asset === "BTC" ? 7 : 2, max_order_notional_brl: options.unitOrderCap??100,
      compounding_enabled:true,max_total_exposure_brl: 1000, slot_count: count }],
    account_quote_caps: [{ ...identity, hard_cap_quote: 1000 }], robot_v1_live_events: [], robot_v1_live_alerts: [],
    robot_v1_ath_profiles: [profile],
    strategy_bulk_batches: [], strategy_bulk_engine_updates: [], account_order_budget_reservations:[],
    robot_v1_live_selective_contribution_allocations: [
      { ...applied, id: "open-slot-pending", slot_number: 1, status: "PENDING", applied_at: null },
      ...(!options.noContribution && !options.openContributionOnly && options.contributionSource !== "ALL_SLOTS" ? [applied] : []),
    ],
    robot_v1_live_adjustment_items: options.contributionSource === "ALL_SLOTS" ? [applied] : [],
  };
  const writes: Array<{ table: string; values: Row; ids: unknown[] }> = [];
  const calls: Array<{ kind: string; input?: Row }> = [];
  let nativeOrderCap=options.unitOrderCap??100;
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
      let page: [number, number] | null = null;
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
            rows.push({ ...structuredClone(insert), id: insert.id ?? `event-${rows.length + 1}`,
              observed_at: insert.observed_at ?? new Date().toISOString() });
            writes.push({ table, values: structuredClone(insert), ids: [] });
          }
        }
        return { data: structuredClone(page ? matches.slice(page[0], page[1] + 1) : matches), error: null, count: matches.length };
      };
      const query = {
        select() { return query; }, order() { return query; }, limit() { return query; }, abortSignal() { return query; },
        range(start: number, end: number) { page = [start, end]; return query; },
        eq(key: string, value: unknown) { predicates.push((row) => row[key] === value); return query; },
        is(key: string, value: unknown) { predicates.push((row) => row[key] === value); return query; },
        in(key: string, value: unknown[]) { predicates.push((row) => value.includes(row[key])); return query; },
        or(expression: string) {
          if(expression.startsWith("lease_until.is.null,lease_until.lt.")){
            predicates.push(row=>row.lease_until==null || Date.parse(String(row.lease_until))<Date.now());return query;
          }
          assert.equal(expression,"result.neq.COMPLETED,result.is.null");
          predicates.push(row=>row.result!=="COMPLETED");return query;
        },
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
    async rpc(name: string, params: Row):Promise<{data:unknown;error:unknown}> {
      calls.push({ kind: name, input: params });
      assert.equal(params.p_lease_owner, run.lease_owner);
      if(name==="authorized_partial_entry_recovery")return{data:true,error:null};
      if(name==="prepare_live_partial_entry_recovery"){
        const auth=(run.config_snapshot as Row).partial_entry_recovery_authorization as Row;
        const result=await service.rpc("prepare_robot_v1_live_order",{...params,p_side:"BUY",p_purpose:"ENTRY",p_quote:auth.quote,p_quantity:null,p_price:null});
        const saved=orders.find(o=>o.client_order_id===params.p_client_order_id)!;
        saved.config_snapshot={...(run.config_snapshot as Row),partial_entry_recovery_intent:auth};
        slots.find(s=>s.id===params.p_slot_id)!.entry_state="OPEN";
        return{...result,data:structuredClone(saved)};
      }
      if(name==="align_live_recovery_order_cap"){
        assert.equal(params.p_expected_cap,options.unitOrderCap);assert.equal(params.p_engine_cap,1000);assert.equal(params.p_account_cap,1000);
        tables.robot_v1_live_preparations[0].max_order_notional_brl=params.p_target_cap;
        Object.assign(engine,{config:{max_order_quote:params.p_target_cap}});
        const details={old_order_cap:params.p_expected_cap,new_order_cap:params.p_target_cap};
        tables.robot_v1_live_events.push({...identity,run_id:run.id,
          event_key:`RECOVERY_ORDER_CAP_ALIGNED:${params.p_slot_id}:1:${monthlyPolicy.monthlyPeriodKey(new Date())}`,
          event_type:"RECOVERY_ORDER_CAP_ALIGNED",details});
        return options.lostOrderCapRpcResponse?{data:null,error:{message:"lost metadata RPC response"}}:{data:details,error:null};
      }
      if (name === "allocate_live_monthly_entry_levels") {
        calls.push({kind:"allocate",input:structuredClone(params)});
        assert.equal((params.p_expected as unknown[]).length,count);
        for(const a of params.p_assignments as Row[]){const s=slots.find(s=>s.id===a.id)!;
          assert.equal(s.entry_state,"PLANNED");assert.equal(s.position_quantity,0);
          assert.ok(!orders.some(o=>o.slot_id===s.id&&["NEW","PREPARED","PARTIALLY_FILLED"].includes(String(o.status))));
          Object.assign(s,{target_buy_price:a.price,entry_reference_price:a.price,operational_rank:a.rank});}
        const sources=Object.fromEntries((params.p_assignments as Row[]).map(a=>[String(a.id),{
          run_id:run.id,engine_id:run.trading_engine_id,slot_id:a.id,price:a.price,source_origin:a.sourceOrigin,plan_id:params.p_plan_id}]));
        const checkpoint={policy:monthlyPolicy.ENTRY_PRIORITY_POLICY,plan_id:params.p_plan_id,period:params.p_period,
          assignments:params.p_assignments,price_sources:sources};
        run.config_snapshot={...(run.config_snapshot as Row),entry_priority_checkpoint:checkpoint,
          entry_priority_policy:monthlyPolicy.ENTRY_PRIORITY_POLICY,entry_price_sources:sources};
        return options.allocationTimeout?{data:null,error:{message:"503 after committed allocation"}}:{data:checkpoint,error:null};
      }
      if (name === "prepare_robot_v1_live_order") {
        const existing = orders.find((o) => o.client_order_id === params.p_client_order_id);
        if (existing) return { data: structuredClone(existing), error: null };
        const selected = slots.find((s) => s.id === params.p_slot_id)!;
        const prepared = order(Number(selected.slot_number), params.p_side as "BUY"|"SELL", {
          id: `prepared-${selected.slot_number}-${params.p_side}-${params.p_revision}`, revision: params.p_revision,
          client_order_id: params.p_client_order_id, status: "PREPARED", exchange_order_id: null,
          submission_guarded_at: null, trades_reconciled: false, requested_quantity: params.p_quantity,
          requested_quote: params.p_quote, price: params.p_price,
          reserved_notional_brl: params.p_side==="SELL"?0:params.p_quote!==null?Number(params.p_quote):Number(params.p_quantity) * Number(params.p_price),
          strategy_decision_id: params.p_decision_id, created_at: new Date().toISOString(),
          config_snapshot:structuredClone(run.config_snapshot),
        });
        orders.push(prepared);
        if(params.p_quote!==null && params.p_purpose==="ENTRY")Object.assign(selected,{entry_state:"ARMED",missed_at:null});
        return { data: structuredClone(prepared), error: null };
      }
      if(name==="finalize_live_market_entry_reference"){
        const buy=orders.find(o=>o.id===params.p_order_id)!;
        const reference=Math.floor(Number(buy.cumulative_quote)/Number(buy.executed_quantity)/Number(params.p_price_tick)+1e-10)*Number(params.p_price_tick);
        Object.assign(slots.find(s=>s.id===buy.slot_id)!,{target_buy_price:reference,entry_reference_price:reference,entry_origin:"REENTRY"});
        return {data:reference,error:null};
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
    balances: [{ asset: identity.quote_asset, free: 1000 }, { asset: "BNB", free: .001 }], supports_unfilled_buy_cancel: true,
    bnb_quote_price: { symbol: `BNB${identity.quote_asset}`, price: 6000, observedAt: new Date().toISOString() },
    execution_caps: { engine: options.staleCaps ? 500 : 1000, account: 1000, max_order: nativeOrderCap },
    open_orders: [...exchange.values()].filter((o) => ["NEW", "PARTIALLY_FILLED"].includes(String(o.status)))
      .map((o) => ({ ...o, id: o.orderId })),
  });
  const dependencies: Record<string, unknown> = {
    "./operator-executor-admin":{operatorConnectionAdmin:async()=>{throw Error("onboarding connection unavailable")},
      operatorExecutorAdmin:async(...args:unknown[])=>{
      assert.equal(args[0],"/v1/admin/capital");const input=args[1]as Row;
      assert.equal(input.operator_id,run.operator_id);assert.equal(input.exchange_account_id,run.exchange_account_id);
      assert.equal(input.trading_engine_id,run.trading_engine_id);assert.equal(input.environment,"REAL");
      assert.equal(input.credential_ref,engine.legacy_compatible&&engine.is_legacy_default?"legacy-binance-production":`account_${String(run.exchange_account_id).replaceAll("-","")}`);
      assert.equal(input.mode,"ORDER_CAP_ALIGNMENT_V1");assert.equal(input.expected_account_cap_quote,1000);assert.equal(input.target_account_cap_quote,1000);
      const rows=input.engines as Row[];assert.equal(rows.length,1);assert.equal(rows[0].expected_hard_cap_quote,1000);assert.equal(rows[0].target_hard_cap_quote,1000);
      calls.push({kind:"native-order-cap",input});nativeOrderCap=Number(rows[0].target_max_order_quote);
      if(options.lostOrderCapResponse)throw Error("metadata response lost");return{status:"UPDATED"};
    }},
    "../supabase/service-role":{createServiceRoleClient:()=>service},
    "./live-audit-event":liveAudit,
    "./live-ledger-read": liveLedgerRead, "./live-read-error": liveReadError,
    "./live-read-recovery": liveReadRecovery,
    "./live-exposure-read": { readLiveExposure },
    "./live-bnb-fee-balance": { liveBnbFeeBalanceCheck }, "./live-quote-balance": { liveQuoteBalanceCheck },
    "./live-account-budget-alert": { ...liveBudgetAlert, resolveAccountBudgetAlert: async () => undefined },
    "./engine-slot-topology": slotTopology,
    "./engine-exposure": engineExposure, "./complete-ledger-read": ledgerRead,
    "./robot-v1-live-cycle": cycle, "./strategy-engine": strategy, "./live-entry-capital-refresh": capitalRefresh,
    "./strategy-price-invariant": priceInvariant, "./live-reconciliation-shortcut": shortcut,
    "./live-unsent-tp-recovery": unsentTp,
    "./live-unsent-entry-recovery": unsentEntry,
    "./account-order-unsent-proof": unsentProof,
    // This legacy-capital fixture has no V2 account-budget policy. Its budget
    // boundary remains mocked, but must enforce the same engine and lease.
    // Account-budget concurrency/permits have their own execution tests.
    "./account-order-budget-server": {
      accountExecutionPolicyRequired: async () => false,
      reserveAccountOrderDispatch: async (_s: unknown, owner: Row, _id: string, _side: string, lease: string, required: boolean) => {
        assert.equal(owner.trading_engine_id, run.trading_engine_id);
        assert.equal(lease, run.lease_owner);
        assert.equal(required, false);
        return undefined;
      },
      acknowledgeAccountOrderDispatch: async (_s: unknown, owner: Row, _id: string, lease: string) => {
        assert.equal(owner.trading_engine_id, run.trading_engine_id);
        assert.equal(lease, run.lease_owner);
      },
    },
    "./live-strategy-snapshot": strategySnapshot, "./market-entry-policy":marketPolicy,
    "./partial-entry-recovery":partialRecovery,
    "./monthly-grid-recovery": monthlyGridRecovery,
    "./ath-ladder": athLadder, "./monthly-slot-policy": monthlyPolicy,
    "./strategy-parameter-registry": strategyParameterRegistry,
    "./ath-profile-server": { loadAthProfile: async () => profile, refreshAthProfile: async () => profile },
    "./operator-context": scope,
    "../supabase/env": { getSupabaseDataSchema: () => "coinops", getCoinOpsServiceTenantId: () => identity.tenant_id },
    "./operator-context-server": { resolveOperatorEngine: async () => engine },
    "./live-executor-health": { loadLiveEngineExecutorStatus: async () => ({ gate: "LIVE_EXECUTOR_ACTIVE",health:{entry_market_protocol:options.marketProtocol?1:undefined,
      order_cap_alignment_protocol:options.orderCapAlignment?1:undefined,partial_entry_recovery_protocol:1} }) },
    "./monthly-slot-server": { loadMonthlySlotStatuses: async () => options.monthlyCounts
      ? monthlyPolicy.rankMonthlySlots(asset,new Date().toISOString(),slots.map(s=>({physicalSlotId:String(s.id),
        physicalSlotNumber:Number(s.slot_number),entryState:String(s.entry_state),balanceUsdc:22,
        lifetimeGainCount:options.monthlyCounts![Number(s.slot_number)]??0,
        monthlyGainCount:options.monthlyCounts![Number(s.slot_number)]??0})),7,count)
      : slots.map((s) => ({
      physicalSlotId: s.id, physicalSlotNumber: s.slot_number, operationalRank: s.operational_rank,
      lifetimeGainCount: 0, monthlyGainCount: 0,
      monthlyGainTarget: asset === "BTC" ? 7 : 2,
      eligibleForNewEntry: true, monthlyTargetReached: false })) },
    "./strategy-decision-server": {
      persistStrategyDecision: async (_s: unknown, _scope: unknown, _env: unknown, decision: Row) => calls.push({ kind: "decision", input: decision }),
      dispatchStrategyDecision: async () => calls.push({ kind: "dispatch" }),
      completeStrategyDecision: async (_s:unknown,_owner:unknown,_env:unknown,id:string) => {
        calls.push({ kind: "complete" });
        const decision=tables.robot_v1_strategy_decisions?.find(d=>d.decision_id===id);
        if(decision)Object.assign(decision,{result:"COMPLETED",completed_at:new Date().toISOString()});
      },
    },
    "./live-executor-transport": {
      readLiveExecutorOrderObservation:async (_run:unknown,id:string)=>{
        if(options.forbidObservation)throw Error("N25_MUST_USE_QUERY_TRADES");
        calls.push({kind:"observe",input:{id}});const actual=exchange.get(id);
        return {order:structuredClone(actual??null),trades:!actual?null:Number(actual.executedQuantity)>0?[{
          id:"trade-fixture",quantity:actual.executedQuantity,quoteQuantity:actual.cumulativeQuoteQuantity,
          commission:0,commissionAsset:identity.quote_asset,isBuyer:actual.side==="BUY",filledAt:"2026-09-27T11:00:00.000Z"}]:[]};
      },
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
        assert.ok(input.type==="LIMIT" || input.type==="MARKET"&&(options.marketProtocol
          ||input.partialEntryRecoveryPolicy===partialRecovery.PARTIAL_ENTRY_RECOVERY_POLICY));
        assert.ok(!exchange.has(String(input.clientOrderId)), "duplicate exchange write");
        const created = { symbol: input.symbol, clientOrderId: input.clientOrderId, side: input.side,
          orderId: `replacement-exchange-${input.side}`, status: "NEW", price: Number(input.price??0),
          executedQuantity: 0, cumulativeQuoteQuantity: 0 };
        if(input.type==="MARKET"&&options.marketFill){
          const quantity=Math.floor(Number(input.quoteOrderQty)/119/.001)*.001;
          Object.assign(created,{status:"FILLED",executedQuantity:quantity,cumulativeQuoteQuantity:Number((quantity*119).toFixed(8))});
        }
        exchange.set(String(input.clientOrderId), created);
        if (options.lostCreateResponse) throw new Error("EXECUTOR_HTTP_503");
        return { order: created };
      },
    },
  };
  const source = readFileSync(new URL("../execution/robot-v1-live-server.ts", import.meta.url), "utf8")
    + "\nexport { armNextEntry, reconcileOrder, confirmCapitalRefreshes, applyAthTransition, applyPendingStrategyUpdate, ensureTakeProfits, assertLiveOrderPrice, repairMonthlyGridProvenance, hydrateRetainedGridContexts, finalizeMarketEntryReferences, progressPartialEntryRecovery };";
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

test("owner authorizes terminal partial; ordinary next worker prepares it once and leaves entry gates held until TP/reconciliation",async()=>{
 const h=harness({asset:"SOL",marketFill:true,forbidObservation:true}),source=h.orders[2];
 Object.assign(source,{status:"CANCELED",executed_quantity:.004,cumulative_quote:.4,trades_reconciled:true,exchange_order_id:"432"});
 Object.assign(h.slots[1],{entry_state:"OPEN",position_quantity:.004,position_committed_brl:.4});
 Object.assign(h.exchange.get(String(source.client_order_id))!,{status:"CANCELED",executedQuantity:.004,cumulativeQuoteQuantity:.4,orderId:"432"});
 Object.assign(h.run.engine as Row,{engine_kill_switch:true});h.tables.robot_v1_live_preparations[0].kill_switch=true;
 h.run.last_error="COINOPS_LIVE_TP_FILTER_UNPROTECTABLE";h.run.lease_owner=null;h.run.lease_until=null;
 const first=new Date(Date.now()-60000).toISOString();
 h.tables.robot_v1_live_alerts=[{...h.tables.operators[0],asset:"SOL",trading_engine_id:h.run.trading_engine_id,
  exchange_account_id:h.run.exchange_account_id,alert_key:`LIVE_RUN:${h.run.id}:CRITICAL`,severity:"CRITICAL",resolved_at:null,
  code:h.run.last_error,first_seen_at:first,last_seen_at:first,
  details:{root_code:h.run.last_error,stage:"PROTECT_TP",run_id:h.run.id}}];
 const before=structuredClone(h.accounts);
 const auth=await h.runtime.authorizePartialEntryRecovery(String(h.run.id),2,1,String(h.run.user_id),"SOL");
 assert.equal(auth.status,"PARTIAL_RECOVERY_AUTHORIZED");assert.equal(auth.quote_cap,5.16);
 assert.equal(h.calls.filter(c=>c.kind==="create"||c.kind==="cancel").length,0);
 h.run.lease_owner="next-worker-lease";h.run.lease_until=new Date(Date.now()+120000).toISOString();
 const ledger=()=>structuredClone({slots:h.slots,orders:h.orders,accounts:h.accounts});
 assert.equal(await h.runtime.progressPartialEntryRecovery(h.service,h.run,ledger(),h.state()),true);
 assert.equal(await h.runtime.progressPartialEntryRecovery(h.service,h.run,ledger(),h.state()),false);
 await h.runtime.ensureTakeProfits(h.service,h.run,ledger(),h.state());
 assert.equal(h.calls.filter(c=>c.kind==="create"&&c.input?.side==="BUY").length,1);
 assert.equal(h.tables.robot_v1_live_preparations[0].kill_switch,true);assert.deepEqual(h.accounts,before);
 assert.equal(h.orders.filter(o=>o.slot_id===source.slot_id&&o.side==="SELL").length,1);
});

for(const lost of [false,true])test(`explicit orphan rescue uses same operation, query-first recovery and combined TP; siblings remain exact (${lost})`,async()=>{
 const h=harness({asset:"SOL",marketFill:true,lostCreateResponse:lost}),source=h.orders[2];
 Object.assign(source,{status:"CANCELED",executed_quantity:.004,cumulative_quote:.4,trades_reconciled:true,exchange_order_id:"432"});
 Object.assign(h.slots[1],{entry_state:"OPEN",position_quantity:.004,position_committed_brl:.4});
 Object.assign(h.exchange.get(String(source.client_order_id))!,{status:"CANCELED",executedQuantity:.004,cumulativeQuoteQuantity:.4,orderId:"432"});
 const sibling=structuredClone({slot:h.slots[0],buy:h.orders[0],tp:h.orders[1]}),balances=structuredClone(h.accounts);
 Object.assign(h.run.engine as Row,{engine_kill_switch:true});h.run.last_error="COINOPS_LIVE_TP_FILTER_UNPROTECTABLE";
 h.tables.robot_v1_live_preparations[0].kill_switch=true;
 const proof={policy:partialRecovery.PARTIAL_ENTRY_RECOVERY_POLICY,run_id:h.run.id,engine_id:h.run.trading_engine_id,
  slot_id:source.slot_id,slot_number:2,operation_sequence:1,source_order_id:source.id,source_client_order_id:source.client_order_id,
  source_exchange_order_id:source.exchange_order_id,source_quantity:.004,source_quote:.4,source_fee_base:0,source_committed:.4,
  quote:5.16,slot_balance:60,gain_rate:.05,spacing:.03,incident_key:"ROOT",incident_first_seen_at:new Date().toISOString(),
  authorization_event_key:"AUTH",authorized_at:new Date().toISOString()};
 const child={...source,id:"child",revision:2,status:"PREPARED",exchange_order_id:null,submission_guarded_at:null,
  strategy_decision_id:"rescue-decision",client_order_id:cycle.liveClientOrderId(String(h.run.id),"SOL",2,1,"BUY",2,h.run.engine as never),
  requested_quote:5.16,requested_quantity:null,price:null,reserved_notional_brl:5.16,executed_quantity:0,cumulative_quote:0,
  trades_reconciled:false,config_snapshot:{...(h.run.config_snapshot as Row),partial_entry_recovery_intent:proof}};
 h.orders.push(child);
 if(lost)await assert.rejects(h.runtime.reconcileOrder(h.service,h.run,child),/EXECUTOR_HTTP_503/);
 await h.runtime.reconcileOrder(h.service,h.run,child);
 assert.equal(h.calls.filter(c=>c.kind==="create"&&c.input?.side==="BUY").length,1);
 assert.equal(h.calls.find(c=>c.kind==="create"&&c.input?.side==="BUY")?.input?.partialEntryRecoveryPolicy,proof.policy);
 const ledger=()=>structuredClone({slots:h.slots,orders:h.orders,accounts:h.accounts});
 // A lost TP ACK is recovered by its exact persisted ID on the next pass.
 if(lost)await assert.rejects(h.runtime.ensureTakeProfits(h.service,h.run,ledger(),h.state()),/EXECUTOR_HTTP_503/);
 for(const o of h.orders.filter(o=>o.side==="SELL"&&o.status==="PREPARED"))await h.runtime.reconcileOrder(h.service,h.run,o);
 await h.runtime.ensureTakeProfits(h.service,h.run,ledger(),h.state());
 const tp=h.calls.find(c=>c.kind==="create"&&c.input?.side==="SELL")?.input;
 assert.equal((tp?.partialEntryRecoverySources as Row).recoveryClientOrderId,child.client_order_id);
 assert.equal(tp?.sourceBuyClientOrderId,source.client_order_id);
 assert.deepEqual({slot:h.slots[0],buy:h.orders[0],tp:h.orders[1]},sibling);assert.deepEqual(h.accounts,balances);
});

test("tiny partial BUY stays resident: TP min-notional is checked BEFORE cancel, without extra BUY or TP changes", async () => {
  const h=harness(); const buy=h.orders[2]!;
  Object.assign(buy,{status:"PARTIALLY_FILLED",executed_quantity:.004,cumulative_quote:.4,trades_reconciled:true});
  Object.assign(h.slots[1]!,{entry_state:"OPEN",position_quantity:.004});
  const before=structuredClone(h.orders);
  await assert.rejects(h.runtime.ensureTakeProfits(h.service,h.run,
    {slots:h.slots,orders:h.orders,accounts:h.accounts},h.state()),/COINOPS_LIVE_TP_FILTER_UNPROTECTABLE/);
  assert.deepEqual(h.orders,before); assert.equal(h.calls.filter(c=>["cancel","create","dispatch"].includes(c.kind)).length,0);
  h.unchangedOpen();
});

function monthlyRepairHarness(crashAfterCancel=false) {
  const h=harness({crashAfterCancel}), code="COINOPS_STRATEGY_PRICE_INVARIANT_FAILED";
  const owner={operator_id:h.run.operator_id,exchange_account_id:h.run.exchange_account_id,trading_engine_id:h.run.trading_engine_id};
  (h.run.engine as Row).engine_kill_switch=true;
  Object.assign(h.run,{last_error:code,ath_period_key:"2026-11",ath_transition_key:null,config_version:2,entry_spacing:.03});
  const source={run_id:h.run.id,engine_id:h.run.trading_engine_id,slot_id:h.slots[1]!.id,price:106.7,source_origin:"GRID"};
  const snapshot={ladder_anchor_price:120,entry_spacing:.03,gain_rate:.05,regime:"NORMAL",
    entry_priority_policy:monthlyPolicy.ENTRY_PRIORITY_POLICY,entry_price_sources:{[String(source.slot_id)]:source}};
  h.run.config_snapshot=structuredClone(snapshot);
  const prior=h.orders[2]!;
  Object.assign(prior,{price:106.7,status:"CANCELED",trades_reconciled:true,config_version:2,
    config_snapshot:{...structuredClone(snapshot),ladder_anchor_price:110},created_at:"2026-10-31T01:00:00Z"});
  Object.assign(h.exchange.get(String(prior.client_order_id))!,{price:106.7,status:"CANCELED"});
  const prepared={...structuredClone(prior),id:"unsent-monthly",revision:2,status:"PREPARED",trades_reconciled:false,
    client_order_id:cycle.liveClientOrderId(String(h.run.id),"SOL",2,1,"BUY",2,h.run.engine as never),
    exchange_order_id:null,submission_guarded_at:null,created_at:"2026-11-01T04:00:50Z",
    strategy_decision_id:"monthly-intent",config_snapshot:structuredClone(snapshot)};
  h.orders.push(prepared);
  Object.assign(h.slots[1]!,{entry_state:"ARMED",target_buy_price:106.7,entry_reference_price:106.7});
  h.tables.robot_v1_live_alerts=[{...owner,product_id:h.run.product_id,tenant_id:h.run.tenant_id,user_id:h.run.user_id,
    severity:"CRITICAL",resolved_at:null,alert_key:`LIVE_RUN:${h.run.id}:CRITICAL`,code,
    first_seen_at:"2026-11-01T04:01:00Z",last_seen_at:"2026-11-01T04:01:01Z",details:{root_code:code,stage:"RECONCILE_ORDERS"}}];
  h.tables.robot_v1_strategy_decisions=[{...owner,product_id:h.run.product_id,tenant_id:h.run.tenant_id,user_id:h.run.user_id,
    cycle_id:h.run.id,environment:"REAL",decision_id:"monthly-intent",action_type:"ARM_NEXT_BUY",
    result:"PENDING",dispatched_at:null,exchange_ack_at:null,completed_at:null}];
  h.tables.account_order_budget_reservations=[];
  h.tables.robot_v1_live_events.push({...owner,run_id:h.run.id,event_type:"ATH_TRANSITION",
    event_key:"ATH_TRANSITION:NORMAL:2026-11",observed_at:"2026-11-01T04:00:40Z",details:{regime:"NORMAL",config_version:2}});
  const repair=()=>h.runtime.repairMonthlyGridProvenance(h.service,h.run,{slots:h.slots,orders:h.orders,accounts:h.accounts},h.state());
  return {...h,prepared,repair};
}

function missedMarketHarness(options:Partial<Options>={},legacyMissed=true){
 const h=harness({noContribution:true,marketProtocol:true,marketFill:true,monthlyCounts:{3:4},...options});
 const slot=h.slots[2]!;
 Object.assign(slot,{entry_state:legacyMissed?"MISSED":"PLANNED",missed_at:legacyMissed?new Date().toISOString():null,
  target_buy_price:130,entry_reference_price:130});
 Object.assign(h.accounts[2]!,{balance_brl:60,contribution_brl:60});
 if(legacyMissed)h.run.config_snapshot={...(h.run.config_snapshot as Row),market_entry_authorization:{
  policy:strategy.ENTRY_MARKET_POLICY,run_id:h.run.id,engine_id:h.run.trading_engine_id,slot_id:slot.id,
  operation_sequence:slot.operation_sequence,period:monthlyPolicy.monthlyPeriodKey(new Date()),
  source_missed_at:slot.missed_at,quote_cap:60}};
 return {...h,selected:slot};
}

test("requested missed owner: zero-fill NEXT BUY canceled, full slot MARKET, actual-fill TP/reference, then ordinary NEXT BUY",async()=>{
 const h=missedMarketHarness(),ledger=()=>structuredClone({slots:h.slots,orders:h.orders,accounts:h.accounts});
 assert.equal(await h.arm(),"MARKET_ENTRY_SUBMITTED");
 const buys=h.calls.filter(c=>c.kind==="create"&&c.input?.side==="BUY");
 assert.equal(buys.length,1);assert.equal(buys[0]!.input?.type,"MARKET");assert.equal(buys[0]!.input?.quoteOrderQty,"60");
 assert.equal(h.calls.filter(c=>c.kind==="cancel").length,1);assert.equal(h.selected.entry_state,"OPEN");
 await h.runtime.finalizeMarketEntryReferences(h.service,h.run,ledger(),h.state());
 assert.equal(h.selected.entry_reference_price,119,"future reentry follows this actual MARKET operation");
 await h.runtime.ensureTakeProfits(h.service,h.run,ledger(),h.state());
 const tp=h.orders.find(o=>o.slot_id===h.selected.id&&o.side==="SELL")!;
 assert.equal(tp.price,124.95);assert.equal(tp.requested_quantity,.504);
 h.unchangedOpen();
 assert.equal(await h.arm(),"NEXT_BUY_ARMED");
 assert.equal(h.calls.filter(c=>c.kind==="create"&&c.input?.type==="MARKET").length,1,"no duplicate catch-up");
});

test("explicit operator recovery wins over 1/7 resident versus 0/7 returning slot once, preserves gains and ordinary queue",async()=>{
 const h=missedMarketHarness({monthlyCounts:{2:1,3:0}});
 assert.equal(await h.arm(),"HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT");
 const auth=(h.run.config_snapshot as Row).market_entry_authorization as Row;
 Object.assign(auth,{recovery_priority:marketPolicy.EXPLICIT_MISSED_RECOVERY,slot_number:3,
  authorization_event_key:`REQUEST:${h.selected.id}:1:${monthlyPolicy.monthlyPeriodKey(new Date())}:${marketPolicy.EXPLICIT_MISSED_RECOVERY}`});
 const accounts=structuredClone(h.accounts);
 assert.equal(await h.arm(),"MARKET_ENTRY_SUBMITTED");assert.equal(h.selected.entry_state,"OPEN");
 assert.deepEqual(h.accounts,accounts);assert.equal(h.calls.filter(c=>c.kind==="cancel").length,1);
 assert.equal(h.calls.filter(c=>c.kind==="create"&&c.input?.type==="MARKET").length,1);
 assert.equal(((h.run.config_snapshot as Row).market_entry_intent as Row).recovery_priority,marketPolicy.EXPLICIT_MISSED_RECOVERY);
 await h.runtime.finalizeMarketEntryReferences(h.service,h.run,structuredClone({slots:h.slots,orders:h.orders,accounts:h.accounts}),h.state());
 await h.runtime.ensureTakeProfits(h.service,h.run,structuredClone({slots:h.slots,orders:h.orders,accounts:h.accounts}),h.state());
 assert.equal(await h.arm(),"NEXT_BUY_ARMED");
 assert.equal(h.calls.filter(c=>c.kind==="create"&&c.input?.type==="MARKET").length,1);h.unchangedOpen();
});

for(const cancel of ["FILLED","PARTIALLY_FILLED","TIMEOUT_NEW"] as const)test(`market catch-up never duplicates a resident with race ${cancel}`,async()=>{
 const h=missedMarketHarness({cancel});
 if(cancel==="TIMEOUT_NEW")await assert.rejects(h.arm(),/EXECUTOR_HTTP_503/);
 else assert.equal(await h.arm(),"ENTRY_FILLED_DURING_REPLACEMENT");
 assert.equal(h.calls.filter(c=>c.kind==="create").length,0);h.unchangedOpen();
});

test("prospective priority-crossed entry works without sweeping legacy MISSED; unsupported native protocol keeps the old BUY",async()=>{
 const future=missedMarketHarness({},false);assert.equal(await future.arm(),"MARKET_ENTRY_SUBMITTED");
 const old=missedMarketHarness({marketProtocol:false});assert.equal(await old.arm(),"MARKET_ENTRY_PROTOCOL_HOLD");
 assert.equal(old.calls.filter(c=>c.kind==="create"||c.kind==="cancel").length,0);
});

for(const legacy of [false,true])for(const failure of ["none","lost-native","lost-rpc"] as const)test(`installed engine cap alignment ignores stale onboarding, keeps exact credential (${legacy}/${failure})`,async()=>{
 const h=missedMarketHarness({legacy,monthlyCounts:{2:1,3:0},unitOrderCap:18,orderCapAlignment:true,
  lostOrderCapResponse:failure==="lost-native",lostOrderCapRpcResponse:failure==="lost-rpc"});
 Object.assign(h.accounts[2],{contribution_brl:18,market_pnl_brl:42,fees_brl:0,manual_gain_brl:0,dust_quantity:0,gain_count:1});
 const auth=(h.run.config_snapshot as Row).market_entry_authorization as Row;
 Object.assign(auth,{recovery_priority:marketPolicy.EXPLICIT_MISSED_RECOVERY,slot_number:3,
  authorization_event_key:`REQUEST:${h.selected.id}:1:${monthlyPolicy.monthlyPeriodKey(new Date())}:${marketPolicy.EXPLICIT_MISSED_RECOVERY}`});
 const before=structuredClone(h.accounts);
 assert.equal(await h.arm(),"MARKET_ENTRY_SUBMITTED");assert.deepEqual(h.accounts,before);
 assert.equal(h.calls.filter(c=>c.kind==="native-order-cap").length,1);
 assert.equal(h.calls.filter(c=>c.kind==="align_live_recovery_order_cap").length,1);
 assert.equal(h.tables.robot_v1_live_preparations[0].max_order_notional_brl,60);
 assert.equal(h.tables.robot_v1_live_preparations[0].max_total_exposure_brl,1000);
 assert.equal(h.calls.filter(c=>c.kind==="create"&&c.input?.side==="BUY").length,1);
 assert.equal(h.calls.find(c=>c.kind==="create"&&c.input?.side==="BUY")?.input?.quoteOrderQty,"60");h.unchangedOpen();
});

test("unsupported cap protocol or unproven reinvestment preserves the resident BUY and caps",async()=>{
 for(const protocol of [false,true]){
  const h=missedMarketHarness({monthlyCounts:{2:1,3:0},unitOrderCap:18,orderCapAlignment:protocol});
  const auth=(h.run.config_snapshot as Row).market_entry_authorization as Row;
  Object.assign(auth,{recovery_priority:marketPolicy.EXPLICIT_MISSED_RECOVERY,slot_number:3,
   authorization_event_key:`REQUEST:${h.selected.id}:1:${monthlyPolicy.monthlyPeriodKey(new Date())}:${marketPolicy.EXPLICIT_MISSED_RECOVERY}`});
  assert.equal(await h.arm(),"CAPACITY_HOLD");assert.equal(h.calls.filter(c=>["create","cancel","native-order-cap"].includes(c.kind)).length,0);
  assert.equal(h.tables.robot_v1_live_preparations[0].max_order_notional_brl,18);h.unchangedOpen();
 }
});

test("lost MARKET response reconciles the exact client id and never submits another BUY",async()=>{
 const h=missedMarketHarness({lostCreateResponse:true});await assert.rejects(h.arm(),/EXECUTOR_HTTP_503/);
 const order=h.orders.find(o=>o.slot_id===h.selected.id&&o.status==="PREPARED")!;
 assert.ok(order);await h.runtime.reconcileOrder(h.service,h.run,order);
 assert.equal(order.status,"FILLED");assert.equal(h.calls.filter(c=>c.kind==="create"&&c.input?.side==="BUY").length,1);
 h.unchangedOpen();
});

test("legacy monthly repair retires only a GET-proven never-submitted intent; immutable snapshots, TPs and gates survive",async()=>{
  const h=monthlyRepairHarness(),before=structuredClone(h.prepared.config_snapshot);
  assert.equal(await h.repair(),true);
  assert.equal(h.prepared.status,"CANCELED");assert.deepEqual(h.prepared.config_snapshot,before);
  assert.equal(h.slots[1]!.entry_state,"PLANNED");assert.equal((h.run.engine as Row).engine_kill_switch,true);
  assert.equal((h.run.config_snapshot as Row).ladder_anchor_price,120,"newly generated GRID keeps new anchor");
  assert.equal(await h.repair(),false);assert.equal(h.calls.filter(c=>["create","cancel","dispatch"].includes(c.kind)).length,0);
  h.unchangedOpen();
});

test("repair crash after retirement resumes from durable STARTED without another order or lost intent",async()=>{
  const h=monthlyRepairHarness(true);
  await assert.rejects(h.repair(),/SLOT_UPDATE_FAILED/);
  assert.equal(h.prepared.status,"CANCELED");
  assert.equal(await h.repair(),true);h.unchangedOpen();
});

test("an exchange order appearing during legacy recovery cannot be retired or replaced",async()=>{
  const h=monthlyRepairHarness();h.exchange.set(String(h.prepared.client_order_id),{orderId:"unexpected",status:"NEW"});
  await assert.rejects(h.repair(),/EXCHANGE_UNPROVEN/);assert.equal(h.prepared.status,"PREPARED");
  assert.equal(h.calls.filter(c=>["create","cancel","dispatch"].includes(c.kind)).length,0);
});

test("legacy future-level provenance backfill preserves the current NEXT BUY, all slots, capital and TPs",async()=>{
  const h=harness(),period=monthlyPolicy.monthlyPeriodKey(new Date()),slot=h.slots[2]!;
  const source={run_id:h.run.id,engine_id:h.run.trading_engine_id,slot_id:slot.id,price:106.7,source_origin:"GRID"};
  const snapshot={ladder_anchor_price:120,entry_spacing:.03,gain_rate:.05,regime:"NORMAL",
    entry_priority_policy:monthlyPolicy.ENTRY_PRIORITY_POLICY,entry_price_sources:{[String(slot.id)]:source}};
  Object.assign(h.run,{config_version:2,ath_period_key:period,ath_transition_key:null,config_snapshot:structuredClone(snapshot)});
  Object.assign(slot,{entry_origin:"GRID",target_buy_price:106.7,entry_reference_price:106.7});
  Object.assign(h.orders[2]!,{config_version:2,created_at:new Date(Date.now()-40*86_400_000).toISOString(),
    config_snapshot:{...structuredClone(snapshot),ladder_anchor_price:110}});
  h.tables.robot_v1_live_events.push({run_id:h.run.id,trading_engine_id:h.run.trading_engine_id,event_type:"ATH_TRANSITION",
    event_key:`ATH_TRANSITION:NORMAL:${period}`,observed_at:`${period}-01T04:00:40Z`,details:{regime:"NORMAL",config_version:2}});
  const before=structuredClone({orders:h.orders,slots:h.slots,accounts:h.accounts});
  const hydrate=()=>h.runtime.hydrateRetainedGridContexts(h.service,h.run,{slots:h.slots,orders:h.orders,accounts:h.accounts},h.state());
  await hydrate();await hydrate();
  const ctx=strategySnapshot.gridContextForPrice(h.run.config_snapshot as Row,
    {id:String(h.run.id),trading_engine_id:String(h.run.trading_engine_id)},106.7,25)!;
  assert.equal(ctx.anchor,110);assert.deepEqual({orders:h.orders,slots:h.slots,accounts:h.accounts},before);
  assert.equal(h.calls.filter(c=>["cancel","create","dispatch"].includes(c.kind)).length,0);
  assert.equal(h.writes.filter(w=>w.table==="robot_v1_live_events"&&w.values.event_type==="GRID_CONTEXT_PROVEN").length,1);
});

test("monthly transition preserves the geometric origin of retained GRID levels across allocation and new order snapshot", async () => {
  const h=harness(); const retained=h.slots[2]!;
  Object.assign(h.run,{anchor_price:110,entry_spacing:.03,config_snapshot:{ladder_anchor_price:110,
    entry_spacing:.03,gain_rate:.05,entry_priority_policy:monthlyPolicy.ENTRY_PRIORITY_POLICY,
    entry_price_sources:{[String(retained.id)]:{run_id:h.run.id,engine_id:h.run.trading_engine_id,
      slot_id:retained.id,price:106.7,source_origin:"GRID"}}}});
  Object.assign(retained,{target_buy_price:106.7,entry_reference_price:106.7});
  h.slots[3]!.entry_origin="GRID";
  (h.run.engine as Row).ath_reference_symbol="SOLUSDC";
  const previousFetch=globalThis.fetch;
  globalThis.fetch=async()=>({ok:true,json:async()=>({price:"120"})}) as Response;
  try { await h.runtime.applyAthTransition(h.service,h.run,{slots:h.slots,orders:h.orders,accounts:h.accounts},h.state(),false); }
  finally { globalThis.fetch=previousFetch; }
  const snapshot=h.run.config_snapshot as Row;
  assert.equal(snapshot.ladder_anchor_price,120);
  const context=strategySnapshot.gridContextForPrice(snapshot,{id:String(h.run.id),trading_engine_id:String(h.run.trading_engine_id)},106.7,25)!;
  assert.equal(context.anchor,110);assert.equal(context.spacing,.03);
  const next={...h.orders[2]!,slot_id:retained.id,price:106.7,config_snapshot:structuredClone(snapshot)};
  h.runtime.assertLiveOrderPrice(h.run,{slots:h.slots,orders:h.orders,accounts:h.accounts},next,.01);
  const wrong=structuredClone(next);((wrong.config_snapshot as Row).entry_grid_contexts as Row)={};
  assert.throws(()=>h.runtime.assertLiveOrderPrice(h.run,{slots:h.slots,orders:h.orders,accounts:h.accounts},wrong,.01),/PRICE_INVARIANT/);
  h.unchangedOpen();
});

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

for (const slotCount of [50, 75, 100]) test(`${slotCount} slots NEXT BUY replacement is idempotent and OPEN/TP are frozen`, async () => {
  const h = harness({ slotCount });
  assert.equal(await h.arm(), "NEXT_BUY_ARMED");
  assert.equal(await h.arm(), "HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT");
  assert.equal(h.calls.filter(call => call.kind === "create").length, 1);
  assert.equal(h.calls.filter(call => call.kind === "cancel").length, 1);
  assert.equal(h.orders.filter(order => order.side === "BUY" && order.status === "NEW").length, 1);
  h.unchangedOpen();
});

for(const slotCount of [25,50,100]) test(`${slotCount} monthly allocation replaces the owner after a verified zero-fill cancel`,async()=>{
 const h=harness({asset:"BTC",slotCount,noContribution:true,monthlyCounts:{2:1,3:4,4:3,5:2}});
 const money=structuredClone(h.tables.robot_v1_live_slot_accounts);
 assert.equal(await h.arm(),"NEXT_BUY_ARMED");
 assert.equal(h.orders.find(o=>o.side==="BUY"&&o.status==="NEW")?.slot_number,3);
 assert.equal(h.orders.find(o=>o.side==="BUY"&&o.status==="NEW")?.price,100);
 assert.equal(h.calls.filter(c=>c.kind==="cancel").length,1);assert.equal(h.calls.filter(c=>c.kind==="allocate").length,1);
 assert.equal(await h.arm(),"HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT");
 assert.equal(h.calls.filter(c=>c.kind==="create").length,1);assert.deepEqual(h.tables.robot_v1_live_slot_accounts,money);h.unchangedOpen();
});
for(const cancel of ["FILLED","PARTIALLY_FILLED","TIMEOUT_NEW","TIMEOUT_CANCELED"] as const)
test(`monthly priority cancel race ${cancel} never allocates executed capital or duplicates a BUY`,async()=>{
 const h=harness({asset:"BTC",cancel,noContribution:true,monthlyCounts:{2:1,3:4}});
 if(cancel==="TIMEOUT_NEW")await assert.rejects(h.arm(),/503/);
 else assert.equal(await h.arm(),cancel==="TIMEOUT_CANCELED"?"NEXT_BUY_ARMED":"ENTRY_FILLED_DURING_REPLACEMENT");
 assert.equal(h.calls.filter(c=>c.kind==="allocate").length,cancel==="TIMEOUT_CANCELED"?1:0);
 assert.equal(h.calls.filter(c=>c.kind==="create").length,cancel==="TIMEOUT_CANCELED"?1:0);h.unchangedOpen();
});
test("monthly allocation timeout after commit is read back and never repeated",async()=>{
 const h=harness({asset:"BTC",allocationTimeout:true,noContribution:true,monthlyCounts:{2:1,3:4}});
 assert.equal(await h.arm(),"NEXT_BUY_ARMED");assert.equal(await h.arm(),"HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT");
 assert.equal(h.calls.filter(c=>c.kind==="allocate").length,1);assert.equal(h.calls.filter(c=>c.kind==="create").length,1);h.unchangedOpen();
});

test("a GRID slot receiving a proven REENTRY level retains the committed level provenance",async()=>{
 const h=harness({asset:"BTC",noContribution:true,monthlyCounts:{2:1,3:4}});
 h.slots[2].entry_origin="GRID";
 assert.equal(await h.arm(),"NEXT_BUY_ARMED");
 const own=h.orders.find(o=>o.side==="BUY"&&o.status==="NEW")!;
 const snapshot=own.config_snapshot as Row;
 assert.equal(((snapshot.entry_price_sources as Row)[String(own.slot_id)] as Row).source_origin,"REENTRY");
 h.unchangedOpen();
});
test("crash after committed allocation resumes without another cancel or financial duplication",async()=>{
 const h=harness({asset:"BTC",noContribution:true,monthlyCounts:{2:1,3:4}}),rpc=h.service.rpc.bind(h.service);let crash=true;
 h.service.rpc=async(name,params)=>{const result=await rpc(name,params);
   if(name==="allocate_live_monthly_entry_levels"&&crash){crash=false;throw Error("FIXTURE_CRASH_AFTER_COMMIT")}return result};
 await assert.rejects(h.arm(),/FIXTURE_CRASH_AFTER_COMMIT/);
 assert.equal(await h.arm(),"NEXT_BUY_ARMED");assert.equal(await h.arm(),"HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT");
 assert.equal(h.calls.filter(c=>c.kind==="cancel").length,1);assert.equal(h.calls.filter(c=>c.kind==="create").length,1);h.unchangedOpen();
});

for (const slotCount of [50, 100]) test(`${slotCount} slots known cancel503/crash checkpoint converge and ambiguous outcomes never duplicate`, async () => {
  const canceled = harness({ slotCount, cancel: "TIMEOUT_CANCELED" });
  assert.equal(await canceled.arm(), "NEXT_BUY_ARMED");
  assert.equal(canceled.calls.filter(call => call.kind === "cancel").length, 1);
  canceled.unchangedOpen();
  const unknown = harness({ slotCount, cancel: "TIMEOUT_NEW" });
  await assert.rejects(unknown.arm(), /EXECUTOR_HTTP_503/);
  assert.equal(unknown.calls.filter(call => call.kind === "create").length, 0);
  const crashed = harness({ slotCount, crashAfterCancel: true });
  await assert.rejects(crashed.arm(), /COINOPS_LIVE_SLOT_UPDATE_FAILED/);
  assert.equal(await crashed.arm(), "NEXT_BUY_ARMED");
  assert.equal(crashed.calls.filter(call => call.kind === "cancel").length, 1);
  assert.equal(crashed.calls.filter(call => call.kind === "create").length, 1);
  crashed.unchangedOpen();
  for (const cancel of ["FILLED", "PARTIALLY_FILLED"] as const) {
    const racing = harness({ slotCount, cancel });
    assert.equal(await racing.arm(), "ENTRY_FILLED_DURING_REPLACEMENT");
    assert.equal(racing.calls.filter(call => call.kind === "create").length, 0);
    assert.equal(racing.slots[1].entry_state, "OPEN");
    racing.unchangedOpen();
  }
});

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

test("explicit legacy authorization proves exact empty missed operation without touching exchange, gates or freshness",async()=>{
 const h=harness({marketProtocol:true});
 h.run.lease_until=null;h.run.lease_owner=null;
 h.run.last_reconciled_at="2026-11-01T04:00:30Z";
 const s=h.slots[6];Object.assign(s,{entry_state:"MISSED",missed_at:"2026-11-01T04:00:28Z",target_buy_price:130,entry_reference_price:130});
 h.tables.robot_v1_live_events.push({...h.run,run_id:h.run.id,slot_number:7,event_type:"MISSED_LEVEL",
  observed_at:"2026-11-01T04:00:28.870Z",details:{reason:"NO_RESIDENT_BUY_AT_OBSERVATION",target_price:130}});
 const request=()=>h.runtime.authorizeMissedMarketEntry(String(h.run.id),7,1,String(h.run.user_id),"SOL");
 const result=await request();assert.equal(result.status,"MARKET_ENTRY_AUTHORIZED");
 const snapshot=h.run.config_snapshot as Row;const proof=snapshot.market_entry_authorization as Row;
 assert.equal(proof.slot_id,s.id);assert.equal(proof.quote_cap,h.accounts[6].balance_brl);
 assert.equal(h.calls.filter(c=>["create","cancel"].includes(c.kind)).length,0);
 assert.equal(s.entry_state,"MISSED");assert.equal(h.run.last_reconciled_at,"2026-11-01T04:00:30Z");
 await request();assert.equal(h.tables.robot_v1_live_events.filter(e=>e.event_type==="MISSED_MARKET_ENTRY_REQUESTED").length,1);
 for(const change of [{operation_sequence:2},{entry_state:"OPEN",position_quantity:.001}]){
  const before=structuredClone(s);Object.assign(s,change);await assert.rejects(request());Object.assign(s,before);
 }
 Object.assign(h.tables.robot_v1_live_events.find(e=>e.event_type==="MISSED_LEVEL")!,{details:{reason:"UNKNOWN",target_price:130}});
 await assert.rejects(request(),/MISSED_EVIDENCE_UNPROVEN/);
 h.unchangedOpen();
});

test("LIVE existing all-slots contribution reuses the same resizing path and source audit", async () => {
  const h = harness({ contributionSource: "ALL_SLOTS" });
  assert.equal(await h.arm(), "NEXT_BUY_ARMED");
  const event = h.tables.robot_v1_live_events.find((e) => e.event_type === "NEXT_BUY_CAPITAL_REFRESH_PLANNED")!;
  assert.deepEqual((event.details as Row).capital_sources, ["adjustment:allocation-new-capital"]);
  h.unchangedOpen();
});
