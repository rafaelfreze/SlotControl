import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { planAthLadder } from "./ath-ladder.ts";
import { monthlyPeriodKey, ENTRY_PRIORITY_POLICY, rankMonthlySlots } from "./monthly-slot-policy.ts";
import { cumulativeSlotGoal } from "./cumulative-slot-goal.ts";
import * as topology from "./engine-slot-topology.ts";
import * as snapshot from "./live-strategy-snapshot.ts";
import * as priceInvariant from "./strategy-price-invariant.ts";
import * as crypto from "node:crypto";

type Row = Record<string, any>;
const parameters = { gainRate: .055, normalSpacing: .03, postAthSpacing: .03 };
function slots(n = 25) {
  return Array.from({ length: n }, (_, i) => ({ physicalSlotId: `s${i + 1}`, physicalSlotNumber: i + 1,
    lifetimeGainCount: i === 9 ? 2 : 0, monthlyGainCount: 0, entryState: i < 9 ? "OPEN" : "PLANNED",
    status: i < 9 ? "OPEN" : "PENDING", buyPrice: i === 9 ? 92.99 : Math.floor(119.7 * .97 ** i * 100) / 100,
    entryOrigin: i === 9 ? "REENTRY" as const : "GRID" as const, operationSequence: i === 9 ? 3 : 1 }));
}

test("month-only ranking never creates the Thyely 92.78 level beside retained 92.99", () => {
  const input = slots(), original = structuredClone(input);
  const fixed = planAthLadder("SOL", "NORMAL", 95.65, parameters, .01, input, 2, 25, "PRESERVE_LEVELS");
  assert.deepEqual(fixed.map(s => s.nextBuyPrice), input.map(s => s.buyPrice));
  assert.equal(fixed[9]!.nextBuyPrice, 92.99);
  assert.notEqual(fixed[10]!.nextBuyPrice, 92.78);
  assert.deepEqual(input, original);
  // An actual ATH/config transition retains its existing authorized geometry.
  const actual = planAthLadder("SOL", "NORMAL", 95.65, parameters, .01, input, 2);
  assert.equal(actual[10]!.nextBuyPrice, 92.78);
});

test("25/50/100 BTC/SOL: current monthly eligibility and PRIMARY/RESERVE with unchanged level multiset", () => {
  for (const n of [25, 50, 100]) for (const asset of ["BTC", "SOL"] as const) {
    const input = slots(n).map(s => ({ ...s, status: "PENDING", entryState: "PLANNED",
      lifetimeGainCount: Math.max(7, s.physicalSlotNumber), monthlyGainCount: s.physicalSlotNumber === 1 ? 7 : 0 }));
    const before = structuredClone(input);
    const held = planAthLadder(asset, "POST_ATH", 95.65, parameters, .01, input, 7, n, "PRESERVE_LEVELS");
    assert.equal(held[0]!.operationalRank, null);
    const reset = input.map(s => ({ ...s, monthlyGainCount: 0 }));
    const next = planAthLadder(asset, "POST_ATH", 95.65, parameters, .01, reset, 7, n, "PRESERVE_LEVELS");
    assert.notEqual(next[0]!.operationalRank, null);
    assert.equal(next.filter(s => s.postAthGroup === "PRIMARY").length, 15);
    assert.equal(next.filter(s => s.postAthGroup === "RESERVE").length, n - 15);
    assert.deepEqual(next.map(s => s.nextBuyPrice), reset.map(s => s.buyPrice));
    const allMet = input.map(s => ({ ...s, monthlyGainCount: 7, lifetimeGainCount: 7 }));
    assert.equal(planAthLadder(asset, "NORMAL", 95.65, parameters, .01, allMet, 7, n,
      "PRESERVE_LEVELS").filter(s => s.operationalRank !== null).length, n);
    assert.deepEqual(input, before);
  }
  assert.equal(monthlyPeriodKey("2027-01-01T03:59:59Z"), "2026-12");
  assert.equal(monthlyPeriodKey("2027-01-01T04:00:00Z"), "2027-01");
});

/** Executes the production transition; all I/O is in-memory. Any transport
 * dependency outside these explicit stubs is absent and cannot place trades. */
function harness(options: { cumulative?: boolean; partial?: boolean; transition?: boolean; force?: boolean; rankCrash?: number;
  failedRunSave?: boolean; fillDuringCancel?: boolean; engine?: string } = {}) {
  const id = options.engine ?? "engine-a";
  const input = slots();
  const ledger: Row = { slots: input.map((s, i) => ({ id: s.physicalSlotId, slot_number: i + 1,
    operation_sequence: s.operationSequence, entry_state: i === 10 ? (options.partial ? "PARTIALLY_FILLED" : "ARMED") : s.entryState,
    entry_origin: s.entryOrigin, target_buy_price: s.buyPrice, entry_reference_price: s.buyPrice,
    operational_rank: null, post_ath_group: null, post_ath_group_rank: null,
    position_quantity: i < 9 || i === 10 && options.partial ? 1 : 0, missed_at: null })),
    accounts: input.map(s => ({ slot_number: s.physicalSlotNumber, balance_brl: 60 })),
    orders: [{ id: "buy", slot_id: "s11", side: "BUY", status: options.partial ? "PARTIALLY_FILLED" : "NEW",
      executed_quantity: options.partial ? .1 : 0 }] };
  const run: Row = { id: `run-${id}`, tenant_id: "t", user_id: "u", product_id: "p", operator_id: "o",
    exchange_account_id: "a", trading_engine_id: id, engine: { slot_count: 25 }, asset: "SOL", gain_rate: .055,
    entry_spacing: .03, config_version: 7, entry_regime: "NORMAL", ath_transition_key: null,
    ath_period_key: options.cumulative ? monthlyPeriodKey(new Date()) : "2000-12", lease_owner: `lease-${id}`, anchor_price: 119.7,
    config_snapshot: { gain_rate: .055, entry_spacing: .03, ladder_anchor_price: 119.7,
      normal_spacing_rate: .03, post_ath_spacing_rate: .03, regime: "NORMAL", marker: "PRESERVED",
      entry_price_sources: { s10: { run_id: `run-${id}`, engine_id: id, slot_id: "s10", price: 92.99, source_origin: "REENTRY" } },
      entry_grid_contexts: {} } };
  const before = structuredClone({ run, ledger });
  const effects: Row = { cancel: 0, slot: [], save: [], events: [], leases: 0 };
  let crash = options.rankCrash, failedRunSave = options.failedRunSave;
  const service = { from(table: string) {
    assert.equal(table, "robot_v1_live_runs"); const filters: Row = {}; let data: Row = {};
    const q = { update(v: Row) { data = v; return q; }, eq(k: string, v: unknown) { filters[k] = v; return q; },
      select() { return q; }, async single() {
        assert.equal(filters.id, run.id); assert.equal(filters.lease_owner, run.lease_owner);
        effects.save.push(structuredClone({ data, filters }));
        if (failedRunSave) { failedRunSave = false; return { data: null, error: { code: "503" } }; }
        Object.assign(run, structuredClone(data)); return { data: structuredClone(run), error: null };
      } }; return q;
  } };
  const deps: Row = { "node:crypto": crypto, "./ath-ladder": { planAthLadder }, "./monthly-slot-policy": { monthlyPeriodKey, ENTRY_PRIORITY_POLICY },
    "./engine-slot-topology": topology, "./live-strategy-snapshot": snapshot,
    "./strategy-price-invariant": priceInvariant, "./robot-v1-live-cycle": { LIVE_ACTIVE_ORDER_STATUSES: new Set(["NEW", "PARTIALLY_FILLED", "PREPARED"]) } };
  const source = ts.transpileModule(readFileSync(new URL("./robot-v1-live-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Row = {};
  const f = { run, ledger, effects, service, options,
    statuses() {
      const raw = ledger.slots.map((s: Row) => ({physicalSlotId:`REAL:${id}:${s.slot_number}`,physicalSlotNumber:s.slot_number,
        lifetimeGainCount:s.slot_number===10?2:0,monthlyGainCount:0,monthlyGainTarget:2,
        entryState:s.entry_state,balanceUsdc:60}));
      if(!options.cumulative) return raw;
      const goal=cumulativeSlotGoal({policy:"CUMULATIVE_LIFETIME_V1",anchor_at:"2026-09-24T05:40:17Z",
        schedule:[{effective_period:"2026-09",monthly_target:2,source:"FIRST_BUY"}]},new Date());
      return rankMonthlySlots("SOL",new Date(),raw,goal.target,25,undefined,goal);
    },
    async slot(slot: Row, data: Row) {
      if (crash !== undefined && effects.slot.length === crash) { crash = undefined; throw Error("FIXTURE_CRASH"); }
      effects.slot.push({ id: slot.id, data: structuredClone(data) }); Object.assign(slot, data);
    } };
  new Function("require", "exports", "f", source + `
    refreshRealAthProfile=async()=>({regime:'NORMAL',transition_key:f.options.transition?'REAL_ATH_CHANGE':null,
      config_version:7,normal_spacing_rate:.03,post_ath_spacing_rate:.03});
    monthly=async()=>f.statuses();
    renewLease=async()=>{f.effects.leases++;};
    updateSlot=async(_service,_run,slot,data)=>f.slot(slot,data);
    cancelOwnedEntry=async()=>{f.effects.cancel++;return !f.options.fillDuringCancel;};
    runRows=async()=>f.ledger;
    scopedPreparation=async()=>({max_order_notional_brl:60});
    event=async(_service,_run,key,type,_slot,details)=>{f.effects.events.push({key,type,details});};
    exports.execute=()=>applyAthTransition(f.service,f.run,f.ledger,
      {price:{price:95.65},filters:{priceTick:.01,quantityStep:.001,minQuantity:.001,maxQuantity:1000,minNotional:10}},f.options.force);
  `)((name: string) => deps[name] ?? {}, exports, f);
  return { execute: exports.execute as () => Promise<boolean>, ...f, before };
}

test("LIVE month-only refresh preserves resident/partial BUY, OPEN/TP, prices, sources, balances and rates", async () => {
  for (const partial of [false, true]) for (const engine of ["engine-a", "sibling-other-shard"]) {
    const f = harness({ partial, engine }); await f.execute();
    assert.equal(f.effects.cancel, 0);
    assert.deepEqual(f.ledger.orders, f.before.ledger.orders);
    assert.deepEqual(f.ledger.accounts, f.before.ledger.accounts);
    assert.deepEqual(f.ledger.slots.filter((s: Row) => ["OPEN", "PARTIALLY_FILLED"].includes(s.entry_state)),
      f.before.ledger.slots.filter((s: Row) => ["OPEN", "PARTIALLY_FILLED"].includes(s.entry_state)));
    assert.ok(f.effects.slot.every((s: Row) => Object.keys(s.data).every(k => ["operational_rank", "post_ath_group", "post_ath_group_rank"].includes(k))));
    assert.deepEqual(f.ledger.slots.map((s: Row) => [s.target_buy_price, s.entry_reference_price]),
      f.before.ledger.slots.map((s: Row) => [s.target_buy_price, s.entry_reference_price]));
    const { monthly_priority_rollover, ...snapshotBefore } = f.run.config_snapshot;
    assert.deepEqual(snapshotBefore, f.before.run.config_snapshot);
    assert.equal(monthly_priority_rollover.reanchored, false);
    assert.equal(f.run.ath_period_key, monthlyPeriodKey(new Date()));
    assert.deepEqual(f.effects.events.map((e: Row) => e.type), ["MONTHLY_PRIORITY_REFRESHED"]);
    const counts = structuredClone(f.effects);
    assert.equal(await f.execute(), false); assert.deepEqual(f.effects, counts);
  }
});

test("adopting cumulative goal in the same calendar month only refreshes metadata, never resident BUY/OPEN/TP or prices",async()=>{
  const f=harness({cumulative:true});assert.equal(await f.execute(),true);
  assert.equal(f.effects.cancel,0);assert.deepEqual(f.ledger.orders,f.before.ledger.orders);
  assert.deepEqual(f.ledger.accounts,f.before.ledger.accounts);
  assert.deepEqual(f.ledger.slots.map((s:Row)=>s.target_buy_price),f.before.ledger.slots.map((s:Row)=>s.target_buy_price));
  assert.equal(f.run.config_snapshot.slot_goal_state.policy,"CUMULATIVE_LIFETIME_V1");
  assert.equal(f.run.config_snapshot.monthly_priority_rollover.levels_preserved,true);
  assert.equal(await f.execute(),false);
});

test("crash or failed503 checkpoint retries metadata only before month watermark advances", async () => {
  for (const options of [{ rankCrash: 2 }, { failedRunSave: true }]) {
    const f = harness(options); await assert.rejects(f.execute());
    assert.equal(f.run.ath_period_key, "2000-12");
    await f.execute(); assert.equal(f.run.ath_period_key, monthlyPeriodKey(new Date()));
    assert.equal(f.effects.cancel, 0); assert.equal(f.effects.events.length, 1);
    assert.deepEqual(f.ledger.orders, f.before.ledger.orders);
  }
});

test("actual ATH transition or explicit config force retains canonical zero-fill cancel/reanchor", async () => {
  for (const options of [{ transition: true }, { force: true }]) {
    const f = harness(options); assert.equal(await f.execute(), true);
    assert.equal(f.effects.cancel, 1); assert.equal(f.run.config_snapshot.ladder_anchor_price, 95.65);
    assert.equal(f.ledger.slots[9].target_buy_price, 92.99);
    assert.equal(f.effects.events[0].type, "ATH_TRANSITION");
    const race = harness({ ...options, fillDuringCancel: true });
    await assert.rejects(race.execute(), /FILLED_DURING_SNAPSHOT/);
    assert.equal(race.effects.save.length, 0); assert.equal(race.effects.events.length, 0);
    const partial = harness({ ...options, partial: true });
    await assert.rejects(partial.execute(), /BUY_RECONCILIATION_REQUIRED/); assert.equal(partial.effects.cancel, 0);
  }
});
