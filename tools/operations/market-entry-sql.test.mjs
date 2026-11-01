import {readFileSync}from'node:fs';
import{createRequire}from'node:module';
import{before,after,test}from'node:test';
import assert from'node:assert/strict';
import{liveClientOrderId}from'../../apps/web/lib/execution/robot-v1-live-cycle.ts';
const require=createRequire(new URL('../testing/account-pause-sql/package.json',import.meta.url));
const{PGlite}=require('@electric-sql/pglite');const db=new PGlite();
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,q=s=>"'"+String(s).replaceAll("'","''")+"'";
const j=x=>q(JSON.stringify(x))+'::jsonb',decision='a'.repeat(64),lease=id(9);
const engine={exchange_account_id:id(5),trading_engine_id:id(6),base_asset:'BTC',legacy_compatible:false,slot_count:25};
const cid=liveClientOrderId(id(7),'BTC',7,8,'BUY',1,engine);
const query=async s=>(await db.query(s)).rows;
before(async()=>{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema coinops;
 create table coinops.operators(id uuid primary key,product_id uuid,tenant_id uuid,user_id uuid,status text,kill_switch boolean);
 create table coinops.exchange_accounts(id uuid primary key,operator_id uuid,status text,kill_switch boolean);
 create table coinops.trading_engines(id uuid primary key,operator_id uuid,exchange_account_id uuid,environment text,
   status text,symbol text,slot_count int,kill_switch boolean,strategy_config_pending boolean,hard_cap_quote numeric,legacy_compatible boolean);
 create table coinops.account_quote_caps(exchange_account_id uuid,quote_asset text,hard_cap_quote numeric);
 create table coinops.robot_v1_live_runs(id uuid primary key,product_id uuid,tenant_id uuid,user_id uuid,operator_id uuid,
   exchange_account_id uuid,trading_engine_id uuid,symbol text,asset text,quote_asset text,slot_count int,status text,
   lease_owner uuid,lease_until timestamptz,last_error text,config_snapshot jsonb,config_version int default 1);
 create table coinops.robot_v1_live_preparations(product_id uuid,tenant_id uuid,user_id uuid,trading_engine_id uuid,
   asset text,symbol text,slot_count int,configured_live_capital_brl numeric,max_order_notional_brl numeric,
   max_total_exposure_brl numeric,live_enabled boolean,kill_switch boolean,monthly_target int);
 create table coinops.robot_v1_live_slots(id uuid primary key,run_id uuid,product_id uuid,tenant_id uuid,user_id uuid,
   operator_id uuid,exchange_account_id uuid,trading_engine_id uuid,slot_number int,operation_sequence int,
   entry_state text,entry_reference_price numeric,target_buy_price numeric,operational_rank int,entry_origin text,
   position_quantity numeric,position_committed_brl numeric,missed_at timestamptz,unique(run_id,slot_number));
 create table coinops.robot_v1_live_slot_accounts(product_id uuid,tenant_id uuid,user_id uuid,operator_id uuid,
   exchange_account_id uuid,trading_engine_id uuid,asset text,slot_number int,balance_brl numeric,contribution_brl numeric,gain_count int);
 create table coinops.robot_v1_slot_gain_totals(product_id uuid,tenant_id uuid,user_id uuid,operator_id uuid,
   exchange_account_id uuid,trading_engine_id uuid,asset text,environment text,slot_number int,period_key text,
   lifetime_gain_count bigint,monthly_gain_count bigint);
 create table coinops.robot_v1_live_alerts(trading_engine_id uuid,severity text,resolved_at timestamptz);
 create table coinops.robot_v1_strategy_decisions(decision_id text primary key,product_id uuid,tenant_id uuid,user_id uuid,
   operator_id uuid,exchange_account_id uuid,trading_engine_id uuid,cycle_id uuid,slot_id uuid,environment text,
   operation_sequence int,action_type text,result text,dispatched_at timestamptz,exchange_ack_at timestamptz,
   constraint robot_v1_strategy_decisions_action_type_check check(action_type in('OPEN_INITIAL_MARKET','CREATE_TP','PLAN_LOCAL_REENTRY','ARM_NEXT_BUY','CANCEL_REPLACE_NEXT_BUY','COMPLETE_CYCLE','REANCHOR','WAIT')));
 create table coinops.robot_v1_live_orders(id uuid primary key default gen_random_uuid(),run_id uuid,slot_id uuid,
   product_id uuid,tenant_id uuid,user_id uuid,operator_id uuid,exchange_account_id uuid,trading_engine_id uuid,quote_asset text,
   slot_number int,operation_sequence int,side text,purpose text,revision int,client_order_id text unique,
   requested_quantity numeric,requested_quote numeric,price numeric,reserved_notional_brl numeric,
   strategy_decision_id text,config_version int,config_snapshot jsonb,status text default 'PREPARED',
   executed_quantity numeric default 0,cumulative_quote numeric default 0,trades_reconciled boolean default false,
   constraint robot_v1_live_order_request check((purpose='INITIAL'and requested_quote>0 and requested_quantity is null and price is null)
     or(purpose in('ENTRY','TP')and requested_quote is null and requested_quantity>0 and price>0)));
 create table coinops.robot_v1_live_events(id uuid default gen_random_uuid(),run_id uuid,product_id uuid,tenant_id uuid,
   user_id uuid,operator_id uuid,exchange_account_id uuid,trading_engine_id uuid,quote_asset text,event_key text,
   event_type text,slot_number int,details jsonb,observed_at timestamptz default now(),unique(run_id,event_key));
 grant usage on schema coinops to service_role;grant select,insert,update on all tables in schema coinops to service_role;
 insert into coinops.operators values('${id(1)}','${id(2)}','${id(3)}','${id(4)}','ACTIVE',false);
 insert into coinops.exchange_accounts values('${id(5)}','${id(1)}','ACTIVE',false);
 insert into coinops.trading_engines values('${id(6)}','${id(1)}','${id(5)}','REAL','ACTIVE','BTCBRL',25,false,false,5000,false);
 insert into coinops.account_quote_caps values('${id(5)}','BRL',5000);
 insert into coinops.robot_v1_live_runs values('${id(7)}','${id(2)}','${id(3)}','${id(4)}','${id(1)}','${id(5)}','${id(6)}',
   'BTCBRL','BTC','BRL',25,'ACTIVE','${lease}',now()+interval '1 hour',null,'{}',1);
 insert into coinops.robot_v1_live_preparations values('${id(2)}','${id(3)}','${id(4)}','${id(6)}','BTC','BTCBRL',25,5000,5000,5000,true,false,7);
 insert into coinops.robot_v1_live_slots select ('00000000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
   '${id(7)}','${id(2)}','${id(3)}','${id(4)}','${id(1)}','${id(5)}','${id(6)}',n,8,'PLANNED',432279,432279,n,'REENTRY',0,0,null from generate_series(1,25)n;
 insert into coinops.robot_v1_live_slot_accounts select '${id(2)}','${id(3)}','${id(4)}','${id(1)}','${id(5)}','${id(6)}','BTC',n,22,22,0 from generate_series(1,25)n;
 insert into coinops.robot_v1_slot_gain_totals select '${id(2)}','${id(3)}','${id(4)}','${id(1)}','${id(5)}','${id(6)}','BTC','REAL',n,
   to_char(now() at time zone 'America/Campo_Grande','YYYY-MM'),0,0 from generate_series(1,25)n;
 `);
 await db.exec(readFileSync(new URL('../../supabase/migrations/20261101123000_live_priority_market_entry.sql',import.meta.url),'utf8'));
});
after(async()=>db.close());
async function intent({missed=false,quote=22}={}){
 const period=(await query(`select to_char(now()at time zone'America/Campo_Grande','YYYY-MM')p`))[0].p;
 const authorization={policy:'PRIORITY_MISSED_MARKET_V1',run_id:id(7),engine_id:id(6),slot_id:id(107),slot_number:7,
  operation_sequence:8,period,source_missed_at:'2026-11-01T04:00:28Z',quote_cap:quote,authorization_event_key:'REQUEST:7:8'};
 const market={policy:'PRIORITY_MISSED_MARKET_V1',run_id:id(7),engine_id:id(6),slot_id:id(107),slot_number:7,
  operation_sequence:8,decision_id:decision,quote,reference_price:432279,reason:missed?'OPERATOR_MISSED_ENTRY':'PROSPECTIVE_CROSSED_ENTRY',period};
 await db.exec(`update coinops.robot_v1_live_runs set config_snapshot=${j({market_entry_intent:market,...(missed?{market_entry_authorization:authorization}:{})})};
 insert into coinops.robot_v1_strategy_decisions values('${decision}','${id(2)}','${id(3)}','${id(4)}','${id(1)}',
  '${id(5)}','${id(6)}','${id(7)}','${id(107)}','REAL',8,'OPEN_ENTRY_MARKET','PENDING',null,null);
 ${missed?`update coinops.robot_v1_live_slots set entry_state='MISSED',missed_at='2026-11-01T04:00:28Z'where slot_number=7;
 insert into coinops.robot_v1_live_events(run_id,trading_engine_id,event_key,event_type,slot_number,details)
 values('${id(7)}','${id(6)}','REQUEST:7:8','MISSED_MARKET_ENTRY_REQUESTED',7,${j(authorization)});`:''}`);
 return market;
}
const call=(quote=22,owner=lease)=>`select (coinops.prepare_robot_v1_live_order('${id(7)}','${id(107)}','BUY','ENTRY',1,
 ${q(cid)},null,${quote},null,'${decision}','${owner}')).*`;
async function tx(fn){await db.exec('begin');try{await fn();}finally{await db.exec('rollback');}}
async function denied(sql){await db.exec('savepoint rejected');await assert.rejects(db.query(sql));await db.exec('rollback to rejected');}

test('REAL prospective MARKET ENTRY uses complete slot budget, exact scope, one idempotent order and unchanged other slots',()=>tx(async()=>{
 await intent();const row=(await query(call()))[0];assert.equal(row.requested_quote,'22');assert.equal(row.price,null);
 assert.equal(row.trading_engine_id,id(6));assert.equal(row.operation_sequence,8);
 assert.equal((await query(`select entry_state from coinops.robot_v1_live_slots where slot_number=7`))[0].entry_state,'ARMED');
 assert.equal((await query(call()))[0].id,row.id);assert.equal((await query('select count(*)::int n from coinops.robot_v1_live_orders'))[0].n,1);
 assert.equal((await query(`select count(*)::int n from coinops.robot_v1_live_slots where slot_number<>7 and entry_state='PLANNED'`))[0].n,24);
}));
test('legacy MISSED requires exact operator request event; ordinary history cannot be swept into MARKET',()=>tx(async()=>{
 await intent({missed:true});await db.exec(`delete from coinops.robot_v1_live_events`);await denied(call());
 assert.equal((await query('select count(*)::int n from coinops.robot_v1_live_orders'))[0].n,0);
}));
test('legacy MISSED requested current operation enters once and clears only its missed flag',()=>tx(async()=>{
 await intent({missed:true});await query(call());const row=(await query(`select entry_state,missed_at from coinops.robot_v1_live_slots where slot_number=7`))[0];
 assert.equal(row.entry_state,'ARMED');assert.equal(row.missed_at,null);
}));
test('R$10 cannot replace a funded R$1122 slot; quote must equal complete current own balance',()=>tx(async()=>{
 await intent({quote:10});await db.exec(`update coinops.robot_v1_live_slot_accounts set balance_brl=1122.26938511 where slot_number=7`);
 await denied(call(10));
}));
test('individual monthly target waits; only complete N/N proof permits the same-month exception',()=>tx(async()=>{
 await intent();await db.exec(`update coinops.robot_v1_slot_gain_totals set lifetime_gain_count=7,monthly_gain_count=7 where slot_number=7`);
 await denied(call());await db.exec(`update coinops.robot_v1_slot_gain_totals set lifetime_gain_count=7,monthly_gain_count=7`);
 assert.equal((await query(call()))[0].requested_quote,'22');
}));
test('lease, position/partial fill, gates, config, ownership, dispatched intent and budget cannot be bypassed',async()=>{
 for(const mutation of [
  `update coinops.robot_v1_live_runs set lease_until=now()-interval '1 second'`,
  `update coinops.robot_v1_live_slots set entry_state='OPEN',position_quantity=.004,position_committed_brl=2.05 where slot_number=7`,
  `update coinops.trading_engines set kill_switch=true`,
  `update coinops.trading_engines set strategy_config_pending=true`,
  `update coinops.robot_v1_live_preparations set kill_switch=true`,
  `update coinops.robot_v1_strategy_decisions set dispatched_at=now(),result='DISPATCHED'`,
  `update coinops.robot_v1_strategy_decisions set exchange_account_id='${id(99)}'`,
  `update coinops.account_quote_caps set hard_cap_quote=1`,
  `update coinops.robot_v1_live_runs set config_snapshot=jsonb_set(config_snapshot,'{market_entry_intent,operation_sequence}','9')`,
 ])await tx(async()=>{await intent();await db.exec(mutation);await denied(call());
  assert.equal((await query('select count(*)::int n from coinops.robot_v1_live_orders'))[0].n,0);});
});
test('actual terminal MARKET fill establishes only its new reference and immutable audit; history/replay cannot drift',()=>tx(async()=>{
 await intent();const order=(await query(call()))[0];
 await db.exec(`update coinops.robot_v1_live_orders set status='FILLED',executed_quantity=.00005,cumulative_quote=21.18365,trades_reconciled=true;
 update coinops.robot_v1_live_slots set entry_state='OPEN',position_quantity=.00005,position_committed_brl=21.18365 where slot_number=7`);
 const sql=`select coinops.finalize_live_market_entry_reference('${order.id}',1,'${lease}')p`;
 assert.equal((await query(sql))[0].p,'423673');assert.equal((await query(sql))[0].p,'423673');
 assert.equal((await query(`select count(*)::int n from coinops.robot_v1_live_events where event_type='MARKET_ENTRY_REFERENCE'`))[0].n,1);
 await denied(`select coinops.finalize_live_market_entry_reference('${order.id}',10,'${lease}')`);
 await db.exec(`update coinops.robot_v1_live_slots set operation_sequence=9 where slot_number=7`);await denied(sql);
}));
test('anon/authenticated cannot execute either financial RPC',async()=>{
 for(const role of ['anon','authenticated'])await tx(async()=>{
  await db.exec(`grant usage on schema coinops to ${role};set local role ${role}`);
  await denied(call());await denied(`select coinops.finalize_live_market_entry_reference('${id(999)}',1,'${lease}')`);
 });
});
