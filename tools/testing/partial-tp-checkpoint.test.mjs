import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createHundredFillFixture } from "./hundred-fills-reconciliation.test.mjs";
import { postMigrationVerificationSQL } from "../operations/verify-slot-workload-migrations.mjs";
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const migration=readFileSync(new URL("../../supabase/migrations/20261016193756_prove_partial_tp_reconciliation_checkpoint.sql",import.meta.url),"utf8");
// Actual canonical SQL sync and checkpoint, local PostgreSQL/WASM only. No
// authenticated CLI, remote account, exchange, secrets or workload certificate.
async function fixture(slotCount=50,commissionAsset="BNB",commission=.00000001){
  const f=await createHundredFillFixture({slotCount,slotCapital:22,fillCount:0,progressCheckpoint:true,
    clockFollowsModel:false,sqlLatencyMs:0,exchangeLatencyMs:0});
  await f.db.exec(migration);
  const order=(await f.query("select * from coinops.robot_v1_live_orders where side='SELL' and slot_number=1"))[0];
  const trade={id:"900001",quantity:.01,quoteQuantity:5.15,commission,commissionAsset,
    filledAt:new Date().toISOString(),isBuyer:false};
  await f.service.rpc("sync_robot_v1_live_order",{p_order_id:order.id,p_exchange_order_id:order.exchange_order_id,
    p_status:"PARTIALLY_FILLED",p_executed_quantity:.01,p_cumulative_quote:5.15,p_trades:[trade],
    p_bnb_brl_price:500,p_bnb_brl_observed_at:new Date().toISOString(),p_lease_owner:f.run.lease_owner});
  const proof=async()=> (await f.query("select private.coinops_partial_tp_fills_accounted($1) v",[order.id]))[0].v;
  const checkpoint=()=>f.service.rpc("record_live_reconciliation_checkpoint",{p_run_id:f.run.id,p_lease_owner:f.run.lease_owner,
    p_phase:"CREDIT_SLOTS",p_quantity_step:.001});
  return {...f,order,proof,checkpoint};
}
test("canonical partial TP remains nonterminal/false and can checkpoint only accounted owned fills",async t=>{
  const f=await fixture();t.after(()=>f.db.close());
  assert.equal(await f.proof(),true);
  const before=(await f.query("select status,trades_reconciled,executed_quantity from coinops.robot_v1_live_orders where id=$1",[f.order.id]))[0];
  assert.equal(before.status,"PARTIALLY_FILLED");assert.equal(before.trades_reconciled,false);
  const result=await f.checkpoint();assert.equal(result.data.contract,"LARGE_ENGINE_PROGRESS_V1");
  const batch=await f.query("select coinops.prove_partial_tp_checkpoint_fills($1,$2::jsonb) v",[f.run.id,JSON.stringify(result.data)]);
  assert.equal(batch[0].v.contract,"PARTIAL_TP_FILLS_PROOF_V1");assert.equal(batch[0].v.orders.length,1);
  assert.equal(batch[0].v.orders[0].id,f.order.id);assert.equal(Number(batch[0].v.orders[0].executed_quantity),.01);
  await assert.rejects(f.query("select coinops.prove_partial_tp_checkpoint_fills($1,$2::jsonb) v",[f.run.id,JSON.stringify({...result.data,settled_orders:999})]),/COINOPS_LIVE_PARTIAL_TP_PROOF_SCOPE_DENIED/);
  const after=(await f.query("select status,trades_reconciled,executed_quantity from coinops.robot_v1_live_orders where id=$1",[f.order.id]))[0];
  assert.deepEqual(after,before);
  assert.equal((await f.query("select last_reconciled_at from coinops.robot_v1_live_runs where id=$1",[f.run.id]))[0].last_reconciled_at,null);
  assert.equal((await f.query("select count(*)::int n from coinops.robot_v1_monthly_slot_gains"))[0].n,0);
});
test("partial proof rejects missing/foreign/incomplete fills, mismatched fees, residual position and terminal or BUY exceptions",async t=>{
  const f=await fixture();t.after(()=>f.db.close());
  const mutations=[
    "delete from coinops.robot_v1_live_fills where order_id=$1",
    "update coinops.robot_v1_live_fills set quantity=quantity+.001 where order_id=$1",
    "update coinops.robot_v1_live_fills set quote_quantity=quote_quantity+.01 where order_id=$1",
    `update coinops.robot_v1_live_fills set trading_engine_id='${id(5)}' where order_id=$1`,
    "update coinops.robot_v1_live_fills set fee_fx_source='UNVERIFIED' where order_id=$1",
    "update coinops.robot_v1_live_orders set fee_other='[]' where id=$1",
    "update coinops.robot_v1_live_orders set fee_base=.0001 where id=$1",
    "update coinops.robot_v1_live_orders set fee_quote=.1 where id=$1",
    "update coinops.robot_v1_live_orders set side='BUY' where id=$1",
    "update coinops.robot_v1_live_orders set status='FILLED' where id=$1",
    "update coinops.robot_v1_live_slots set position_quantity=position_quantity+.001 where id=(select slot_id from coinops.robot_v1_live_orders where id=$1)",
  ];
  for(const sql of mutations){
    await f.query("begin");
    try{
      await f.query(sql,[f.order.id]);assert.equal(await f.proof(),false,sql);
      await assert.rejects(f.checkpoint(),/COINOPS_LIVE_LARGE_ENGINE_PROGRESS_UNSAFE/,sql);
    }finally{await f.query("rollback");}
  }
});
test("quote-denominated fees are canonical; base-fee TP overcoverage still fails safely",async t=>{
  const f=await fixture(50,"BRL",.005);t.after(()=>f.db.close());
  assert.equal(await f.proof(),true);assert.equal((await f.checkpoint()).data.slot_count,50);
  const zero=await fixture(50,"BNB",0);t.after(()=>zero.db.close());
  assert.equal(await zero.proof(),true);assert.equal((await zero.checkpoint()).data.slot_count,50);
  const base=await fixture(50,"SOL",.0001);t.after(()=>base.db.close());
  assert.equal(await base.proof(),true);
  await assert.rejects(base.checkpoint(),/COINOPS_LIVE_LARGE_ENGINE_PROGRESS_UNSAFE/,
    "SELL base fee changes residual quantity: the old resident TP is not silently certified");
});
test("legacy25 remains outside large-engine checkpoints and helper ACL is service-only",async t=>{
  const f=await fixture(25);t.after(()=>f.db.close());
  await assert.rejects(f.checkpoint(),/COINOPS_LIVE_LARGE_ENGINE_PROGRESS_SCOPE_DENIED/);
  for(const[role,allowed]of[["anon",false],["authenticated",false],["service_role",true]])
    assert.equal((await f.query("select has_function_privilege($1,'private.coinops_partial_tp_fills_accounted(uuid)','EXECUTE') v",[role]))[0].v,allowed);
});
test("single read-only post-migration verifier proves exact bodies/ACL/history and legacy25 without financial writes",async t=>{
  const f=await fixture();t.after(()=>f.db.close());
  const fingerprint=readFileSync(new URL("../../supabase/migrations/20261016192533_bind_slot_workload_web_fingerprint.sql",import.meta.url),"utf8");
  await f.db.exec(fingerprint);
  await f.db.exec(`create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text,name text);
    insert into supabase_migrations.schema_migrations values('20261016192533','bind_slot_workload_web_fingerprint'),
      ('20261016193756','prove_partial_tp_reconciliation_checkpoint'),('20261016192312','preserved_other_product');`);
  const rows=await f.db.exec(postMigrationVerificationSQL());
  const proof=rows.find(row=>row.rows?.[0]?.verification).rows[0].verification;
  assert.equal(proof.functions_pass,true,JSON.stringify(proof.functions));assert.equal(proof.migrations_pass,true);
  assert.equal(proof.transaction_read_only,"on");assert.equal(proof.legacy25.basis,"LEGACY_25_SLOT_PROFILE");
  assert.equal(proof.latest_history.length,3);
  assert.equal((await f.query("select count(*)::int n from coinops.robot_v1_monthly_slot_gains"))[0].n,0);
});
