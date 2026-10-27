// Real admission SQL, isolated in disposable in-memory PostgreSQL. No remote
// URLs, credentials or exchange transport. Fixture time edits stay here only.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../testing/account-pause-sql/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();
const owner='11111111-1111-4111-8111-111111111111',engine='22222222-2222-4222-8222-222222222222';
const old='a'.repeat(40),current='b'.repeat(40),hash='c'.repeat(64),policy='capacity-v3-20260930';
const migration=name=>readFileSync(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8');
const q=async sql=>(await db.query(sql)).rows;
const value=async sql=>(await q(sql))[0].v;
const preview=shard=>value(`select coinops.preview_executor_admission('${shard}','REAL',1) v`);
const fresh=async(shard,extra='')=>db.exec(`update coinops.executor_capacity_samples set observed_at=clock_timestamp(),heartbeat_at=clock_timestamp(),weight_observed_at=clock_timestamp()${extra?', '+extra:''} where shard_id='${shard}'`);
const mature=async shard=>{await db.exec(`update coinops.executor_admission_hysteresis set healthy_since=clock_timestamp()-interval '601 seconds' where shard_id='${shard}' and environment='REAL' and healthy_since is not null`);await fresh(shard);};
const certify=async sha=>value(`select coinops.certify_executor_admission('${sha}','${hash}','v24.21.0','${policy}',
 (select jsonb_agg(jsonb_build_object('shard_id',id,'ip',host(egress_ipv4),'status','PASS','config_status','PASS',
 'actual_sha','${sha}','runtime_sha256','${hash}','node_version','v24.21.0','observed_at',clock_timestamp())) from coinops.executor_shards where enabled)) v`);
before(async()=>{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create function auth.uid() returns uuid language sql as $$select null::uuid$$;
 create schema coinops;create schema private;grant usage on schema coinops to service_role;
 create table coinops.operators(id uuid primary key,user_id uuid,status text);
 create table coinops.exchange_accounts(id uuid primary key,status text,executor_note text,operator_id uuid,display_name text,
 kill_switch boolean default true,is_legacy_default boolean default false,credential_ref text,executor_profile text,onboarding_environment text);
 create table coinops.trading_engines(id uuid primary key,exchange_account_id uuid references coinops.exchange_accounts(id),environment text,operator_id uuid,status text);
 create table coinops.operator_push_subscriptions(id uuid primary key);
 create table coinops.account_onboarding_checks(operator_id uuid,exchange_account_id uuid,check_key text,status text,evidence jsonb,created_by uuid,idempotency_key text);
 insert into coinops.operators values('${owner}','${owner}','ACTIVE');
 insert into coinops.exchange_accounts(id,status,operator_id,executor_note)values('${owner}','ACTIVE','${owner}','PRESERVED');
 insert into coinops.trading_engines values('${engine}','${owner}','REAL','${owner}','ACTIVE');`);
 for(const file of['20260926180000_add_coinops_executor_capacity.sql','20260926194558_protect_testnet_shard_capacity.sql','20260926202114_add_coinops_environment_capacity.sql'])await db.exec(migration(file));
 await db.exec(`create table coinops.watchdog_checks(shard_id text,checked_at timestamptz,blocked_engines int default 0,stale_engines int default 0,recovering_engines int default 0);grant select on coinops.watchdog_checks to service_role;`);
 await db.exec(migration('20260929212150_coinops_canonical_admission_policy.sql'));
 await db.exec(migration('20260930140348_coinops_admission_hysteresis.sql'));
 await db.exec(migration('20261016192533_bind_slot_workload_web_fingerprint.sql'));
 const variable=migration('20261016161550_configurable_live_engine_slots.sql');
 await db.exec(variable.slice(variable.indexOf('create or replace function coinops.preview_engine_slot_admission('),variable.indexOf('-- Existing RPCs retain ownership')));
 await db.exec(`insert into coinops.executor_shards(id,egress_ipv4)values('executor-02','192.0.2.2'),('executor-03','192.0.2.3');
 insert into coinops.executor_capacity_samples(shard_id,observed_at,heartbeat_at,weight_observed_at,binance_weight_current,binance_weight_average,
 binance_weight_peak,binance_weight_samples,cpu_percent,ram_used_mb,ram_limit_mb,account_count,engine_count,registry_match,executor_version)
 select id,clock_timestamp(),clock_timestamp(),clock_timestamp(),2300,2400,2800,15,4,150,961,4,7,true,'${old}' from coinops.executor_shards;
 insert into coinops.watchdog_checks select id,clock_timestamp(),0,0,0 from coinops.executor_shards;`);
 await certify(old);for(const shard of['executor-01','executor-02','executor-03'])await mature(shard);
});
after(async()=>db.close());
test('runtime rollout reproduces HEALTHY/+1 NO; official recertification fixes readiness without resetting timers',async()=>{
 assert.equal((await preview('executor-01')).code,'CAPACITY_OK');
 await db.exec(`update coinops.executor_capacity_samples set executor_version='${current}'`);
 const before=await value("select jsonb_agg(to_jsonb(h)order by shard_id,planned_engines)v from coinops.executor_admission_hysteresis h");
 const denied=await preview('executor-01');assert.equal(denied.reason,'RUNTIME_PARITY');assert.equal(denied.executor_state,'HEALTHY');assert.equal(denied.projected_weight,3300);
 await certify(current);assert.equal((await preview('executor-01')).code,'CAPACITY_OK');
 assert.deepEqual(await value("select jsonb_agg(to_jsonb(h)order by shard_id,planned_engines)v from coinops.executor_admission_hysteresis h"),before);
 assert.equal((await value("select to_jsonb(a)v from coinops.exchange_accounts a")).executor_note,'PRESERVED');
});
test('25/50/100 profiles remain distinct; 25 never inherits uncertified larger workloads',async()=>{
 const result=await value("select coinops.preview_engine_slot_admission('executor-01','REAL',array[25],null)v");
 assert.equal(result.code,'CAPACITY_OK');assert.equal(result.capacity_units,1);assert.equal(result.incremental_weight,900);
 for(const n of[50,100]){const r=await value(`select coinops.preview_engine_slot_admission('executor-01','REAL',array[${n}],null)v`);
  assert.equal(r.code,'CAPACITY_UNKNOWN');assert.equal(r.reason,'SLOT_WORKLOAD_UNCERTIFIED');assert.equal(r.slot_count,n);}
 const web='d'.repeat(64),scenarios=Object.fromEntries(['STEADY','ALL_TP_FILL_BURST','TRANSIENT_RETRIES','SIBLING_LOAD','CPU_RAM','RECONCILIATION_BACKLOG','QUEUE_AND_RATE_LIMIT'].map(s=>[s,'PASS']));
 const proof={contract:'SLOT_WORKLOAD_V1',environment:'REAL',target_sha:current,runtime_sha256:hash,policy_version:policy,
  profiles:[{slot_count:50,status:'PASS',capacity_units:4,upper_bound_weight_per_minute:3400,evidence_sha256:hash,web_workload_sha256:web,scenarios},
   {slot_count:100,status:'PASS',capacity_units:6,upper_bound_weight_per_minute:5300,evidence_sha256:hash,web_workload_sha256:web,scenarios}]};
 await db.query("update coinops.executor_admission_attestations set evidence=evidence||jsonb_build_object('slot_workload',$1::jsonb) where shard_id='executor-02'",[JSON.stringify(proof)]);
 await db.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-coinops-workload-sha256':web})]);
 for(const[count,units]of[[25,1],[50,4],[100,6]]){const r=await value(`select coinops.preview_engine_slot_admission('executor-02','REAL',array[${count}],null)v`);
  assert.equal(r.capacity_units,units);assert.equal(r.incremental_weight,units*900);assert.equal(r.reserved_weight,0);}
 await db.exec("update coinops.executor_admission_attestations set evidence=evidence-'slot_workload' where shard_id='executor-02'");
});
test('critical current pressure closes only its shard; isolated historical peak remains OBSERVE with admission',async()=>{
 await fresh('executor-01','binance_weight_current=4500,binance_weight_peak=4500');assert.equal((await preview('executor-01')).code,'CAPACITY_REQUIRED');
 assert.equal((await preview('executor-02')).code,'CAPACITY_OK');
 await fresh('executor-01','binance_weight_current=2300,binance_weight_average=2400,binance_weight_peak=5800');await mature('executor-01');
 const p=await preview('executor-01');assert.equal(p.code,'CAPACITY_OK');assert.equal(p.executor_state,'OBSERVE');assert.equal(p.recovery_headroom_weight,2100);
});
test('hysteresis requires 600 real fixture seconds, reads never advance it and replay does not reset it',async()=>{
 await fresh('executor-01','errors_last_5m=1');await fresh('executor-01','errors_last_5m=0');
 let p=await preview('executor-01');assert.equal(p.reason,'RECOVERY_STABILIZING');
 const state=await value("select to_jsonb(h)v from coinops.executor_admission_hysteresis h where shard_id='executor-01'and environment='REAL'and planned_engines=1");
 for(let n=0;n<3;n++)await preview('executor-01');
 assert.deepEqual(await value("select to_jsonb(h)v from coinops.executor_admission_hysteresis h where shard_id='executor-01'and environment='REAL'and planned_engines=1"),state);
 await db.exec("update coinops.executor_admission_hysteresis set healthy_since=clock_timestamp()-interval '599 seconds' where shard_id='executor-01'and environment='REAL'");await fresh('executor-01');assert.equal((await preview('executor-01')).code,'CAPACITY_REQUIRED');
 await mature('executor-01');assert.equal((await preview('executor-01')).code,'CAPACITY_OK');
});
test('stale telemetry and missing weight evidence stay closed; reservations count once and only on their shard',async()=>{
 await db.exec("update coinops.executor_capacity_samples set weight_observed_at=clock_timestamp()-interval '121 seconds' where shard_id='executor-01'");assert.equal((await preview('executor-01')).code,'CAPACITY_UNKNOWN');
 await fresh('executor-01','binance_weight_samples=1');assert.equal((await preview('executor-01')).code,'CAPACITY_UNKNOWN');
 await fresh('executor-01','binance_weight_samples=15');await mature('executor-01');
 await db.exec(`insert into coinops.executor_capacity_admissions(engine_id,shard_id,reserved_weight,reserved_at,expires_at,environment)values('${engine}','executor-01',900,clock_timestamp(),clock_timestamp()+interval '1 minute','REAL')`);
 const p=await preview('executor-01');assert.equal(p.reserved_weight,900);assert.equal(p.projected_weight,4200);assert.equal(p.code,'CAPACITY_REQUIRED');
 assert.equal((await preview('executor-02')).reserved_weight,0);assert.equal((await preview('executor-02')).code,'CAPACITY_OK');
 await db.exec('delete from coinops.executor_capacity_admissions');
});
test('retired03 remains excluded; certification is service-only and cannot admit a disabled shard',async()=>{
 await db.exec("update coinops.executor_shards set enabled=false where id='executor-03'");await certify(current);
 assert.equal((await preview('executor-03')).reason,'EXECUTOR_DISABLED_OR_MISSING');
 assert.equal(await value("select has_function_privilege('authenticated','coinops.certify_executor_admission(text,text,text,text,jsonb)','execute')v"),false);
});
