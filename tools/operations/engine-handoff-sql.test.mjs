import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../testing/account-pause-sql/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');const db=new PGlite();
const op='d508bb3e-5a1d-4579-bd7a-de171c118d25',renato='b08b6f73-6fc2-485d-a949-5f77ce651c17',
 samya='8464c3b3-62ac-4a52-b2f1-c4bf4bd6ed36',account='95c95966-b92e-4e22-ac03-32a3f1d0bc1b';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const q=s=>"'"+String(s).replaceAll("'","''")+"'";
const query=async sql=>(await db.query(sql)).rows;
before(async()=>{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create schema private;create schema coinops;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql as $$select jsonb_build_object('role',current_setting('request.jwt.claim.role',true))$$;
 grant usage on schema coinops,auth to authenticated,service_role;
 create table coinops.exchange_accounts(id uuid primary key,operator_id uuid,status text default 'ACTIVE',kill_switch boolean default false,executor_shard_id text,
  is_legacy_default boolean default false,credential_ref text,onboarding_environment text default 'REAL');
 create table private.coinops_staged_shard_move_capabilities(account_id uuid,from_shard text,to_shard text,transaction_id bigint);
 create table coinops.executor_shards(id text primary key,enabled boolean default true,egress_ipv4 inet);
 insert into coinops.executor_shards values('executor-02',true,'164.90.223.159'),('executor-03',true,'167.71.37.166');
 create table coinops.trading_engines(id uuid primary key,operator_id uuid,exchange_account_id uuid,environment text default 'REAL',status text default 'ACTIVE',
 kill_switch boolean default false,strategy_config_pending boolean default false,slot_count integer default 25,legacy_compatible boolean default false,
 executor_shard_id text,config jsonb default '{}',symbol text default 'SOLBRL',base_asset text default 'SOL',quote_asset text default 'BRL',updated_at timestamptz default now(),unique(id,operator_id,exchange_account_id));
 create function private.coinops_engine_shard_immutable() returns trigger language plpgsql as $$begin raise exception 'COINOPS_ENGINE_SHARD_IMMUTABLE';end$$;
 create trigger trading_engine_shard_identity before update of executor_shard_id,id,operator_id,exchange_account_id,environment,symbol,quote_asset,base_asset,legacy_compatible
 on coinops.trading_engines for each row execute function private.coinops_engine_shard_immutable();
 create table coinops.robot_v1_live_runs(id uuid primary key,product_id uuid,tenant_id uuid,user_id uuid,trading_engine_id uuid,operator_id uuid,exchange_account_id uuid,
 status text constraint robot_v1_live_runs_status_check check(status in('PREPARING','ACTIVE','PAUSED','COMPLETED')),last_error text,last_reconciled_at timestamptz default now(),
 lease_owner uuid,lease_until timestamptz,created_at timestamptz default now(),updated_at timestamptz default now(),config_snapshot jsonb default '{}');
 create table coinops.robot_v1_live_preparations(trading_engine_id uuid,live_enabled boolean default true,kill_switch boolean default false);
 create table coinops.robot_v1_live_slots(id uuid default gen_random_uuid(),run_id uuid,slot_number integer,entry_state text default 'OPEN',position_quantity numeric default 1);
 create table coinops.robot_v1_live_slot_accounts(trading_engine_id uuid,slot_number integer,balance_brl numeric default 11);
 create table coinops.robot_v1_live_orders(id uuid default gen_random_uuid(),run_id uuid,side text default 'SELL',status text default 'NEW',executed_quantity numeric default 0,trades_reconciled boolean default true);
 create table coinops.robot_v1_live_fills(id uuid default gen_random_uuid(),order_id uuid,amount numeric);
 create table coinops.robot_v1_live_alerts(trading_engine_id uuid,resolved_at timestamptz,severity text);
 create table coinops.strategy_bulk_engine_updates(trading_engine_id uuid,status text);
 create table coinops.account_order_budget_reservations(trading_engine_id uuid,acknowledged_at timestamptz);
 create table coinops.robot_v1_strategy_decisions(trading_engine_id uuid,environment text,action_type text,result text);
 create table coinops.account_executor_connections(exchange_account_id uuid,operator_id uuid,executor_shard_id text,environment text,status text,validation_evidence jsonb,checked_at timestamptz);
 create table coinops.binance_account_identity_bindings(exchange_account_id uuid,operator_id uuid,environment text);
 create table coinops.executor_capacity_admissions(engine_id uuid primary key,shard_id text,environment text,reserved_weight numeric,reserved_at timestamptz default now(),expires_at timestamptz);
 create table coinops.robot_v1_live_events(product_id uuid,tenant_id uuid,user_id uuid,operator_id uuid,exchange_account_id uuid,trading_engine_id uuid,quote_asset text,run_id uuid,event_key text unique,event_type text,details jsonb);
 create function coinops.preview_engine_slot_admission(text,text,integer[],uuid) returns jsonb language sql as $$select jsonb_build_object('code',case when current_setting('test.capacity',true)='FAIL' then 'CAPACITY_REQUIRED' else 'CAPACITY_OK' end)$$;
 create function coinops.executor_capacity_policy() returns jsonb language sql as $$select '{"incremental_weight":900}'::jsonb$$;
 insert into coinops.exchange_accounts(id,operator_id,executor_shard_id) values('c1a0e4d2-8c8f-421d-8fb4-5ddd26e606c3','${op}','executor-02'),('${account}','${op}','executor-03');
 insert into coinops.trading_engines(id,operator_id,exchange_account_id,executor_shard_id,kill_switch) values('${renato}','${op}','c1a0e4d2-8c8f-421d-8fb4-5ddd26e606c3','executor-02',true),('${samya}','${op}','${account}','executor-03',false);
 insert into coinops.robot_v1_live_runs(id,product_id,tenant_id,user_id,trading_engine_id,operator_id,exchange_account_id,status)
 select case when id='${renato}' then '${id(1)}'::uuid else '${id(2)}'::uuid end,'${id(3)}','${id(4)}','${id(5)}',id,operator_id,exchange_account_id,case when id='${renato}' then 'PAUSED' else 'ACTIVE' end from coinops.trading_engines;
 insert into coinops.robot_v1_live_preparations(trading_engine_id) select id from coinops.trading_engines;
 insert into coinops.robot_v1_live_slots(run_id,slot_number) select r.id,s from coinops.robot_v1_live_runs r cross join generate_series(1,25)s;
 insert into coinops.robot_v1_live_slot_accounts(trading_engine_id,slot_number) select e.id,s from coinops.trading_engines e cross join generate_series(1,25)s;
 insert into coinops.robot_v1_live_orders(run_id) select id from coinops.robot_v1_live_runs;
 insert into coinops.account_executor_connections values('${account}','${op}','executor-02','REAL','VALIDATED','{"status":"PASS","executor_ip":"164.90.223.159"}',now());
 insert into coinops.binance_account_identity_bindings values('${account}','${op}','REAL');`);
 await db.exec(readFileSync(new URL('../../supabase/migrations/20261025204059_controlled_engine_handoffs.sql',import.meta.url),'utf8'));
 await db.exec('create trigger exchange_accounts_primary_shard_immutable before update on coinops.exchange_accounts for each row execute function private.coinops_primary_shard_immutable()');
});
after(()=>db.close());
const prepare=async(engine,kind,request=20)=>(await query(`select coinops.prepare_engine_handoff('${id(request)}','${engine}','${kind}') h`))[0].h;
const proof=h=>({contract:'CONTROLLED_HANDOFF_V1',engine_id:h.trading_engine_id,run_id:h.run_id,snapshot_sha256:h.before_sha256,
 source_shard:h.source_shard_id,source_write_fenced:true,binance_ledger_match:true,pending_claims:0,observed_at:new Date().toISOString(),
 client_assumes_management:true,source_process_stopped:true,target_read_proven:true,target_shard:h.target_shard_id});
const commit=(h,p=proof(h))=>query(`select coinops.commit_engine_handoff('${h.id}',${q(JSON.stringify(p))}::jsonb) value`);
const begin=()=>db.exec("begin;select set_config('request.jwt.claim.role','service_role',true)");
async function denied(operation,pattern){await db.exec('savepoint denied');await assert.rejects(operation,pattern);await db.exec('rollback to savepoint denied');}
test('offboarding is scoped, idempotent and preserves every financial row without fake closure',async()=>{
 await begin();try{
 const before=(await query("select jsonb_agg(to_jsonb(s) order by id) x from coinops.robot_v1_live_slots s"))[0].x;
 const h=await prepare(renato,'CLIENT_MANAGED'),p=proof(h);assert.equal(h.phase,'PREPARED');
 assert.equal((await prepare(renato,'CLIENT_MANAGED')).id,h.id);
 await commit(h,p);assert.equal((await commit(h,p))[0].value.replayed,true);
 assert.equal((await query(`select status,last_reconciled_at,lease_owner from coinops.robot_v1_live_runs where id='${id(1)}'`))[0].status,'OFFBOARDED');
 assert.deepEqual((await query("select jsonb_agg(to_jsonb(s) order by id) x from coinops.robot_v1_live_slots s"))[0].x,before);
 assert.equal((await query(`select status from coinops.robot_v1_live_runs where id='${id(2)}'`))[0].status,'ACTIVE');
 await assert.rejects(commit(h,{...p,client_assumes_management:false}),/REPLAY_MISMATCH/);
 }finally{await db.exec('rollback')}
});
test('lease, snapshot, partial fill, decision, dispatch and source fencing cannot be bypassed',async()=>{
 for(const mutation of ["update coinops.robot_v1_live_runs set lease_until=now()-interval '1 second'",
  "update coinops.robot_v1_live_slots set position_quantity=2"]){await begin();try{const h=await prepare(renato,'CLIENT_MANAGED');await db.exec(mutation);await assert.rejects(commit(h),/LEASE_LOST|SNAPSHOT_CHANGED/)}finally{await db.exec('rollback')}}
 for(const mutation of ["update coinops.robot_v1_live_orders set status='PARTIALLY_FILLED'",
  `insert into coinops.robot_v1_strategy_decisions values('${renato}','REAL','CREATE_TP','DISPATCHED')`,
  `insert into coinops.account_order_budget_reservations values('${renato}',null)`]){await begin();try{await db.exec(mutation);await assert.rejects(prepare(renato,'CLIENT_MANAGED'),/UNSETTLED/)}finally{await db.exec('rollback')}}
 await begin();try{const h=await prepare(renato,'CLIENT_MANAGED');await assert.rejects(commit(h,{...proof(h),source_write_fenced:false}),/PROOF_UNPROVEN/)}finally{await db.exec('rollback')}
});
test('migration preserves engine/run/slots; direct shard or namespace writes still fail',async()=>{
 await begin();try{
 await denied(()=>db.exec(`update coinops.trading_engines set executor_shard_id='executor-02' where id='${samya}'`),/SHARD_IMMUTABLE/);
 const h=await prepare(samya,'SHARD_MIGRATION');await commit(h);
 assert.equal((await query(`select executor_shard_id from coinops.trading_engines where id='${samya}'`))[0].executor_shard_id,'executor-02');
 assert.equal((await query(`select executor_shard_id from coinops.exchange_accounts where id='${account}'`))[0].executor_shard_id,'executor-02');
 assert.equal((await query(`select status from coinops.robot_v1_live_runs where id='${id(2)}'`))[0].status,'ACTIVE');
 assert.equal((await query(`select lease_owner::text owner from coinops.robot_v1_live_runs where id='${id(2)}'`))[0].owner,h.id,
  'cutover keeps the lease: a crash cannot resume an old cached routing context');
 assert.equal((await query("select count(*)::int n from coinops.robot_v1_live_slots"))[0].n,50);
 await assert.rejects(db.exec(`update coinops.trading_engines set symbol='BTCBRL' where id='${samya}'`),/NAMESPACE_IMMUTABLE/);
 }finally{await db.exec('rollback')}
});
test('migration rejects capacity, destination ambiguity, stale or absent proof, and another account',async()=>{
 await begin();try{const h=await prepare(samya,'SHARD_MIGRATION');await db.exec("select set_config('test.capacity','FAIL',true)");await assert.rejects(commit(h),/CAPACITY_REQUIRED/)}finally{await db.exec('rollback')}
 for(const patch of [{target_read_proven:false},{source_process_stopped:false},{observed_at:'2000-01-01T00:00:00Z'},{observed_at:null}]){await begin();try{const h=await prepare(samya,'SHARD_MIGRATION');await assert.rejects(commit(h,{...proof(h),...patch}),/UNPROVEN/)}finally{await db.exec('rollback')}}
 await begin();try{await assert.rejects(prepare(samya,'CLIENT_MANAGED'),/SCOPE_DENIED/)}finally{await db.exec('rollback')}
});
test('RLS and RPC grants prevent anon/viewer writes; private snapshots cannot be forged',async()=>{
 await db.exec('begin;set local role authenticated');try{
 await denied(()=>prepare(renato,'CLIENT_MANAGED'),/permission denied/);
 await denied(()=>db.exec("insert into coinops.engine_handoffs(id) values(gen_random_uuid())"),/permission denied/);
 assert.equal((await query('select count(*)::int n from coinops.engine_handoffs'))[0].n,0);
 await assert.rejects(query(`select private.coinops_handoff_snapshot('${renato}')`),/permission denied/);
 }finally{await db.exec('rollback')}
});
