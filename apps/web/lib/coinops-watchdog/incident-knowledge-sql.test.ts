import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const bin = process.env.COINOPS_AUDIT_PG_BIN ?? "C:/Program Files/PostgreSQL/17/bin";
const available = existsSync(join(bin,"initdb.exe"));
const directory = available ? mkdtempSync(join(tmpdir(),"coinops-incident-sql-")) : "";
const port = 49152 + process.pid % 10000;
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG"))),
  NODE_ENV: process.env.NODE_ENV ?? "test",
  PGHOST:"127.0.0.1",PGPORT:String(port),PGUSER:"incident_test",PGDATABASE:"postgres",PGPASSFILE:join(directory,"none") };
const sql = (query:string) => execFileSync(join(bin,"psql.exe"),["-X","-w","-h","127.0.0.1","-p",String(port),"-U","incident_test","-d","postgres","-v","ON_ERROR_STOP=1","-qAt","-f","-"],
  {env,windowsHide:true,encoding:"utf8",stdio:"pipe",input:query}).trim();
const op="11111111-1111-4111-8111-111111111111", account="22222222-2222-4222-8222-222222222222",engine="33333333-3333-4333-8333-333333333333";
const migration=readFileSync(new URL("../../../../supabase/migrations/20261005124719_add_incident_knowledge_and_trading_slo.sql",import.meta.url),"utf8");
before(()=>{
  if(!available)return;
  execFileSync(join(bin,"initdb.exe"),["-D",directory,"-U","incident_test","-A","trust","--no-locale","-E","UTF8"],{env,windowsHide:true,stdio:"pipe"});
  execFileSync(join(bin,"pg_ctl.exe"),["-D",directory,"-l",join(directory,"server.log"),"-o",`-h 127.0.0.1 -p ${port}`,"-w","start"],{env,windowsHide:true,stdio:"ignore"});
  sql(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema coinops; grant usage on schema coinops to anon,authenticated,service_role;
    create table coinops.operators(id uuid primary key);
    create table coinops.trading_engines(id uuid primary key,exchange_account_id uuid,operator_id uuid,environment text);
    create table coinops.watchdog_checks(shard_id text primary key);
    create table coinops.watchdog_incidents(incident_id uuid primary key default gen_random_uuid(),engine_id uuid,account_id uuid,
      incident_key text,detected_condition text,opened_at timestamptz default now(),last_seen_at timestamptz default now(),
      result text default 'OPEN',actions_taken jsonb default '[]',resolved_at timestamptz,recovery_duration_ms bigint);
    create table coinops.robot_v1_live_alerts(trading_engine_id uuid,exchange_account_id uuid,operator_id uuid,
      alert_key text,code text,details jsonb,first_seen_at timestamptz,last_seen_at timestamptz);
    create table coinops.robot_v1_live_events(id uuid default gen_random_uuid(),operator_id uuid,run_id uuid,trading_engine_id uuid,
      observed_at timestamptz default now(),event_type text,details jsonb);
    insert into coinops.operators values('${op}');
    insert into coinops.trading_engines values('${engine}','${account}','${op}','REAL');
    grant select,insert,update on all tables in schema coinops to service_role;`);
  sql(migration);
});
after(()=>{if(available&&existsSync(join(directory,"postmaster.pid")))execFileSync(join(bin,"pg_ctl.exe"),["-D",directory,"-m","fast","-w","stop"],{env,windowsHide:true,stdio:"pipe"});});
const check=(name:string,fn:()=>void)=>test(name,{skip:available?false:"Local PostgreSQL unavailable"},fn);
check("registry deduplicates repeated observations, tracks normal recovery, and raises post-fix recurrence",()=>{
  const id=sql(`insert into coinops.watchdog_incidents(engine_id,account_id,incident_key,detected_condition)
    values('${engine}','${account}','run:READ_FAILED','READ_FAILED') returning incident_id`);
  sql(`select coinops.record_incident_knowledge('${id}'); select coinops.record_incident_knowledge('${id}');`);
  assert.equal(sql(`select occurrences from coinops.incident_knowledge where incident_signature='READ_FAILED:UNKNOWN:UNKNOWN'`),"1");
  sql(`update coinops.watchdog_incidents set result='RECOVERED',resolved_at=now(),recovery_duration_ms=1000,
    actions_taken='[{"action":"VERIFIED_READ_RECOVERY","status":"RESUMED"}]' where incident_id='${id}'`);
  assert.equal(sql(`select auto_recoveries from coinops.incident_knowledge where incident_signature='READ_FAILED:UNKNOWN:UNKNOWN'`),"1");
  sql(`update coinops.incident_knowledge set status='FIXED',fixed_at=now(),permanent_fix_version='fixture',regression_test='fixture'
    where incident_signature='READ_FAILED:UNKNOWN:UNKNOWN';
    insert into coinops.watchdog_incidents(engine_id,account_id,incident_key,detected_condition)
    values('${engine}','${account}','run2:READ_FAILED','READ_FAILED')`);
  assert.equal(sql(`select status||':'||priority||':'||occurrences from coinops.incident_knowledge where incident_signature='READ_FAILED:UNKNOWN:UNKNOWN'`),"RECURRENCE_REGRESSION:HIGH:2");
  const summary=JSON.parse(sql(`set role service_role; select coinops.trading_reliability_summary('${op}',now()-interval '1 day');`));
  assert.equal(summary.engineRecoveries,1); assert.equal(summary.watchdogRecoveries,0);
  assert.equal(summary.NORMAL_TRADING_WATCHDOG_DEPENDENCY_RATE,null);
});
check("SLO covers more than 1000 events, preserves operator/engine identity and reports unknown attribution",()=>{
  sql(`insert into coinops.robot_v1_live_events(operator_id,run_id,trading_engine_id,event_type,details)
    select '${op}','${account}','${engine}','SLOT_PROFIT_CREDITED',jsonb_build_object('tp_client_order_id','tp-'||n) from generate_series(1,1001)n;`);
  let summary=JSON.parse(sql(`select coinops.trading_reliability_summary('${op}',now()-interval '1 day')`));
  assert.equal(summary.gains,1001); assert.equal(summary.unattributedEvents,1001); assert.equal(summary.NORMAL_TRADING_WATCHDOG_DEPENDENCY_RATE,null);
  sql(`insert into coinops.robot_v1_live_events(operator_id,run_id,trading_engine_id,event_type,details)
    select '${op}','${account}','${engine}','TRADING_FLOW_OWNER',jsonb_build_object('client_order_id','tp-'||n,'kind','GAIN','source','ENGINE') from generate_series(1,1001)n;`);
  summary=JSON.parse(sql(`select coinops.trading_reliability_summary('${op}',now()-interval '1 day')`));
  assert.equal(summary.NORMAL_TRADING_WATCHDOG_DEPENDENCY_RATE,0); assert.equal(summary.unattributedEvents,0);
  const foreign=JSON.parse(sql(`select coinops.trading_reliability_summary('${account}',now()-interval '1 day')`));
  assert.equal(foreign.gains,0); assert.equal(foreign.incidents,0); assert.deepEqual(foreign.signatures,[]);
});
check("RLS denies client registry and SLO access; observability never mutates financial tables",()=>{
  assert.equal(sql(`select has_table_privilege('authenticated','coinops.incident_knowledge','SELECT')||':'||
    has_function_privilege('anon','coinops.trading_reliability_summary(uuid,timestamptz,timestamptz)','EXECUTE')`),"false:false");
  assert.equal(sql(`select relforcerowsecurity from pg_class where oid='coinops.incident_knowledge'::regclass`),"t");
  assert.doesNotMatch(migration,/\b(update|delete from|insert into) coinops\.(trading_engines|robot_v1_live_(slots|orders|runs|fills|slot_accounts))\b/i);
});
