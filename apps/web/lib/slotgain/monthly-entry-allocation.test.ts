import assert from "node:assert/strict";
import test from "node:test";
import { ENTRY_PRIORITY_POLICY, rankMonthlySlots, monthlyPeriodKey } from "../execution/monthly-slot-policy.ts";
import { allocateMonthlyEntryLevels, planStrategyNextEntry, planStrategyPostAthNextEntry, type StrategyCandidate } from "../execution/strategy-engine.ts";
const at="2026-10-26T14:00:00Z";
const ctx={asset:"BTC" as const,cycleId:"engine-A:run",observedAt:at,entryPriorityPolicy:ENTRY_PRIORITY_POLICY};
const fixture=():StrategyCandidate[]=>[7,6,8,5].map((n,i)=>({id:`A:${n}`,slotNumber:n,operationSequence:3,
 buyPrice:[427956,432279,423676,436645][i]!,balanceQuote:18+n/100,monthlyGainCount:[4,3,2,1][i]!,
 lifetimeGainCount:n===5?99:[4,3,2,1][i]!,monthlyEntryEligible:true,monthlyTargetReached:false,
 operationalRank:i+1,entryOrigin:"REENTRY",state:n===5?"ARMED":"PLANNED"}));
const assigned=(c:StrategyCandidate[],p:ReturnType<typeof allocateMonthlyEntryLevels>)=>c.map(s=>({...s,
 buyPrice:p.assignments.find(a=>a.id===s.id)?.price??s.buyPrice,state:"PLANNED" as const}));
test("4/7 > 3/7 > 2/7 > 1/7 own the descending levels, not each other's money/history",()=>{
 const c=fixture(),before=structuredClone(c),p=allocateMonthlyEntryLevels(ctx,c,440000,"NORMAL",{candidateId:"A:5",executedQuantity:0});
 assert.deepEqual(p.assignments.map(a=>[a.slotNumber,a.price]),[[7,436645],[6,432279],[8,427956],[5,423676]]);
 assert.equal(p.requiresResidentCancel,true);assert.equal(p.nextCandidateId,"A:7");assert.deepEqual(c,before);
 const next=planStrategyNextEntry(ctx,assigned(c,p),440000);assert.equal(next.nextCandidateId,"A:7");
 assert.equal(next.decision.target_price,436645);assert.equal(next.decision.target_notional,c[0]!.balanceQuote);
});
test("new gain, month/year rollover and repeated invocations are deterministic",()=>{
 const c=fixture();const p=allocateMonthlyEntryLevels(ctx,c,440000,"NORMAL");
 for(let i=0;i<5;i++)assert.deepEqual(allocateMonthlyEntryLevels(ctx,c,440000,"NORMAL"),p);
 const changed=assigned(c,p);changed.find(s=>s.slotNumber===6)!.monthlyGainCount=5;changed.find(s=>s.slotNumber===6)!.lifetimeGainCount=5;
 assert.equal(allocateMonthlyEntryLevels(ctx,changed,440000,"NORMAL").nextCandidateId,"A:6");
 assert.equal(monthlyPeriodKey("2027-01-01T03:59:59Z"),"2026-12");assert.equal(monthlyPeriodKey("2027-01-01T04:00:00Z"),"2027-01");
 const reset=changed.map(s=>({...s,monthlyGainCount:0}));
 assert.equal(allocateMonthlyEntryLevels(ctx,reset,440000,"NORMAL").nextCandidateId,"A:5","lifetime only breaks a monthly tie");
});
test("OPEN, missed, unknown and crossed levels cannot be moved; partial/crossed resident is pinned",()=>{
 for(const patch of [{state:"OPEN"},{state:"MISSED"},{monthlyEntryEligible:false},{buyPrice:450000}]){
  const c=fixture();Object.assign(c[0]!,patch);const p=allocateMonthlyEntryLevels(ctx,c,440000,"NORMAL");
  assert.ok(!p.assignments.some(a=>a.id==="A:7"));assert.notEqual(p.nextCandidateId,"A:7");
 }
 for(const patch of [{state:"PARTIALLY_FILLED" as const},{buyPrice:450000}]){
  const c=fixture();Object.assign(c.find(s=>s.id==="A:5")!,patch);
  const p=allocateMonthlyEntryLevels(ctx,c,440000,"NORMAL",{candidateId:"A:5",executedQuantity:0});
  assert.equal(p.held,true);assert.deepEqual(p.assignments,[]);assert.equal(p.requiresResidentCancel,false);
 }
 assert.equal(allocateMonthlyEntryLevels(ctx,fixture(),440000,"NORMAL",{candidateId:"A:5",executedQuantity:.001}).held,true);
 const invalid=fixture();delete invalid[0]!.monthlyGainCount;assert.throws(()=>allocateMonthlyEntryLevels(ctx,invalid,440000,"NORMAL"),/EVIDENCE_INVALID/);
});
test("25/50/100, BTC/SOL, monthly progress beats lifetime; goals cannot stop the available queue",()=>{
 for(const asset of ["BTC","SOL"] as const)for(const n of [25,50,100]){
  const rows=Array.from({length:n},(_,i)=>({physicalSlotNumber:i+1,physicalSlotId:`${asset}:${n}:${i+1}`,
   monthlyGainCount:i===0?1:i===1?4:2,lifetimeGainCount:i===0?100:i===1?4:2,balanceUsdc:22,entryState:"PLANNED"}));
  const ranked=rankMonthlySlots(asset,at,rows,7,n);assert.equal(ranked[1]!.operationalRank,1);
  const complete=rankMonthlySlots(asset,at,rows.map(s=>({...s,monthlyGainCount:7,lifetimeGainCount:100})),7,n);
  assert.equal(complete.filter(s=>s.eligibleForNewEntry).length,n);
  const open=rankMonthlySlots(asset,at,rows.map((s,i)=>({...s,entryState:i===0?"OPEN":"PLANNED",
   monthlyGainCount:i===0?0:7,lifetimeGainCount:100})),7,n);
  assert.equal(open.filter(s=>s.eligibleForNewEntry).length,1,"a still-open unfinished slot does not release N-1 completed goals");
  const c=ranked.map((s,i):StrategyCandidate=>({id:s.physicalSlotId,slotNumber:i+1,operationSequence:1,
   buyPrice:1000-i,balanceQuote:22,state:"PLANNED",operationalRank:s.operationalRank,
   monthlyGainCount:s.monthlyGainCount!,lifetimeGainCount:s.lifetimeGainCount,monthlyEntryEligible:s.eligibleForNewEntry}));
  assert.equal(allocateMonthlyEntryLevels({...ctx,asset,slotCount:n},c,1100,"NORMAL").nextCandidateId,rows[1]!.physicalSlotId);
 }
});
test("post-ATH retains the PRIMARY gate, and the existing REENTRY exception, with monthly priority",()=>{
 const c:StrategyCandidate[]=fixture().map(s=>({...s,state:"PLANNED" as const,entryOrigin:"GRID" as const,
  postAthGroup:s.slotNumber===6?"PRIMARY" as const:"RESERVE" as const}));
 assert.equal(allocateMonthlyEntryLevels(ctx,c,440000,"POST_ATH").nextCandidateId,"A:6");
 c[0]!.entryOrigin="REENTRY";
 const p=allocateMonthlyEntryLevels(ctx,c,440000,"POST_ATH");assert.equal(p.nextCandidateId,"A:7");
 assert.equal(planStrategyPostAthNextEntry(ctx,assigned(c,p),440000).nextCandidateId,"A:7");
});
test("engine and shard identity are preserved by run/slot scope and decision idempotency",()=>{
 const a=fixture(),p=allocateMonthlyEntryLevels(ctx,a,440000,"NORMAL");const c=assigned(a,p);
 const first=planStrategyNextEntry(ctx,c,440000),b=c.map(s=>({...s,id:s.id.replace("A:","B:")}));
 const second=planStrategyNextEntry({...ctx,cycleId:"engine-B:other-shard:run"},b,440000);
 assert.notEqual(first.decision.decision_id,second.decision.decision_id);assert.equal(second.nextCandidateId,"B:7");
 assert.equal(planStrategyNextEntry({...ctx,observedAt:"2026-10-26T14:01:00Z"},c,440000).decision.decision_id,first.decision.decision_id);
});
