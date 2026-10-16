import assert from "node:assert/strict";
import { test } from "node:test";
import { createHundredFillFixture, reconcilePhase } from "./hundred-fills-reconciliation.test.mjs";
import { LiveReadUnavailable } from "../../apps/web/lib/execution/live-read-error.ts";
import { planStrategyNextEntry } from "../../apps/web/lib/execution/strategy-engine.ts";

// Exact requested topology/economics. This is an in-memory SQL/exchange fixture,
// not Binance LIVE, runtime capacity approval or an activation smoke.
const options={slotCount:50,slotCapital:22,normalSpacingRate:.02,postAthSpacingRate:.03,gainRate:.03,monthlyTarget:3};
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const ownAccounts=`trading_engine_id='${id(4)}'`;
const gains=f=>f.query("select count(*)::int n from coinops.robot_v1_monthly_slot_gains").then(rows=>rows[0].n);
const settled=f=>f.query("select count(*)::int n from coinops.robot_v1_live_fills").then(rows=>rows[0].n);
const assertSibling=async f=>assert.equal(JSON.stringify(await f.query(`select * from coinops.robot_v1_live_slot_accounts where trading_engine_id='${id(5)}' order by slot_number`)),f.beforeSibling);
const assertReadOnly=f=>assert.ok(f.requests.length>0&&f.requests.every(row=>row.method==="GET"),"observation/settlement cannot create or cancel orders");
const credit=async(f,rows)=>f.api.creditClosedSlots(f.service,f.run,rows??await f.api.runRows(f.service,f.run),await f.state());

test("50 exact slots of R$22: simultaneous TP fills settle/gain exactly once; engine and sibling stay isolated",async t=>{
  const f=await createHundredFillFixture(options);t.after(()=>f.db.close());
  assert.equal(f.run.engine.slot_count,50);assert.equal(f.run.engine.hard_cap_quote,1100);
  assert.equal(Number(f.run.slot_notional_brl),22);assert.equal(Number(f.run.entry_spacing),.02);
  assert.equal(Number(f.run.gain_rate),.03);assert.equal(f.run.config_snapshot.post_ath_spacing_rate,.03);
  assert.equal(f.run.config_snapshot.monthly_target,3);
  assert.equal((await f.query(`select monthly_target from coinops.robot_v1_live_preparations where trading_engine_id='${id(4)}'`))[0].monthly_target,3);
  const baseline=structuredClone(f.metrics);
  const rows=await reconcilePhase(f),phaseMetrics=structuredClone(f.metrics),phaseWeights=f.totals();
  for(const key of ["sql","sync","credit","renew","ackCalls","completeCalls","modeledLatencyMs"])phaseMetrics[key]-=baseline[key];
  assert.equal(rows.slots.length,50);assert.deepEqual(rows.slots.map(row=>row.slot_number).sort((a,b)=>a-b),Array.from({length:50},(_,i)=>i+1));
  assert.equal(rows.slots.filter(row=>Number(row.position_quantity)===0).length,50);
  assert.equal(rows.orders.filter(row=>row.side==="SELL"&&row.status==="FILLED"&&row.trades_reconciled).length,50);
  await credit(f,rows);await credit(f);await reconcilePhase(f);await credit(f);
  assert.equal(await settled(f),100);assert.equal(await gains(f),50);
  assert.deepEqual((await f.query(`select sum(gain_count)::int gains,sum(balance_brl)::numeric balance from coinops.robot_v1_live_slot_accounts where ${ownAccounts}`))[0],
    {gains:50,balance:"1132.99975000"});
  assert.equal((await f.query("select count(*)::int n from coinops.robot_v1_strategy_decisions where result='COMPLETED' and action_type='CREATE_TP'"))[0].n,50);
  const foreign={...f.engine,id:id(5),trading_engine_id:id(5),slot_count:25,executor_shard_id:"executor-01"};
  const own50=rows.orders.find(row=>row.slot_number===50&&row.side==="SELL");
  await assert.rejects(f.transport(foreign).queryOrder("SOLBRL",own50.client_order_id,own50.exchange_order_id),/EXECUTOR_ORDER_NOT_OWNED/);
  await assertSibling(f);assertReadOnly(f);
  assert.ok(phaseMetrics.peakObservationsInFlight>1&&phaseMetrics.peakObservationsInFlight<=4);
  console.log(JSON.stringify({scenario:"50x22_EXACT_ACTUAL_RECONCILIATION_PHASE",phaseMetrics,phaseWeights,
    caveat:"Actual canonical observation/SQL credit/metadata only, not full ARM path or hardware capacity certificate"}));
});

test("50 slots: crashes after durable fill17 and gain17 resume without duplicate financial effects",async t=>{
  for(const crash of [{crashAfterSync:17},{crashAfterCredit:17}]){
    const f=await createHundredFillFixture({...options,...crash});t.after(()=>f.db.close());
    if(crash.crashAfterSync)await assert.rejects(reconcilePhase(f),/SIMULATED_PROCESS_EXIT_AFTER_DURABLE_SYNC/);
    const rows=await reconcilePhase(f);
    if(crash.crashAfterCredit){
      await assert.rejects(credit(f,rows),/SIMULATED_PROCESS_EXIT_AFTER_DURABLE_CREDIT/);
      assert.equal(await gains(f),17);
    }
    await credit(f);await credit(f);
    assert.equal(await settled(f),100);assert.equal(await gains(f),50);
    assert.equal((await f.query(`select sum(gain_count)::int n from coinops.robot_v1_live_slot_accounts where ${ownAccounts}`))[0].n,50);
    await assertSibling(f);assertReadOnly(f);
  }
});

test("50 slots: three intermittent503s converge; fourth drains workers and safely resumes next invocation",async t=>{
  for(const transientQuerySlots of [[1,25,50],[1,11,21,31]]){
    const f=await createHundredFillFixture({...options,transientQuerySlots});t.after(()=>f.db.close());
    if(transientQuerySlots.length===4){
      await assert.rejects(reconcilePhase(f),error=>error instanceof LiveReadUnavailable&&error.path==="/v1/observe-order");
      const before={sql:f.metrics.sql,requests:f.requests.length};
      await new Promise(resolve=>setTimeout(resolve,40));
      assert.equal(f.metrics.sql,before.sql);assert.equal(f.requests.length,before.requests);
      assert.equal(f.metrics.observationsInFlight,0);assert.equal(await gains(f),0);
      const durable=await settled(f);assert.ok(durable>50&&durable<100);
    }
    await credit(f,await reconcilePhase(f));await credit(f);
    assert.equal(await settled(f),100);assert.equal(await gains(f),50);
    await assertSibling(f);assertReadOnly(f);
    console.log(JSON.stringify({scenario:`50_SLOTS_${transientQuerySlots.length}_TRANSIENT_503S`,weights:f.totals(),metrics:f.metrics,
      caveat:"Fourth transient intentionally defers remaining observations; this is not all retries converging inside one invocation"}));
  }
});

test("50 slots: partial TP fills remain protected; later terminal fills credit once, replay never alters existing TP ownership",async t=>{
  const f=await createHundredFillFixture({...options,fillCount:25});t.after(()=>f.db.close());
  const pending=[...f.exchange.values()].filter(row=>row.side==="SELL"&&row.status==="NEW");
  const trade=(order,part)=>({id:Number(order.orderId)+part*100000,orderId:order.orderId,
    qty:".022",quoteQty:"11.33",commission:".000000005",commissionAsset:"BNB",isBuyer:false,time:Date.now()});
  for(const row of pending){row.status="PARTIALLY_FILLED";row.executedQty=".022";row.cummulativeQuoteQty="11.33";row.trades=[trade(row,1)];}
  let rows=await reconcilePhase(f);
  assert.equal(rows.slots.filter(row=>Number(row.position_quantity)>0).length,25);
  assert.equal(rows.orders.filter(row=>row.side==="SELL"&&row.status==="PARTIALLY_FILLED").length,25);
  const tpIdentities=rows=>rows.map(row=>[row.id,row.client_order_id,row.exchange_order_id]).sort((a,b)=>a[0].localeCompare(b[0]));
  const liveTPs=tpIdentities(rows.orders.filter(row=>row.side==="SELL"&&row.status==="PARTIALLY_FILLED"));
  await f.api.ensureTakeProfits(f.service,f.run,rows,await f.state());await credit(f,rows);
  assert.equal(await gains(f),25);assert.equal(await settled(f),100);
  for(const row of pending){row.status="FILLED";row.executedQty=".044";row.cummulativeQuoteQty="22.66";row.trades.push(trade(row,2));}
  rows=await reconcilePhase(f);await credit(f,rows);await credit(f);
  assert.equal(await gains(f),50);assert.equal(await settled(f),125);
  assert.deepEqual(tpIdentities(rows.orders.filter(row=>row.side==="SELL"&&row.slot_number>25)),liveTPs);
  assert.equal(rows.slots.filter(row=>Number(row.position_quantity)>0).length,0);
  await assertSibling(f);assertReadOnly(f);
});

test("50 slots: canceled partial TP is not mistaken for protected terminal success",async t=>{
  const f=await createHundredFillFixture({...options,fillCount:49,progressCheckpoint:true,clockFollowsModel:false});t.after(()=>f.db.close());
  const row=[...f.exchange.values()].find(row=>row.side==="SELL"&&row.status==="NEW");
  row.status="CANCELED";row.executedQty=".022";row.cummulativeQuoteQty="11.33";
  await reconcilePhase(f);
  assert.equal((await f.query("select count(*)::int n from coinops.robot_v1_live_slots where position_quantity>0"))[0].n,1);
  await assert.rejects(f.api.checkpointLargeEngineProgress(f.service,f.run,f.clockNow()-120001,"CREDIT_SLOTS"),/COINOPS_LIVE_OPEN_WITHOUT_RESIDENT_TP/);
  assert.equal((await f.query(`select reconciliation_checkpoint from coinops.robot_v1_live_runs where id='${id(6)}'`))[0].reconciliation_checkpoint,null);
  await assertSibling(f);assertReadOnly(f);
});

test("50 slots: realSQL checkpoint preserves17 then33 credits and never manufactures full reconciliation freshness",async t=>{
  const f=await createHundredFillFixture({...options,progressCheckpoint:true,clockFollowsModel:false});t.after(()=>f.db.close());
  const rows=await reconcilePhase(f);
  assert.equal(await f.api.checkpointLargeEngineProgress(f.service,f.run,f.clockNow(),"CREDIT_SLOTS",true),true);
  const first=(await f.query(`select reconciliation_checkpoint,last_reconciled_at from coinops.robot_v1_live_runs where id='${id(6)}'`))[0];
  assert.equal(first.last_reconciled_at,null);assert.equal(first.reconciliation_checkpoint.slot_count,50);
  assert.equal(first.reconciliation_checkpoint.settled_orders,100);assert.equal(first.reconciliation_checkpoint.credited_gains,0);
  assert.equal(await f.api.checkpointLargeEngineProgress(f.service,f.run,f.clockNow()-120001,"CREDIT_SLOTS"),true);
  assert.deepEqual((await f.query(`select reconciliation_checkpoint from coinops.robot_v1_live_runs where id='${id(6)}'`))[0].reconciliation_checkpoint,first.reconciliation_checkpoint);
  let completed=0;
  assert.equal(await f.api.creditClosedSlots(f.service,f.run,rows,await f.state(),()=>++completed===17
    ? f.api.checkpointLargeEngineProgress(f.service,f.run,f.clockNow()-120001,"CREDIT_SLOTS") : false),true);
  assert.equal(completed,17);assert.equal(await gains(f),17);
  const second=(await f.query(`select reconciliation_checkpoint,last_reconciled_at from coinops.robot_v1_live_runs where id='${id(6)}'`))[0];
  assert.equal(second.last_reconciled_at,null);assert.equal(second.reconciliation_checkpoint.credited_gains,17);
  assert.equal(second.reconciliation_checkpoint.started_at,first.reconciliation_checkpoint.started_at);
  await credit(f);await credit(f);assert.equal(await gains(f),50);assert.equal(await settled(f),100);
  await f.api.release(f.service,f.run,null,true);
  const final=(await f.query(`select reconciliation_checkpoint,last_reconciled_at,lease_owner from coinops.robot_v1_live_runs where id='${id(6)}'`))[0];
  assert.equal(final.reconciliation_checkpoint,null);assert.ok(final.last_reconciled_at);assert.equal(final.lease_owner,null);
  await assertSibling(f);assertReadOnly(f);
});

test("50 slots: canonical lease exclusion and NEXTBUY planner keep one decision, not50 orders",async t=>{
  const f=await createHundredFillFixture({...options,fillCount:0,clockFollowsModel:false});t.after(()=>f.db.close());
  assert.equal(await f.api.claim(f.service,f.run.id),null);
  await f.query(`update coinops.robot_v1_live_runs set lease_until=now()-interval '1 second' where id='${id(6)}'`);
  const order=(await f.api.runRows(f.service,f.run)).orders.find(row=>row.side==="SELL");order.status="PARTIALLY_FILLED";
  await assert.rejects(f.api.reconcileOrder(f.service,f.run,order),/COINOPS_LIVE_LEASE_LOST/);
  const claims=await Promise.all([f.api.claim(f.service,f.run.id),f.api.claim(f.service,f.run.id)]);
  assert.equal(claims.filter(Boolean).length,1);
  const candidates=Array.from({length:50},(_,i)=>({id:`slot-${i+1}`,slotNumber:i+1,operationSequence:1,buyPrice:500*.98**i,
    balanceQuote:22,operationalRank:i+1,monthlyTargetReached:false,state:"PLANNED"}));
  const plan=planStrategyNextEntry({asset:"SOL",cycleId:f.run.id,observedAt:new Date().toISOString(),quoteAsset:"BRL",slotCount:50},candidates,490);
  assert.equal(plan.decision.action_type,"ARM_NEXT_BUY");assert.equal(plan.decisions,undefined);
  await assertSibling(f);assertReadOnly(f);
});
