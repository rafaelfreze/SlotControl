// Full correction SQL, isolated PostgreSQL, no provider or LIVE transport.
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {cumulativeSlotGoal} from '../../apps/web/lib/execution/cumulative-slot-goal.ts';
const require=createRequire(new URL('../testing/account-pause-sql/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const q=x=>"'"+String(x).replaceAll("'","''")+"'",j=x=>q(JSON.stringify(x))+'::jsonb';
const policy=(rate=2,anchor='2026-09-24T05:40:17.723Z')=>({policy:'CUMULATIVE_LIFETIME_V1',anchor_at:anchor,
 schedule:[{effective_period:anchor.slice(0,7),monthly_target:rate,source:'RECONCILED_FIRST_BUY_BASELINE'}]});
const read=async sql=>(await db.query(sql)).rows;
const scalar=async sql=>(await read(sql))[0].n;
const convert=async p=>scalar('select coinops.october_slot_goal_policy('+j(p)+')n');
const apply=(p=policy(),run=id(7))=>scalar(`select coinops.correct_cumulative_goal_october_start('${run}',${j(p)})n`);
const tx=fn=>async()=>{await db.exec('begin');try{await fn();}finally{await db.exec('rollback');}};
before(async()=>{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create schema coinops;
 create function auth.jwt()returns jsonb language sql as $$select jsonb_build_object('role',current_setting('request.jwt.claim.role',true))$$;
 create table coinops.operators(id uuid primary key,product_id uuid,tenant_id uuid,user_id uuid,status text,kill_switch boolean);
 create table coinops.trading_engines(id uuid primary key,operator_id uuid,exchange_account_id uuid,
 slot_count int,environment text,status text,kill_switch boolean,strategy_config_pending boolean);
 create table coinops.robot_v1_live_runs(id uuid primary key,product_id uuid,tenant_id uuid,user_id uuid,operator_id uuid,
 exchange_account_id uuid,trading_engine_id uuid,quote_asset text,slot_count int,status text,lease_owner uuid,lease_until timestamptz,
 last_error text,last_reconciled_at timestamptz,config_snapshot jsonb);
 create table coinops.robot_v1_live_preparations(id uuid primary key,product_id uuid,tenant_id uuid,user_id uuid,operator_id uuid,
 exchange_account_id uuid,trading_engine_id uuid,slot_count int,monthly_target int,config_version int,kill_switch boolean,
 live_enabled boolean,slot_goal_policy jsonb,capital numeric default 375);
 create table coinops.robot_v1_live_orders(id uuid primary key,run_id uuid,product_id uuid,tenant_id uuid,user_id uuid,operator_id uuid,
 exchange_account_id uuid,trading_engine_id uuid,side text,status text,executed_quantity numeric,trades_reconciled boolean,
 slot_id uuid,price numeric,quantity numeric);
 create table coinops.robot_v1_live_fills(order_id uuid,filled_at timestamptz,quantity numeric);
 create table coinops.robot_v1_live_alerts(trading_engine_id uuid,severity text,resolved_at timestamptz);
 create table coinops.strategy_bulk_engine_updates(trading_engine_id uuid,status text);
 create table coinops.account_order_budget_reservations(trading_engine_id uuid,acknowledged_at timestamptz);
 create table coinops.robot_v1_strategy_decisions(trading_engine_id uuid,environment text,action_type text,result text);
 create table coinops.robot_v1_live_events(id uuid default gen_random_uuid(),run_id uuid,product_id uuid,tenant_id uuid,user_id uuid,
 operator_id uuid,exchange_account_id uuid,trading_engine_id uuid,quote_asset text,event_key text,event_type text,
 slot_number int,details jsonb,observed_at timestamptz default now(),unique(run_id,event_key));
 create table coinops.financial_history(engine_id uuid,payload jsonb);
 insert into coinops.operators values('${id(1)}','${id(2)}','${id(3)}','${id(4)}','ACTIVE',false);
 insert into coinops.trading_engines values('${id(6)}','${id(1)}','${id(5)}',25,'REAL','ACTIVE',false,false);
 insert into coinops.robot_v1_live_runs values('${id(7)}','${id(2)}','${id(3)}','${id(4)}','${id(1)}','${id(5)}','${id(6)}','BRL',25,
 'ACTIVE',null,null,null,now(),'"historical snapshot"');
 insert into coinops.robot_v1_live_preparations values('${id(8)}','${id(2)}','${id(3)}','${id(4)}','${id(1)}','${id(5)}','${id(6)}',25,2,1,false,true,${j(policy())},375);
 insert into coinops.robot_v1_live_orders values('${id(10)}','${id(7)}','${id(2)}','${id(3)}','${id(4)}','${id(1)}','${id(5)}','${id(6)}',
 'BUY','FILLED',1,true,'${id(11)}',100,1),('${id(12)}','${id(7)}','${id(2)}','${id(3)}','${id(4)}','${id(1)}','${id(5)}','${id(6)}',
 'SELL','NEW',0,false,'${id(11)}',103,1),('${id(13)}','${id(7)}','${id(2)}','${id(3)}','${id(4)}','${id(1)}','${id(5)}','${id(6)}',
 'BUY','NEW',0,false,'${id(14)}',98,1);
 insert into coinops.robot_v1_live_fills values('${id(10)}','2026-09-24T05:40:17.723Z',1);
 insert into coinops.financial_history values('${id(6)}','{"lifetime":2,"capital":375,"OPEN":1,"TP":1,"NEXT_BUY":1}');
 alter table coinops.robot_v1_live_preparations enable row level security;
 alter table coinops.robot_v1_live_preparations force row level security;
 grant usage on schema coinops,auth to service_role,anon,authenticated;
 grant select on all tables in schema coinops to service_role;
 grant update on coinops.robot_v1_live_runs,coinops.robot_v1_live_preparations,coinops.trading_engines to service_role;
 grant insert on coinops.robot_v1_live_events to service_role;
 set request.jwt.claim.role='service_role';`);
 const original=readFileSync(new URL('../../supabase/migrations/20261103110000_cumulative_slot_goals.sql',import.meta.url),'utf8');
 await db.exec(original.slice(original.indexOf('create or replace function coinops.cumulative_slot_goal_target'),
  original.indexOf('-- Adoption is idempotent')));
 await db.exec(readFileSync(new URL('../../supabase/migrations/20261103131530_cumulative_goal_october_start.sql',import.meta.url),'utf8'));
 await db.exec(readFileSync(new URL('../../supabase/migrations/20261103133122_fix_cumulative_goal_operator_scope.sql',import.meta.url),'utf8'));
});
after(()=>db.close());
for(const rate of [2,3,7])test(`September excluded, rate${rate}, SQL/production TypeScript agree on October/November/December`,async()=>{
 const p=await convert(policy(rate));
 assert.equal(p.execution_anchor_at,policy(rate).anchor_at);
 for(const [at,target]of[['2026-10-01T04:00:00Z',rate],['2026-11-01T04:00:00Z',rate*2],['2026-12-01T04:00:00Z',rate*3]]){
  assert.equal(cumulativeSlotGoal(p,at).target,target);
  assert.equal(await scalar(`select coinops.cumulative_slot_goal_target(${j(p)},'${at}')n`),target);
 }
 assert.equal(cumulativeSlotGoal(p,'2026-11-30T12:00:00Z').cycleMonth,2);
 assert.equal(cumulativeSlotGoal(p,'2026-11-30T12:00:00Z').nextTarget,rate*3);
 assert.equal(cumulativeSlotGoal(p,'2026-12-01T03:59:59Z').target,rate*2);
 assert.equal(cumulativeSlotGoal(p,'2027-01-01T04:00:00Z').target,rate*4);
});
test('October/later starters remain byte-for-byte unchanged, never backdated to October',async()=>{
 for(const date of ['2026-10-03T23:05:00Z','2026-10-28T16:25:00Z','2026-11-03T12:00:00Z','2027-01-15T12:00:00Z']){
  const p=policy(3,date);assert.deepEqual(await convert(p),p);
 }
});
test('October and future target versions retain their exact economics; September is the only removed competence',async()=>{
 const p=policy();p.schedule.push({effective_period:'2026-10',monthly_target:3,source:'CONFIG2'},
  {effective_period:'2026-12',monthly_target:5,source:'CONFIG3'});
 const next=await convert(p);assert.deepEqual(next.schedule,p.schedule.slice(1));
 assert.equal(cumulativeSlotGoal(next,'2026-11-03').target,6);
 assert.equal(cumulativeSlotGoal(next,'2026-12-03').target,11);
});
test('scope cannot become a general history rewrite or recursive month reset',async()=>{
 await assert.rejects(convert(policy(2,'2026-08-31T12:00:00Z')),/SCOPE_DENIED/);
 assert.deepEqual(await convert(await convert(policy())),await convert(policy()));
});
test('audited CAS update is idempotent and changes no gains, money, OPEN/TP/NEXT BUY, timestamps or run snapshots',tx(async()=>{
 const orders=await read('select * from coinops.robot_v1_live_orders order by id'),history=await read('select * from coinops.financial_history'),
  run=await scalar('select to_jsonb(r)n from coinops.robot_v1_live_runs r');
 await db.exec('set local role service_role');
 const result=await apply();assert.equal(result.status,'APPLIED');assert.equal((await apply()).status,'ALREADY_APPLIED');
 assert.deepEqual(await read('select * from coinops.robot_v1_live_orders order by id'),orders);
 assert.deepEqual(await read('select * from coinops.financial_history'),history);
 assert.deepEqual(await scalar('select to_jsonb(r)n from coinops.robot_v1_live_runs r'),run);
 assert.equal(await scalar('select count(*)::int n from coinops.robot_v1_live_events'),1);
 const ev=await scalar('select details n from coinops.robot_v1_live_events');
 assert.deepEqual(ev.before,policy());assert.deepEqual(ev.after,result.policy);
 assert.equal(await scalar('select monthly_target n from coinops.robot_v1_live_preparations'),2);
 assert.equal(await scalar('select capital n from coinops.robot_v1_live_preparations'),'375');
}));
test('direct change remains forbidden without the exact immutable event and its live owned lease',tx(async()=>{
 const p=await convert(policy());await assert.rejects(db.exec('update coinops.robot_v1_live_preparations set slot_goal_policy='+j(p)),/HISTORY_IMMUTABLE/);
}));
for(const [name,mutation]of[
 ['active worker',`update coinops.robot_v1_live_runs set lease_owner='${id(91)}',lease_until=now()+interval '5 minutes'`],
 ['stale reconciliation',"update coinops.robot_v1_live_runs set last_reconciled_at=now()-interval '10 minutes'"],
 ['real error',"update coinops.robot_v1_live_runs set last_error='REAL_ERROR'"],
 ['closed gate',"update coinops.trading_engines set kill_switch=true"],
 ['pending config',"update coinops.trading_engines set strategy_config_pending=true"],
 ['critical incident',`insert into coinops.robot_v1_live_alerts values('${id(6)}','CRITICAL',null)`],
 ['partial',"update coinops.robot_v1_live_orders set status='PARTIALLY_FILLED' where side='BUY'and status='NEW'"],
 ['unknown response',"update coinops.robot_v1_live_orders set status='UNKNOWN' where side='BUY'and status='NEW'"],
 ['unreconciled fill',"update coinops.robot_v1_live_orders set trades_reconciled=false where status='FILLED'"],
 ['dispatch',`insert into coinops.account_order_budget_reservations values('${id(6)}',null)`],
 ['decision',`insert into coinops.robot_v1_strategy_decisions values('${id(6)}','REAL','CREATE_TP','PREPARED')`],
 ['bulk update',`insert into coinops.strategy_bulk_engine_updates values('${id(6)}','PENDING')`],
])test(`defer ${name}, preserving policy and event history`,tx(async()=>{
 await db.exec(mutation);const before=await scalar('select slot_goal_policy n from coinops.robot_v1_live_preparations');
 assert.equal((await apply()).status,'DEFERRED');
 assert.deepEqual(await scalar('select slot_goal_policy n from coinops.robot_v1_live_preparations'),before);
 assert.equal(await scalar('select count(*)::int n from coinops.robot_v1_live_events'),0);
}));
for(const [name,mutation]of[
 ['account',`update coinops.robot_v1_live_preparations set exchange_account_id='${id(99)}'`],
 ['tenant',`update coinops.operators set tenant_id='${id(99)}'`],
 ['product',`update coinops.operators set product_id='${id(99)}'`],
 ['inactive operator',"update coinops.operators set status='PAUSED'"],
 ['slot count',"update coinops.trading_engines set slot_count=50"],
 ['wrong origin',"update coinops.robot_v1_live_fills set filled_at='2026-09-25T12:00:00Z'"],
])test(`reject ${name} mismatch before any policy commit`,tx(async()=>{
 await db.exec(mutation);await assert.rejects(apply(),/SCOPE_DENIED|ORIGIN_UNPROVEN/);
}));
test('stale expected policy cannot overwrite a concurrent prospective edit',tx(async()=>{
 await db.exec('update coinops.robot_v1_live_preparations set monthly_target=3,config_version=2');
 await assert.rejects(apply(),/CONCURRENT_CHANGE/);
}));
test('future edits after correction remain prospective and retain the execution anchor and correction trail',tx(async()=>{
 const first=await apply();await db.exec('update coinops.robot_v1_live_preparations set monthly_target=3,config_version=2');
 const next=await scalar('select slot_goal_policy n from coinops.robot_v1_live_preparations');
 assert.deepEqual(next.anchor_correction,first.policy.anchor_correction);
 assert.equal(next.execution_anchor_at,policy().anchor_at);
 assert.equal(cumulativeSlotGoal(next,'2026-11-03').target,4);
 assert.equal(cumulativeSlotGoal(next,'2026-12-03').target,7);
}));
test('an actual sibling engine in the same account on another shard remains untouched',tx(async()=>{
 await db.exec(`alter table coinops.trading_engines add column shard text default 'executor-01';
 insert into coinops.trading_engines select '${id(60)}',operator_id,exchange_account_id,
 slot_count,environment,status,kill_switch,strategy_config_pending,'executor-02' from coinops.trading_engines where id='${id(6)}';
 insert into coinops.robot_v1_live_runs select '${id(70)}',product_id,tenant_id,user_id,operator_id,exchange_account_id,
 '${id(60)}',quote_asset,slot_count,status,lease_owner,lease_until,last_error,last_reconciled_at,config_snapshot
 from coinops.robot_v1_live_runs where id='${id(7)}';
 insert into coinops.robot_v1_live_preparations select '${id(80)}',product_id,tenant_id,user_id,operator_id,exchange_account_id,
 '${id(60)}',slot_count,monthly_target,config_version,kill_switch,live_enabled,slot_goal_policy,capital
 from coinops.robot_v1_live_preparations where id='${id(8)}';`);
 const sibling=await scalar(`select to_jsonb(p)n from coinops.robot_v1_live_preparations p where p.trading_engine_id='${id(60)}'`);
 assert.equal((await apply()).status,'APPLIED');
 assert.deepEqual(await scalar(`select to_jsonb(p)n from coinops.robot_v1_live_preparations p where p.trading_engine_id='${id(60)}'`),sibling);
 assert.equal(await scalar(`select count(*)::int n from coinops.robot_v1_live_events where trading_engine_id='${id(60)}'`),0);
}));
test('the fixture follows the real engine schema: scope is inherited through operators, never invented engine columns',async()=>{
 const columns=await read("select column_name from information_schema.columns where table_schema='coinops'and table_name='trading_engines'");
 assert.equal(columns.some(x=>['product_id','tenant_id','user_id'].includes(x.column_name)),false);
});
test('role grants, RLS and invoker privileges keep correction service-only',async()=>{
 assert.deepEqual((await read(`select has_function_privilege('anon','coinops.correct_cumulative_goal_october_start(uuid,jsonb)','execute')a,
 has_function_privilege('authenticated','coinops.correct_cumulative_goal_october_start(uuid,jsonb)','execute')u,
 has_function_privilege('service_role','coinops.correct_cumulative_goal_october_start(uuid,jsonb)','execute')s`))[0],{a:false,u:false,s:true});
 assert.equal(await scalar("select relrowsecurity and relforcerowsecurity n from pg_class where oid='coinops.robot_v1_live_preparations'::regclass"),true);
 assert.equal(await scalar("select prosecdef n from pg_proc where oid='coinops.correct_cumulative_goal_october_start(uuid,jsonb)'::regprocedure"),false);
});
for(const slots of [25,50,100])test(`${slots} physical slots are preserved; exact scope can share account or symbol across shards`,tx(async()=>{
 await db.exec(`update coinops.trading_engines set slot_count=${slots};update coinops.robot_v1_live_runs set slot_count=${slots};update coinops.robot_v1_live_preparations set slot_count=${slots};
 insert into coinops.financial_history values('${id(90)}','{"same_account":true,"other_shard":true}');`);
 assert.equal((await apply()).status,'APPLIED');
 assert.equal(await scalar('select slot_count n from coinops.trading_engines'),slots);
 assert.deepEqual(await scalar(`select payload n from coinops.financial_history where engine_id='${id(90)}'`),{same_account:true,other_shard:true});
}));
