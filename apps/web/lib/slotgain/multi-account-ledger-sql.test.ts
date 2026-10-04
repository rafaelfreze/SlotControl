import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

// Full versioned Robot V1 chain in a disposable loopback PostgreSQL. No .env,
// linked Supabase project, production secrets, network exchange or financial I/O.
const bin=process.env.COINOPS_AUDIT_PG_BIN??"C:/Program Files/PostgreSQL/17/bin";
const available=existsSync(join(bin,"initdb.exe"));
const directory=available?mkdtempSync(join(tmpdir(),"coinops-multi-account-")):"";
let port=0;
let postgresProcess:ChildProcess|null=null;
const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("PG"))),
 NODE_ENV:process.env.NODE_ENV??"test",
 PGHOST:"127.0.0.1",PGPORT:String(port),PGUSER:"multi_account_audit",PGDATABASE:"postgres",PGPASSFILE:join(directory,"no-credentials")};
const args=()=>["-X","-w","-h","127.0.0.1","-p",String(port),"-U","multi_account_audit","-d","postgres","-v","ON_ERROR_STOP=1","-At"];
function invoke(extra:string[]){try{return execFileSync(join(bin,"psql.exe"),[...args(),...extra],{env,windowsHide:true,encoding:"utf8",stdio:"pipe"}).replace(/\r/g,"").trim();}
 catch(error){const e=error as {stderr?:Buffer};throw new Error(e.stderr?.toString()??String(error));}}
function invokeAsync(extra:string[]){return new Promise<string>((resolve,reject)=>{
 execFile(join(bin,"psql.exe"),[...args(),...extra],{env,windowsHide:true,encoding:"utf8"},(error,stdout,stderr)=>{
  if(error)reject(new Error(stderr||String(error)));else resolve(stdout.replace(/\r/g,"").trim());
 });
});}
const sql=(s:string)=>invoke(["-c",s]);
const tx=(s:string)=>sql(`begin;set local request.jwt.claim.role='service_role';${s};rollback;`);
const product="11111111-1111-4111-8111-111111111111",tenant="22222222-2222-4222-8222-222222222222",user="33333333-3333-4333-8333-333333333333";
const scope=`'${product}','${tenant}','${user}'`;
const migration="20260924141913_add_multi_account_operator_engine_isolation.sql";
let operator="",account="",engine="",testEngine="";
const scaffold=`create role anon;create role authenticated;create role service_role bypassrls;
 create schema coinops;create schema private;create schema auth;
 grant usage on schema coinops,private,auth to anon,authenticated,service_role;
 create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;
 create function private.coinops_touch_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;
 create function private.coinops_can_access_row(p uuid,t uuid,u uuid) returns boolean language sql as $$
 select coalesce(current_setting('audit.master',true),'false')='true' or (p::text=current_setting('audit.product',true) and t::text=current_setting('audit.tenant',true) and u::text=current_setting('audit.user_id',true))$$;
 create table public.product_tenants(product_id uuid,tenant_id uuid,primary key(product_id,tenant_id));
 insert into public.product_tenants values('${product}','${tenant}');`;
before(async()=>{
 if(!available)return;
 const reservation=createServer();
 await new Promise<void>((resolve,reject)=>{reservation.once("error",reject);reservation.listen(0,"127.0.0.1",resolve);});
 const address=reservation.address();
 if(!address||typeof address==="string")throw new Error("Local audit port not allocated");
 port=address.port;env.PGPORT=String(port);
 await new Promise<void>((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()));
 execFileSync(join(bin,"initdb.exe"),["-D",directory,"-U","multi_account_audit","-A","trust","--no-locale","-E","UTF8"],{env,windowsHide:true,stdio:"pipe"});
 postgresProcess=spawn(join(bin,"postgres.exe"),["-D",directory,"-h","127.0.0.1","-p",String(port)],{env,windowsHide:true,stdio:"ignore"});
 for(let attempt=0;attempt<80;attempt+=1){
  try{sql("select 1");break;}catch(error){
   if(postgresProcess.exitCode!==null)throw new Error(`Disposable PostgreSQL exited before readiness: ${String(error)}`);
   if(attempt===79)throw error;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
 }
 sql(scaffold);
 const path=resolve("../../supabase/migrations");
 for(const file of readdirSync(path).filter(n=>n>="20260922012849"&&n<"20260924100000").sort())invoke(["-1","-f",join(path,file)]);
 sql(`insert into coinops.robot_v1_configs(product_id,tenant_id,user_id,asset,symbol,capital_usdc,gain_rate,entry_spacing)
  values(${scope},'BTC','BTCUSDC',250,.005,.01),(${scope},'SOL','SOLUSDC',250,.005,.01);
 insert into coinops.robot_v1_testnet_runs(product_id,tenant_id,user_id,asset,symbol,anchor_price,slot_notional_usdc,gain_rate,entry_spacing)
  values(${scope},'BTC','BTCUSDC',100000,10,.005,.01),(${scope},'SOL','SOLUSDC',100,10,.005,.01);
 insert into coinops.robot_v1_ath_profiles(product_id,tenant_id,user_id,environment,asset,gain_rate,normal_spacing_rate,post_ath_spacing_rate)
  select ${scope},e,a,.005,.01,.05 from unnest(array['SHADOW','TESTNET','REAL'])e cross join unnest(array['BTC','SOL'])a;
 insert into coinops.robot_v1_live_preparations(product_id,tenant_id,user_id,asset,symbol,monthly_target,configured_live_capital_brl,max_order_notional_brl,max_total_exposure_brl)
  values(${scope},'BTC','BTCBRL',7,450,18,450),(${scope},'SOL','SOLBRL',2,275,11,275);
 insert into coinops.robot_v1_live_global_caps(product_id,tenant_id,user_id,max_total_live_exposure_brl)values(${scope},725);
 insert into coinops.robot_v1_live_slot_accounts(product_id,tenant_id,user_id,asset,slot_number,balance_brl,contribution_brl)
  select ${scope},a,n,case a when 'BTC' then 18 else 11 end,case a when 'BTC' then 18 else 11 end from unnest(array['BTC','SOL'])a cross join generate_series(1,25)n;
 insert into coinops.robot_v1_testnet_slots(run_id,product_id,tenant_id,user_id,slot_number,entry_state,target_buy_price,balance_usdc,entry_reference_price)
 select id,${scope},1,'OPEN',100000,100,100000 from coinops.robot_v1_testnet_runs where asset='BTC';
 insert into coinops.robot_v1_testnet_orders(run_id,slot_id,product_id,tenant_id,user_id,slot_number,side,purpose,revision,client_order_id,status,requested_quantity,price,executed_quantity,cumulative_quote)
 select s.run_id,s.id,${scope},1,x.side,x.purpose,1,'COV1-BTC-1-1-'||x.side||'-'||substr(md5(s.id::text||x.side),1,18),
 x.status,.001,case when x.side='BUY' then 100000 else 100500 end,case when x.side='BUY' then .001 else 0 end,case when x.side='BUY' then 100 else 0 end
 from coinops.robot_v1_testnet_slots s cross join (values('BUY','INITIAL','FILLED'),('SELL','TP','NEW'))x(side,purpose,status);
 create table public.audit_before as select 'LIVE_ACCOUNTS' kind,to_jsonb(a) data from coinops.robot_v1_live_slot_accounts a
  union all select 'LIVE_PREPARATIONS',to_jsonb(p) from coinops.robot_v1_live_preparations p
  union all select 'TESTNET_SLOTS',to_jsonb(s) from coinops.robot_v1_testnet_slots s
  union all select 'TESTNET_ORDERS',to_jsonb(o) from coinops.robot_v1_testnet_orders o;`);
 invoke(["-f",join(path,migration)]);
 invoke(["-f",join(path,"20260924142810_optimize_operator_rls_allowed_set.sql")]);
 invoke(["-f",join(path,"20260924144559_finalize_multi_account_engine_idempotency.sql")]);
 operator=sql("select id from coinops.operators");account=sql("select id from coinops.exchange_accounts where is_legacy_default");
 engine=sql("select id from coinops.trading_engines where environment='REAL' and symbol='BTCBRL'");
 testEngine=sql("select id from coinops.trading_engines where environment='TESTNET' and symbol='SOLUSDC'");
});
after(()=>{postgresProcess?.kill();});
const check=(name:string,fn:()=>void|Promise<void>)=>test(name,{skip:available?false:"Local PostgreSQL unavailable: multi-account SQL NOT verified"},fn);
check("5.6 SQL: metadata backfill preserves legacy principal, flags, config, IDs and timestamps",()=>{
 assert.equal(sql(`select count(*)=6 and bool_and(legacy_compatible) from coinops.trading_engines`),"t");
 assert.equal(sql(`select bool_and(ath_reference_symbol=base_asset||'USDC') from coinops.trading_engines`),"t");
 assert.equal(sql(`select bool_and(not exists(select 1 from jsonb_each(b.data) d where to_jsonb(a)->d.key is distinct from d.value))
  from public.audit_before b join coinops.robot_v1_live_slot_accounts a on b.data->>'asset'=a.asset and (b.data->>'slot_number')::integer=a.slot_number where b.kind='LIVE_ACCOUNTS'`),"t");
 assert.equal(sql(`select bool_and(not exists(select 1 from jsonb_each(b.data)d where to_jsonb(p)->d.key is distinct from d.value))
  from public.audit_before b join coinops.robot_v1_live_preparations p on b.data->>'id'=p.id::text where b.kind='LIVE_PREPARATIONS'`),"t");
 assert.equal(sql(`select count(*)=50 and sum(balance_quote)=725 and bool_and(quote_asset='BRL') from coinops.robot_v1_live_slot_accounts`),"t");
});
check("5.6 SQL: new account and engine are inactive and fail closed by default",()=>{
 const out=tx(`insert into coinops.exchange_accounts(operator_id,display_name)values('${operator}','Fixture B');
 insert into coinops.trading_engines(operator_id,exchange_account_id,environment,symbol,base_asset,quote_asset)
 select '${operator}',id,'REAL','BTCUSDT','BTC','USDT' from coinops.exchange_accounts where display_name='Fixture B';
 select e.status='INACTIVE' and e.kill_switch and not e.legacy_compatible and a.status='INACTIVE' and a.kill_switch
 from coinops.trading_engines e join coinops.exchange_accounts a on a.id=e.exchange_account_id where a.display_name='Fixture B'`);
 assert.ok(out.split("\n").includes("t"));
});
check("5.6 SQL: backfill preserves existing OPEN position, filled BUY and resident TP byte for byte",()=>{
 assert.equal(sql(`select bool_and(not exists(select 1 from jsonb_each(b.data)d where to_jsonb(s)->d.key is distinct from d.value))
 from public.audit_before b join coinops.robot_v1_testnet_slots s on b.data->>'id'=s.id::text where b.kind='TESTNET_SLOTS'`),"t");
 assert.equal(sql(`select bool_and(not exists(select 1 from jsonb_each(b.data)d where to_jsonb(o)->d.key is distinct from d.value))
 from public.audit_before b join coinops.robot_v1_testnet_orders o on b.data->>'id'=o.id::text where b.kind='TESTNET_ORDERS'`),"t");
 assert.equal(sql(`select count(*)=2 and count(distinct trading_engine_id)=1 from coinops.robot_v1_testnet_orders`),"t");
});
check("5.6 SQL: wrong account or operator cannot be attached to an owned engine",()=>{
 assert.throws(()=>tx(`insert into coinops.robot_v1_live_slot_accounts(operator_id,exchange_account_id,trading_engine_id,product_id,tenant_id,user_id,asset,slot_number)
  values('${operator}','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','${engine}',${scope},'BTC',1)`),/COINOPS_ENGINE_SCOPE_DENIED/);
 assert.throws(()=>tx(`update coinops.robot_v1_live_slot_accounts set trading_engine_id='${testEngine}' where trading_engine_id='${engine}'`),/COINOPS_ENGINE_SCOPE_DENIED|COINOPS_ENGINE_IDENTITY/);
});
check("5.6 SQL: explicit missing engine never resolves the legacy account",()=>{
 assert.throws(()=>sql(`select id from private.coinops_resolve_engine(${scope},'REAL','BTC','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',null)`),/COINOPS_ENGINE_SCOPE_DENIED/);
 assert.equal(sql(`select id from private.coinops_resolve_engine(${scope},'REAL','BTC',null,null)`),engine);
});
check("5.6 SQL: RLS denies another operator, client writes and credential metadata",()=>{
 const owned=`set local audit.product='${product}';set local audit.tenant='${tenant}';set local audit.user_id='${user}';set local role authenticated;`;
 assert.ok(tx(`${owned}select count(*)=1 from coinops.exchange_accounts`).split("\n").includes("t"));
 assert.ok(tx(`set local audit.product='${product}';set local audit.tenant='${tenant}';set local audit.user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';set local role authenticated;select count(*)=0 from coinops.trading_engines`).split("\n").includes("t"));
 assert.throws(()=>tx(`${owned}select credential_ref from coinops.exchange_accounts`),/permission denied/);
 assert.throws(()=>tx(`${owned}update coinops.exchange_accounts set kill_switch=false`),/permission denied/);
 assert.ok(tx(`update coinops.operators set status='DISABLED' where id='${operator}';${owned}select count(*)=0 from coinops.trading_engines`).split("\n").includes("t"));
 assert.ok(tx(`update coinops.operators set status='DISABLED' where id='${operator}';${owned}select count(*)=0 from coinops.robot_v1_live_slot_accounts`).split("\n").includes("t"));
});
check("5.6 SQL: RLS allowed set preserves master, disabled, anonymous and service access",()=>{
 const other="88888888-8888-4888-8888-888888888888";
 const setup=`insert into coinops.operators(id,product_id,tenant_id,user_id,status)values('${other}','${product}','${tenant}','${other}','ACTIVE');
 insert into coinops.exchange_accounts(operator_id,display_name)values('${other}','Other operator');`;
 assert.ok(tx(`${setup}set local audit.master='true';set local role authenticated;select count(*)=2 from coinops.exchange_accounts`).split("\n").includes("t"));
 assert.ok(tx(`${setup}update coinops.operators set status='DISABLED' where id='${operator}';set local audit.master='true';set local role authenticated;select count(*)=1 from coinops.exchange_accounts`).split("\n").includes("t"));
 assert.ok(tx(`${setup}update coinops.operators set status='DISABLED' where id='${operator}';set local role service_role;select count(*)=2 from coinops.exchange_accounts`).split("\n").includes("t"));
 assert.throws(()=>tx("set local role anon;select id from coinops.exchange_accounts"),/permission denied/);
 assert.equal(sql(`select count(*)=34 from pg_policies where schemaname='coinops' and policyname in ('operator_owned','operator_context_visible') and tablename<>'operators' and qual like '%SELECT operators.id%'`),"t");
});
check("5.6 SQL: RLS 9000-event plan computes authorized operators only once",()=>{
 const seed=`insert into coinops.robot_v1_testnet_events(run_id,product_id,tenant_id,user_id,event_key,event_type)
 select r.id,${scope},'RLS_BENCH:'||n,'RLS_BENCH' from coinops.robot_v1_testnet_runs r cross join generate_series(1,9000)n where r.asset='BTC';
 analyze coinops.robot_v1_testnet_events;
 set local audit.product='${product}';set local audit.tenant='${tenant}';set local audit.user_id='${user}';`;
 const explain=(legacy:boolean)=>{
  const output=tx(`${seed}${legacy?"alter policy operator_context_visible on coinops.robot_v1_testnet_events using(private.coinops_operator_owned(operator_id));":""}
   set local role authenticated;explain(analyze,buffers,format json)select count(*) from coinops.robot_v1_testnet_events`);
  return JSON.parse(output.slice(output.indexOf("[\n"),output.lastIndexOf("\n]")+2))[0] as {Plan:Record<string,unknown>;"Execution Time":number};
 };
 const before=explain(true),after=explain(false);
 const nodes:Record<string,unknown>[]=[];
 const visit=(node:Record<string,unknown>)=>{nodes.push(node);for(const child of (node.Plans??[]) as Record<string,unknown>[])visit(child);};visit(after.Plan);
 assert.equal(nodes.find(node=>node["Relation Name"]==="operators")?.["Actual Loops"],1);
 assert.ok(JSON.stringify(before.Plan).includes("coinops_operator_owned"));
 assert.ok(!JSON.stringify(after.Plan).includes("coinops_operator_owned"));
 assert.equal(after.Plan["Actual Rows"],1);
 console.info(`RLS local 9000 rows: per-row=${before["Execution Time"]}ms; allowed-set=${after["Execution Time"]}ms; operator scan loops=1`);
});
const accountB="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",engineB="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",runB="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const fixtureB=()=>`insert into coinops.exchange_accounts(id,operator_id,display_name)values('${accountB}','${operator}','Fixture B');
 insert into coinops.trading_engines(id,operator_id,exchange_account_id,environment,symbol,base_asset,quote_asset)
 values('${engineB}','${operator}','${accountB}','TESTNET','SOLUSDT','SOL','USDT');
 insert into coinops.robot_v1_testnet_runs(id,product_id,tenant_id,user_id,asset,symbol,trading_engine_id,quote_asset,anchor_price,slot_notional_usdc,gain_rate,entry_spacing)
 values('${runB}',${scope},'SOL','SOLUSDT','${engineB}','USDT',100,100,.005,.01);
 insert into coinops.robot_v1_ath_profiles(product_id,tenant_id,user_id,environment,asset,trading_engine_id,quote_asset,gain_rate,normal_spacing_rate,post_ath_spacing_rate)
 values(${scope},'TESTNET','SOL','${engineB}','USDT',.005,.01,.05);
 insert into coinops.robot_v1_testnet_slots(run_id,product_id,tenant_id,user_id,slot_number,entry_state,target_buy_price,balance_usdc,entry_reference_price)
 select r.id,${scope},n,case when n=1 then 'OPEN' else 'PLANNED' end,100,100,100
 from coinops.robot_v1_testnet_runs r cross join generate_series(1,25)n where r.trading_engine_id in ('${testEngine}','${engineB}');
 insert into coinops.robot_v1_testnet_orders(run_id,slot_id,product_id,tenant_id,user_id,slot_number,side,purpose,revision,client_order_id,status,requested_quantity,price,executed_quantity,cumulative_quote)
 select s.run_id,s.id,${scope},1,x.side,x.purpose,1,'COV1-SOL-1-1-'||x.side||'-'||substr(md5(s.id::text||x.side),1,18),
 x.status,1,case when x.side='BUY' then 100 else 100.5 end,case when x.side='BUY' then 1 else 0 end,case when x.side='BUY' then 100 else 0 end
 from coinops.robot_v1_testnet_slots s cross join (values('BUY','INITIAL','FILLED'),('SELL','TP','NEW'))x(side,purpose,status)
 where s.slot_number=1 and s.trading_engine_id in ('${testEngine}','${engineB}');`;
const manualCall=(e:string,key:string,kind="MANUAL_CONTRIBUTION",gain=0,amount=5,balance=100,lifetime=0,monthly=0,reversal="null")=>
 `coinops.apply_robot_v1_manual_adjustment(${scope},'${user}','TESTNET','SOL',1,'${kind}',${gain},'USD',${amount},null,null,null,'Audit fixture',null,${reversal},'${key}',${balance},${lifetime},${monthly},'${e}')`;
check("5.6 SQL: engine-selected OPEN adjustment preserves A, existing B position and TP",()=>{
 const out=tx(`${fixtureB()}create temp table unchanged_orders as select to_jsonb(o)j from coinops.robot_v1_testnet_orders o;
 select id from ${manualCall(engineB,"multi-account-idempotent-001")};
 select id from ${manualCall(engineB,"multi-account-idempotent-001")};
 select balance_quote=105 and quote_asset='USDT' from coinops.robot_v1_testnet_slots where trading_engine_id='${engineB}' and slot_number=1;
 select balance_quote=100 from coinops.robot_v1_testnet_slots where trading_engine_id='${testEngine}' and slot_number=1;
 select count(*)=1 from coinops.robot_v1_manual_adjustments where trading_engine_id='${engineB}';
 select not exists((select to_jsonb(o)from coinops.robot_v1_testnet_orders o except select j from unchanged_orders)
 union all(select j from unchanged_orders except select to_jsonb(o)from coinops.robot_v1_testnet_orders o));`);
 assert.equal(out.split("\n").filter(x=>x==="t").length,4);
});
check("5.6 SQL: same idempotency key in different engines remains isolated and gain rank uses native engine",()=>{
 const key="multi-account-same-key-001";
 const out=tx(`${fixtureB()}select id from ${manualCall(testEngine,key,"MANUAL_TARGET_GAIN",1,1)};
 select id from ${manualCall(engineB,key,"MANUAL_TARGET_GAIN",1,1)};
 select count(*)=2 and count(distinct trading_engine_id)=2 and bool_and(lifetime_gain_count=1)
 from coinops.robot_v1_slot_gain_totals where asset='SOL';
 select physical_slot_id='TESTNET:${engineB}:1' and quote_asset='USDT' from coinops.robot_v1_slot_gain_totals where trading_engine_id='${engineB}';`);
 assert.equal(out.split("\n").filter(x=>x==="t").length,2);
});
check("5.6 SQL: reversal targeting another engine and forged child parent are rejected",()=>{
 assert.throws(()=>tx(`${fixtureB()}select id from ${manualCall(testEngine,"multi-account-reverse-key-001")};
 select id from ${manualCall(engineB,"multi-account-reverse-key-002","REVERSAL",0,0,100,0,0,"(select id from coinops.robot_v1_manual_adjustments limit 1)")}`),/query returned no rows/);
 assert.throws(()=>tx(`${fixtureB()}update coinops.robot_v1_testnet_orders set trading_engine_id='${testEngine}' where trading_engine_id='${engineB}'`),/COINOPS_ENGINE_PARENT_MISMATCH/);
});
check("5.6 SQL: immutable engine identity cannot be moved to another account or market",()=>{
 assert.throws(()=>tx(`${fixtureB()}update coinops.trading_engines set exchange_account_id='${account}' where id='${engineB}'`),/COINOPS_ENGINE_IDENTITY_IMMUTABLE/);
 assert.throws(()=>tx(`${fixtureB()}update coinops.trading_engines set quote_asset='USDC',symbol='SOLUSDC' where id='${engineB}'`),/COINOPS_ENGINE_IDENTITY_IMMUTABLE/);
});
check("5.6 SQL: identical decision and reset keys are isolated after contract migration",()=>{
 assert.equal(sql(`select count(*)=6 and bool_and(i.indisvalid and i.indisready)
 from (values('robot_v1_strategy_decisions','decision_id'),('robot_v1_audit_events','idempotency_key'),
 ('robot_v1_slots','idempotency_key'),('robot_v1_live_alerts','alert_key'),
 ('robot_v1_live_runs','reset_idempotency_key'),('robot_v1_testnet_runs','reset_idempotency_key')) expected(table_name,key_column)
 join pg_constraint c on c.conrelid=('coinops.'||expected.table_name)::regclass
  and c.contype='u' and pg_get_constraintdef(c.oid)='UNIQUE (trading_engine_id, '||expected.key_column||')'
 join pg_index i on i.indexrelid=c.conindid`),"t");
 const hash="e".repeat(64);
 const out=tx(`${fixtureB()}
 insert into coinops.robot_v1_strategy_decisions(product_id,tenant_id,user_id,environment,asset,decision_id,strategy_version,cycle_id,action_type,priority,reason,expected_next_state)
 select ${scope},'TESTNET','SOL','${hash}','4.3.1',id,'WAIT',1,'Fixture','{}'
 from coinops.robot_v1_testnet_runs where trading_engine_id in ('${testEngine}','${engineB}');
 select count(*)=2 and count(distinct trading_engine_id)=2 from coinops.robot_v1_strategy_decisions where decision_id='${hash}';
 insert into coinops.robot_v1_testnet_runs(product_id,tenant_id,user_id,asset,symbol,trading_engine_id,quote_asset,status,anchor_price,slot_notional_usdc,gain_rate,entry_spacing,previous_run_id,reset_idempotency_key)
 select ${scope},asset,symbol,trading_engine_id,quote_asset,'COMPLETED',anchor_price,slot_notional_usdc,gain_rate,entry_spacing,id,'${hash}'
 from coinops.robot_v1_testnet_runs where trading_engine_id in ('${testEngine}','${engineB}');
 select count(*)=2 and count(distinct trading_engine_id)=2 from coinops.robot_v1_testnet_runs where reset_idempotency_key='${hash}';`);
 assert.equal(out.split("\n").filter(x=>x==="t").length,2);
});
check("5.6 SQL: NULL-engine alerts deduplicate per account without colliding with another account or engine",()=>{
 const key="ACCOUNT_ALERT_FIXTURE";
 const alert=(selectedAccount:string,selectedEngine:string|null)=>`insert into coinops.robot_v1_live_alerts
 (product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,asset,alert_key,severity,code)
 values(${scope},'${operator}','${selectedAccount}',${selectedEngine?`'${selectedEngine}'`:"null"},${selectedEngine?"'BTC'":"null"},'${key}','WARNING','COINOPS_TEST_ALERT')`;
 assert.throws(()=>tx(`${alert(account,null)};${alert(account,null)}`),/robot_v1_live_account_alert_key_unique/);
 const out=tx(`insert into coinops.exchange_accounts(id,operator_id,display_name)values('${accountB}','${operator}','Account alert fixture');
 ${alert(account,null)};
 ${alert(account,null)} on conflict(exchange_account_id,alert_key) where trading_engine_id is null do update set code='COINOPS_TEST_REPLAY';
 ${alert(accountB,null)};${alert(account,engine)};
 select count(*)=3 and count(*)filter(where trading_engine_id is null)=2 and count(distinct exchange_account_id)=2
 from coinops.robot_v1_live_alerts where alert_key='${key}';
 select code='COINOPS_TEST_REPLAY' from coinops.robot_v1_live_alerts where exchange_account_id='${account}' and trading_engine_id is null and alert_key='${key}';`);
 assert.equal(out.split("\n").filter(x=>x==="t").length,2);
});
check("5.6 SQL: onboarding is append-only, actor-scoped and never enables engine",()=>{
 const fixture=`${fixtureB()}insert into coinops.account_onboarding_checks(operator_id,exchange_account_id,trading_engine_id,check_key,status,evidence,created_by,idempotency_key)
 values('${operator}','${accountB}','${engineB}','READ_ONLY_CONNECTION','PASS','{"source":"local_fixture"}','${user}','onboarding-fixture-001');`;
 const out=tx(`${fixture}
 select e.status='INACTIVE' and e.kill_switch and a.status='INACTIVE' and a.kill_switch from coinops.trading_engines e join coinops.exchange_accounts a on a.id=e.exchange_account_id where e.id='${engineB}';
 select count(*)=2 and bool_and(details::text not like '%legacy-binance-production%') from coinops.operator_admin_events where exchange_account_id='${accountB}';`);
 assert.equal(out.split("\n").filter(x=>x==="t").length,2);
 assert.throws(()=>tx(`${fixture}update coinops.account_onboarding_checks set status='FAIL' where exchange_account_id='${accountB}'`),/COINOPS_ONBOARDING_AUDIT_IMMUTABLE/);
 assert.throws(()=>tx(`${fixture}delete from coinops.operator_admin_events where exchange_account_id='${accountB}'`),/COINOPS_ONBOARDING_AUDIT_IMMUTABLE/);
 assert.throws(()=>tx(`${fixtureB()}insert into coinops.account_onboarding_checks(operator_id,exchange_account_id,check_key,created_by,idempotency_key)
 values('${operator}','${accountB}','READ_ONLY_CONNECTION','${accountB}','onboarding-fixture-002')`),/COINOPS_ONBOARDING_ACTOR_DENIED/);
});
check("5.6 SQL: settings audit captures only six numeric config fields and no credentials",()=>{
 const safe={slot_count:25,initial_capital_quote:250,gain_rate:0.005,normal_spacing_rate:0.01,post_ath_spacing_rate:0.05,monthly_target:2};
 const fixture={...safe,api_secret:"DO_NOT_LOG_FIXTURE",credential_ref:"DO_NOT_LOG_FIXTURE",unknown_number:999};
 const out=tx(`${fixtureB()}
 update coinops.trading_engines set config='${JSON.stringify(fixture)}' where id='${engineB}';
 select details#>'{before,config}'='{}'::jsonb and details#>'{after,config}'='${JSON.stringify(safe)}'::jsonb
 from coinops.operator_admin_events where trading_engine_id='${engineB}' and event_type='TRADING_ENGINES_UPDATE';
 select bool_and(details::text not like '%DO_NOT_LOG_FIXTURE%' and details::text not like '%unknown_number%')
 from coinops.operator_admin_events where exchange_account_id='${accountB}';
 select private.coinops_audit_numeric_engine_config('{"slot_count":"25","gain_rate":0.005,"monthly_target":null,"api_secret":"DO_NOT_LOG_FIXTURE"}')='{"gain_rate":0.005}'::jsonb;`);
 assert.equal(out.split("\n").filter(x=>x==="t").length,3);
});
const liveRun="dddddddd-dddd-4ddd-8ddd-dddddddddddd",liveSlot="99999999-9999-4999-8999-999999999999",lease="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const buy="COR1-BTC-1-1-BUY-0123456789abcd",sell="COR1-BTC-1-1-SELL-0123456789abcd";
const liveFixture=()=>`insert into coinops.robot_v1_live_runs(id,product_id,tenant_id,user_id,asset,symbol,status,anchor_price,slot_notional_brl,gain_rate,entry_spacing,entry_regime,config_version,config_snapshot,strategy_version)
 values('${liveRun}',${scope},'BTC','BTCBRL','PREPARING',437724,18,.012,.01,'NORMAL',1,'{}','4.3.1');
 insert into coinops.robot_v1_live_slots(id,run_id,product_id,tenant_id,user_id,slot_number,target_buy_price,entry_reference_price,operational_rank)
 select case when n=1 then '${liveSlot}'::uuid else gen_random_uuid() end,'${liveRun}',${scope},n,437724,437724,n from generate_series(1,25)n;
 select id from coinops.activate_robot_v1_live_cycle('${liveRun}');
 update coinops.robot_v1_live_runs set lease_owner='${lease}',lease_until=now()+interval '5 minutes' where id='${liveRun}';
 insert into coinops.robot_v1_strategy_decisions(product_id,tenant_id,user_id,environment,asset,decision_id,strategy_version,cycle_id,slot_id,action_type,priority,reason,expected_next_state,operation_sequence)
 values(${scope},'REAL','BTC','${"a".repeat(64)}','4.3.1','${liveRun}','${liveSlot}','OPEN_INITIAL_MARKET',1,'Fixture','{}',1),
 (${scope},'REAL','BTC','${"b".repeat(64)}','4.3.1','${liveRun}','${liveSlot}','CREATE_TP',1,'Fixture','{}',1);`;
const prepareBuy=()=>`coinops.prepare_robot_v1_live_order('${liveRun}','${liveSlot}','BUY','INITIAL',1,'${buy}',null,18,null,'${"a".repeat(64)}','${lease}')`;
const sync=(client:string,id:string,tradeId:string,quote:number,side:"BUY"|"SELL")=>`select status from coinops.sync_robot_v1_live_order(
 (select id from coinops.robot_v1_live_orders where client_order_id='${client}'),'${id}','FILLED',.00004,${quote},
 '[{"id":"${tradeId}","quantity":0.00004,"quoteQuantity":${quote},"commission":0.000002,"commissionAsset":"BNB","isBuyer":${side==="BUY"},"filledAt":"${new Date().toISOString()}"}]',5000,now(),'${lease}');`;
check("5.6 SQL: legacy LIVE activation, fill, TP and settlement remain transactional and idempotent",()=>{
 const out=tx(`${liveFixture()}select id from ${prepareBuy()};select id from ${prepareBuy()};${sync(buy,"101","1",17.5,"BUY")}
 select id from coinops.prepare_robot_v1_live_order('${liveRun}','${liveSlot}','SELL','TP',1,'${sell}',.00004,null,445000,'${"b".repeat(64)}','${lease}');
 ${sync(sell,"102","2",17.8,"SELL")}
 select slot_number from coinops.credit_robot_v1_live_closed_slot('${liveRun}','${liveSlot}',1,'${sell}',.00001,'${lease}');
 select slot_number from coinops.credit_robot_v1_live_closed_slot('${liveRun}','${liveSlot}',1,'${sell}',.00001,'${lease}');
 select balance_quote=18.28 and market_pnl_quote=.30 and fees_quote=.02 and gain_count=1
 from coinops.robot_v1_live_slot_accounts where trading_engine_id='${engine}' and slot_number=1;
 select count(*)=2 and bool_and(trading_engine_id='${engine}') from coinops.robot_v1_live_fills;
 select lifetime_gain_count=1 and monthly_gain_count=1 and market_gain_count=1 from coinops.robot_v1_slot_gain_totals where trading_engine_id='${engine}';`);
 assert.equal(out.split("\n").filter(x=>x==="t").length,3);
});
check("5.6 SQL: operator, account and engine kill switches each block a new LIVE intent",()=>{
 for(const target of [`coinops.operators where id='${operator}'`,`coinops.exchange_accounts where id='${account}'`,`coinops.trading_engines where id='${engine}'`]){
 const [table,where]=target.split(" where ");
 assert.throws(()=>tx(`${liveFixture()}update ${table} set kill_switch=true where ${where};select id from ${prepareBuy()}`),/COINOPS_ENGINE_NEW_WRITES_BLOCKED/);
 }
});
check("5.6 SQL: authenticated client cannot invoke either manual write signature",()=>{
 assert.throws(()=>tx(`set local role authenticated;select id from ${manualCall(testEngine,"multi-account-denied-001")}`),/permission denied/);
});
const otherLive=(quote:"BRL"|"USDT")=>`insert into coinops.exchange_accounts(id,operator_id,display_name,status,kill_switch)
 values('${accountB}','${operator}','Fixture B','ACTIVE',false);
 insert into coinops.trading_engines(id,operator_id,exchange_account_id,environment,symbol,base_asset,quote_asset,status,kill_switch,hard_cap_quote)
 values('${engineB}','${operator}','${accountB}','REAL','BTC${quote}','BTC','${quote}','ACTIVE',false,250);
 insert into coinops.account_quote_caps(operator_id,exchange_account_id,quote_asset,hard_cap_quote)values('${operator}','${accountB}','${quote}',20);
 insert into coinops.robot_v1_live_preparations(product_id,tenant_id,user_id,asset,symbol,quote_asset,trading_engine_id,monthly_target,configured_live_capital_brl,max_order_notional_brl,max_total_exposure_brl)
 values(${scope},'BTC','BTC${quote}','${quote}','${engineB}',7,250,10,250);
 insert into coinops.robot_v1_live_slot_accounts(product_id,tenant_id,user_id,asset,slot_number,quote_asset,trading_engine_id,balance_brl,contribution_brl)
 select ${scope},'BTC',n,'${quote}','${engineB}',10,10 from generate_series(1,25)n;
 insert into coinops.robot_v1_live_runs(id,product_id,tenant_id,user_id,asset,symbol,quote_asset,trading_engine_id,status,anchor_price,slot_notional_brl,gain_rate,entry_spacing,entry_regime,config_version,config_snapshot,strategy_version)
 values('${runB}',${scope},'BTC','BTC${quote}','${quote}','${engineB}','PREPARING',100,10,.012,.01,'NORMAL',1,'{}','4.3.1');
 insert into coinops.robot_v1_live_slots(run_id,product_id,tenant_id,user_id,slot_number,target_buy_price,entry_reference_price,operational_rank)
 select '${runB}',${scope},n,100,100,n from generate_series(1,25)n;
 select id from coinops.activate_robot_v1_live_cycle('${runB}');
 update coinops.robot_v1_live_runs set lease_owner='${lease}',lease_until=now()+interval '5 minutes' where id='${runB}';
 insert into coinops.robot_v1_strategy_decisions(product_id,tenant_id,user_id,environment,asset,decision_id,strategy_version,cycle_id,slot_id,action_type,priority,reason,expected_next_state)
 select ${scope},'REAL','BTC','${"c".repeat(64)}','4.3.1','${runB}',id,'OPEN_INITIAL_MARKET',1,'Fixture','{}'
 from coinops.robot_v1_live_slots where run_id='${runB}' and slot_number=1;`;
for(const quote of ["BRL","USDT"] as const)check(`5.6 SQL: ${quote} account cap and exchange trade ID are isolated from Rafael`,()=>{
 const client=`C2-${createHash("sha256").update(`${accountB}|${engineB}`).digest("hex").slice(0,10)}-1-B-0123456789abcd`;
 const out=tx(`${liveFixture()}select id from ${prepareBuy()};${sync(buy,"101","1",17.5,"BUY")}
 ${otherLive(quote)}
 select id from coinops.prepare_robot_v1_live_order('${runB}',(select id from coinops.robot_v1_live_slots where run_id='${runB}' and slot_number=1),
 'BUY','INITIAL',1,'${client}',null,10,null,'${"c".repeat(64)}','${lease}');
 select status from coinops.sync_robot_v1_live_order((select id from coinops.robot_v1_live_orders where client_order_id='${client}'),
 '101','FILLED',.1,10,'[{"id":"1","quantity":0.1,"quoteQuantity":10,"commission":0.01,"commissionAsset":"${quote}","isBuyer":true,"filledAt":"${new Date().toISOString()}"}]',null,null,'${lease}');
 select count(*)=2 and count(distinct exchange_account_id)=2 from coinops.robot_v1_live_fills where exchange_trade_id='1';
 select commission_quote=.01 and quote_asset='${quote}' from coinops.robot_v1_live_fills where exchange_account_id='${accountB}';
 select position_committed_quote=10.01 and quote_asset='${quote}' from coinops.robot_v1_live_slots where run_id='${runB}' and slot_number=1;`);
 assert.equal(out.split("\n").filter(x=>x==="t").length,3);
});
check("5.8 SQL: provisioning and immutable adjustments install without touching LIVE rows",()=>{
 const before=sql("select count(*) from coinops.robot_v1_live_slot_accounts");
 const path=resolve("../../supabase/migrations");
 for(const file of ["20260925024845_add_operator_engine_provisioning.sql",
  "20260925024857_add_live_operator_adjustments.sql",
  "20260925024909_add_live_operator_adjustment_reversal.sql",
  "20260925024922_add_live_contribution_plans.sql"])
  invoke(["-f",join(path,file)]);
 assert.equal(sql("select count(*) from coinops.robot_v1_live_slot_accounts"),before);
 assert.equal(sql("select count(*) from coinops.robot_v1_live_adjustment_batches"),"0");
 assert.equal(sql("select count(*) from coinops.robot_v1_live_contribution_plans"),"0");
 const provision=tx(`insert into coinops.exchange_accounts(id,operator_id,display_name,status,kill_switch,
   credential_ref,executor_profile) values('${accountB}','${operator}','Fixture New','INACTIVE',true,
   'account_${accountB.replaceAll("-","")}','coinops-fixed-ip');
  insert into coinops.account_onboarding_checks(operator_id,exchange_account_id,check_key,status,
   evidence,created_by,idempotency_key) values('${operator}','${accountB}','BINANCE_CREDENTIAL','PASS',
   '{"environment":"REAL","status":"PASS","whitelist_accepted":true,"permission":{"spotTrading":true,"withdrawals":false}}',
   '${user}','fixture-credential-0001');
  select jsonb_array_length(coinops.stage_operator_engine_plan('${operator}','${accountB}','USDT',20,
   '[{"asset":"BTC","capital":10,"gain":0.012,"spacing":0.02,"postAth":0.05},
     {"asset":"SOL","capital":10,"gain":0.055,"spacing":0.03,"postAth":0.08}]',
   '33333333-4444-4555-8666-777777777777'))=2;
  select count(*)=2 and bool_and(status='INACTIVE' and kill_switch and not legacy_compatible)
   from coinops.trading_engines where exchange_account_id='${accountB}';
  select count(*)=50 and sum(balance_brl)=0 from coinops.robot_v1_live_slot_accounts
   where exchange_account_id='${accountB}';
  select jsonb_array_length(coinops.stage_operator_engine_plan('${operator}','${accountB}','USDT',20,
   '[{"asset":"BTC","capital":10,"gain":0.012,"spacing":0.02,"postAth":0.05},
     {"asset":"SOL","capital":10,"gain":0.055,"spacing":0.03,"postAth":0.08}]',
   '33333333-4444-4555-8666-777777777777'))=2;`);
 assert.equal(provision.split("\n").filter(x=>x==="t").length,4);
 const allocation=`(select jsonb_build_array(jsonb_build_object('engineId','${engineB}',
  'slotNumber',1,'amount',0,'gainUnits',1,'balanceBefore',a.balance_brl,
  'operationSequence',s.operation_sequence,'monthlyBefore',0,'lifetimeBefore',0))
  from coinops.robot_v1_live_slot_accounts a join coinops.robot_v1_live_slots s
  on s.trading_engine_id=a.trading_engine_id and s.slot_number=a.slot_number
  where a.trading_engine_id='${engineB}' and a.slot_number=1)`;
 const out=tx(`${otherLive("USDT")}
  update coinops.robot_v1_live_runs set lease_owner=null,lease_until=null where id='${runB}';
  select coinops.apply_live_operator_adjustment('${operator}','${accountB}','${user}',
    'MANUAL_GAIN','USDT','USDT',0,0,null,null,null,'fixture gain',${allocation},20,
    '11111111-2222-4333-8444-555555555555')->>'status';
  select gain_count=1 and balance_brl=10 and contribution_brl=10
    from coinops.robot_v1_live_slot_accounts where trading_engine_id='${engineB}' and slot_number=1;
  select monthly_gain_count=1 and lifetime_gain_count=1
    from coinops.robot_v1_slot_gain_totals where trading_engine_id='${engineB}' and slot_number=1;
  select coinops.reverse_live_operator_adjustment('${operator}','${accountB}','${user}',
    (select id from coinops.robot_v1_live_adjustment_batches where request_id='11111111-2222-4333-8444-555555555555'),
    'fixture reverse','22222222-3333-4444-8555-666666666666')->>'status';
  select gain_count=0 and balance_brl=10 from coinops.robot_v1_live_slot_accounts
    where trading_engine_id='${engineB}' and slot_number=1;
  select count(*)=2 and bool_and(reversal_of is null or kind='REVERSAL')
    from coinops.robot_v1_live_adjustment_batches where exchange_account_id='${accountB}';`);
 assert.deepEqual(out.split("\n").filter(x=>["APPLIED","REVERSED","t"].includes(x)),
  ["APPLIED","t","t","REVERSED","t","t"]);
 const capitalAllocation=`(select jsonb_build_array(jsonb_build_object('engineId','${engineB}',
  'slotNumber',1,'amount',2,'gainUnits',0,'balanceBefore',a.balance_brl,
  'operationSequence',s.operation_sequence,'monthlyBefore',0,'lifetimeBefore',0))
  from coinops.robot_v1_live_slot_accounts a join coinops.robot_v1_live_slots s
  on s.trading_engine_id=a.trading_engine_id and s.slot_number=a.slot_number
  where a.trading_engine_id='${engineB}' and a.slot_number=1)`;
 const funded=tx(`${otherLive("USDT")}
  update coinops.robot_v1_live_runs set lease_owner=null,lease_until=null where id='${runB}';
  select coinops.apply_live_operator_adjustment('${operator}','${accountB}','${user}',
   'CAPITAL','USDT','USDT',2,2,null,null,null,'fixture capital',${capitalAllocation},20,
   '44444444-5555-4666-8777-888888888888')->>'status';
  select balance_brl=12 and contribution_brl=12 and gain_count=0
   from coinops.robot_v1_live_slot_accounts where trading_engine_id='${engineB}' and slot_number=1;
  select hard_cap_quote=22 from coinops.account_quote_caps where exchange_account_id='${accountB}';
  select coinops.reverse_live_operator_adjustment('${operator}','${accountB}','${user}',
   (select id from coinops.robot_v1_live_adjustment_batches where request_id='44444444-5555-4666-8777-888888888888'),
   'fixture reverse','55555555-6666-4777-8888-999999999999')->>'status';
  select balance_brl=10 and contribution_brl=10 from coinops.robot_v1_live_slot_accounts
   where trading_engine_id='${engineB}' and slot_number=1;
  select hard_cap_quote=20 from coinops.account_quote_caps where exchange_account_id='${accountB}';`);
 assert.deepEqual(funded.split("\n").filter(x=>["APPLIED","REVERSED","t"].includes(x)),
  ["APPLIED","t","t","REVERSED","t","t"]);
});

check("5.9 SQL: selective slots stay pending while OPEN, apply after TP, and replay once",()=>{
 const path=resolve("../../supabase/migrations");
 invoke(["-f",join(path,"20260927133000_add_selective_slot_contributions.sql")]);
 const request="66666666-7777-4888-8999-aaaaaaaaaaaa",fingerprint="a".repeat(64);
 const allocation=`(select jsonb_build_array(
  jsonb_build_object('engineId','${engine}','slotNumber',1,'amount',2,
    'balanceBefore',a.balance_brl,'operationSequence',s.operation_sequence))
  from coinops.robot_v1_live_slot_accounts a join coinops.robot_v1_live_slots s
    on s.trading_engine_id=a.trading_engine_id and s.slot_number=a.slot_number
  where a.trading_engine_id='${engine}' and a.slot_number=1)`;
 const out=tx(`${liveFixture()}
  select id from ${prepareBuy()};${sync(buy,"101","1",17.5,"BUY")}
  select id from coinops.prepare_robot_v1_live_order('${liveRun}','${liveSlot}','SELL','TP',1,
   '${sell}',.00004,null,445000,'${"b".repeat(64)}','${lease}');
  create temp table selective_orders_before as select to_jsonb(o) row_data
   from coinops.robot_v1_live_orders o where run_id='${liveRun}';
  create temp table selective_slot_before as select position_quantity,position_committed_brl,
   entry_reference_price,last_take_profit_price from coinops.robot_v1_live_slots where id='${liveSlot}';
  update coinops.robot_v1_live_runs set lease_owner=null,lease_until=null where id='${liveRun}';
  select coinops.apply_live_selective_contribution('${operator}','${account}','${engine}','${user}',
   'BRL','BRL',2,2,null,'selected fixture',${allocation},725,'${request}','${fingerprint}')->>'status';
  select balance_brl=18 and contribution_brl=18 from coinops.robot_v1_live_slot_accounts
   where trading_engine_id='${engine}' and slot_number=1;
  select not exists((select to_jsonb(o) from coinops.robot_v1_live_orders o where run_id='${liveRun}'
    except select row_data from selective_orders_before)
   union all(select row_data from selective_orders_before except
    select to_jsonb(o) from coinops.robot_v1_live_orders o where run_id='${liveRun}'));
  select (s.position_quantity,s.position_committed_brl,s.entry_reference_price,s.last_take_profit_price)
   is not distinct from (b.position_quantity,b.position_committed_brl,b.entry_reference_price,b.last_take_profit_price)
   from coinops.robot_v1_live_slots s cross join selective_slot_before b where s.id='${liveSlot}';
  select status='PENDING' and applied_at is null from coinops.robot_v1_live_selective_contribution_allocations;
  select coinops.apply_live_selective_contribution('${operator}','${account}','${engine}','${user}',
   'BRL','BRL',2,2,null,'selected fixture',${allocation},725,'${request}','${fingerprint}')->>'status';
  select count(*)=1 from coinops.robot_v1_live_selective_contribution_batches;
  update coinops.robot_v1_live_runs set lease_owner='${lease}',lease_until=now()+interval '5 minutes' where id='${liveRun}';
  ${sync(sell,"102","2",17.8,"SELL")}
  select slot_number from coinops.credit_robot_v1_live_closed_slot('${liveRun}','${liveSlot}',1,'${sell}',.00001,'${lease}');
  select status='APPLIED' and applied_at is not null and applied_operation_sequence=2
   from coinops.robot_v1_live_selective_contribution_allocations;
  select balance_brl=20.28 and contribution_brl=20 and market_pnl_brl=.30 and fees_brl=.02 and gain_count=1
   from coinops.robot_v1_live_slot_accounts where trading_engine_id='${engine}' and slot_number=1;
 select count(*)=1 from coinops.robot_v1_live_events where run_id='${liveRun}'
   and event_type='SELECTIVE_CONTRIBUTION_APPLIED';`);
 assert.deepEqual(out.split("\n").filter(x=>["APPLIED","REPLAYED","t"].includes(x)),
  ["APPLIED","t","t","t","t","REPLAYED","t","t","t","t"]);
});

check("5.9 SQL: concurrent duplicate confirmations converge to one batch",async()=>{
 const request="77777777-8888-4999-8aaa-bbbbbbbbbbbb",fingerprint="c".repeat(64);
 sql(`begin;set local request.jwt.claim.role='service_role';${liveFixture()}
  update coinops.robot_v1_live_runs set lease_owner=null,lease_until=null where id='${liveRun}';commit;`);
 const allocation=`(select jsonb_build_array(jsonb_build_object('engineId','${engine}',
  'slotNumber',2,'amount',2,'balanceBefore',a.balance_brl,'operationSequence',s.operation_sequence))
  from coinops.robot_v1_live_slot_accounts a join coinops.robot_v1_live_slots s
   on s.trading_engine_id=a.trading_engine_id and s.slot_number=a.slot_number
  where a.trading_engine_id='${engine}' and a.slot_number=2)`;
 const statement=`set request.jwt.claim.role='service_role';select coinops.apply_live_selective_contribution(
  '${operator}','${account}','${engine}','${user}','BRL','BRL',2,2,null,'concurrent fixture',
  ${allocation},725,'${request}','${fingerprint}')->>'status';`;
 const outcomes=(await Promise.all([invokeAsync(["-c",statement]),invokeAsync(["-c",statement])]))
  .map((output)=>output.split("\n").at(-1)).sort();
 assert.deepEqual(outcomes,["APPLIED","REPLAYED"]);
 assert.equal(sql(`select count(*)=1 from coinops.robot_v1_live_selective_contribution_batches
  where request_id='${request}'`),"t");
 assert.equal(sql(`select hard_cap_quote=727 from coinops.account_quote_caps
  where exchange_account_id='${account}' and quote_asset='BRL'`),"t");
 assert.equal(sql(`select balance_brl=20 and contribution_brl=20 from coinops.robot_v1_live_slot_accounts
  where trading_engine_id='${engine}' and slot_number=2`),"t");
});

check("5.10 SQL: preset CRUD, RLS and usage audit stay outside the financial ledger",()=>{
 const path=resolve("../../supabase/migrations");
 const slotsBefore=sql("select md5(string_agg(to_jsonb(s)::text,'' order by s.id)) from coinops.robot_v1_live_slots s");
 const ordersBefore=sql("select md5(coalesce(string_agg(to_jsonb(o)::text,'' order by o.id),'')) from coinops.robot_v1_live_orders o");
 invoke(["-f",join(path,"20260927201831_add_selective_contribution_presets.sql")]);
 invoke(["-f",join(path,"20260927204259_index_selective_contribution_presets.sql")]);
 assert.equal(sql(`select count(*)=2 and bool_and(built_in and status='ACTIVE')
   from coinops.robot_v1_live_selective_contribution_presets where operator_id='${operator}'`),"t");
 const custom="99999999-aaaa-4bbb-8ccc-dddddddddddd";
 const output=tx(`select coinops.manage_live_selective_contribution_preset('${operator}','${user}',
   'CREATE',null,'1 + 2',3,1,2,null)->>'status';
  update coinops.robot_v1_live_selective_contribution_presets set id='${custom}'
    where operator_id='${operator}' and name='1 + 2';
  select coinops.manage_live_selective_contribution_preset('${operator}','${user}',
   'UPDATE','${custom}','1 aberto + 2 abaixo',3,1,2,null)->>'status';
  select coinops.manage_live_selective_contribution_preset('${operator}','${user}',
   'TOGGLE','${custom}',null,null,null,null,false)->>'status';
  select coinops.manage_live_selective_contribution_preset('${operator}','${user}',
   'TOGGLE','${custom}',null,null,null,null,true)->>'status';
  select coinops.mark_live_selective_contribution_preset_usage('${operator}','${user}','${custom}',
   '${engine}','88888888-9999-4aaa-8bbb-cccccccccccc',1,array[1,2,3])->>'status';
  select coinops.mark_live_selective_contribution_preset_usage('${operator}','${user}','${custom}',
   '${engine}','88888888-9999-4aaa-8bbb-cccccccccccc',1,array[1,2,3])->>'status';
  select coinops.manage_live_selective_contribution_preset('${operator}','${user}',
   'DELETE','${custom}',null,null,null,null,null)->>'status';
  select status='DISABLED' and usage_count=1 from coinops.robot_v1_live_selective_contribution_presets
    where id='${custom}';
  set local audit.product='${product}';set local audit.tenant='${tenant}';set local audit.user_id='${user}';
  set local role authenticated;
  select count(*)=3 from coinops.robot_v1_live_selective_contribution_presets;`);
 assert.deepEqual(output.split("\n").filter(value=>["ACTIVE","DISABLED","RECORDED","REPLAYED","DISABLED_USED","t"].includes(value)),
   ["ACTIVE","ACTIVE","DISABLED","ACTIVE","RECORDED","REPLAYED","DISABLED_USED","t","t"]);
 assert.equal(sql(`select count(*)=0 from coinops.robot_v1_live_selective_contribution_preset_usages`),"t");
 assert.throws(()=>tx("set local role anon;select id from coinops.robot_v1_live_selective_contribution_presets"),/permission denied/);
 assert.equal(sql("select md5(string_agg(to_jsonb(s)::text,'' order by s.id)) from coinops.robot_v1_live_slots s"),slotsBefore);
 assert.equal(sql("select md5(coalesce(string_agg(to_jsonb(o)::text,'' order by o.id),'')) from coinops.robot_v1_live_orders o"),ordersBefore);
});

check("multi-shard SQL: backfill preserves installed LIVE state and engine ownership is immutable",()=>{
 const beforeSlots=sql("select md5(coalesce(string_agg(to_jsonb(s)::text,'' order by s.id),'')) from coinops.robot_v1_live_slots s");
 const beforeOrders=sql("select md5(coalesce(string_agg(to_jsonb(o)::text,'' order by o.id),'')) from coinops.robot_v1_live_orders o");
 // Use the current official cap contract, not the historical bootstrap725
 // function left by this deliberately staged legacy regression harness.
 invoke(["-f",resolve("../../supabase/migrations/20260927215500_allow_legacy_selective_cap_growth.sql")]);
 sql("create table coinops.operator_push_subscriptions(id uuid primary key)");
 for (const file of ["20260926180000_add_coinops_executor_capacity.sql", "20260926192555_add_coinops_shard_assignment.sql", "20260926194558_protect_testnet_shard_capacity.sql",
   "20260926202114_add_coinops_environment_capacity.sql"])
   invoke(["-f", resolve("../../supabase/migrations", file)]);
 sql(`insert into coinops.executor_shards(id,egress_ipv4) values('executor-02','203.0.113.2'),('executor-03','203.0.113.3');
 create table coinops.watchdog_checks(shard_id text,checked_at timestamptz,blocked_engines integer default 0,
   stale_engines integer default 0,recovering_engines integer default 0);grant select on coinops.watchdog_checks to service_role;`);
 for (const file of ["20260929212150_coinops_canonical_admission_policy.sql", "20260930140348_coinops_admission_hysteresis.sql"])
   invoke(["-f", resolve("../../supabase/migrations", file)]);
 invoke(["-f", resolve("../../supabase/migrations/20260926194212_add_coinops_global_binance_identity.sql")]);
 invoke(["-f",resolve("../../supabase/migrations/20261004125202_add_same_symbol_engine_provisioning.sql")]);
 assert.equal(sql("select bool_and(executor_shard_id='executor-01') from coinops.trading_engines where environment='REAL'"),"t");
 assert.equal(sql("select md5(coalesce(string_agg(to_jsonb(s)::text,'' order by s.id),'')) from coinops.robot_v1_live_slots s"),beforeSlots);
 assert.equal(sql("select md5(coalesce(string_agg(to_jsonb(o)::text,'' order by o.id),'')) from coinops.robot_v1_live_orders o"),beforeOrders);
 assert.throws(()=>tx(`update coinops.trading_engines set executor_shard_id='executor-03' where id='${engine}'`),/ENGINE_SHARD_IMMUTABLE/);
 for(const assignment of ["symbol='BTCUSDT'","quote_asset='USDT'","environment='TESTNET'"])
   assert.throws(()=>tx(`update coinops.trading_engines set ${assignment} where id='${engine}'`),/ORDER_NAMESPACE_IMMUTABLE|ENGINE_IDENTITY_IMMUTABLE/);
 for(const table of ["account_executor_connections","account_order_budget_samples","account_order_budget_reservations","account_order_budget_probe_leases","account_execution_policies","account_engine_append_previews"]){
   assert.throws(()=>tx(`set local role authenticated;select * from coinops.${table}`),/permission denied/);
   assert.throws(()=>tx(`set local role anon;select * from coinops.${table}`),/permission denied/);
 }
 assert.throws(()=>tx(`set local role authenticated;select coinops.append_operator_engine_plan('${operator}','${account}','executor-03','BRL',100,'[]','${user}')`),/permission denied/);
});

const budgetFixture=()=>`update coinops.account_executor_connections set status='VALIDATED'
 where exchange_account_id='${account}' and executor_shard_id='executor-01';
 insert into coinops.account_order_budget_samples(exchange_account_id,operator_id,observed_at,server_time_ms,
 intervals,symbol_limits,source_shard_id) values('${account}','${operator}',clock_timestamp(),
 floor(extract(epoch from clock_timestamp())*1000)::bigint,
 '[{"intervalMs":86400000,"limit":100,"count":95}]',
 '{"BTCBRL":{"maxOrders":200,"openOrders":20,"externalOrders":2,"selfTradePrevention":"EXPIRE_TAKER"}}','executor-01');`;
const budgetDecision=(orders=3,counts="{\"BTCBRL\":1}")=>`private.coinops_account_order_budget_gate(
 '${operator}','${account}',${orders},'${counts}')`;

check("account-global SQL: probe lease is single-flight, fenced and cannot alter financial rows",async()=>{
 const owners=Array.from({length:3},()=>randomUUID());
 const financialBefore=sql(`select md5(string_agg(j,'' order by j)) from (
 select to_jsonb(x)::text j from coinops.robot_v1_live_orders x union all select to_jsonb(x)::text from coinops.robot_v1_live_slots x
 union all select to_jsonb(x)::text from coinops.trading_engines x union all select to_jsonb(x)::text from coinops.exchange_accounts x)s`);
 const acquired=await Promise.all(owners.map(owner=>invokeAsync(['-c',`begin;set local request.jwt.claim.role='service_role';
 select coinops.acquire_account_order_budget_probe('${operator}','${account}','${owner}');commit;`])));
 assert.equal(acquired.filter(result=>result.split('\n').includes('t')).length,1);
 assert.equal(acquired.filter(result=>result.split('\n').includes('f')).length,2);
 const current=sql(`select lease_owner from coinops.account_order_budget_probe_leases where exchange_account_id='${account}'`);
 const other=owners.find(owner=>owner!==current)!;
 const record=(owner:string,observed="clock_timestamp()")=>`select coinops.record_account_order_budget_sample(
 '${operator}','${account}','${owner}','executor-01',${observed},floor(extract(epoch from clock_timestamp())*1000)::bigint,
 '[{"intervalMs":86400000,"limit":100,"count":2}]',
 '{"BTCBRL":{"maxOrders":200,"openOrders":0,"externalOrders":0,"selfTradePrevention":"EXPIRE_TAKER"}}','[]',null);`;
 assert.throws(()=>tx(record(other)),/PROBE_FENCED/);
 assert.throws(()=>tx(record(current,"clock_timestamp()-interval '31 seconds'")),/OBSERVATION_INVALID/);
 const pass=tx(`update coinops.account_executor_connections set status='VALIDATED'
 where exchange_account_id='${account}' and executor_shard_id='executor-01';${record(current)}
 select coinops.preview_account_order_budget('${operator}','${account}',3,'{"BTCBRL":1}')->>'code';`);
 assert.ok(pass.split('\n').includes('PASS'));
 // An expired lease can be superseded, but its former response stays fenced.
 const fenced=tx(`update coinops.account_order_budget_probe_leases set expires_at=clock_timestamp()-interval '1 second';
 select coinops.acquire_account_order_budget_probe('${operator}','${account}','${other}');
 select lease_owner='${other}' from coinops.account_order_budget_probe_leases where exchange_account_id='${account}';`);
 assert.equal(fenced.split('\n').filter(value=>value==='t').length,2);
 assert.throws(()=>tx(`update coinops.account_order_budget_probe_leases set lease_owner='${other}';${record(current)}`),/PROBE_FENCED/);
 assert.throws(()=>tx(`set local role authenticated;select coinops.acquire_account_order_budget_probe('${operator}','${account}','${other}')`),/permission denied/);
 assert.equal(sql(`select md5(string_agg(j,'' order by j)) from (
 select to_jsonb(x)::text j from coinops.robot_v1_live_orders x union all select to_jsonb(x)::text from coinops.robot_v1_live_slots x
 union all select to_jsonb(x)::text from coinops.trading_engines x union all select to_jsonb(x)::text from coinops.exchange_accounts x)s`),financialBefore);
 sql(`delete from coinops.account_order_budget_probe_leases where exchange_account_id='${account}'`);
});

check("account-global SQL: protective and unknown dispatch reserves survive timeout and IP changes",()=>{
 const second="0d000000-0000-4000-8000-000000000003";
 const output=tx(`${budgetFixture()}
 insert into coinops.trading_engines(id,operator_id,exchange_account_id,environment,symbol,base_asset,quote_asset,executor_shard_id)
 values('${second}','${operator}','${account}','REAL','BTCBRL','BTC','BRL','executor-03');
 insert into coinops.account_order_budget_reservations(client_order_id,exchange_account_id,operator_id,trading_engine_id,executor_shard_id,
 reserved_at,acknowledged_at,protection_orders) values('synthetic-A','${account}','${operator}','${engine}','executor-01',
 clock_timestamp()-interval '1 day',null,1),('synthetic-B','${account}','${operator}','${second}','executor-03',
 clock_timestamp()-interval '1 day',clock_timestamp()-interval '23 hours',1);
 select ${budgetDecision()}->>'code';
 update coinops.account_order_budget_reservations set acknowledged_at=clock_timestamp()-interval '23 hours'
 where client_order_id='synthetic-A';
 select ${budgetDecision()}->>'code';
 update coinops.account_order_budget_samples set observed_at=clock_timestamp(),server_time_ms=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 select ${budgetDecision()}->>'code';`);
 assert.deepEqual(output.split("\n").filter(x=>x==='PASS'||x.startsWith('ACCOUNT_')),
   ['ACCOUNT_ORDER_CAPACITY_REQUIRED','PASS','PASS']);
});

check("account-global SQL: signed counters, symbol STP and global resident filters fail closed",()=>{
 assert.equal(tx(`${budgetFixture()} select ${budgetDecision()}->>'code';`).split("\n").at(-2),'PASS');
 const mutations=[
   "observed_at=clock_timestamp()-interval '31 seconds'",
   "server_time_ms=server_time_ms+3000",
   "intervals='[{\"intervalMs\":86400000,\"limit\":null,\"count\":0}]'",
   "intervals='[{\"intervalMs\":86400000,\"limit\":100,\"count\":null}]'",
   "intervals='[{\"intervalMs\":null,\"limit\":100,\"count\":0}]'",
   "intervals='[{\"intervalMs\":86400000,\"limit\":100,\"count\":0},{\"intervalMs\":86400000,\"limit\":100,\"count\":0}]'",
   "restrictions='[\"SOL:MAX_ASSET\"]'",
   "symbol_limits=jsonb_set(symbol_limits,'{BTCBRL,selfTradePrevention}','null')",
   "symbol_limits=jsonb_set(symbol_limits,'{BTCBRL,maxOrders}','null')",
   "exchange_limits='{\"limit\":100,\"openOrders\":0,\"externalOrders\":null}'"
 ];
 for(const mutation of mutations){
   const out=tx(`${budgetFixture()} update coinops.account_order_budget_samples set ${mutation}; select ${budgetDecision()}->>'code';`);
   assert.ok(out.split("\n").includes('ACCOUNT_ORDER_BUDGET_UNKNOWN'),mutation);
 }
 const exhausted=tx(`${budgetFixture()} update coinops.account_order_budget_samples
 set exchange_limits='{"limit":60,"openOrders":10,"externalOrders":0}'; select ${budgetDecision()}->>'code';`);
 assert.ok(exhausted.split("\n").includes('ACCOUNT_ORDER_CAPACITY_REQUIRED'));
 assert.throws(()=>tx(`set local role authenticated;select ${budgetDecision()}`),/permission denied/);
});

check("multi-shard SQL: same symbol/account coexist without reusing slots, caps or engine ownership",()=>{
 const id="0d000000-0000-4000-8000-000000000003";
 const oldCap=sql(`select hard_cap_quote from coinops.trading_engines where id='${engine}'`);
 const output=tx(`insert into coinops.trading_engines(id,operator_id,exchange_account_id,environment,
 symbol,base_asset,quote_asset,ath_reference_symbol,hard_cap_quote,executor_shard_id)
 values('${id}','${operator}','${account}','REAL','BTCBRL','BTC','BRL','BTCBRL',100,'executor-03');
 select count(*)=2 and count(distinct order_owner_prefix)=2 and count(distinct executor_shard_id)=2
 from coinops.trading_engines where id in('${engine}','${id}');
 select count(*)=0 from coinops.robot_v1_live_slot_accounts where trading_engine_id='${id}';
 select hard_cap_quote=${oldCap} from coinops.trading_engines where id='${engine}';`);
 assert.deepEqual(output.split("\n").filter(value=>value==='t'),["t","t","t"]);
});

check("same SOLBRL/account SQL: engine A closure on01 cannot credit or reconcile engine B on03",()=>{
 const a=sql(`select id from coinops.trading_engines where exchange_account_id='${account}' and environment='REAL' and symbol='SOLBRL'`);
 const b="0d000000-0000-4000-8000-000000000013";
 const runA="0d000000-0000-4000-8000-000000000021",runOther="0d000000-0000-4000-8000-000000000023";
 const leaseA="0d000000-0000-4000-8000-000000000031",leaseB="0d000000-0000-4000-8000-000000000033";
 const ca="COR1-SOL-1-1-BUY-0123456789abcd",sa="COR1-SOL-1-1-SELL-0123456789abcd";
 const cb=`C2-${createHash("sha256").update(`${account}|${b}`).digest("hex").slice(0,10)}-1-B-0123456789abcd`;
 const sb=cb.replace('-1-B-','-1-S-');
 const reserve=(id:string,client:string,leaseId:string)=>`select coinops.reserve_account_order_budget(
 '${operator}','${account}','${id}','${client}','${leaseId}')->>'code';`;
 const ack=(id:string,client:string,leaseId:string)=>`select coinops.acknowledge_account_order_budget(
 '${operator}','${account}','${id}','${client}','${leaseId}');`;
 const prepare=(run:string,side:string,client:string,decision:string,leaseId:string)=>`select id from coinops.prepare_robot_v1_live_order(
 '${run}',(select id from coinops.robot_v1_live_slots where run_id='${run}' and slot_number=1),'${side}',
 '${side==='BUY'?'INITIAL':'TP'}',1,'${client}',${side==='BUY'?'null':'.1'},${side==='BUY'?'10':'null'},
 ${side==='BUY'?'null':'112'},'${decision}','${leaseId}');`;
 const fill=(client:string,exchangeId:string,tradeId:string,side:string,leaseId:string)=>`select status from coinops.sync_robot_v1_live_order(
 (select id from coinops.robot_v1_live_orders where client_order_id='${client}'),'${exchangeId}','FILLED',.1,${side==='BUY'?10:11.2},
 '[{"id":"${tradeId}","quantity":0.1,"quoteQuantity":${side==='BUY'?10:11.2},"commission":0,"commissionAsset":"BRL","isBuyer":${side==='BUY'},"filledAt":"${new Date().toISOString()}"}]',null,null,'${leaseId}');`;
 const before=sql(`select md5(string_agg(to_jsonb(o)::text,'' order by o.id)) from coinops.robot_v1_live_orders o`);
 const output=tx(`insert into coinops.trading_engines(id,operator_id,exchange_account_id,environment,symbol,base_asset,quote_asset,
 ath_reference_symbol,status,kill_switch,hard_cap_quote,executor_shard_id)
 values('${b}','${operator}','${account}','REAL','SOLBRL','SOL','BRL','SOLBRL','ACTIVE',false,250,'executor-03');
 update coinops.account_quote_caps set hard_cap_quote=hard_cap_quote+250 where exchange_account_id='${account}' and quote_asset='BRL';
 insert into coinops.robot_v1_live_preparations(product_id,tenant_id,user_id,trading_engine_id,asset,symbol,quote_asset,
 monthly_target,configured_live_capital_brl,max_order_notional_brl,max_total_exposure_brl)
 values(${scope},'${b}','SOL','SOLBRL','BRL',2,250,10,250);
 insert into coinops.robot_v1_live_slot_accounts(product_id,tenant_id,user_id,trading_engine_id,asset,quote_asset,slot_number,balance_brl,contribution_brl)
 select ${scope},'${b}','SOL','BRL',n,10,10 from generate_series(1,25)n;
 insert into coinops.robot_v1_live_runs(id,product_id,tenant_id,user_id,trading_engine_id,asset,symbol,quote_asset,status,
 anchor_price,slot_notional_brl,gain_rate,entry_spacing,entry_regime,config_version,config_snapshot,strategy_version)
 select r.id::uuid,${scope},r.engine::uuid,'SOL','SOLBRL','BRL','PREPARING',100,10,.12,.03,'NORMAL',1,'{}','4.3.1'
 from(values('${runA}','${a}'),('${runOther}','${b}'))r(id,engine);
 insert into coinops.robot_v1_live_slots(run_id,product_id,tenant_id,user_id,slot_number,target_buy_price,entry_reference_price,operational_rank)
 select r.id,${scope},n,100,100,n from coinops.robot_v1_live_runs r cross join generate_series(1,25)n where r.id in('${runA}','${runOther}');
 select id from coinops.activate_robot_v1_live_cycle('${runA}');select id from coinops.activate_robot_v1_live_cycle('${runOther}');
 update coinops.robot_v1_live_runs set lease_owner=case id when '${runA}' then '${leaseA}'::uuid else '${leaseB}'::uuid end,
 lease_until=now()+interval '5 minutes' where id in('${runA}','${runOther}');
 insert into coinops.robot_v1_strategy_decisions(product_id,tenant_id,user_id,environment,trading_engine_id,asset,decision_id,
 strategy_version,cycle_id,slot_id,action_type,priority,reason,expected_next_state)
 select ${scope},'REAL',r.trading_engine_id,'SOL',repeat(case when r.id='${runA}' then x.a else x.b end,64),
 '4.3.1',r.id,s.id,x.action,1,'Local isolation fixture','{}' from coinops.robot_v1_live_runs r
 join coinops.robot_v1_live_slots s on s.run_id=r.id and s.slot_number=1
 cross join(values('d','e','OPEN_INITIAL_MARKET'),('f','0','CREATE_TP'))x(a,b,action) where r.id in('${runA}','${runOther}');
 ${prepare(runA,'BUY',ca,'d'.repeat(64),leaseA)}${prepare(runOther,'BUY',cb,'e'.repeat(64),leaseB)}
 ${budgetFixture()}
 update coinops.account_order_budget_samples set symbol_limits=
 '{"SOLBRL":{"maxOrders":200,"openOrders":0,"externalOrders":0,"selfTradePrevention":"EXPIRE_TAKER"}}';
 ${reserve(a,ca,leaseA)}${reserve(a,ca,leaseA)}${reserve(b,cb,leaseB)}
 do $$begin
   perform coinops.reserve_account_order_budget('${operator}','${account}','${b}','${ca}','${leaseB}');
   raise exception 'EXPECTED_FOREIGN_ENGINE_REJECTION';
 exception when others then if sqlerrm<>'COINOPS_ACCOUNT_ORDER_BUDGET_SCOPE_DENIED' then raise;end if;end$$;
 ${fill(ca,'901','9011','BUY',leaseA)}${fill(cb,'902','9021','BUY',leaseB)}
 ${ack(a,ca,leaseA)}${ack(b,cb,leaseB)}
 update coinops.account_order_budget_samples set observed_at=clock_timestamp(),server_time_ms=floor(extract(epoch from clock_timestamp())*1000)::bigint,
 intervals='[{"intervalMs":86400000,"limit":100,"count":97}]';
 ${prepare(runA,'SELL',sa,'f'.repeat(64),leaseA)}${prepare(runOther,'SELL',sb,'0'.repeat(64),leaseB)}
 ${reserve(a,sa,leaseA)}
 select protection_orders=0 from coinops.account_order_budget_reservations where client_order_id='${ca}';
 select protection_orders=1 from coinops.account_order_budget_reservations where client_order_id='${cb}';
 ${reserve(b,sb,leaseB)}
 select count(*)=50 and count(distinct id)=50 and count(distinct run_id)=2
 from coinops.robot_v1_live_slots where trading_engine_id in('${a}','${b}');
 select count(*)=4 and count(distinct client_order_id)=4 and count(distinct trading_engine_id)=2
 from coinops.robot_v1_live_orders where trading_engine_id in('${a}','${b}');
 create temporary table sibling_snapshot as select to_jsonb(s) data from coinops.robot_v1_live_slots s where run_id='${runOther}';
 ${fill(sa,'903','9031','SELL',leaseA)}
 select slot_number from coinops.credit_robot_v1_live_closed_slot('${runA}',
 (select id from coinops.robot_v1_live_slots where run_id='${runA}' and slot_number=1),1,'${sa}',.001,'${leaseA}');
 select gain_count=1 from coinops.robot_v1_live_slot_accounts where trading_engine_id='${a}' and slot_number=1;
 select gain_count=0 from coinops.robot_v1_live_slot_accounts where trading_engine_id='${b}' and slot_number=1;
 select bool_and(to_jsonb(s)=b.data) from coinops.robot_v1_live_slots s join sibling_snapshot b on b.data->>'id'=s.id::text;
 select status='PREPARED' and executed_quantity=0 from coinops.robot_v1_live_orders where client_order_id='${sb}';
 update coinops.robot_v1_live_runs set last_error='SYNTHETIC_B_FAILURE' where id='${runOther}';
 select last_error is null and status='ACTIVE' from coinops.robot_v1_live_runs where id='${runA}';`);
 assert.equal(output.split("\n").filter(x=>x==='t').length,11,output);
 assert.equal(output.split("\n").filter(x=>x==='PASS').length,5,output);
 assert.equal(sql(`select md5(string_agg(to_jsonb(o)::text,'' order by o.id)) from coinops.robot_v1_live_orders o`),before);
});

check("account-global SQL: concurrent retry reserves one BUY plus one future TP without financial writes",async()=>{
 sql(`begin;set local request.jwt.claim.role='service_role';
 update coinops.robot_v1_live_runs set lease_owner='${lease}',lease_until=now()+interval '5 minutes' where id='${liveRun}';
 select id from ${prepareBuy()};${budgetFixture()}commit;`);
 const financial=()=>sql(`select md5(string_agg(data::text,'' order by data::text)) from(
 select to_jsonb(o) data from coinops.robot_v1_live_orders o
 union all select to_jsonb(s) from coinops.robot_v1_live_slots s
 union all select to_jsonb(a) from coinops.robot_v1_live_slot_accounts a
 union all select to_jsonb(r) from coinops.robot_v1_live_runs r) state`);
 const before=financial();
 const statement=`set request.jwt.claim.role='service_role';select coinops.reserve_account_order_budget(
 '${operator}','${account}','${engine}','${buy}','${lease}')->>'replayed';`;
 const results=(await Promise.all(Array.from({length:3},()=>invokeAsync(["-c",statement]))))
   .map(out=>out.split("\n").at(-1)).sort();
 assert.deepEqual(results,['false','true','true']);
 assert.equal(sql(`select count(*)=1 and sum(protection_orders)=1 from coinops.account_order_budget_reservations
 where client_order_id='${buy}'`),'t');
 assert.equal(financial(),before);
 assert.throws(()=>tx(`select coinops.reserve_account_order_budget('${operator}','${account}',
 '${engine}','${buy}','${user}')`),/BUDGET_SCOPE_DENIED/);
 assert.throws(()=>tx(`select coinops.acknowledge_account_order_budget('${operator}','${account}',
 '${engine}','${buy}','${lease}')`),/ACK_UNPROVEN/);
 assert.throws(()=>tx(`set local role authenticated;select coinops.reserve_account_order_budget(
 '${operator}','${account}','${engine}','${buy}','${lease}')`),/permission denied/);
});

check("multi-shard policy SQL: PREPARING is fenced; every hosting shard must prove the same runtime before ACTIVE, without moving engines",()=>{
 const request=randomUUID(),version='1'.repeat(40);
 const fixture=`update coinops.account_executor_connections set status='VALIDATED' where exchange_account_id='${account}';
 insert into coinops.account_executor_connections(exchange_account_id,operator_id,executor_shard_id,environment,credential_ref,status)
 values('${account}','${operator}','executor-03','REAL','account_${account.replaceAll('-','')}','VALIDATED');`;
 const stage=`coinops.stage_account_execution_policy('${operator}','${account}','executor-03','${version}','${request}')`;
 const proof=(shard:string,req=request,ip=shard==='executor-01'?'46.101.104.48':'203.0.113.3',enabled='true')=>
 `coinops.record_account_execution_policy('${operator}','${account}','${req}','${shard}','${version}','${ip}',${enabled})`;
 const before=sql(`select md5(string_agg(j,'' order by j)) from(select to_jsonb(e)::text j from coinops.trading_engines e
 union all select to_jsonb(o)::text from coinops.robot_v1_live_orders o)s`);
 const result=tx(`${fixture}select ${stage}->>'status';select ${stage}->>'status';
 select ${proof('executor-01')}->>'status';
 select ${proof('executor-03')}->>'status';
 select required_shards=array['executor-01','executor-03'] and proofs ?& required_shards from coinops.account_execution_policies
 where exchange_account_id='${account}';`);
 assert.deepEqual(result.split('\n').filter(x=>['PREPARING','ACTIVE','t'].includes(x)),['PREPARING','PREPARING','PREPARING','ACTIVE','t']);
 for(const suffix of [proof('executor-03',randomUUID()),proof('executor-03',request,'203.0.113.99'),proof('executor-03',request,undefined,'false')])
   assert.throws(()=>tx(`${fixture}select ${stage};select ${suffix};`),/ENGINE_ISOLATION_PROOF_DENIED|ENGINE_ISOLATION_SCOPE_DENIED/);
 assert.throws(()=>tx(`${fixture}select ${stage};select coinops.stage_account_execution_policy('${operator}','${account}',
 'executor-03','${version}','${randomUUID()}');`),/ENGINE_ISOLATION_PREPARING/);
 assert.equal(sql(`select md5(string_agg(j,'' order by j)) from(select to_jsonb(e)::text j from coinops.trading_engines e
 union all select to_jsonb(o)::text from coinops.robot_v1_live_orders o)s`),before);
});

check("account-global SQL: signed no-POST receipt releases only its exact guarded attempt and preserves audit; uncertain/later attempts remain guarded",()=>{
 const proof={protocol:1,outcome:'NOT_SUBMITTED',operator_id:operator,exchange_account_id:account,trading_engine_id:engine,
   executor_shard_id:'executor-01',environment:'REAL',symbol:'BTCBRL',clientOrderId:buy,decision_id:'a'.repeat(64),
   bodyHash:'1'.repeat(64),request_nonce:'fictional-proof-nonce-123456',observedAt:Date.now()};
 const staged=`update coinops.robot_v1_live_orders set submission_guarded_at=clock_timestamp() where client_order_id='${buy}';
 update coinops.robot_v1_strategy_decisions set result='DISPATCHED',dispatched_at=clock_timestamp()
 where trading_engine_id='${engine}' and decision_id='${'a'.repeat(64)}';
 create temporary table guarded_attempt as select dispatched_at from coinops.robot_v1_strategy_decisions
 where trading_engine_id='${engine}' and decision_id='${'a'.repeat(64)}';`;
 const release=(value:unknown,guard='(select dispatched_at from guarded_attempt)')=>
 `coinops.release_proven_unsent_account_order('${operator}','${account}','${engine}','${buy}','${lease}',${guard},'${JSON.stringify(value)}')`;
 const output=tx(`${staged}select ${release(proof)};
 select submission_guarded_at is not null and account_order_unsent_receipt->>'request_nonce'='${proof.request_nonce}'
 and status='PREPARED' and exchange_order_id is null and executed_quantity=0
 from coinops.robot_v1_live_orders where client_order_id='${buy}';
 select result='PENDING' and dispatched_at is null from coinops.robot_v1_strategy_decisions where trading_engine_id='${engine}'
 and decision_id='${'a'.repeat(64)}';
 select count(*)=1 from coinops.robot_v1_live_events where run_id='${liveRun}' and event_type='ACCOUNT_ORDER_NOT_SUBMITTED';
 select coinops.claim_proven_unsent_account_order('${operator}','${account}','${engine}','${buy}','${lease}','${proof.request_nonce}') is not null;
 select submission_guarded_at is not null and account_order_unsent_receipt is null from coinops.robot_v1_live_orders where client_order_id='${buy}';
 do $$begin
 perform coinops.claim_proven_unsent_account_order('${operator}','${account}','${engine}','${buy}','${lease}','${proof.request_nonce}');
 raise exception 'EXPECTED_CONSUMED_PROOF_REJECTION';
 exception when others then if sqlerrm<>'COINOPS_ACCOUNT_ORDER_UNSENT_UNPROVEN' then raise;end if;end$$;`);
 assert.equal(output.split('\n').filter(x=>x==='t').length,6,output);
 for(const patch of [{executor_shard_id:'executor-03'},{clientOrderId:'foreign-order'},{trading_engine_id:engineB},
 {observedAt:Date.now()-61000},{request_nonce:''},{outcome:'UNKNOWN'}])
   assert.throws(()=>tx(`${staged}select ${release({...proof,...patch})};`),/UNSENT_UNPROVEN/);
 assert.throws(()=>tx(`${staged}update coinops.robot_v1_strategy_decisions set dispatched_at=dispatched_at+interval '1 second'
 where trading_engine_id='${engine}' and decision_id='${'a'.repeat(64)}';select ${release(proof)};`),/UNSENT_UNPROVEN/);
 assert.throws(()=>tx(`${staged}set local role authenticated;select ${release(proof)};`),/permission denied/);
});

check("account-global SQL: terminal zero-fill BUY releases only unused protection; partial STP keeps TP reserve",()=>{
 const ack=`select coinops.acknowledge_account_order_budget('${operator}','${account}','${engine}','${buy}','${lease}');`;
 for(const filled of [0,0.00001]){
   const output=tx(`update coinops.robot_v1_live_orders set exchange_order_id='synthetic-zero-fill',status='EXPIRED_IN_MATCH',
    executed_quantity=${filled},cumulative_quote=${filled?4.3:0},trades_reconciled=true where client_order_id='${buy}';${ack}
    select protection_orders=${filled?1:0} from coinops.account_order_budget_reservations where client_order_id='${buy}';`);
   assert.equal(output.split('\n').filter(x=>x==='t').length,2,output);
 }
});

const appendRequest = "ab000001-1111-4111-8111-111111111111";
const appendPlan = [{ asset: "SOL", capital: 100, gain: .055, spacing: .03, postAth: .08, monthlyTarget: 2 }];
const appendInput = { quote: "BRL", capital: 100, shardId: "executor-03", engines: appendPlan };
const appendCall = (request = appendRequest, capital = 100) => `coinops.append_operator_engine_plan('${operator}','${account}',
 'executor-03','BRL',${capital},'${JSON.stringify(appendPlan)}','${request}')`;
function appendFixture(request = appendRequest) {
 const version = '1'.repeat(40), policyRequest = randomUUID();
 return `update coinops.exchange_accounts set executor_profile='coinops-fixed-ip' where id='${account}';
 update coinops.account_executor_connections set status='VALIDATED' where exchange_account_id='${account}';
 insert into coinops.account_executor_connections(exchange_account_id,operator_id,executor_shard_id,environment,credential_ref,status)
 values('${account}','${operator}','executor-03','REAL','account_${account.replaceAll('-','')}','VALIDATED');
 select coinops.claim_binance_account_identity('${operator}','${account}','REAL','${'9'.repeat(64)}');
 insert into coinops.executor_capacity_samples(shard_id,observed_at,heartbeat_at,weight_observed_at,binance_weight_current,
 binance_weight_average,binance_weight_peak,binance_weight_samples,cpu_percent,ram_used_mb,ram_limit_mb,registry_match,executor_version)
 select id,now(),now(),now(),500,500,500,15,5,153,961,true,'${version}' from coinops.executor_shards;
 -- Persisted synthetic healthy-history boundary; the official collector
 -- trigger and canonical readiness/certification still make the decision.
 update coinops.executor_admission_hysteresis set healthy_since=now()-interval '11 minutes',sample_at=now()-interval '1 minute';
 update coinops.executor_capacity_samples set observed_at=now()+interval '1 microsecond';
 insert into coinops.watchdog_checks(shard_id,checked_at)select id,now()from coinops.executor_shards;
 select coinops.certify_executor_admission('${version}','${'b'.repeat(64)}','v24.21.0','capacity-v3-20260930',
 (select jsonb_agg(jsonb_build_object('shard_id',id,'ip',host(egress_ipv4),'status','PASS','config_status','PASS',
 'actual_sha','${version}','runtime_sha256','${'b'.repeat(64)}','node_version','v24.21.0','observed_at',now()))from coinops.executor_shards));
 select coinops.stage_account_execution_policy('${operator}','${account}','executor-03','${version}','${policyRequest}');
 select coinops.record_account_execution_policy('${operator}','${account}','${policyRequest}',id,'${version}',egress_ipv4,true)
 from coinops.executor_shards where id in('executor-01','executor-03')order by id;
 insert into coinops.account_order_budget_samples(exchange_account_id,operator_id,observed_at,server_time_ms,intervals,symbol_limits,source_shard_id)
 values('${account}','${operator}',clock_timestamp(),floor(extract(epoch from clock_timestamp())*1000)::bigint,
 '[{"intervalMs":86400000,"limit":100000,"count":1}]',
 '{"BTCBRL":{"maxOrders":2000,"openOrders":0,"externalOrders":0,"selfTradePrevention":"EXPIRE_TAKER"},
 "SOLBRL":{"maxOrders":2000,"openOrders":0,"externalOrders":0,"selfTradePrevention":"EXPIRE_TAKER"}}','executor-03')
 on conflict(exchange_account_id)do update set observed_at=excluded.observed_at,server_time_ms=excluded.server_time_ms,
 intervals=excluded.intervals,symbol_limits=excluded.symbol_limits,source_shard_id=excluded.source_shard_id;
 insert into coinops.account_engine_append_previews(exchange_account_id,operator_id,request_id,input,preview_hash,observed_at,
 expected_account_cap,engine_inventory,available_capital)values('${account}','${operator}','${request}','${JSON.stringify(appendInput)}','${'a'.repeat(64)}',now(),
 (select hard_cap_quote from coinops.account_quote_caps where exchange_account_id='${account}'and quote_asset='BRL'),
 (select jsonb_agg(jsonb_build_object('id',id,'cap',hard_cap_quote,'shard',executor_shard_id)order by id)
 from coinops.trading_engines where exchange_account_id='${account}'and environment='REAL'and quote_asset='BRL'),100);`;
}
check("append SQL: existing same SOLBRL survives new03 engine, 25 isolated slots, cap once, no run/order/flags and exact retry", () => {
 const result = tx(`${appendFixture()}
 create temp table append_engines_before as select to_jsonb(e)j from coinops.trading_engines e;
 create temp table append_orders_before as select to_jsonb(o)j from coinops.robot_v1_live_orders o;
 create temp table append_slots_before as select to_jsonb(s)j from coinops.robot_v1_live_slots s;
 create temp table append_original_cap as select hard_cap_quote cap from coinops.account_quote_caps where exchange_account_id='${account}'and quote_asset='BRL';
 create temp table append_result as select ${appendCall()} j;
 select ${appendCall()}=(select j from append_result);
 select count(*)=1 and bool_and(symbol='SOLBRL'and executor_shard_id='executor-03'and status='INACTIVE'and kill_switch and not legacy_compatible)
 from coinops.trading_engines where id=((select j from append_result)->0->>'engineId')::uuid;
 select count(*)=25 and count(distinct slot_number)=25 and sum(balance_quote)=0
 from coinops.robot_v1_live_slot_accounts where trading_engine_id=((select j from append_result)->0->>'engineId')::uuid;
 select count(*)=1 and bool_and(environment='REAL'and shard_id='executor-03')from coinops.executor_capacity_admissions
 where engine_id=((select j from append_result)->0->>'engineId')::uuid;
 select hard_cap_quote=(select cap+100 from append_original_cap)from coinops.account_quote_caps where exchange_account_id='${account}'and quote_asset='BRL';
 select not exists(select j from append_engines_before except select to_jsonb(e)from coinops.trading_engines e);
 select not exists((select to_jsonb(o)from coinops.robot_v1_live_orders o except select j from append_orders_before)
 union all(select j from append_orders_before except select to_jsonb(o)from coinops.robot_v1_live_orders o));
 select not exists((select to_jsonb(s)from coinops.robot_v1_live_slots s except select j from append_slots_before)
 union all(select j from append_slots_before except select to_jsonb(s)from coinops.robot_v1_live_slots s));
 select not exists(select 1 from coinops.robot_v1_live_runs where trading_engine_id=((select j from append_result)->0->>'engineId')::uuid);`);
 assert.equal(result.split('\n').filter(value => value === 't').length, 9);
});
check("append SQL: expired/changed/insufficient allocation, credential and uncertified shard fail before engine creation", () => {
 for (const [mutation, error] of [
  ["update coinops.account_engine_append_previews set observed_at=now()-interval '31 seconds'", /PREVIEW_EXPIRED/],
  ["update coinops.account_engine_append_previews set available_capital=99", /PREVIEW_EXPIRED/],
  [`update coinops.trading_engines set hard_cap_quote=hard_cap_quote+1 where id='${engine}'`, /PREVIEW_EXPIRED/],
  ["delete from coinops.executor_admission_attestations where shard_id='executor-03'", /CAPACITY_REQUIRED/],
  ["update coinops.account_executor_connections set status='VALIDATION_REQUIRED'where executor_shard_id='executor-03'", /CREDENTIAL_GATE_DENIED/],
 ] as const) assert.throws(() => tx(`${appendFixture()}${mutation};select ${appendCall()};`), error);
 assert.throws(() => tx(`${appendFixture()}select ${appendCall()};select ${appendCall(appendRequest, 101)};`), /REPLAY_MISMATCH/);
});

check("isolation report SQL: authenticated owner only, sanitized metadata and no financial writes", () => {
 const authorize = `set local audit.product='${product}';set local audit.tenant='${tenant}';set local audit.user_id='${user}';set local role authenticated;`;
 const before = sql(`select md5(string_agg(j,''order by j))from(select to_jsonb(e)::text j from coinops.trading_engines e
 union all select to_jsonb(o)::text from coinops.robot_v1_live_orders o union all select to_jsonb(s)::text from coinops.robot_v1_live_slots s)state`);
 const report = JSON.parse(tx(`${authorize}select coinops.read_engine_isolation_report(array['${engine}'::uuid]);`)
   .split('\n').find(line => line.startsWith('[{'))!);
 assert.equal(report.length, 1); assert.equal(report[0].trading_engine_id, engine);
 assert.equal(report[0].executor_shard_id, 'executor-01');
 assert.equal(report[0].evidence_basis, 'CURRENT_PERSISTED_ENGINE_ISOLATION_METADATA_NOT_RUNTIME_SMOKE');
 for (const forbidden of ['credential_ref','proofs','apiKey','apiSecret','secret','uid','identity_hash'])
   assert.equal(forbidden in report[0], false, forbidden);
 assert.throws(() => tx(`set local role anon;select coinops.read_engine_isolation_report(array['${engine}'::uuid]);`), /permission denied/);
 assert.throws(() => tx(`${authorize}set local audit.user_id='${randomUUID()}';select coinops.read_engine_isolation_report(array['${engine}'::uuid]);`), /REPORT_ENGINE_DENIED/);
 assert.throws(() => tx(`${authorize}select coinops.read_engine_isolation_report(array['${randomUUID()}'::uuid]);`), /REPORT_ENGINE_DENIED/);
 assert.throws(() => tx(`${authorize}select coinops.read_engine_isolation_report(array['${engine}'::uuid,'${engine}'::uuid]);`), /REPORT_ENGINE_DENIED/);
 assert.equal(sql(`select md5(string_agg(j,''order by j))from(select to_jsonb(e)::text j from coinops.trading_engines e
 union all select to_jsonb(o)::text from coinops.robot_v1_live_orders o union all select to_jsonb(s)::text from coinops.robot_v1_live_slots s)state`), before);
});

check("append SQL: concurrent exact retry creates once and reserves cap once", async () => {
 const request = randomUUID();
 const beforeCount = Number(sql(`select count(*)from coinops.trading_engines`));
 const beforeCap = Number(sql(`select hard_cap_quote from coinops.account_quote_caps where exchange_account_id='${account}'and quote_asset='BRL'`));
 const old = sql(`select md5(string_agg(j,''order by j))from(select to_jsonb(e)::text j from coinops.trading_engines e
 union all select to_jsonb(o)::text from coinops.robot_v1_live_orders o union all select to_jsonb(s)::text from coinops.robot_v1_live_slots s)state`);
 // This is the final test: commit only in this disposable local PostgreSQL.
 sql(`begin;set local request.jwt.claim.role='service_role';${appendFixture(request)}commit;`);
 const outputs = await Promise.all(Array.from({length: 3}, () => invokeAsync([
   '-c', `set request.jwt.claim.role='service_role';select ${appendCall(request)};`])));
 const results = outputs.map(out => JSON.parse(out.split('\n').find(line => line.startsWith('[{'))!));
 assert.deepEqual(results[0], results[1]); assert.deepEqual(results[1], results[2]);
 const id = results[0][0].engineId;
 assert.equal(Number(sql(`select count(*)from coinops.trading_engines`)), beforeCount + 1);
 assert.equal(Number(sql(`select hard_cap_quote from coinops.account_quote_caps where exchange_account_id='${account}'and quote_asset='BRL'`)), beforeCap + 100);
 assert.equal(sql(`select count(*)=25 from coinops.robot_v1_live_slot_accounts where trading_engine_id='${id}'`), 't');
 assert.equal(sql(`select md5(string_agg(j,''order by j))from(select to_jsonb(e)::text j from coinops.trading_engines e where e.id<>'${id}'
 union all select to_jsonb(o)::text from coinops.robot_v1_live_orders o union all select to_jsonb(s)::text from coinops.robot_v1_live_slots s)state`), old);
});
