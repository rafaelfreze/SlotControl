import test from "node:test";import assert from "node:assert/strict";
import{minimalPartialRecoveryQuote,partialEntryRecoveryIntent,PARTIAL_ENTRY_RECOVERY_POLICY,planPartialEntryRecovery,type PartialEntryRecovery}from"./partial-entry-recovery.ts";
test("minimal rescue uses a venue-valid lot above minimum and never the full slot; BTC/SOL filters",()=>{
 assert.equal(minimalPartialRecoveryQuote(500,10,.001),10.5);
 assert.equal(minimalPartialRecoveryQuote(516.4,10,.001),10.85);
 assert.equal(minimalPartialRecoveryQuote(425000,10,.00001),17);
 for(const n of [0,-1,NaN,Infinity])assert.throws(()=>minimalPartialRecoveryQuote(n,10,.001));
});
const proof:PartialEntryRecovery={policy:PARTIAL_ENTRY_RECOVERY_POLICY,run_id:"r",engine_id:"e",slot_id:"s",slot_number:8,operation_sequence:3,
 source_order_id:"source",source_client_order_id:"source-client",source_exchange_order_id:"1",source_quantity:.004,source_quote:2,
 source_fee_base:0,source_committed:2.001,quote:10.5,slot_balance:1122,gain_rate:.055,spacing:.03,incident_key:"root",
 incident_first_seen_at:"2026-11-01T04:05:00Z",authorization_event_key:"auth",authorized_at:"2026-11-01T18:00:00Z"};
const order={side:"BUY",purpose:"ENTRY",run_id:"r",trading_engine_id:"e",slot_id:"s",slot_number:8,operation_sequence:3,
 requested_quote:10.5,requested_quantity:null,price:null,config_snapshot:{partial_entry_recovery_intent:proof}};
test("rescue intent preserves original operation and quote; identity/capital/fields cannot drift",()=>{
 assert.deepEqual(partialEntryRecoveryIntent(order),proof);
 for(const patch of [{trading_engine_id:"sibling"},{operation_sequence:4},{requested_quote:11},{price:500},{side:"SELL"}])
  assert.throws(()=>partialEntryRecoveryIntent({...order,...patch}));
 assert.throws(()=>partialEntryRecoveryIntent({...order,config_snapshot:{partial_entry_recovery_intent:{...proof,slot_balance:5}}}));
 const a=planPartialEntryRecovery({asset:"SOL",cycleId:"r",observedAt:proof.authorized_at},proof);
 const b=planPartialEntryRecovery({asset:"SOL",cycleId:"r",observedAt:"2026-11-01T18:01:00Z"},proof);
 assert.equal(a.decision_id,b.decision_id);assert.equal(a.target_notional,10.5);assert.equal(a.reason,PARTIAL_ENTRY_RECOVERY_POLICY);
});
