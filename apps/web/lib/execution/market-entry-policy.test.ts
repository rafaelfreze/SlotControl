import assert from "node:assert/strict";
import test from "node:test";
import { ENTRY_MARKET_POLICY, planStrategyMissedMarketEntry, planStrategyNextEntry, type StrategyCandidate } from "./strategy-engine.ts";
import { ENTRY_PRIORITY_POLICY } from "./monthly-slot-policy.ts";
import { marketEntryIntent, planExplicitMissedMarketRecovery, EXPLICIT_MISSED_RECOVERY } from "./market-entry-policy.ts";

const ctx={asset:"BTC" as const,cycleId:"run",observedAt:"2026-11-01T04:00:30Z",
  entryPriorityPolicy:ENTRY_PRIORITY_POLICY,entryMarketPolicy:ENTRY_MARKET_POLICY};
function slots(n=25):StrategyCandidate[]{return Array.from({length:n},(_,i)=>({id:`slot-${i+1}`,slotNumber:i+1,
  operationSequence:8,buyPrice:400-i,balanceQuote:i===0?1122.26938511:22,operationalRank:i+1,
  monthlyGainCount:0,lifetimeGainCount:i===0?7:0,monthlyEntryEligible:true,monthlyTargetReached:false,
  marketEntryEligible:true,entryOrigin:"REENTRY",state:"PLANNED"}));}

for(const asset of ["BTC","SOL"] as const)for(const count of [25,50,100])test(`${asset} ${count}: only highest eligible crossed owner buys MARKET, full own balance/gains, one decision`,()=>{
  const s=slots(count);s[0]!.buyPrice=432279;
  const p=planStrategyMissedMarketEntry({...ctx,asset,slotCount:count},s,423673,"NORMAL")!;
  assert.equal(p.candidateId,"slot-1");assert.equal(p.decision.action_type,"OPEN_ENTRY_MARKET");
  assert.equal(p.decision.target_notional,1122.26938511);assert.equal(p.referencePrice,432279);
  assert.equal(p.requiresResidentCancel,false);assert.equal(s.filter(x=>x.state==="PLANNED").length,count);
  s[0]!.state="OPEN";
  assert.equal(planStrategyMissedMarketEntry({...ctx,asset,slotCount:count},s,423673,"NORMAL"),null,
    "the next owner is uncrossed, no burst through lower crossed priorities");
});

test("Rafael 7/7 last month, 0/7 now: explicit legacy missed proof permits the priority operation, not all MISSED history",()=>{
  const s=slots();Object.assign(s[0]!,{state:"MISSED",buyPrice:432279,operationalRank:null,marketEntryEligible:false});
  assert.equal(planStrategyMissedMarketEntry(ctx,s,423673,"NORMAL"),null);
  s[0]!.marketEntryEligible=true;
  assert.equal(planStrategyMissedMarketEntry(ctx,s,423673,"NORMAL")!.candidateId,"slot-1");
  s[0]!.monthlyTargetReached=true;s[0]!.monthlyEntryEligible=false;s[0]!.monthlyGainCount=7;
  assert.equal(planStrategyMissedMarketEntry(ctx,s,423673,"NORMAL"),null,"individual target waits until next month");
  for(const x of s){x.monthlyTargetReached=true;x.monthlyEntryEligible=true;x.monthlyGainCount=7;x.lifetimeGainCount=7;}
  assert.equal(planStrategyMissedMarketEntry(ctx,s,423673,"NORMAL")!.candidateId,"slot-1","all N/N completed exception stays");
});

test("one zero-fill resident requires cancellation; partial/fill/crossed resident never authorizes a second BUY",()=>{
  const s=slots();Object.assign(s[0]!,{buyPrice:432279});Object.assign(s[1]!,{state:"ARMED",buyPrice:419440});
  const resident={candidateId:"slot-2",executedQuantity:0};
  assert.equal(planStrategyMissedMarketEntry(ctx,s,423673,"NORMAL",resident)!.requiresResidentCancel,true);
  assert.equal(planStrategyMissedMarketEntry(ctx,s,423673,"NORMAL",{...resident,executedQuantity:.00001}),null);
  s[1]!.state="PARTIALLY_FILLED";assert.equal(planStrategyMissedMarketEntry(ctx,s,423673,"NORMAL",resident),null);
  s[1]!.state="ARMED";s[1]!.buyPrice=430000;assert.equal(planStrategyMissedMarketEntry(ctx,s,423673,"NORMAL",resident),null);
});

test("new crossed lower-priority plans remain queued, legacy snapshots preserve historical MISSED semantics",()=>{
  const s=slots();s[1]!.buyPrice=450000;
  assert.deepEqual(planStrategyNextEntry(ctx,s,423673).missedCandidateIds,[]);
  assert.deepEqual(planStrategyNextEntry({...ctx,entryMarketPolicy:undefined},s,423673).missedCandidateIds,["slot-2"]);
});

test("POST_ATH primary/reserve and existing local reentry exception remain canonical",()=>{
  const s=slots();for(const x of s){x.postAthGroup="RESERVE";x.entryOrigin="GRID";}
  Object.assign(s[0]!,{buyPrice:432279,postAthGroup:"RESERVE"});s[1]!.postAthGroup="PRIMARY";
  assert.equal(planStrategyMissedMarketEntry(ctx,s,423673,"POST_ATH"),null);
  s[0]!.entryOrigin="REENTRY";
  assert.equal(planStrategyMissedMarketEntry(ctx,s,423673,"POST_ATH")!.candidateId,"slot-1");
});

test("an ENTRY quote needs exact immutable market intent; foreign scope, amount, operation or type fails closed",()=>{
  const intent={policy:ENTRY_MARKET_POLICY,run_id:"run",engine_id:"engine",slot_id:"slot",slot_number:7,
    operation_sequence:8,decision_id:"decision",quote:19.26268762,reference_price:432279,
    reason:"OPERATOR_MISSED_ENTRY" as const,period:"2026-11"};
  const order={side:"BUY",purpose:"ENTRY",run_id:"run",trading_engine_id:"engine",slot_id:"slot",slot_number:7,
    operation_sequence:8,requested_quote:19.26268762,requested_quantity:null,price:null,
    strategy_decision_id:"decision",config_snapshot:{market_entry_intent:intent}};
  assert.deepEqual(marketEntryIntent(order),intent);
  for(const change of [{trading_engine_id:"other"},{operation_sequence:9},{requested_quote:10},{price:432279},
    {requested_quantity:.00004},{strategy_decision_id:"other"}])assert.throws(()=>marketEntryIntent({...order,...change}));
  assert.equal(marketEntryIntent({...order,requested_quote:null,requested_quantity:.00004,price:432279}),null,
    "immutable old LIMIT is not reinterpreted by a later policy");
});

test("explicit historical recovery selects only its empty operation despite a higher normal monthly owner",()=>{
 const s=slots();Object.assign(s[0]!,{state:"MISSED",buyPrice:432279,monthlyGainCount:0});
 Object.assign(s[1]!,{state:"ARMED",buyPrice:419440,monthlyGainCount:1,lifetimeGainCount:4});
 const resident={candidateId:s[1]!.id,executedQuantity:0},original=structuredClone(s);
 const auth={policy:ENTRY_MARKET_POLICY,recovery_priority:EXPLICIT_MISSED_RECOVERY,run_id:"run",engine_id:"engine",
  slot_id:s[0]!.id,slot_number:1,operation_sequence:8,period:"2026-11",quote_cap:1122.26938511,
  authorization_event_key:`REQUEST:slot-1:8:2026-11:${EXPLICIT_MISSED_RECOVERY}`};
 assert.equal(planStrategyMissedMarketEntry(ctx,s,423673,"NORMAL",resident),null,"normal monthly priority remains unchanged");
 const plan=()=>planExplicitMissedMarketRecovery(ctx,"engine",s,423673,"NORMAL",resident,auth);
 assert.equal(plan()!.candidateId,s[0]!.id);assert.equal(plan()!.requiresResidentCancel,true);
 assert.equal(plan()!.decision.target_notional,1122.26938511);assert.deepEqual(s,original);
 for(const change of [{engine_id:"other"},{run_id:"other"},{operation_sequence:9},{slot_number:2},
   {period:"2026-10"},{recovery_priority:undefined},{authorization_event_key:"REQUEST"},{quote_cap:10},{quote_cap:undefined}])
  assert.equal(planExplicitMissedMarketRecovery(ctx,"engine",s,423673,"NORMAL",resident,{...auth,...change}),null);
 s[0]!.monthlyEntryEligible=false;assert.equal(plan(),null);s[0]!.monthlyEntryEligible=true;
 s[0]!.state="OPEN";assert.equal(plan(),null);s[0]!.state="MISSED";
 s[1]!.state="PARTIALLY_FILLED";assert.equal(plan(),null);s[1]!.state="ARMED";
 assert.equal(planExplicitMissedMarketRecovery(ctx,"engine",s,423673,"NORMAL",{...resident,executedQuantity:.001},auth),null);
});
