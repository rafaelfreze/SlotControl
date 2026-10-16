import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// Actual PostgreSQL engine compiled to WASM, in memory only. No network, env
// credentials, Supabase connection, persistent financial data or LIVE writes.
const requireFixture=createRequire(new URL('../../tools/testing/account-pause-sql/package.json',import.meta.url));
const {PGlite}=requireFixture('@electric-sql/pglite');
const db=new PGlite();
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const targetSha='a'.repeat(40),runtimeSha='b'.repeat(64),policyVersion='capacity-v3-20260930';
const scenarios=Object.fromEntries(['STEADY','ALL_TP_FILL_BURST','TRANSIENT_RETRIES','SIBLING_LOAD','CPU_RAM','RECONCILIATION_BACKLOG','QUEUE_AND_RATE_LIMIT'].map(s=>[s,'PASS']));
// Synthetic reviewed evidence for exercising gates; NOT an actual fleet or
// Binance workload certificate. Deliberately non-linear: 75 uses two units.
const workload={contract:'SLOT_WORKLOAD_V1',environment:'REAL',target_sha:targetSha,runtime_sha256:runtimeSha,policy_version:policyVersion,
 profiles:[{slot_count:50,capacity_units:2,upper_bound_weight_per_minute:1700},{slot_count:75,capacity_units:2,upper_bound_weight_per_minute:1750},
 {slot_count:100,capacity_units:4,upper_bound_weight_per_minute:3000}].map(p=>({...p,status:'PASS',evidence_sha256:'c'.repeat(64),scenarios}))};
const q=async sql=>(await db.query(sql)).rows;
const rpc=async sql=>(await q(sql))[0].v;
const engine=(n,count=25,account=2,shard='executor-02')=>`insert into coinops.trading_engines
 (id,operator_id,exchange_account_id,environment,symbol,base_asset,quote_asset,status,kill_switch,hard_cap_quote,executor_shard_id,config,slot_count)
 values('${id(n)}','${id(1)}','${id(account)}','REAL','SOLBRL','SOL','BRL','ACTIVE',false,${count*11},'${shard}','{"slot_count":${count}}',${count});`;
const preparation=(n,count=25,account=2)=>`insert into coinops.robot_v1_live_preparations
 (product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,asset,symbol,quote_asset,slot_count,monthly_target,
 configured_live_capital_brl,max_order_notional_brl,max_total_exposure_brl)
 values('${id(90)}','${id(91)}','${id(3)}','${id(1)}','${id(account)}','${id(n)}','SOL','SOLBRL','BRL',${count},3,${count*11},${count*11},${count*11});`;
const run=(n,count=25,account=2)=>`insert into coinops.robot_v1_live_runs
 (id,operator_id,exchange_account_id,trading_engine_id,product_id,tenant_id,user_id,asset,symbol,quote_asset,status,anchor_price,
 slot_notional_brl,gain_rate,entry_spacing,entry_regime,config_version,config_snapshot,strategy_version)
 values('${id(n+100)}','${id(1)}','${id(account)}','${id(n)}','${id(90)}','${id(91)}','${id(3)}','SOL','SOLBRL','BRL',
 'PREPARING',500,11,.03,.01,'NORMAL',1,'{"slot_count":${count}}','4.3.1');`;
const accounts=(n,count=25,account=2)=>`insert into coinops.robot_v1_live_slot_accounts
 (product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,asset,quote_asset,slot_number)
 select '${id(90)}','${id(91)}','${id(3)}','${id(1)}','${id(account)}','${id(n)}','SOL','BRL',s from generate_series(1,${count})s;`;
const slots=(n,count=25)=>`insert into coinops.robot_v1_live_slots(run_id,product_id,tenant_id,user_id,slot_number,operational_rank)
 select '${id(n+100)}','${id(90)}','${id(91)}','${id(3)}',s,s from generate_series(1,${count})s;`;
const seed=n=>`select coinops.seed_robot_v1_live_slot_accounts('${id(n+100)}',(select jsonb_agg(11) from generate_series(1,(select slot_count from coinops.trading_engines where id='${id(n)}')))) as v`;
before(async()=>{
 await db.exec(readFileSync(new URL('./configurable_engine_slots_fixture.sql',import.meta.url),'utf8'));
 await db.exec(`insert into coinops.operators(id,user_id,product_id,tenant_id,status,kill_switch)
  values('${id(1)}','${id(3)}','${id(90)}','${id(91)}','ACTIVE',false);
  insert into coinops.exchange_accounts(id,operator_id,display_name,status,kill_switch,executor_profile,credential_ref)
  values('${id(2)}','${id(1)}','Synthetic','ACTIVE',false,'coinops-fixed-ip','account_${id(2).replaceAll('-','')}');
  insert into coinops.trading_engines(id,operator_id,exchange_account_id,environment,symbol,base_asset,quote_asset,status,kill_switch,config)
  values('${id(4)}','${id(1)}','${id(2)}','REAL','SOLBRL','SOL','BRL','ACTIVE',false,'{"slot_count":25}');`);
 await db.exec(readFileSync(new URL('../migrations/20261016161550_configurable_live_engine_slots.sql',import.meta.url),'utf8'));
 await db.exec(`insert into coinops.executor_admission_release values(true,'${targetSha}','${runtimeSha}','v24.21.0','${policyVersion}',now());
  insert into coinops.executor_admission_attestations(shard_id,target_sha,runtime_sha256,node_version,policy_version,verified_at,evidence)
  values('executor-03','${targetSha}','${runtimeSha}','v24.21.0','${policyVersion}',now(),'{"slot_workload":${JSON.stringify(workload)}}');`);
 await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
});
after(async()=>{await db.close()});

test('legacy migration backfills default25 without changing strategy or engine identity',async()=>{
 const e=(await q(`select slot_count,config,id from coinops.trading_engines where id='${id(4)}'`))[0];
 assert.equal(e.slot_count,25);assert.deepEqual(e.config,{slot_count:25});assert.equal(e.id,id(4));
 for(const n of [1,101])await assert.rejects(db.exec(engine(500+n,n)),/slot_count|TOPOLOGY/);
 await assert.rejects(db.exec(`update coinops.trading_engines set slot_count=100 where id='${id(4)}'`),/IMMUTABLE/);
 await assert.rejects(db.exec(`update coinops.trading_engines set config='{"slot_count":100}' where id='${id(4)}'`),/TOPOLOGY/);
});
test('25,50,75,100 physical slot sets seed transactionally and replay without changing money',async()=>{
 for(const [n,count]of [[10,25],[11,50],[12,75],[13,100]]){
  await db.exec(engine(n,count)+preparation(n,count)+run(n,count)+accounts(n,count)+slots(n,count));
  assert.equal((await q(`select slot_count from coinops.robot_v1_live_runs where id='${id(n+100)}'`))[0].slot_count,count);
  assert.deepEqual(await rpc(seed(n)),{seeded_count:count,replayed:false});
  assert.deepEqual(await rpc(seed(n)),{seeded_count:count,replayed:true});
  const row=(await q(`select count(*)::int n,sum(balance_brl) total from coinops.robot_v1_live_slot_accounts where trading_engine_id='${id(n)}'`))[0];
  assert.equal(row.n,count);assert.equal(Number(row.total),count*11);
 }
});
test('per-engine upper bounds, run ownership and stale/mismatched snapshots fail closed',async()=>{
 await assert.rejects(db.exec(`insert into coinops.robot_v1_live_slot_accounts(trading_engine_id,operator_id,exchange_account_id,slot_number) values('${id(10)}','${id(1)}','${id(2)}',26)`),/OUT_OF_RANGE/);
 await assert.rejects(db.exec(`update coinops.robot_v1_live_slots set trading_engine_id='${id(10)}',slot_number=99 where run_id='${id(113)}' and slot_number=100`),/SCOPE_DENIED/);
 await assert.rejects(db.exec(`update coinops.robot_v1_live_runs set slot_count=25 where id='${id(113)}'`),/IMMUTABLE/);
 await assert.rejects(db.exec(`update coinops.robot_v1_live_runs set config_snapshot='{"slot_count":25}' where id='${id(113)}'`),/TOPOLOGY/);
 await assert.rejects(db.exec(`update coinops.robot_v1_live_preparations set slot_count=100 where trading_engine_id='${id(10)}'`),/IMMUTABLE/);
});
test('seed rejects incomplete, noncent, changed or already active financial state without partial updates',async()=>{
 for(const [n,count]of [[14,100],[15,25]])await db.exec(engine(n,count)+preparation(n,count)+run(n,count)+accounts(n,count));
 await db.exec(`delete from coinops.robot_v1_live_slot_accounts where trading_engine_id='${id(14)}' and slot_number=100`);
 await assert.rejects(q(seed(14)),/SLOT_COUNT_INVALID/);
 assert.equal(Number((await q(`select sum(balance_brl) total from coinops.robot_v1_live_slot_accounts where trading_engine_id='${id(14)}'`))[0].total),0);
 await assert.rejects(q(`select coinops.seed_robot_v1_live_slot_accounts('${id(115)}','[1.001]')`),/SEED_GATE/);
 await db.exec(`update coinops.robot_v1_live_slot_accounts set fees_brl=.01 where trading_engine_id='${id(15)}' and slot_number=1`);
 await assert.rejects(q(seed(15)),/EXISTING_FINANCIAL_STATE/);
});
test('same account/symbol cross-shard engines retain separate slots, runs and principal',async()=>{
 await db.exec(engine(16,100,2,'executor-03')+preparation(16,100)+run(16,100)+accounts(16,100)+slots(16,100));
 await rpc(seed(16));
 assert.equal((await q(`select count(distinct run_id)::int n from coinops.robot_v1_live_slots where trading_engine_id in('${id(13)}','${id(16)}')`))[0].n,2);
 await db.exec(`update coinops.robot_v1_live_slot_accounts set balance_brl=12 where trading_engine_id='${id(16)}' and slot_number=100`);
 assert.equal(Number((await q(`select balance_brl from coinops.robot_v1_live_slot_accounts where trading_engine_id='${id(13)}' and slot_number=100`))[0].balance_brl),11);
});
test('mixed slot order footprints and reviewed exact-count capacity profiles stay distinct',async()=>{
 assert.equal(Number(await rpc(`select private.coinops_symbol_order_footprint('[25,100]') as v`)),127);
 assert.equal(Number(await rpc(`select private.coinops_symbol_order_footprint('2') as v`)),52);
 await assert.rejects(q(`select private.coinops_symbol_order_footprint('[101]')`),/INVALID_PROJECTION/);
 const p=await rpc(`select coinops.preview_engine_slot_admission('executor-03','REAL',array[25,100]) as v`);
 assert.equal(p.capacity_units,5);assert.equal(p.requested_units,5);
 assert.equal((await rpc(`select coinops.preview_engine_slot_admission('executor-03','REAL',array[75]) as v`)).capacity_units,2);
 assert.equal((await rpc(`select coinops.preview_engine_slot_admission('executor-03','REAL',array[50]) as v`)).capacity_units,2);
 await db.exec(`select set_config('coinops.test.capacity','deny',false)`);
 assert.equal((await rpc(`select coinops.preview_engine_slot_admission('executor-03','REAL',array[100]) as v`)).code,'CAPACITY_REQUIRED');
 await db.exec(`select set_config('coinops.test.capacity','',false)`);
});
test('missing/extraneous/foreign workload evidence cannot certify any non25 slot count',async()=>{
 const preview=(count=100,shard='executor-03')=>`select coinops.preview_engine_slot_admission('${shard}','REAL',array[${count}]) as v`;
 for(const [count,shard]of [[100,'executor-02'],[51,'executor-03'],[2,'executor-03']]){
  const p=await rpc(preview(count,shard));assert.equal(p.code,'CAPACITY_UNKNOWN');assert.equal(p.reason,'SLOT_WORKLOAD_UNCERTIFIED');
 }
 assert.equal((await rpc(preview(25,'executor-02'))).code,'CAPACITY_OK');
 const mutations=[
  `evidence-'slot_workload'`,
  `jsonb_set(evidence,'{slot_workload,contract}','"OTHER_CONTRACT"')`,
  `jsonb_set(evidence,'{slot_workload,environment}','"TESTNET"')`,
  `jsonb_set(evidence,'{slot_workload,runtime_sha256}','"${'d'.repeat(64)}"')`,
  `jsonb_set(evidence,'{slot_workload,target_sha}','"${'d'.repeat(40)}"')`,
  `jsonb_set(evidence,'{slot_workload,policy_version}','"other-policy"')`,
  `jsonb_set(evidence,'{slot_workload,profiles,2,slot_count}','99')`,
  `jsonb_set(evidence,'{slot_workload,profiles,2,status}','"FAIL"')`,
  `jsonb_set(evidence,'{slot_workload,profiles,2,capacity_units}','0')`,
  `jsonb_set(evidence,'{slot_workload,profiles,2,capacity_units}','1.5')`,
  `jsonb_set(evidence,'{slot_workload,profiles,2,upper_bound_weight_per_minute}','3601')`,
  `evidence#-'{slot_workload,profiles,2,scenarios,ALL_TP_FILL_BURST}'`,
  `jsonb_set(evidence,'{slot_workload,profiles,2,scenarios,TRANSIENT_RETRIES}','"FAIL"')`,
  `jsonb_set(evidence,'{slot_workload,profiles,2,evidence_sha256}','"missing artifact"')`,
 ];
 for(const mutation of mutations){
  await db.exec(`begin; update coinops.executor_admission_attestations set evidence=${mutation} where shard_id='executor-03'`);
  const p=await rpc(preview());assert.equal(p.code,'CAPACITY_UNKNOWN',mutation);assert.equal(p.reason,'SLOT_WORKLOAD_UNCERTIFIED',mutation);
  assert.equal((await rpc(preview(25))).code,'CAPACITY_OK');await db.exec('rollback');
 }
 for(const [column,value]of [['runtime_sha256','d'.repeat(64)],['target_sha','d'.repeat(40)],['policy_version','other-policy']]){
  await db.exec(`begin; update coinops.executor_admission_release set ${column}='${value}'`);
  assert.equal((await rpc(preview())).reason,'SLOT_WORKLOAD_UNCERTIFIED');await db.exec('rollback');
 }
});
test('RLS remains enabled/forced and anonymous/foreign users cannot read or seed',async()=>{
 assert.equal((await q(`select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='coinops' and c.relname in('trading_engines','robot_v1_live_runs','robot_v1_live_slots','robot_v1_live_slot_accounts') and c.relrowsecurity and c.relforcerowsecurity`))[0].n,4);
 await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${id(3)}',false)`);
 assert.ok((await q(`select count(*)::int n from coinops.trading_engines`))[0].n>0);
 await assert.rejects(q(seed(13)),/permission denied/);
 await db.exec(`select set_config('request.jwt.claim.sub','${id(999)}',false)`);
 assert.equal((await q(`select count(*)::int n from coinops.trading_engines`))[0].n,0);
 await db.exec('reset role; set role anon');
 await assert.rejects(q(seed(13)),/permission denied/);
 await db.exec('reset role');
});

test('account order budget sums mixed engine footprints, preserves EXPIRE_TAKER and fails closed when stale',async()=>{
 await db.exec(`begin;
  insert into coinops.exchange_accounts(id,operator_id,status,kill_switch) values('${id(20)}','${id(1)}','ACTIVE',false);
  ${engine(21,25,20)}
  insert into coinops.account_executor_connections(exchange_account_id,operator_id,executor_shard_id,environment,status)
   values('${id(20)}','${id(1)}','executor-03','REAL','VALIDATED');
  insert into coinops.account_order_budget_samples(exchange_account_id,operator_id,source_shard_id,observed_at,server_time_ms,intervals,symbol_limits)
   values('${id(20)}','${id(1)}','executor-03',clock_timestamp(),extract(epoch from clock_timestamp())*1000,
   '[{"intervalMs":86400000,"limit":200000,"count":1}]',
   '{"SOLBRL":{"maxOrders":200,"openOrders":0,"externalOrders":0,"selfTradePrevention":"EXPIRE_TAKER"}}');`);
 const gate=plan=>`select private.coinops_account_order_budget_gate('${id(1)}','${id(20)}',3,'${JSON.stringify(plan)}') as v`;
 assert.equal((await rpc(gate({SOLBRL:[100]}))).code,'PASS');
 assert.equal((await rpc(gate({SOLBRL:[100,100]}))).code,'ACCOUNT_ORDER_CAPACITY_REQUIRED');
 assert.equal((await rpc(gate({SOLBRL:1}))).code,'PASS');
 await db.exec(`update coinops.account_order_budget_samples set symbol_limits=jsonb_set(symbol_limits,'{SOLBRL,selfTradePrevention}','"EXPIRE_MAKER"')`);
 assert.equal((await rpc(gate({SOLBRL:[100]}))).code,'ACCOUNT_ORDER_BUDGET_UNKNOWN');
 await db.exec('rollback');
});
test('append100 is atomic/idempotent, preserves sibling25 and reserves four explicitly attested units',async()=>{
 await db.exec(`begin;
  insert into coinops.exchange_accounts(id,operator_id,status,kill_switch,executor_profile,credential_ref,executor_shard_id)
   values('${id(30)}','${id(1)}','ACTIVE',false,'coinops-fixed-ip','account_${id(30).replaceAll('-','')}','executor-02');
  ${engine(31,25,30)}
  insert into coinops.account_quote_caps(operator_id,exchange_account_id,quote_asset,hard_cap_quote) values('${id(1)}','${id(30)}','BRL',275);
  insert into coinops.account_executor_connections(exchange_account_id,operator_id,executor_shard_id,environment,status)
   values('${id(30)}','${id(1)}','executor-03','REAL','VALIDATED');
  insert into coinops.binance_account_identity_bindings(exchange_account_id,operator_id,environment) values('${id(30)}','${id(1)}','REAL');
  insert into coinops.account_execution_policies(exchange_account_id,operator_id,status,contract,required_shards,proofs)
   values('${id(30)}','${id(1)}','ACTIVE','ENGINE_ISOLATION_V2',array['executor-02','executor-03'],'{"executor-02":true,"executor-03":true}');
  insert into coinops.executor_shards(id,enabled,incremental_engine_weight) values('executor-03',true,900);
  insert into coinops.account_order_budget_samples(exchange_account_id,operator_id,source_shard_id,observed_at,server_time_ms,intervals,symbol_limits)
   values('${id(30)}','${id(1)}','executor-03',clock_timestamp(),extract(epoch from clock_timestamp())*1000,
   '[{"intervalMs":86400000,"limit":200000,"count":1}]','{"SOLBRL":{"maxOrders":200,"openOrders":0,"externalOrders":0,"selfTradePrevention":"EXPIRE_TAKER"}}');`);
 const plan=[{asset:'SOL',capital:1100,gain:.03,spacing:.01,postAth:.02,monthlyTarget:3,slotCount:100}];
 const input={quote:'BRL',capital:1100,engines:plan,shardId:'executor-03'};
 await db.exec(`insert into coinops.account_engine_append_previews(exchange_account_id,operator_id,request_id,input,expected_account_cap,engine_inventory,observed_at,available_capital)
  values('${id(30)}','${id(1)}','${id(32)}','${JSON.stringify(input)}',275,
  '[{"id":"${id(31)}","cap":275,"shard":"executor-02"}]',clock_timestamp(),1100);`);
 const append=`select coinops.append_operator_engine_plan('${id(1)}','${id(30)}','executor-03','BRL',1100,'${JSON.stringify(plan)}','${id(32)}') as v`;
 const first=await rpc(append),second=await rpc(append);assert.deepEqual(first,second);assert.equal(first.length,1);
 const newEngine=first[0].engineId;
 assert.equal((await q(`select slot_count from coinops.trading_engines where id='${newEngine}'`))[0].slot_count,100);
 assert.equal((await q(`select count(*)::int n from coinops.robot_v1_live_slot_accounts where trading_engine_id='${newEngine}'`))[0].n,100);
 assert.equal(Number((await q(`select reserved_weight from coinops.executor_capacity_admissions where engine_id='${newEngine}'`))[0].reserved_weight),3600);
 assert.equal(Number((await q(`select hard_cap_quote from coinops.account_quote_caps where exchange_account_id='${id(30)}'`))[0].hard_cap_quote),1375);
 assert.equal((await q(`select slot_count,executor_shard_id from coinops.trading_engines where id='${id(31)}'`))[0].slot_count,25);
 assert.equal((await q(`select executor_shard_id from coinops.trading_engines where id='${id(31)}'`))[0].executor_shard_id,'executor-02');
 await db.exec('savepoint mismatched_retry');
 await assert.rejects(q(append.replace('"slotCount":100','"slotCount":50')),/REPLAY_MISMATCH/);
 await db.exec('rollback to mismatched_retry; rollback');
});
test('activation validates exact100 principal and restart creates unique100 successor without touching siblings',async()=>{
 await db.exec(`begin;
  insert into coinops.account_quote_caps(operator_id,exchange_account_id,quote_asset,hard_cap_quote) values('${id(1)}','${id(2)}','BRL',100000);
  insert into coinops.executor_shards(id,enabled,incremental_engine_weight) values('executor-02',true,900);
  insert into coinops.executor_admission_attestations(shard_id,target_sha,runtime_sha256,node_version,policy_version,verified_at,evidence)
   values('executor-02','${targetSha}','${runtimeSha}','v24.21.0','${policyVersion}',now(),'{"slot_workload":${JSON.stringify(workload)}}');
  select coinops.reserve_executor_capacity('executor-02','${id(13)}');
  select coinops.activate_robot_v1_live_cycle('${id(113)}');
  update coinops.robot_v1_live_runs set lease_owner='${id(800)}',lease_until=now()+interval '1 minute' where id='${id(113)}';`);
 assert.equal((await q(`select status from coinops.robot_v1_live_runs where id='${id(113)}'`))[0].status,'ACTIVE');
 const plans=Array.from({length:100},(_,i)=>({slot_number:i+1,operational_rank:i+1,target_buy_price:500-i,post_ath_group:i<15?'PRIMARY':'RESERVE',post_ath_group_rank:i<15?i+1:i-14}));
 const restart=`select to_jsonb(coinops.restart_robot_v1_live_cycle('${id(113)}','unique-reset-key-at-least16',500,.03,.01,'NORMAL',1,'{"slot_count":100}',null,'2026-10','${JSON.stringify(plans)}','${id(800)}')) as v`;
 const next=await rpc(restart),replay=await rpc(restart);assert.equal(next.id,replay.id);assert.equal(next.slot_count,100);
 assert.equal((await q(`select count(*)::int n from coinops.robot_v1_live_slots where run_id='${next.id}'`))[0].n,100);
 assert.equal((await q(`select status from coinops.robot_v1_live_runs where id='${id(116)}'`))[0].status,'PREPARING');
 await db.exec('rollback');
});
test('direct non25 activation cannot bypass workload proof or its own valid reservation',async()=>{
 await db.exec(`begin;
  insert into coinops.account_quote_caps(operator_id,exchange_account_id,quote_asset,hard_cap_quote) values('${id(1)}','${id(2)}','BRL',100000);
  insert into coinops.executor_shards(id,enabled,incremental_engine_weight) values('executor-02',true,900);
  savepoint missing_proof;`);
 await assert.rejects(q(`select coinops.activate_robot_v1_live_cycle('${id(113)}')`),/SLOT_WORKLOAD_UNCERTIFIED/);
 await db.exec(`rollback to missing_proof;
  insert into coinops.executor_admission_attestations(shard_id,target_sha,runtime_sha256,node_version,policy_version,verified_at,evidence)
   values('executor-02','${targetSha}','${runtimeSha}','v24.21.0','${policyVersion}',now(),'{"slot_workload":${JSON.stringify(workload)}}');
  savepoint missing_reservation;`);
 await assert.rejects(q(`select coinops.activate_robot_v1_live_cycle('${id(113)}')`),/RESERVATION_REQUIRED/);
 await db.exec(`rollback to missing_reservation;
  insert into coinops.executor_capacity_admissions(engine_id,shard_id,environment,reserved_weight,expires_at)
   values('${id(13)}','executor-02','REAL',3600,now()-interval '1 second'); savepoint expired_reservation;`);
 await assert.rejects(q(`select coinops.activate_robot_v1_live_cycle('${id(113)}')`),/RESERVATION_REQUIRED/);
 await db.exec(`rollback to expired_reservation;
  update coinops.executor_capacity_admissions set expires_at=now()+interval '1 minute',reserved_weight=900; savepoint under_reserved;`);
 await assert.rejects(q(`select coinops.activate_robot_v1_live_cycle('${id(113)}')`),/RESERVATION_REQUIRED/);
 await db.exec(`rollback to under_reserved;
  select coinops.reserve_executor_capacity('executor-02','${id(13)}');
  select coinops.activate_robot_v1_live_cycle('${id(113)}');`);
 assert.equal((await q(`select status from coinops.robot_v1_live_runs where id='${id(113)}'`))[0].status,'ACTIVE');
 // An idempotent readback is not a new activation and does not need a renewed reservation.
 await db.exec(`update coinops.executor_capacity_admissions set expires_at=now()-interval '1 second'; select coinops.activate_robot_v1_live_cycle('${id(113)}'); rollback;`);
});
test('slot100 TP preparation is idempotent and rejects a sibling engine namespace',async()=>{
 await db.exec(`begin;
  insert into coinops.account_quote_caps(operator_id,exchange_account_id,quote_asset,hard_cap_quote) values('${id(1)}','${id(2)}','BRL',100000);
  update coinops.robot_v1_live_runs set status='ACTIVE',lease_owner='${id(800)}',lease_until=now()+interval '1 minute' where id='${id(113)}';
  update coinops.robot_v1_live_preparations set live_enabled=true,kill_switch=false where trading_engine_id='${id(13)}';
  update coinops.robot_v1_live_slots set entry_state='OPEN',position_quantity=.021,position_committed_brl=11 where run_id='${id(113)}' and slot_number=100;
  insert into coinops.robot_v1_strategy_decisions(environment,cycle_id,slot_id,decision_id,product_id,tenant_id,user_id)
   select 'REAL','${id(113)}',s.id,'${'a'.repeat(64)}','${id(90)}','${id(91)}','${id(3)}' from coinops.robot_v1_live_slots s where run_id='${id(113)}' and slot_number=100;`);
 const cid=engineId=>`'C2-'||substr(encode(sha256(convert_to('${id(2)}|${id(engineId)}','UTF8')),'hex'),1,10)||'-100-S-${'b'.repeat(14)}'`;
 const prep=engineId=>`select to_jsonb(coinops.prepare_robot_v1_live_order('${id(113)}',(select id from coinops.robot_v1_live_slots where run_id='${id(113)}' and slot_number=100),'SELL','TP',1,${cid(engineId)},.021,null,540,'${'a'.repeat(64)}','${id(800)}')) as v`;
 const first=await rpc(prep(13)),retry=await rpc(prep(13));assert.equal(first.id,retry.id);assert.equal(first.slot_number,100);assert.equal(first.trading_engine_id,id(13));
 await db.exec('savepoint foreign_namespace');
 await assert.rejects(q(prep(16)),/INTENT_INVALID/);
 await db.exec('rollback to foreign_namespace; rollback');
});
test('slot100 gains, full100 contribution and presets keep individual target semantics and exact ownership',async()=>{
 await db.exec(`begin;
  insert into coinops.account_quote_caps(operator_id,exchange_account_id,quote_asset,hard_cap_quote) values('${id(1)}','${id(2)}','BRL',100000);
  update coinops.robot_v1_live_runs set status='ACTIVE',lease_until=null where id='${id(113)}';`);
 const gain=[{engineId:id(13),slotNumber:100,amount:0,gainUnits:1,balanceBefore:11,operationSequence:1,monthlyBefore:0,lifetimeBefore:0}];
 const gainRpc=request=>`select coinops.apply_live_operator_adjustment('${id(1)}','${id(2)}','${id(3)}','MANUAL_GAIN','BRL','BRL',0,0,null,null,null,'Synthetic gain','${JSON.stringify(gain)}',100000,'${id(request)}') as v`;
 assert.equal((await rpc(gainRpc(830))).status,'APPLIED');assert.equal((await rpc(gainRpc(830))).status,'REPLAYED');
 assert.equal((await q(`select count(*)::int n from coinops.robot_v1_monthly_slot_gains where trading_engine_id='${id(13)}' and slot_number=100`))[0].n,1);
 assert.equal((await q(`select gain_count from coinops.robot_v1_live_slot_accounts where trading_engine_id='${id(16)}' and slot_number=100`))[0].gain_count,0);
 await db.exec('savepoint excessive_gain_units');
 await assert.rejects(q(gainRpc(831).replace('"gainUnits":1','"gainUnits":26')),/ITEM_DENIED/);
 await db.exec('rollback to excessive_gain_units');
 const allocations=Array.from({length:100},(_,i)=>({engineId:id(13),slotNumber:i+1,amount:10,balanceBefore:11,operationSequence:1}));
 const contribute=`select coinops.apply_live_selective_contribution('${id(1)}','${id(2)}','${id(13)}','${id(3)}','BRL','BRL',1000,1000,null,'Synthetic contribution','${JSON.stringify(allocations)}',100000,'${id(832)}','${'c'.repeat(64)}') as v`;
 assert.equal((await rpc(contribute)).item_count,100);assert.equal((await rpc(contribute)).status,'REPLAYED');
 assert.equal(Number((await q(`select sum(balance_brl) total from coinops.robot_v1_live_slot_accounts where trading_engine_id='${id(13)}'`))[0].total),2100);
 const preset=await rpc(`select coinops.manage_live_selective_contribution_preset('${id(1)}','${id(3)}','CREATE',null,'Synthetic 100',100,1,99,true) as v`);
 const mark=`select coinops.mark_live_selective_contribution_preset_usage('${id(1)}','${id(3)}','${preset.id}','${id(13)}','${id(833)}',100,array(select generate_series(1,100))) as v`;
 assert.equal((await rpc(mark)).status,'RECORDED');assert.equal((await rpc(mark)).status,'REPLAYED');
 await db.exec('rollback');
});
test('both stage overloads persist count100 and individual target without replacing existing account engines',async()=>{
 await db.exec('begin');
 for(const [account,request,withEnvironment]of [[40,840,false],[41,841,true]]){
  await db.exec(`insert into coinops.exchange_accounts(id,operator_id,status,kill_switch,executor_profile,credential_ref)
   values('${id(account)}','${id(1)}','INACTIVE',true,'coinops-fixed-ip','account_${id(account).replaceAll('-','')}');
   insert into coinops.account_onboarding_checks(operator_id,exchange_account_id,check_key,status,evidence)
   values('${id(1)}','${id(account)}','BINANCE_CREDENTIAL','PASS',
   '{"environment":"REAL","status":"PASS","whitelist_accepted":true,"permission":{"spotTrading":true,"withdrawals":false}}');`);
  const plan=[{asset:'SOL',capital:1100,gain:.03,spacing:.01,postAth:.02,slotCount:100,monthlyTarget:3}];
  const staged=`select coinops.stage_operator_engine_plan('${id(1)}','${id(account)}','BRL',1100,'${JSON.stringify(plan)}','${id(request)}'${withEnvironment?",'REAL'":''}) as v`;
  const first=await rpc(staged),retry=await rpc(staged);assert.deepEqual(first,retry);assert.equal(first.length,1);
  const p=(await q(`select slot_count,monthly_target from coinops.robot_v1_live_preparations where trading_engine_id='${first[0].engineId}'`))[0];
  assert.deepEqual(p,{slot_count:100,monthly_target:3});
  assert.equal((await q(`select count(*)::int n from coinops.robot_v1_live_slot_accounts where trading_engine_id='${first[0].engineId}'`))[0].n,100);
 }
 await db.exec('rollback');
});
