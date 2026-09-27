import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

// Disposable local PostgreSQL only. Never loads .env, Supabase URL or a live credential.
const bin=process.env.COINOPS_AUDIT_PG_BIN ?? "C:/Program Files/PostgreSQL/17/bin";
const available=existsSync(join(bin,"initdb.exe"));
const directory=available ? mkdtempSync(join(tmpdir(),"coinops-finops-")) : "";
const tenant="11111111-1111-4111-8111-111111111111", otherTenant="22222222-2222-4222-8222-222222222222";
const operator="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", otherOperator="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const owner="cccccccc-cccc-4ccc-8ccc-cccccccccccc", nextOwner="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
let port=0;
const env: NodeJS.ProcessEnv={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("PG"))),
  NODE_ENV:"test", PGHOST:"127.0.0.1",PGPORT:"",PGUSER:"finops_audit",PGDATABASE:"postgres",PGCLIENTENCODING:"UTF8",PGPASSFILE:join(directory,"no-credentials")};
const args=(query:string)=>["-X","-w","-h","127.0.0.1","-p",String(port),"-U","finops_audit","-d","postgres",
  "-v","ON_ERROR_STOP=1","-qAt","-c",query];
const psql=(query:string)=>{
  try { return execFileSync(join(bin,"psql.exe"),[...args("").slice(0,-2),"-f","-"],
    {env,windowsHide:true,encoding:"utf8",stdio:"pipe",input:query}).replace(/\r/g,"").trim(); }
  catch(error) { throw new Error(String((error as {stderr?:string}).stderr ?? "LOCAL_PG_QUERY_FAILED")); }
};
const asService=(query:string)=>`set role service_role; ${query}`;
const migrations=resolve("../../supabase/migrations");
const candidates=readdirSync(migrations).filter(file=>file.endsWith("_add_coinops_finops_admin.sql"));
assert.equal(candidates.length,1,"exactly one official FinOps schema migration is required");
const migration=readFileSync(join(migrations,candidates[0]!),"utf8");
before(async()=>{
  if(!available)return;
  const reservation=createServer();
  await new Promise<void>((done,reject)=>{reservation.once("error",reject);reservation.listen(0,"127.0.0.1",done);});
  const address=reservation.address();
  if(!address || typeof address==="string")throw new Error("LOCAL_PG_PORT_UNAVAILABLE");
  port=address.port;env.PGPORT=String(port);
  await new Promise<void>((done,reject)=>reservation.close(error=>error?reject(error):done()));
  execFileSync(join(bin,"initdb.exe"),["-D",directory,"-U","finops_audit","-A","trust","--no-locale","-E","UTF8"],{env,windowsHide:true,stdio:"pipe"});
  execFileSync(join(bin,"pg_ctl.exe"),["-D",directory,"-l",join(directory,"server.log"),"-o",`-h 127.0.0.1 -p ${port}`,"-w","start"],{env,windowsHide:true,stdio:"ignore"});
  psql(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema coinops; grant usage on schema coinops to anon,authenticated,service_role;
    alter default privileges in schema coinops grant all on tables to service_role;
    create table coinops.operators(id uuid primary key,tenant_id uuid not null,user_id uuid,status text);
    create table coinops.executor_shards(id text primary key,egress_ipv4 inet not null,enabled boolean default true);
    insert into coinops.operators values('${operator}','${tenant}','${owner}','ACTIVE'),('${otherOperator}','${otherTenant}','${nextOwner}','ACTIVE');
    insert into coinops.executor_shards values('executor-01','46.101.104.48',true),('executor-02','164.90.223.159',true),('executor-03','192.0.2.3',true);
    create table coinops.trading_guard_fixture(engine text primary key,state jsonb);
    insert into coinops.trading_guard_fixture values('untouched','{"status":"ACTIVE","tp":"resident","nextBuy":"resident"}');`);
  psql(migration);
});
after(()=>{
  if(available && existsSync(join(directory,"postmaster.pid")))
    execFileSync(join(bin,"pg_ctl.exe"),["-D",directory,"-m","fast","-w","stop"],{env,windowsHide:true,stdio:"pipe"});
});
const check=(name:string,fn:()=>void|Promise<void>)=>test(name,{skip:available?false:"Local PostgreSQL unavailable"},fn);

check("FinOps SQL seeds only proven executor plans; future resources do not inherit a price",()=>{
  assert.equal(psql(`select count(*)||':'||sum(recurring_monthly)||':'||bool_and(actual_month_cost is null) from coinops.finops_services
    where operator_id='${operator}' and provider='DigitalOcean'`),"2:12.0000:true");
  assert.equal(psql("select count(*) from coinops.finops_services where shard_id='executor-03'"),"0");
});
check("RLS and explicit grants deny anon/VIEWER direct access even with broad default privileges",()=>{
  assert.equal(psql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='coinops' and c.relname like 'finops_%' and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity"),"5");
  for(const role of ["anon","authenticated"]){
    assert.throws(()=>psql(`set role ${role}; select * from coinops.finops_services`),/permission denied/);
    assert.throws(()=>psql(`set role ${role}; select coinops.finops_claim_sync('${tenant}','${operator}','${owner}')`),/permission denied/);
  }
  assert.equal(psql("select has_table_privilege('service_role','coinops.finops_snapshots','UPDATE')||':'||has_table_privilege('service_role','coinops.finops_snapshots','DELETE')"),"false:false");
});
check("database scope guards reject cross-tenant services and cross-operator revisions",()=>{
  assert.throws(()=>psql(asService(`insert into coinops.finops_services(tenant_id,operator_id,service_key,provider,name,cost_period)
    values('${otherTenant}','${operator}','bad','Fixture','Bad','2026-09-01')`)),/SCOPE_INVALID/);
  const serviceId=psql(`select id from coinops.finops_services where operator_id='${operator}' limit 1`);
  assert.throws(()=>psql(asService(`insert into coinops.finops_service_revisions(service_id,tenant_id,operator_id,after_value)
    values('${serviceId}','${otherTenant}','${otherOperator}','{}')`)),/SERVICE_SCOPE_INVALID/);
  assert.throws(()=>psql(asService(`update coinops.finops_services set operator_id='${otherOperator}',tenant_id='${otherTenant}' where id='${serviceId}'`)),/SCOPE_IMMUTABLE/);
});
check("snapshots and source revisions are immutable including privileged SQL; FX/history stay frozen",()=>{
  psql(asService(`insert into coinops.finops_snapshots(tenant_id,operator_id,period,snapshot_key,captured_at,payload)
    values('${tenant}','${operator}','2026-08-01','fixture-history','2026-08-31T23:59:00Z','{"fx":[{"rate":5.2}],"amount":31.2}')`));
  assert.throws(()=>psql(`update coinops.finops_snapshots set payload='{}'`),/OBSERVATION_IMMUTABLE/);
  assert.throws(()=>psql(`delete from coinops.finops_snapshots`),/OBSERVATION_IMMUTABLE/);
  assert.throws(()=>psql(`update coinops.finops_service_revisions set after_value='{}'`),/OBSERVATION_IMMUTABLE/);
  assert.equal(psql(asService(`select payload->>'amount' from coinops.finops_monthly_history('${tenant}','${operator}')`)),"31.2");
  assert.equal(psql(asService(`select count(*) from coinops.finops_monthly_history('${otherTenant}','${operator}')`)),"0");
});
check("simultaneous sync leases admit exactly one worker and do not block another operator",async()=>{
  const claim=(claimOwner:string)=>promisify(execFile)(join(bin,"psql.exe"),args(asService(`select coinops.finops_claim_sync('${tenant}','${operator}','${claimOwner}')`)),{env,windowsHide:true,encoding:"utf8"});
  const results=await Promise.all([claim(owner),claim(nextOwner)]);
  assert.deepEqual(results.map(r=>r.stdout.trim()).sort(),["f","t"]);
  assert.equal(psql(asService(`select coinops.finops_claim_sync('${otherTenant}','${otherOperator}','${owner}')`)),"t");
});
check("expired worker cannot publish; successor finishes atomically and manual snapshots do not reset external cooldown",()=>{
  psql(`update coinops.finops_sync_state set lease_until=now()-interval '1 second' where operator_id='${operator}'`);
  assert.equal(psql(asService(`select coinops.finops_claim_sync('${tenant}','${operator}','${nextOwner}')`)),"t");
  const payload=`jsonb_build_object('capturedAt',now(),'syncStatus','OK','fx',jsonb_build_array(jsonb_build_object('rate',5.2)))`;
  assert.throws(()=>psql(asService(`select coinops.finops_finish_sync('${tenant}','${operator}','${owner}','wrong-owner',true,${payload})`)),/LEASE_LOST/);
  psql(asService(`select coinops.finops_finish_sync('${tenant}','${operator}','${nextOwner}','external-test',true,${payload})`));
  const observed=psql(`select last_external_synced_at from coinops.finops_sync_state where operator_id='${operator}'`);
  psql(asService(`select coinops.finops_finish_sync('${tenant}','${operator}','${nextOwner}','manual-test',false,${payload})`));
  assert.equal(psql(`select last_external_synced_at from coinops.finops_sync_state where operator_id='${operator}'`),observed);
  assert.equal(psql("select count(*) from coinops.finops_snapshots where snapshot_key='wrong-owner'"),"0");
});
check("ledger evidence audit preserves null costs and currency; signed provider credits remain real",()=>{
  psql(asService(`insert into coinops.finops_services(tenant_id,operator_id,service_key,provider,name,cost_period,currency,origin,actual_month_cost)
    values('${tenant}','${operator}','credit','Fixture','Credit','2026-09-01','USD','REAL',-2),
    ('${tenant}','${operator}','unknown','Fixture','Unknown','2026-09-01','BRL','INDISPONIVEL',null)`));
  assert.equal(psql(`select currency||':'||origin||':'||coalesce(actual_month_cost::text,'NULL') from coinops.finops_services where service_key='unknown'`),"BRL:INDISPONIVEL:NULL");
  assert.equal(psql(`select after_value->>'actual_month_cost' from coinops.finops_service_revisions r join coinops.finops_services s on s.id=r.service_id where s.service_key='credit'`),"-2.0000");
  assert.throws(()=>psql(`update coinops.finops_services set billing_period_start='2026-09-14',billing_period_end=null where service_key='unknown'`),/check constraint/);
  assert.throws(()=>psql(`update coinops.finops_services set billing_period_start=null,billing_period_end='2026-10-14' where service_key='unknown'`),/check constraint/);
});
check("FinOps migration and recovery tests never touch the independent trading fixture",()=>{
  assert.equal(psql("select state->>'status'||':'||(state->>'tp')||':'||(state->>'nextBuy') from coinops.trading_guard_fixture"),"ACTIVE:resident:resident");
});
