// Real append RPC and CHECK in an isolated in-memory PostgreSQL. The capacity,
// account-budget and credential fixtures are synthetic; no remote DB or Binance.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../testing/account-pause-sql/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();
const migration=n=>readFileSync(new URL('../../supabase/migrations/'+n,import.meta.url),'utf8');
const fix=migration('20261027232254_allow_individual_live_monthly_targets.sql');
const variable=migration('20261016161550_configurable_live_engine_slots.sql');
const append=variable.slice(variable.indexOf('CREATE OR REPLACE FUNCTION coinops.append_operator_engine_plan('),variable.indexOf('CREATE OR REPLACE FUNCTION coinops.apply_live_operator_adjustment('));
const legacy=migration('20260924141913_add_multi_account_operator_engine_isolation.sql')
 .match(/add constraint robot_v1_live_monthly_target\s+(check\(monthly_target=case asset when 'BTC' then 7 when 'SOL' then 2 end\))/)[1];
const owner='11111111-1111-4111-8111-111111111111',account='22222222-2222-4222-8222-222222222222';
const request='33333333-3333-4333-8333-333333333333',sibling='44444444-4444-4444-8444-444444444444';
const plan=[{asset:'SOL',capital:375,gain:.055,spacing:.01,postAth:.02,monthlyTarget:3,slotCount:25}];
const input={quote:'BRL',capital:375,engines:plan,shardId:'executor-01'};
const call=`select coinops.append_operator_engine_plan('${owner}','${account}','executor-01','BRL',375,'${JSON.stringify(plan)}','${request}') v`;
const value=async sql=>(await db.query(sql)).rows[0].v;
before(async()=>{
 await db.exec(`create schema coinops;create schema private;create schema auth;
 create role anon;create role authenticated;create role service_role bypassrls;
 create function auth.jwt()returns jsonb language sql as $$select '{"role":"service_role"}'::jsonb$$;
 create table coinops.operators(id uuid primary key,product_id uuid,tenant_id uuid,user_id uuid,status text,kill_switch boolean);
 create table coinops.exchange_accounts(id uuid primary key,operator_id uuid,status text,kill_switch boolean,executor_profile text,executor_shard_id text,is_legacy_default boolean,credential_ref text);
 create table coinops.trading_engines(id uuid primary key default gen_random_uuid(),operator_id uuid,exchange_account_id uuid,environment text,
 symbol text,base_asset text,quote_asset text,ath_reference_symbol text,status text,kill_switch boolean,legacy_compatible boolean,hard_cap_quote numeric,executor_shard_id text,slot_count integer,config jsonb);
 create table coinops.account_onboarding_checks(id uuid default gen_random_uuid(),operator_id uuid,exchange_account_id uuid,check_key text,status text,evidence jsonb,created_by uuid,idempotency_key text,unique(exchange_account_id,idempotency_key));
 create table coinops.account_executor_connections(exchange_account_id uuid,operator_id uuid,executor_shard_id text,environment text,status text);
 create table coinops.binance_account_identity_bindings(exchange_account_id uuid,operator_id uuid,environment text);
 create table coinops.account_execution_policies(exchange_account_id uuid,operator_id uuid,status text,contract text,required_shards text[],proofs jsonb);
 create table coinops.executor_shards(id text,enabled boolean);
 create table coinops.executor_admission_attestations(shard_id text);
 create table coinops.executor_admission_release(singleton boolean);
 create table coinops.account_quote_caps(operator_id uuid,exchange_account_id uuid,quote_asset text,hard_cap_quote numeric,primary key(exchange_account_id,quote_asset));
 create table coinops.account_engine_append_previews(exchange_account_id uuid,operator_id uuid,request_id uuid,input jsonb,expected_account_cap numeric,engine_inventory jsonb,observed_at timestamptz,available_capital numeric);
 create table coinops.executor_capacity_admissions(engine_id uuid,shard_id text,environment text,reserved_weight numeric,expires_at timestamptz);
 create table coinops.robot_v1_ath_profiles(product_id uuid,tenant_id uuid,user_id uuid,operator_id uuid,exchange_account_id uuid,trading_engine_id uuid,environment text,asset text,quote_asset text,config_version integer,gain_rate numeric,normal_spacing_rate numeric,post_ath_spacing_rate numeric,regime text);
 create table coinops.robot_v1_live_preparations(product_id uuid,tenant_id uuid,user_id uuid,operator_id uuid,exchange_account_id uuid,trading_engine_id uuid,
 asset text,symbol text,quote_asset text,slot_count integer,monthly_target integer not null,configured_live_capital_brl numeric,max_order_notional_brl numeric,max_total_exposure_brl numeric,
 compounding_enabled boolean,single_active_entry boolean,initial_market_enabled boolean,local_reentry_enabled boolean,kill_switch boolean,live_enabled boolean,
 constraint robot_v1_live_monthly_target ${legacy});
 alter table coinops.robot_v1_live_preparations enable row level security;
 alter table coinops.robot_v1_live_preparations force row level security;
 grant select,insert on coinops.robot_v1_live_preparations to service_role;
 create table coinops.robot_v1_live_slot_accounts(product_id uuid,tenant_id uuid,user_id uuid,operator_id uuid,exchange_account_id uuid,trading_engine_id uuid,asset text,quote_asset text,slot_number integer);
 create table coinops.preserved_orders(engine_id uuid,payload jsonb);
 create function private.coinops_plan_replay_input(p jsonb)returns jsonb language sql as $$select p$$;
 create function private.coinops_plan_slot_count(p jsonb)returns integer language sql as $$select coalesce((p->>'slotCount')::integer,25)$$;
 create function coinops.preview_engine_slot_admission(text,text,integer[])returns jsonb language sql as $$select '{"code":"CAPACITY_OK"}'::jsonb$$;
 create function private.coinops_slot_workload_profile(text,text,integer)returns jsonb language sql as $$select '{"code":"SLOT_WORKLOAD_CERTIFIED","capacity_units":1}'::jsonb$$;
 create function coinops.executor_capacity_policy()returns jsonb language sql as $$select '{"incremental_weight":900}'::jsonb$$;
 create function private.coinops_account_order_budget_gate(uuid,uuid,integer,jsonb)returns jsonb language sql as $$select '{"code":"PASS"}'::jsonb$$;
 insert into coinops.operators values('${owner}','${owner}','${owner}','${owner}','ACTIVE',false);
 insert into coinops.exchange_accounts values('${account}','${owner}','ACTIVE',false,'coinops-fixed-ip','executor-01',false,'account_${account.replaceAll('-','')}');
 insert into coinops.account_executor_connections values('${account}','${owner}','executor-01','REAL','VALIDATED');
 insert into coinops.binance_account_identity_bindings values('${account}','${owner}','REAL');
 insert into coinops.account_execution_policies values('${account}','${owner}','ACTIVE','ENGINE_ISOLATION_V2',array['executor-01'],'{"executor-01":true}');
 insert into coinops.executor_shards values('executor-01',true);insert into coinops.executor_admission_attestations values('executor-01');insert into coinops.executor_admission_release values(true);
 insert into coinops.trading_engines(id,operator_id,exchange_account_id,environment,symbol,quote_asset,executor_shard_id,status,slot_count)
 values('${sibling}','${owner}','${account}','REAL','SOLUSDT','USDT','executor-01','ACTIVE',25);
 insert into coinops.robot_v1_live_preparations(trading_engine_id,asset,monthly_target)values('${sibling}','SOL',2);
 insert into coinops.preserved_orders values('${sibling}','{"position":"OPEN","tp":"NEW","buy":"NEW","monthlyGains":1}');
 insert into coinops.account_engine_append_previews values('${account}','${owner}','${request}','${JSON.stringify(input)}',0,'[]',clock_timestamp(),377.36);`);
 await db.exec(append);
});
after(async()=>db.close());
test('production incident reproduces exact23514; failed append rolls back engine, cap, reservation and audit',async()=>{
 await assert.rejects(db.transaction(async tx=>tx.query(call)),e=>e.code==='23514'&&e.constraint==='robot_v1_live_monthly_target');
 for(const table of['account_quote_caps','executor_capacity_admissions','account_onboarding_checks'])assert.equal(await value(`select count(*)::integer v from coinops.${table}`),0);
 assert.equal(await value('select count(*)::integer v from coinops.trading_engines'),1);
});
test('fix preserves existing targets, RLS and grants; positive integer range is accepted and invalid targets denied',async()=>{
 const before=await value("select jsonb_build_object('row',(select to_jsonb(p)from coinops.robot_v1_live_preparations p),'rls',(select relrowsecurity and relforcerowsecurity from pg_class where oid='coinops.robot_v1_live_preparations'::regclass),'grants',(select relacl::text from pg_class where oid='coinops.robot_v1_live_preparations'::regclass))v");
 await db.transaction(async tx=>tx.exec(fix));
 assert.deepEqual(await value("select jsonb_build_object('row',(select to_jsonb(p)from coinops.robot_v1_live_preparations p),'rls',(select relrowsecurity and relforcerowsecurity from pg_class where oid='coinops.robot_v1_live_preparations'::regclass),'grants',(select relacl::text from pg_class where oid='coinops.robot_v1_live_preparations'::regclass))v"),before);
 for(const asset of['BTC','SOL'])for(const target of[1,2,3,7,2147483647])await db.query('insert into coinops.robot_v1_live_preparations(asset,monthly_target)values($1,$2)',[asset,target]);
 for(const target of[0,-1,null,2147483648])await assert.rejects(db.query('insert into coinops.robot_v1_live_preparations(asset,monthly_target)values($1,$2)',['SOL',target]));
 assert.equal(await value("select convalidated v from pg_constraint where conname='robot_v1_live_monthly_target'"),true);
});
test('same authorized append succeeds after fix, creates25 slots once and preserves sibling OPEN/TP/BUY',async()=>{
 const before=await value("select jsonb_build_object('engine',(select to_jsonb(e)from coinops.trading_engines e where id='"+sibling+"'),'orders',(select to_jsonb(o)from coinops.preserved_orders o))v");
 await db.exec('update coinops.account_engine_append_previews set observed_at=clock_timestamp()');
 const result=await value(call);assert.equal(result.length,1);assert.equal(result[0].capital,375);assert.equal(result[0].slotCount,25);
 assert.deepEqual(await value(call),result);
 const id=result[0].engineId;
 assert.equal(await value(`select count(*)::integer v from coinops.robot_v1_live_slot_accounts where trading_engine_id='${id}'`),25);
 assert.equal(await value('select count(*)::integer v from coinops.executor_capacity_admissions'),1);
 assert.equal(await value('select count(*)::integer v from coinops.account_onboarding_checks'),1);
 assert.equal(await value('select hard_cap_quote v from coinops.account_quote_caps'),'375');
 assert.deepEqual(await value(`select jsonb_build_object('target',monthly_target,'gain',p.gain_rate,'normal',p.normal_spacing_rate,'postAth',p.post_ath_spacing_rate,'live',live_enabled,'kill',r.kill_switch)v from coinops.robot_v1_live_preparations r join coinops.robot_v1_ath_profiles p using(trading_engine_id)where trading_engine_id='${id}'`),{target:3,gain:.055,normal:.01,postAth:.02,live:false,kill:true});
 assert.deepEqual(await value("select jsonb_build_object('engine',(select to_jsonb(e)from coinops.trading_engines e where id='"+sibling+"'),'orders',(select to_jsonb(o)from coinops.preserved_orders o))v"),before);
});
