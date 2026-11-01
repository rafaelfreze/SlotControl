import assert from "node:assert/strict";
import test from "node:test";
import { proveMonthlyGridRepair, proveRetainedGridContext } from "./monthly-grid-recovery.ts";
import { gridContextForPrice } from "./live-strategy-snapshot.ts";
import { athLadderLevelPrice } from "./ath-ladder-price.ts";
import { ENTRY_PRIORITY_POLICY } from "./monthly-slot-policy.ts";

function fixture(count = 25, asset = "BTC") {
  const spacing = asset === "BTC" ? .02 : .03, price = athLadderLevelPrice(110, spacing, 6, .01);
  const scope = { run_id: "run", operator_id: "operator", exchange_account_id: "account", trading_engine_id: "engine" };
  const source = { run_id: "run", engine_id: "engine", slot_id: "slot-1", price, source_origin: "GRID" };
  const snapshot = { entry_priority_policy: ENTRY_PRIORITY_POLICY, entry_price_sources: { "slot-1": source },
    regime: "NORMAL", entry_spacing: spacing, gain_rate: .03, ladder_anchor_price: 100 };
  const run = { ...scope, id: "run", entry_regime: "NORMAL", ath_period_key: "2026-11", anchor_price: 110,
    entry_spacing: spacing, gain_rate: .03, config_version:2, config_snapshot: structuredClone(snapshot) };
  const slots = Array.from({ length: count }, (_, i) => ({ id: `slot-${i+1}`, position_quantity: 0,
    entry_state: i ? "PLANNED" : "ARMED", entry_origin: i ? "GRID" as const : "REENTRY" as const,
    target_buy_price: i ? athLadderLevelPrice(100, spacing, i, .01) : price,
    entry_reference_price: i ? athLadderLevelPrice(100, spacing, i, .01) : price }));
  const order = { ...scope, id: "prepared", slot_id: "slot-1", side: "BUY", purpose: "ENTRY", status: "PREPARED",
    price, executed_quantity: 0, cumulative_quote: 0, exchange_order_id: null as string | null,
    submission_guarded_at: null as string | null, created_at: "2026-11-01T04:00:50Z", trades_reconciled: false,
    config_version: 2, config_snapshot: structuredClone(snapshot) };
  const prior = { ...structuredClone(order), id: "prior", status: "CANCELED", exchange_order_id: "confirmed-prior",
    created_at: "2026-10-31T01:00:00Z", trades_reconciled: true,
    config_snapshot: { ...structuredClone(snapshot), ladder_anchor_price: 110 } };
  const incident = { code: "COINOPS_STRATEGY_PRICE_INVARIANT_FAILED", first_seen_at: "2026-11-01T04:01:00Z",
    details: { root_code: "COINOPS_STRATEGY_PRICE_INVARIANT_FAILED", stage: "RECONCILE_ORDERS" } };
  return { run, slots, orders: [prior, order], incident };
}

for (const count of [25,50,100]) for (const asset of ["BTC","SOL"]) {
  test(`${asset} ${count}: proves retained old GRID alongside fresh monthly GRID without changing prices/strategy`, () => {
    const f = fixture(count, asset), before = structuredClone(f);
    const proof = proveMonthlyGridRepair(f.run, f.orders, f.slots, f.incident, .01, count);
    assert.equal(proof.corrected_anchor,110); assert.equal(proof.previous_anchor,100);
    assert.deepEqual(f,before);
    f.orders[1]!.status="CANCELED";
    assert.deepEqual(proveMonthlyGridRepair(f.run,f.orders,f.slots,f.incident,.01,count,
      JSON.parse(JSON.stringify(proof, Object.keys(proof).sort()))),proof,"restart accepts JSONB key order");
  });
}

test("ambiguous/sent/foreign/non-monthly/changed strategy/invalid geometry cannot inherit recovery", () => {
  for (const mutate of [
    (f:ReturnType<typeof fixture>)=>{f.orders[1]!.submission_guarded_at="2026-11-01T04:00:51Z";},
    (f:ReturnType<typeof fixture>)=>{f.orders[1]!.exchange_order_id="sent";},
    (f:ReturnType<typeof fixture>)=>{f.orders[1]!.executed_quantity=.001;},
    (f:ReturnType<typeof fixture>)=>{f.orders[0]!.trades_reconciled=false;},
    (f:ReturnType<typeof fixture>)=>{f.orders[0]!.trading_engine_id="sibling";},
    (f:ReturnType<typeof fixture>)=>{f.incident.first_seen_at="2026-11-02T04:01:00Z";},
    (f:ReturnType<typeof fixture>)=>{f.incident.details.stage="ARM_ENTRY";},
    (f:ReturnType<typeof fixture>)=>{f.orders[0]!.config_snapshot.gain_rate=.04;},
    (f:ReturnType<typeof fixture>)=>{f.slots[8]!.target_buy_price=41.33;},
    (f:ReturnType<typeof fixture>)=>{f.slots[0]!.position_quantity=.001;},
  ]) { const f=fixture(); mutate(f); assert.throws(()=>proveMonthlyGridRepair(f.run,f.orders,f.slots,f.incident,.01,25)); }
});

test("grid contexts travel by price; wrong engine, topology or altered price fails closed", () => {
  const c={run_id:"run",engine_id:"engine",price:97.44,anchor:110,spacing:.02,slot_count:25};
  const snapshot={entry_grid_contexts:{"97.44":c}};
  assert.deepEqual(gridContextForPrice(snapshot,{id:"run",trading_engine_id:"engine"},97.44,25),c);
  assert.throws(()=>gridContextForPrice(snapshot,{id:"run",trading_engine_id:"other"},97.44,25));
  assert.throws(()=>gridContextForPrice(snapshot,{id:"run",trading_engine_id:"engine"},97.44,50));
  c.price=97.45; assert.throws(()=>gridContextForPrice(snapshot,{id:"run",trading_engine_id:"engine"},97.44,25));
});

test("an uncommitted level can inherit geometry only from its immutable pre-transition scoped GRID source",()=>{
  const f=fixture(),price=f.slots[0]!.target_buy_price;
  const p=proveRetainedGridContext(f.run,f.orders,price,"2026-11-01T04:00:40Z",.01,25)!;
  assert.equal(p.source_order_id,"prior");assert.equal(p.context.anchor,110);
  for(const mutate of [(v:typeof f)=>{delete (v.orders[0]!.config_snapshot as Record<string,unknown>).entry_price_sources;},
    (v:typeof f)=>{v.orders[0]!.exchange_account_id="other";},
    (v:typeof f)=>{v.orders[0]!.config_snapshot.entry_spacing=.03;},
    (v:typeof f)=>{v.orders[0]!.created_at="2026-11-01T04:00:45Z";},
    (v:typeof f)=>{v.orders[0]!.config_version=99;}]){
    const bad=fixture();mutate(bad);assert.equal(proveRetainedGridContext(bad.run,bad.orders,price,"2026-11-01T04:00:40Z",.01,25),null);
  }
});
