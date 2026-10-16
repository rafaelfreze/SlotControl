import assert from "node:assert/strict";
import { test } from "node:test";
import { createFullAdvanceFixture,offlineId as id } from "./variable-engine-full-advance-fixture.mjs";

async function mixedSnapshot(f,{full=25,partial=24,buySlot=50,prepared=false}={}){
  const rows=await f.service.query("select * from coinops.robot_v1_live_orders where run_id=$1 order by slot_number",[f.run.id]);
  for(const row of rows.filter(row=>row.side==="SELL"&&row.slot_number>full&&row.slot_number<=full+partial)){
    const order=f.exchange.get(row.exchange_order_id);
    order.status="PARTIALLY_FILLED";order.executedQty=".022";order.cummulativeQuoteQty="11.33";
    order.trades=[{id:Number(order.orderId)+100000,orderId:Number(order.orderId),qty:".022",quoteQty:"11.33",
      commission:".000000005",commissionAsset:"BNB",isBuyer:false,time:Date.now()}];
  }
  const buy=rows.find(row=>row.slot_number===buySlot&&row.side==="BUY"),tp=rows.find(row=>row.slot_number===buySlot&&row.side==="SELL");
  await f.service.query("delete from coinops.robot_v1_live_fills where order_id=$1",[buy.id]);
  await f.service.query("delete from coinops.account_order_budget_reservations where client_order_id=$1",[tp.client_order_id]);
  await f.service.query("delete from coinops.robot_v1_live_orders where id=$1",[tp.id]);f.exchange.delete(tp.exchange_order_id);
  await f.service.query("update coinops.robot_v1_live_orders set status='NEW',executed_quantity=0,cumulative_quote=0,trades_reconciled=false where id=$1",[buy.id]);
  await f.service.query("update coinops.robot_v1_live_slots set entry_state='ARMED',position_quantity=0,position_committed_brl=0 where id=$1",[buy.slot_id]);
  if(prepared){
    f.exchange.delete(buy.exchange_order_id);
    await f.service.query("delete from coinops.account_order_budget_reservations where client_order_id=$1",[buy.client_order_id]);
    await f.service.query("update coinops.robot_v1_live_orders set status='PREPARED',exchange_order_id=null,submission_guarded_at=null where id=$1",[buy.id]);
    await f.service.query("update coinops.robot_v1_strategy_decisions set result='PENDING',dispatched_at=null,exchange_ack_at=null,completed_at=null where decision_id=$1",[buy.strategy_decision_id]);
  }
}

async function converge(f,maxPasses=5,{cadenceMs=0,retryBudgetHolds=false}={}){
  const passes=[];let result,runId=f.run.id,previousStart=0;
  for(let pass=0;pass<maxPasses;pass++){
    if(previousStart&&cadenceMs){const remaining=previousStart+cadenceMs-Date.now();
      if(remaining>0)await new Promise(resolve=>setTimeout(resolve,remaining));}
    previousStart=Date.now();
    const baseline=f.beginMeasurement();result=await f.advance(runId);passes.push({result,report:f.report(baseline)});
    const budgetHold=retryBudgetHolds&&result.status==="RETRY"&&result.code==="COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN";
    if(result.status!=="RETRY"||result.code!=="COINOPS_LIVE_RECONCILIATION_PROGRESS"&&!budgetHold)return {result,passes};
    runId=result.continuation.at(-1).runId;
    if(budgetHold&&!cadenceMs)await new Promise(resolve=>setTimeout(resolve,6000));
    // Immediate replay proves only cursor/idempotence, not normal60s cadence.
  }
  assert.fail("canonical cooperative progress failed to converge");
}

async function assertProtectedFinal(f,expectedGains){
  const runs=await f.service.query("select id,last_error from coinops.robot_v1_live_runs where trading_engine_id=$1 and status='ACTIVE'",[id(4)]);
  assert.equal(runs.length,1);assert.equal(runs[0].last_error,null);
  const orders=await f.service.query("select * from coinops.robot_v1_live_orders where run_id=$1",[runs[0].id]);
  assert.equal(orders.filter(order=>order.side==="BUY"&&["PREPARED","NEW","PARTIALLY_FILLED"].includes(order.status)).length,1);
  const protection=await f.service.query(`select s.id,s.position_quantity,coalesce(sum(o.requested_quantity-o.executed_quantity),0) covering
    from coinops.robot_v1_live_slots s left join coinops.robot_v1_live_orders o on o.slot_id=s.id
      and o.operation_sequence=s.operation_sequence and o.side='SELL' and o.status in ('NEW','PARTIALLY_FILLED')
    where s.run_id=$1 and s.position_quantity>0 group by s.id,s.position_quantity`,[runs[0].id]);
  for(const slot of protection){const residual=Number(slot.position_quantity)-Number(slot.covering);
    assert.ok(residual>=-1e-12&&residual<.001+1e-12,`Unprotected ${slot.id}: residual ${residual}`);}
  assert.equal((await f.service.query("select count(*)::int n from coinops.robot_v1_monthly_slot_gains where trading_engine_id=$1",[id(4)]))[0].n,expectedGains);
}

test("full canonical advance50: unchanged resident TPs reach ARM wait and reconcile with every gate intact",async t=>{
  const f=await createFullAdvanceFixture();t.after(()=>f.close());
  const result=await f.advance();
  console.log(JSON.stringify({scenario:"FULL50_RESIDENT_TP",result,report:f.report()}));
  assert.equal(result.status,"OK");
  assert.equal(f.report().posts,0);assert.equal(f.report().deletes,0);assert.deepEqual(f.metrics.sqlErrors,[]);
  const run=(await f.service.query("select * from coinops.robot_v1_live_runs where id=$1",[id(6)]))[0];
  assert.equal(run.last_error,null);assert.ok(run.last_reconciled_at);assert.equal(run.lease_owner,null);
});

test("full canonical advance50 real60s cadence: global order filter and all retry layers keep request windows observable",async t=>{
  const f=await createFullAdvanceFixture({fillCount:24,fillNewBuyCount:2,newBuyFillMode:"partial",failPermissionSnapshots:40,
    failOrderQueries:[1,11,21],binanceClockOffsetMs:-1021,clockReadFailures:true,budgetWindowFailures:2,globalOrderLimit:1000});t.after(()=>f.close());
  await mixedSnapshot(f,{full:24,partial:25,prepared:true});
  const {result,passes}=await converge(f,6,{cadenceMs:60000,retryBudgetHolds:true}),report=f.report();
  console.log(JSON.stringify({scenario:"FULL50_ACTUAL_60S_CADENCE_GLOBAL_FILTER_ALL_RETRIES",result,passes,report,
    caveat:"Actual wall clock, one controller start per60s; no SQL timestamp edits and no external network. This trace is not a universal endpoint frequency proof."}));
  assert.equal(result.status,"OK");assert.equal(report.posts,5);assert.equal(report.deletes,2);
  assert.ok(passes.every(pass=>pass.report.posts<=2&&pass.report.deletes<=1));
  for(const pass of passes.filter(pass=>pass.result.code==="COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN")){
    assert.equal(pass.report.posts,0);assert.equal(pass.report.deletes,0);
  }
  assert.equal((await f.service.query("select count(*)::int n from coinops.robot_v1_live_alerts where code='COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN' and resolved_at is null"))[0].n,0);
  await assertProtectedFinal(f,24);assert.deepEqual(report.sqlErrors,[]);
});

for(const slotCount of [25,100])test(`full canonical advance${slotCount}: exact topology keeps resident TP and zero financial writes`,async t=>{
  const f=await createFullAdvanceFixture({slotCount,slotCapital:slotCount===25?11:22});t.after(()=>f.close());
  const result=await f.advance(),report=f.report();
  console.log(JSON.stringify({scenario:`FULL${slotCount}_RESIDENT_TP_REGRESSION`,result,report}));
  assert.equal(result.status,"OK");assert.equal(report.posts,0);assert.equal(report.deletes,0);
  assert.deepEqual(report.sqlErrors,[]);
  assert.equal((await f.service.query("select count(*)::int n from coinops.robot_v1_live_slots where run_id=$1",[f.run.id]))[0].n,slotCount);
});

test("full canonical advance50: all TP fills credit exactly once and create one protected successor before one NEXT BUY",async t=>{
  const f=await createFullAdvanceFixture({fillCount:50,monthlyTarget:1});t.after(()=>f.close());
  const {result,passes}=await converge(f,6),report=f.report();
  console.log(JSON.stringify({scenario:"FULL50_ALL_FILLED_SUCCESSOR",result,passes,report}));
  assert.equal(result.status,"OK");assert.equal(result.next,"NEXT_BUY_ARMED");
  assert.equal(passes[0].result.status,"RETRY");assert.equal(passes[0].report.posts,0);
  assert.equal((await f.service.query("select count(*)::int n from coinops.robot_v1_monthly_slot_gains"))[0].n,50);
  const successors=await f.service.query("select id from coinops.robot_v1_live_runs where previous_run_id=$1",[f.run.id]);
  assert.equal(successors.length,1);
  const ownOrders=await f.service.query("select * from coinops.robot_v1_live_orders where run_id=$1",[successors[0].id]);
  assert.equal(ownOrders.filter(order=>order.side==="BUY"&&["PREPARED","NEW","PARTIALLY_FILLED"].includes(order.status)).length,1);
  assert.equal(ownOrders.filter(order=>order.side==="SELL"&&order.status==="NEW").length,1);
  assert.equal(report.posts,3);assert.deepEqual(report.sqlErrors,[]);
  const before=f.beginMeasurement();assert.equal((await f.advance(successors[0].id)).status,"OK");
  assert.equal(f.report(before).posts,0);
  assert.equal((await f.service.query("select count(*)::int n from coinops.robot_v1_monthly_slot_gains"))[0].n,50);
});

test("full canonical advance50: preparedBUY plus24TP/25partial yields protected phases; two25-slot siblings execute concurrently",async t=>{
  const f=await createFullAdvanceFixture({fillCount:24,fillNewBuyCount:2});t.after(()=>f.close());
  const siblings=await Promise.all([f.addSibling(1),f.addSibling(2)]);
  const principalBefore=await f.service.query("select trading_engine_id,slot_number,balance_brl,contribution_brl,gain_count from coinops.robot_v1_live_slot_accounts where trading_engine_id<>$1 order by trading_engine_id,slot_number",[id(4)]);
  await mixedSnapshot(f,{full:24,partial:25,prepared:true});
  const settled=await Promise.allSettled([f.advance(),...siblings.map(sibling=>f.advance(sibling.runId))]);
  for(const outcome of settled)if(outcome.status==="rejected"){
    console.log(JSON.stringify({event:"OFFLINE_SIBLING_FAILURE_STATE",slots:await f.service.query("select run_id,entry_state,count(*)::int n,sum(position_quantity) position from coinops.robot_v1_live_slots group by run_id,entry_state order by run_id,entry_state"),
      gains:await f.service.query("select trading_engine_id,count(*)::int n from coinops.robot_v1_monthly_slot_gains group by trading_engine_id"),report:f.report()}));
    throw outcome.reason;
  }
  const [first,...siblingResults]=settled.map(outcome=>outcome.value);
  assert.equal(first.status,"RETRY");const {result,passes}=await converge(f);
  console.log(JSON.stringify({scenario:"FULL50_PREPARED_BUY_FOUR_POSTS_WITH_TWO25_SIBLINGS",first,result,passes,siblingResults,report:f.report()}));
  assert.equal(result.status,"OK");assert.equal(f.report().posts,5);assert.equal(f.report().deletes,0);
  await assertProtectedFinal(f,24);
  assert.ok(siblingResults.every(row=>row.status==="OK"));
  assert.deepEqual(await f.service.query("select trading_engine_id,slot_number,balance_brl,contribution_brl,gain_count from coinops.robot_v1_live_slot_accounts where trading_engine_id<>$1 order by trading_engine_id,slot_number",[id(4)]),principalBefore);
  assert.deepEqual(f.metrics.sqlErrors,[]);
});

test("full canonical advance50:25TP fills,24partialTPs, residentBUY fill, TP/NEXT and account budget converge through safe phases",async t=>{
  const f=await createFullAdvanceFixture({fillCount:25,fillNewBuyCount:1});t.after(()=>f.close());
  await mixedSnapshot(f);
  const {result,passes}=await converge(f);
  console.log(JSON.stringify({scenario:"FULL50_MIXED_25TP24PARTIAL1BUY",result,passes,report:f.report(),logs:f.logs.filter(row=>row.status>=400)}));
  assert.equal(result.status,"OK");assert.equal(result.next,"NEXT_BUY_ARMED");
  assert.equal(passes[0].result.status,"RETRY");assert.equal(passes[0].report.posts,1);
  assert.equal(f.report().posts,4);assert.equal(f.report().deletes,0);assert.deepEqual(f.metrics.sqlErrors,[]);
  await assertProtectedFinal(f,25);
  const gains=await f.service.query("select count(*)::int n from coinops.robot_v1_monthly_slot_gains");assert.equal(gains[0].n,25);
  assert.ok(f.metrics.rpc.reserve_account_order_budget>=3);assert.ok(f.metrics.rpc.record_account_order_budget_sample>=1);
});

test("full canonical advance50: internal permission503s plus three outerGET retries preserve TP, gains and account budget",async t=>{
  const f=await createFullAdvanceFixture({fillCount:25,fillNewBuyCount:1,failPermissionSnapshots:15,failOrderQueries:[1,11,21]});t.after(()=>f.close());
  await mixedSnapshot(f);
  const {result,passes}=await converge(f),report=f.report();
  console.log(JSON.stringify({scenario:"FULL50_MIXED_INTERNAL_PERMISSION_AND_3_OUTER_RETRIES",result,passes,report}));
  assert.equal(result.status,"OK");assert.equal(report.posts,4);assert.equal(report.deletes,0);
  await assertProtectedFinal(f,25);
  assert.equal(report.outerOrderFailures,3);assert.ok(report.snapshotPermissionFailures>=12&&report.snapshotPermissionFailures<=15);
  assert.deepEqual(report.sqlErrors,[]);assert.equal((await f.service.query("select count(*)::int n from coinops.robot_v1_monthly_slot_gains"))[0].n,25);
});

test("full canonical advance50 worst branch: two partialBUYs cancel safely and keep both TPs under real retry budgets",async t=>{
  const f=await createFullAdvanceFixture({fillCount:24,fillNewBuyCount:2,newBuyFillMode:"partial",failPermissionSnapshots:25,failOrderQueries:[1,11,21]});t.after(()=>f.close());
  await mixedSnapshot(f,{full:24,partial:25,prepared:true});
  const {result,passes}=await converge(f),report=f.report();
  console.log(JSON.stringify({scenario:"FULL50_WORST_FOUR_POST_TWO_DELETE_PERMISSION_AND_OUTER_RETRIES",result,passes,report,
    caveat:"Combined immediate controller retries are not a normal60s cron cadence; per-pass profiles are separate."}));
  assert.equal(result.status,"OK");assert.equal(report.posts,5);assert.equal(report.deletes,2);assert.equal(report.outerOrderFailures,3);
  assert.equal(passes[0].result.status,"RETRY");assert.equal(passes[0].report.posts,2);assert.equal(passes[0].report.deletes,1);
  assert.ok(passes.every(pass=>pass.report.posts<=2&&pass.report.deletes<=1));
  await assertProtectedFinal(f,24);
  assert.deepEqual(report.sqlErrors,[]);
});

for(const [rpc,count] of [["sync_robot_v1_live_order",17],["credit_robot_v1_live_closed_slot",17]])
test(`full canonical advance50: abrupt worker interruption after durable ${rpc}17 resumes without duplicate finances`,async t=>{
  const f=await createFullAdvanceFixture({fillCount:50,interruptAfter:{rpc,count}});t.after(()=>f.close());
  if(rpc==="credit_robot_v1_live_closed_slot")assert.equal((await f.advance()).code,"COINOPS_LIVE_RECONCILIATION_PROGRESS");
  const oldWorker=f.advance();
  const stopped=await Promise.race([f.waitForInterruption(),oldWorker.then(result=>assert.fail(`Worker returned before interruption: ${JSON.stringify(result)}`))]);
  assert.equal(stopped.rpc,rpc);
  await f.restartAfterInterruption();
  const {result,passes}=await converge(f,6),report=f.report();
  console.log(JSON.stringify({scenario:`FULL50_ABRUPT_${rpc.toUpperCase()}`,stopped,result,passes,report,
    caveat:"Provider-fenced abrupt web-worker loss; not a real OS kill or provider-write failure. Only fixture lease expires for takeover."}));
  assert.equal(result.status,"OK");assert.equal((await f.service.query("select count(*)::int n from coinops.robot_v1_monthly_slot_gains"))[0].n,50);
  assert.equal((await f.service.query("select count(distinct exchange_trade_id)::int n from coinops.robot_v1_live_fills where order_id in (select id from coinops.robot_v1_live_orders where side='SELL')"))[0].n,50);
  const successors=await f.service.query("select id from coinops.robot_v1_live_runs where previous_run_id=$1",[f.run.id]);assert.equal(successors.length,1);
  const activeBuys=await f.service.query("select * from coinops.robot_v1_live_orders where run_id=$1 and side='BUY' and status in ('PREPARED','NEW','PARTIALLY_FILLED')",[successors[0].id]);
  assert.equal(activeBuys.length,1);assert.equal(report.posts,3);assert.deepEqual(report.sqlErrors,[]);
  await assertProtectedFinal(f,50);
});

for(const reuseFeeQuoteFor25 of [false,true])test(`full advance50 sibling25 TP bursts retain account budget and gain ownership; candidateFeeReuse25=${reuseFeeQuoteFor25}`,async t=>{
  const f=await createFullAdvanceFixture({fillCount:24,fillNewBuyCount:1,reuseFeeQuoteFor25});t.after(()=>f.close());
  const siblings=[await f.addSibling(1,{fillCount:25}),await f.addSibling(2,{fillCount:25})];
  await mixedSnapshot(f,{full:24,partial:25,prepared:true});
  const baseline=f.beginMeasurement();
  const settled=await Promise.allSettled([f.advance(),...siblings.map(sibling=>f.advance(sibling.runId))]);
  for(const outcome of settled)if(outcome.status==="rejected"){
    console.log(JSON.stringify({event:"OFFLINE_SIBLING_BURST_FAILURE_STATE",slots:await f.service.query("select run_id,entry_state,count(*)::int n,sum(position_quantity) position from coinops.robot_v1_live_slots group by run_id,entry_state order by run_id,entry_state"),
      remaining:await f.service.query("select s.run_id,s.slot_number,s.entry_state,s.operation_sequence,s.last_credited_sell_client_order_id,o.side,o.status,o.executed_quantity,o.trades_reconciled,o.operation_sequence order_sequence,o.client_order_id from coinops.robot_v1_live_slots s join coinops.robot_v1_live_orders o on o.slot_id=s.id where s.entry_state='OPEN' and s.run_id<>$1 order by s.run_id,s.slot_number,o.side",[f.run.id]),
      gains:await f.service.query("select trading_engine_id,count(*)::int n from coinops.robot_v1_monthly_slot_gains group by trading_engine_id"),report:f.report()}));
    throw outcome.reason;
  }
  const initialResults=settled.map(outcome=>outcome.value),results=[...initialResults];
  for(let index=1;index<results.length;index++)for(let retry=0;retry<3&&results[index].status==="RETRY"
    &&results[index].code==="COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN";retry++){
    // A budget hold is not proof of TP protection. Resume the exact persisted
    // successor through the normal engine after real cooldown, then assert it.
    await new Promise(resolve=>setTimeout(resolve,6000));
    results[index]=await f.advance(results[index].continuation.at(-1).runId);
  }
  const report=f.report(baseline);
  console.log(JSON.stringify({scenario:"FULL50_WITH_TWO25_CONCURRENT_TP_BURSTS",initialResults,results,report}));
  assert.equal(results[0].status,"RETRY");assert.ok(results.slice(1).every(result=>result.status==="OK"));
  const gains=await f.service.query("select trading_engine_id,count(*)::int n from coinops.robot_v1_monthly_slot_gains group by trading_engine_id order by trading_engine_id");
  assert.deepEqual(gains,siblings.map(sibling=>({trading_engine_id:sibling.engineId,n:25})));
  for(const sibling of siblings){
    const activeRuns=await f.service.query("select id,last_error from coinops.robot_v1_live_runs where trading_engine_id=$1 and status='ACTIVE'",[sibling.engineId]);
    assert.equal(activeRuns.length,1);assert.equal(activeRuns[0].last_error,null);
    const activeOrders=await f.service.query("select * from coinops.robot_v1_live_orders where run_id=$1 and status in ('NEW','PARTIALLY_FILLED')",[activeRuns[0].id]);
    assert.equal(activeOrders.filter(order=>order.side==="BUY").length,1);assert.equal(activeOrders.filter(order=>order.side==="SELL").length,1);
  }
  assert.deepEqual(report.sqlErrors,[]);
});

for(const globalOrderLimit of [null,1000])test(`full canonical advance50 bound: partialBUY, clock drift, permission503, outerGET, two invalid windows; globalFilter=${globalOrderLimit!==null}`,async t=>{
  const f=await createFullAdvanceFixture({fillCount:24,fillNewBuyCount:2,newBuyFillMode:"partial",failPermissionSnapshots:40,
    failOrderQueries:[1,11,21],binanceClockOffsetMs:-1021,clockReadFailures:true,budgetWindowFailures:2,globalOrderLimit});t.after(()=>f.close());
  await mixedSnapshot(f,{full:24,partial:25,prepared:true});
  const {result,passes}=await converge(f,6,{retryBudgetHolds:true}),report=f.report();
  console.log(JSON.stringify({scenario:"FULL50_BOUND_INTERNAL_CLOCK_PERMISSION_OUTER_AND_BUDGET_WINDOWS",result,passes,report,
    caveat:"Full provider -1021 responses and actual10s counter-window crossings; immediate controller retries do not establish normal cron cadence."}));
  assert.equal(result.status,"OK");assert.ok(report.clockReadFailures>0);assert.equal(report.outerOrderFailures,3);
  assert.equal(report.posts,5);assert.equal(report.deletes,2);
  assert.ok(passes.every(pass=>pass.report.posts<=2&&pass.report.deletes<=1));
  for(const pass of passes.filter(pass=>pass.result.code==="COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN")){
    assert.equal(pass.report.posts,0);assert.equal(pass.report.deletes,0);
  }
  assert.equal((await f.service.query("select count(*)::int n from coinops.robot_v1_live_alerts where code='COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN' and resolved_at is null"))[0].n,0);
  await assertProtectedFinal(f,24);
  assert.deepEqual(report.sqlErrors,[]);
});

test("full canonical advance50: fourth transient GET yields a typed checkpoint and next worker converges without Watchdog or duplicate order",async t=>{
  const f=await createFullAdvanceFixture({fillCount:50,failOrderQueries:[1,11,21,31]});t.after(()=>f.close());
  const first=await f.advance();assert.equal(first.status,"RETRY");assert.equal(first.code,"COINOPS_LIVE_TRANSIENT_EXECUTOR_READ");
  const before=f.requests.length;await new Promise(resolve=>setTimeout(resolve,25));assert.equal(f.requests.length,before,"Late provider work after lease release");
  assert.equal(f.report().posts,0);
  const {result,passes}=await converge(f,6);assert.equal(result.status,"OK");await assertProtectedFinal(f,50);
  console.log(JSON.stringify({scenario:"FULL50_FOURTH_GET_EXHAUSTION_AND_RESTART",first,result,passes,report:f.report()}));
  assert.deepEqual(f.metrics.sqlErrors,[]);
});
