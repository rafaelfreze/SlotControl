import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("PG"))),
 NODE_ENV:process.env.NODE_ENV??"test",
 PGHOST:"127.0.0.1",PGPORT:String(port),PGUSER:"multi_account_audit",PGDATABASE:"postgres",PGPASSFILE:join(directory,"no-credentials")};
const args=()=>["-X","-w","-h","127.0.0.1","-p",String(port),"-U","multi_account_audit","-d","postgres","-v","ON_ERROR_STOP=1","-At"];
function invoke(extra:string[]){try{return execFileSync(join(bin,"psql.exe"),[...args(),...extra],{env,windowsHide:true,encoding:"utf8",stdio:"pipe"}).replace(/\r/g,"").trim();}
 catch(error){const e=error as {stderr?:Buffer};throw new Error(e.stderr?.toString()??String(error));}}
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
 execFileSync(join(bin,"pg_ctl.exe"),["-D",directory,"-l",join(directory,"server.log"),"-o",`-h 127.0.0.1 -p ${port}`,"-w","start"],{env,windowsHide:true,stdio:"ignore"});
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
after(()=>{if(available&&existsSync(join(directory,"postmaster.pid")))execFileSync(join(bin,"pg_ctl.exe"),["-D",directory,"-m","fast","-w","stop"],{env,windowsHide:true,stdio:"pipe"});});
const check=(name:string,fn:()=>void)=>test(name,{skip:available?false:"Local PostgreSQL unavailable: multi-account SQL NOT verified"},fn);
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
 insert into coinops.robot_v1_strategy_decisions(product_id,tenant_id,user_id,environment,asset,decision_id,strategy_version,cycle_id,slot_id,action_type,priority,reason,expected_next_state)
 values(${scope},'REAL','BTC','${"a".repeat(64)}','4.3.1','${liveRun}','${liveSlot}','OPEN_INITIAL_MARKET',1,'Fixture','{}'),
 (${scope},'REAL','BTC','${"b".repeat(64)}','4.3.1','${liveRun}','${liveSlot}','CREATE_TP',1,'Fixture','{}');`;
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
