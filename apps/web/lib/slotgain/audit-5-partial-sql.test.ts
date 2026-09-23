import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Disposable loopback-only PostgreSQL, independent from the ledger test's port.
// No .env, Supabase link, production credential or external server is read.
const bin = process.env.COINOPS_AUDIT_PG_BIN ?? "C:/Program Files/PostgreSQL/17/bin";
const available = existsSync(join(bin, "initdb.exe"));
const directory = available ? mkdtempSync(join(tmpdir(), "coinops-audit-partial-")) : "";
const port = 55442;
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG"))), NODE_ENV: process.env.NODE_ENV,
  PGHOST: "127.0.0.1", PGPORT: String(port), PGUSER: "audit_owner", PGDATABASE: "postgres",
  PGPASSFILE: join(directory, "no-credentials") };
const args = ["-X", "-w", "-h", "127.0.0.1", "-p", String(port), "-U", "audit_owner", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"];
const sql = (query: string) => execFileSync(join(bin, "psql.exe"), [...args, "-c", query], { env,
  encoding: "utf8", windowsHide: true, stdio: "pipe" }).replace(/\r/g, "").trim();
const ids = { product: "11111111-1111-4111-8111-111111111111", tenant: "22222222-2222-4222-8222-222222222222",
  user: "33333333-3333-4333-8333-333333333333", run: "55555555-5555-4555-8555-555555555555" };
const scope = `'${ids.product}','${ids.tenant}','${ids.user}'`;
const slot = `(select id from coinops.robot_v1_testnet_slots where run_id='${ids.run}' and slot_number=1)`;
const proof = `private.coinops_testnet_operation_closure('${ids.run}',${slot},1,.001)`;
const bootstrap = `
create role anon; create role authenticated; create role service_role bypassrls;
create schema coinops; create schema private; create schema auth;
grant usage on schema coinops,private,auth to authenticated,service_role,anon;
create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;
create table coinops.robot_v1_testnet_runs(id uuid primary key default gen_random_uuid(),product_id uuid,tenant_id uuid,user_id uuid,
 asset text,symbol text,status text default 'ACTIVE',anchor_price numeric,slot_notional_usdc numeric,gain_rate numeric,entry_spacing numeric,
 next_capital_usdc numeric,next_gain_rate numeric,next_entry_spacing numeric,previous_run_id uuid,terminal_fill_client_order_id text,
 reset_idempotency_key text unique,reset_started_at timestamptz,recovery_source text,completed_at timestamptz,completion_reason text);
create table coinops.robot_v1_testnet_slots(id uuid primary key default gen_random_uuid(),run_id uuid,product_id uuid,tenant_id uuid,user_id uuid,
 slot_number integer,entry_state text,operation_sequence integer default 1,balance_usdc numeric,gain_count integer default 0,net_profit_usdc numeric default 0,
 target_buy_price numeric,entry_origin text default 'GRID',entry_reference_price numeric,unique(run_id,slot_number));
create table coinops.robot_v1_testnet_orders(id uuid primary key default gen_random_uuid(),run_id uuid,slot_id uuid,product_id uuid,tenant_id uuid,user_id uuid,
 slot_number integer,operation_sequence integer default 1,side text,purpose text,revision integer default 1,client_order_id text unique,
 exchange_order_id text,status text,executed_quantity numeric,cumulative_quote numeric,fee_base numeric default 0,fee_quote numeric default 0,
 fee_other jsonb default '[]',trades_reconciled boolean default true,price numeric);
create table coinops.robot_v1_testnet_events(id uuid primary key default gen_random_uuid(),run_id uuid,product_id uuid,tenant_id uuid,user_id uuid,
 event_key text,event_type text,slot_number integer,details jsonb,observed_at timestamptz default now(),unique(run_id,event_key));
create table coinops.robot_v1_monthly_slot_gains(environment text,source_id uuid,product_id uuid,tenant_id uuid,user_id uuid,asset text,
 slot_number integer,physical_slot_id text,credited_at timestamptz,effective_gain_at timestamptz,evidence_basis text,period_key text,
 primary key(environment,source_id));
create table coinops.robot_v1_slot_gain_totals(environment text,product_id uuid,tenant_id uuid,user_id uuid,asset text,slot_number integer,monthly_gain_count integer);
insert into coinops.robot_v1_testnet_runs(id,product_id,tenant_id,user_id,asset,symbol,anchor_price,slot_notional_usdc,gain_rate,entry_spacing)
 values('${ids.run}',${scope},'SOL','SOLUSDC',10,10,.005,.01);
insert into coinops.robot_v1_testnet_slots(run_id,product_id,tenant_id,user_id,slot_number,entry_state,balance_usdc,target_buy_price,entry_reference_price)
 select '${ids.run}',${scope},n,case when n=1 then 'OPEN' else 'PLANNED' end,10,10,10 from generate_series(1,25)n;
insert into coinops.robot_v1_testnet_orders(run_id,slot_id,product_id,tenant_id,user_id,slot_number,side,purpose,client_order_id,exchange_order_id,status,executed_quantity,cumulative_quote,fee_base,fee_quote,price)
 values('${ids.run}',${slot},${scope},1,'BUY','INITIAL','buy','exchange-buy','FILLED',1,10,.0005,.01,10),
 ('${ids.run}',${slot},${scope},1,'SELL','TP','sell','exchange-sell','CANCELED',.999,10.2,0,.01,10.21);
`;
before(() => {
  if (!available) return;
  execFileSync(join(bin,"initdb.exe"),["-D",directory,"-U","audit_owner","-A","trust","--no-locale","-E","UTF8"],{env,windowsHide:true,stdio:"pipe"});
  execFileSync(join(bin,"pg_ctl.exe"),["-D",directory,"-l",join(directory,"server.log"),"-o",`-h 127.0.0.1 -p ${port}`,"-w","start"],{env,windowsHide:true,stdio:"ignore"});
  sql(bootstrap);
  const baseline = readFileSync(resolve("../../supabase/migrations/20260923181111_add_robot_v1_monthly_slot_gain_ledger.sql"),"utf8");
  const fn = baseline.match(/create function coinops\.record_robot_v1_testnet_monthly_gain\(\)[\s\S]*?end \$\$;/)?.[0];
  assert.ok(fn); sql(fn);
  sql("create trigger monthly_gain after insert on coinops.robot_v1_testnet_events for each row execute function coinops.record_robot_v1_testnet_monthly_gain()");
  if (process.env.COINOPS_AUDIT_PARTIAL_BASELINE !== "1") execFileSync(join(bin,"psql.exe"),[...args,"-f",resolve("../../supabase/migrations/20260923231731_harden_robot_v1_testnet_partial_accounting.sql")],{env,windowsHide:true,stdio:"pipe"});
});
after(() => {
  if(available&&existsSync(join(directory,"postmaster.pid"))) execFileSync(join(bin,"pg_ctl.exe"),["-D",directory,"-m","fast","-w","stop"],{env,windowsHide:true,stdio:"pipe"});
});
const check=(name:string,fn:()=>void)=>test(name,{skip:available?false:"Local PostgreSQL unavailable: partial SQL NOT verified"},fn);
const tx=(body:string)=>sql(`begin; set local request.jwt.claim.role='service_role'; ${body}; rollback`);
const close=(key="close",profit=".18",execution=true)=>`insert into coinops.robot_v1_testnet_events(run_id,product_id,tenant_id,user_id,event_key,event_type,slot_number,details,observed_at)
 values('${ids.run}',${scope},'${key}','SLOT_CLOSED',1,jsonb_build_object('profitUsdc',${profit},'gainCount',1,'operationSequence',1${execution?",'execution',jsonb_build_object('quantityStep',.001,'closingSellClientOrderId','sell','remainingDust',.0005,'terminalStatus','CANCELED')":""}),'2026-10-01T04:01:00Z')`;
const reset=(override:Partial<{run:string;terminal:string;anchor:string;tick:string;key:string;source:string;at:string}>={})=>{
 const v={run:`'${ids.run}'`,terminal:"'sell'",anchor:"10",tick:".01",key:`'${"a".repeat(64)}'`,source:"'AUDIT'",at:"now()",...override};
 return `coinops.restart_robot_v1_testnet_cycle_v2(${v.run},${v.terminal},${v.anchor},${v.tick},${v.key},${v.source},${v.at})`;
};
check("partial SQL: terminal partial TP credits one month gain from proven remaining dust",()=>{
 const result=tx(`${close()}; select count(*)=1 from coinops.robot_v1_monthly_slot_gains`);
 assert.ok(result.split("\n").includes("t"));
});
check("partial SQL: reconciled 10/50/99 percent BUY closes exactly its acquired quantity",()=>{
 for(const qty of [.1,.5,.99]) assert.ok(tx(`update coinops.robot_v1_testnet_orders set status='CANCELED',executed_quantity=${qty},cumulative_quote=${qty}*10,fee_base=0,fee_quote=0 where side='BUY';
 update coinops.robot_v1_testnet_orders set executed_quantity=${qty},cumulative_quote=${qty}*10.1,fee_quote=0 where side='SELL';
 select (${proof}->>'eligible')::boolean and (${proof}->>'net_profit_usdc')::numeric=${qty}*.1`).split("\n").includes("t"));
});
check("partial SQL: unclosed position, active order, unvalued fee and unreconciled trades fail closed",()=>{
 for(const update of ["executed_quantity=.5","status='PARTIALLY_FILLED'","fee_other='[{\"asset\":\"BNB\",\"amount\":0.1}]'::jsonb","trades_reconciled=false"])
  assert.ok(tx(`update coinops.robot_v1_testnet_orders set ${update} where side='SELL'; select not (${proof}->>'eligible')::boolean`).split("\n").includes("t"));
});
check("partial SQL: multiple terminal TP revisions close once after all fills and fees",()=>{
 const result=tx(`update coinops.robot_v1_testnet_orders set executed_quantity=.499,cumulative_quote=5.1,fee_quote=.005 where side='SELL';
 insert into coinops.robot_v1_testnet_orders(run_id,slot_id,product_id,tenant_id,user_id,slot_number,side,purpose,revision,client_order_id,
 exchange_order_id,status,executed_quantity,cumulative_quote,fee_quote,price)
 values('${ids.run}',${slot},${scope},1,'SELL','TP',2,'sell-final','exchange-final','EXPIRED_IN_MATCH',.5,5.1,.005,10.2);
 select (${proof}->>'eligible')::boolean and ${proof}->>'closing_sell_client_order_id'='sell-final'
 and (${proof}->>'net_profit_usdc')::numeric=.18 and (${proof}->>'remaining_dust')::numeric=.0005`);
 assert.ok(result.split("\n").includes("t"));
});
check("partial SQL: oversell and NaN cannot produce closure or gain",()=>{
 for(const value of ["2","'NaN'::numeric"])
  assert.ok(tx(`update coinops.robot_v1_testnet_orders set executed_quantity=${value} where side='SELL'; select not (${proof}->>'eligible')::boolean`).split("\n").includes("t"));
 assert.throws(()=>tx(close("invalid","'NaN'::numeric")),/GAIN_UNKNOWN/);
});
check("partial SQL: profit mismatch and repeated operation gain are rejected atomically",()=>{
 assert.throws(()=>tx(close("wrong","1")),/GAIN_EVIDENCE_INVALID/);
 assert.throws(()=>tx(`${close()}; ${close("duplicate")}`),/OPERATION_ALREADY_CREDITED/);
 assert.equal(sql("select count(*) from coinops.robot_v1_monthly_slot_gains"),"0");
});
check("partial SQL: delayed reconciliation attributes gain to exchange month boundary",()=>{
 const result=tx(`insert into coinops.robot_v1_testnet_events(run_id,product_id,tenant_id,user_id,event_key,event_type,details)
 values('${ids.run}',${scope},'fill','TESTNET_FILL_OBSERVED','{"clientOrderId":"sell","filledAt":"2026-10-01T03:59:59.999Z"}');
 ${close()}; select period_key='2026-09' and evidence_basis='TESTNET_EXCHANGE_FILL' from coinops.robot_v1_monthly_slot_gains`);
 assert.ok(result.split("\n").includes("t"));
});
check("partial SQL: closure month follows the latest fill across all SELL revisions, not the newest order",()=>{
 const result=tx(`update coinops.robot_v1_testnet_orders set executed_quantity=.499,cumulative_quote=5.1,fee_quote=.005 where side='SELL';
 insert into coinops.robot_v1_testnet_orders(run_id,slot_id,product_id,tenant_id,user_id,slot_number,side,purpose,revision,client_order_id,
 exchange_order_id,status,executed_quantity,cumulative_quote,fee_quote,price)
 values('${ids.run}',${slot},${scope},1,'SELL','TP',2,'sell-final','exchange-final','CANCELED',.5,5.1,.005,10.2);
 insert into coinops.robot_v1_testnet_events(run_id,product_id,tenant_id,user_id,event_key,event_type,details,observed_at)
 values('${ids.run}',${scope},'fill-r2','TESTNET_FILL_OBSERVED','{"clientOrderId":"sell-final","filledAt":"2026-10-01T03:59:59.999Z"}','2026-10-01T04:02:00Z'),
 ('${ids.run}',${scope},'fill-r1','TESTNET_FILL_OBSERVED','{"clientOrderId":"sell","filledAt":"2026-10-01T04:00:00.001Z"}','2026-10-01T04:01:00Z'),
 ('${ids.run}',${scope},'buy-ignore','TESTNET_FILL_OBSERVED','{"clientOrderId":"buy","filledAt":"2026-11-01T04:00:00Z"}','2026-11-01T04:01:00Z');
 ${close().replace("'closingSellClientOrderId','sell'","'closingSellClientOrderId','sell-final'")};
 select period_key='2026-10' and effective_gain_at='2026-10-01T04:00:00.001Z'::timestamptz from coinops.robot_v1_monthly_slot_gains`);
 assert.ok(result.split("\n").includes("t"));
});
check("partial SQL: missing time for any executed SELL uses explicit credit fallback, never an early month",()=>{
 const result=tx(`update coinops.robot_v1_testnet_orders set executed_quantity=.499,cumulative_quote=5.1,fee_quote=.005 where side='SELL';
 insert into coinops.robot_v1_testnet_orders(run_id,slot_id,product_id,tenant_id,user_id,slot_number,side,purpose,revision,client_order_id,
 exchange_order_id,status,executed_quantity,cumulative_quote,fee_quote,price)
 values('${ids.run}',${slot},${scope},1,'SELL','TP',2,'sell-final','exchange-final','CANCELED',.5,5.1,.005,10.2);
 insert into coinops.robot_v1_testnet_events(run_id,product_id,tenant_id,user_id,event_key,event_type,details)
 values('${ids.run}',${scope},'fill-r2','TESTNET_FILL_OBSERVED','{"clientOrderId":"sell-final","filledAt":"2026-10-01T03:59:59.999Z"}');
 select (${proof}->>'eligible')::boolean and ${proof}->>'closed_at' is null;
 ${close().replace("'closingSellClientOrderId','sell'","'closingSellClientOrderId','sell-final'")};
 select period_key='2026-10' and effective_gain_at='2026-10-01T04:01:00Z'::timestamptz
 and evidence_basis='TESTNET_CREDIT_FALLBACK' from coinops.robot_v1_monthly_slot_gains`);
 assert.equal(result.split("\n").filter(line=>line==="t").length,2);
});
check("partial SQL: legacy FILLED event remains compatible but partial needs proof",()=>{
 assert.ok(tx(`update coinops.robot_v1_testnet_orders set status='FILLED' where side='SELL'; ${close("legacy",".18",false)};
 select count(*)=1 from coinops.robot_v1_monthly_slot_gains`).split("\n").includes("t"));
 assert.throws(()=>tx(close("no-proof",".18",false)),/GAIN_EVIDENCE_INVALID/);
});
check("partial SQL: terminal partial rollover carries 25 slots and retry creates no duplicate",()=>{
 const result=tx(`${close()}; update coinops.robot_v1_testnet_slots set entry_state='CLOSED' where slot_number=1;
 select created from ${reset()}; select not created from ${reset()};
 select count(*)=2 from coinops.robot_v1_testnet_runs;
 select count(*)=25 and count(distinct slot_number)=25 from coinops.robot_v1_testnet_slots where run_id<>'${ids.run}'`);
 assert.equal(result.split("\n").filter(line=>line==="t").length,4);
});
check("partial SQL: restart requires partial closure proof and rejects forged proof",()=>{
 assert.throws(()=>tx(`update coinops.robot_v1_testnet_slots set entry_state='CLOSED'; select * from ${reset()}`),/TERMINAL_FILL_REQUIRED/);
 assert.throws(()=>tx(`${close()}; update coinops.robot_v1_testnet_slots set entry_state='CLOSED';
 update coinops.robot_v1_testnet_orders set executed_quantity=.5 where side='SELL'; select * from ${reset()}`),/TERMINAL_FILL_REQUIRED/);
});
check("partial SQL: restart parameters reject NULL, NaN and invalid date",()=>{
 for(const change of [{anchor:"null"},{tick:"null"},{key:"null"},{source:"null"},{at:"null"},
  {anchor:"'NaN'::numeric"},{tick:"'NaN'::numeric"},{at:"'infinity'::timestamptz"}])
  assert.throws(()=>tx(`select * from ${reset(change)}`),/RESET_INPUT_INVALID/);
});
check("partial SQL: reset idempotency key cannot alias another old run",()=>{
 assert.throws(()=>tx(`${close()}; update coinops.robot_v1_testnet_slots set entry_state='CLOSED'; select * from ${reset()};
 insert into coinops.robot_v1_testnet_runs(id,product_id,tenant_id,user_id,asset,symbol,status) values('77777777-7777-4777-8777-777777777777',${scope},'BTC','BTCUSDC','ACTIVE');
 select * from ${reset({run:"'77777777-7777-4777-8777-777777777777'"})}`),/RESET_IDEMPOTENCY_CONFLICT/);
});
check("partial SQL: all 25 targets block cycle creation and next period eligibility permits it",()=>{
 assert.throws(()=>tx(`${close()}; update coinops.robot_v1_testnet_slots set entry_state='CLOSED';
 insert into coinops.robot_v1_slot_gain_totals select 'TESTNET',${scope},'SOL',n,2 from generate_series(1,25)n;
 select * from ${reset()}`),/ALL_MONTHLY_TARGETS_REACHED/);
 assert.ok(tx(`${close()}; update coinops.robot_v1_testnet_slots set entry_state='CLOSED';
 insert into coinops.robot_v1_slot_gain_totals select 'TESTNET',${scope},'SOL',n,0 from generate_series(1,25)n;
 select created from ${reset()}`).split("\n").includes("t"));
});
check("partial SQL: privileged helper/restart unavailable to authenticated and anon",()=>{
 const physicalId=sql(`select id from coinops.robot_v1_testnet_slots where run_id='${ids.run}' and slot_number=1`);
 const directProof=`private.coinops_testnet_operation_closure('${ids.run}','${physicalId}',1,.001)`;
 for(const role of ["authenticated","anon"]) {
  assert.throws(()=>sql(`begin; set local role ${role}; select ${directProof}; rollback`),/permission denied for function/);
  assert.throws(()=>sql(`begin; set local role ${role}; select * from ${reset()}; rollback`),/permission denied for function/);
 }
});
