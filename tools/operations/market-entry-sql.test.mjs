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
 await db.exec(`alter table coinops.trading_engines add column config jsonb default '{}',add column updated_at timestamptz default now();
 alter table coinops.robot_v1_live_preparations add column id uuid default gen_random_uuid(),add column compounding_enabled boolean default true,
 add column max_order_notional_quote numeric generated always as(max_order_notional_brl)stored,add column updated_at timestamptz default now(),
 add column operator_id uuid default '${id(1)}',add column exchange_account_id uuid default '${id(5)}',add column config_version int default 1;
 alter table coinops.robot_v1_live_slot_accounts add column market_pnl_brl numeric default 0,add column manual_gain_brl numeric default 0,
 add column fees_brl numeric default 0,add column dust_quantity numeric default 0;
 alter table coinops.account_quote_caps add column operator_id uuid default '${id(1)}';`);
 await db.exec(readFileSync(new URL('../../supabase/migrations/20261101123000_live_priority_market_entry.sql',import.meta.url),'utf8'));
 await db.exec(readFileSync(new URL('../../supabase/migrations/20261101171116_live_recovery_order_cap_alignment.sql',import.meta.url),'utf8'));
 await db.exec(readFileSync(new URL('../../supabase/migrations/20261101175214_fix_recovery_order_cap_generated_alias.sql',import.meta.url),'utf8'));
 await db.exec(`create schema auth;create schema private;create function auth.jwt()returns jsonb language sql as 'select ''{"role":"service_role"}''::jsonb';
 alter table coinops.trading_engines add column executor_shard_id text default 'executor-02';
 alter table coinops.robot_v1_live_runs add column gain_rate numeric default .055,add column entry_spacing numeric default .03;
 alter table coinops.robot_v1_live_orders add column exchange_order_id text,add column fee_base numeric default 0;
 alter table coinops.robot_v1_strategy_decisions add column reason text;
 alter table coinops.robot_v1_live_alerts add column id uuid default gen_random_uuid(),add column alert_key text,
  add column exchange_account_id uuid,add column code text,add column details jsonb,add column first_seen_at timestamptz default now();
 create table coinops.robot_v1_live_fills(order_id uuid,quantity numeric,quote_quantity numeric,commission_brl numeric,commission_asset text);
 create table coinops.account_order_budget_reservations(client_order_id text primary key,exchange_account_id uuid,operator_id uuid,
  trading_engine_id uuid,executor_shard_id text,reserved_at timestamptz default now(),acknowledged_at timestamptz,protection_orders int default 0);
 create table coinops.account_order_budget_samples(exchange_account_id uuid,server_time_ms bigint,observed_at timestamptz,intervals jsonb);
 create function private.coinops_account_order_budget_gate(uuid,uuid,integer,jsonb)returns jsonb language sql as
 'select jsonb_build_object(''code'',coalesce(nullif(current_setting(''fixture.budget_gate'',true),''''),''PASS''),''cost'',$3)';
 grant select,insert,update on all tables in schema coinops to service_role;`);
 const budgetMigration=readFileSync(new URL('../../supabase/migrations/20261004125202_add_same_symbol_engine_provisioning.sql',import.meta.url),'utf8');
 const reserve=budgetMigration.slice(budgetMigration.indexOf('create function coinops.reserve_account_order_budget('),budgetMigration.indexOf('create function coinops.acknowledge_account_order_budget('));
 await db.exec(reserve);
 await db.exec(readFileSync(new URL('../../supabase/migrations/20261101175946_live_orphaned_partial_entry_recovery.sql',import.meta.url),'utf8'));
 await db.exec(`alter table coinops.robot_v1_live_slots add column last_take_profit_price numeric,add column last_credited_sell_client_order_id text;
  alter table coinops.robot_v1_live_slot_accounts add column dust_cost_brl numeric default 0;
  alter table coinops.robot_v1_live_fills add column filled_at timestamptz default now();
  create table coinops.robot_v1_monthly_slot_gains(environment text,source_id uuid,product_id uuid,tenant_id uuid,user_id uuid,asset text,
    slot_number int,physical_slot_id text,credited_at timestamptz,effective_gain_at timestamptz,evidence_basis text,period_key text,unique(environment,source_id));
  create table coinops.robot_v1_live_selective_contribution_allocations(trading_engine_id uuid,slot_number int,status text,
    applied_at timestamptz,applied_operation_sequence int,amount_quote numeric);`);
 const creditMigration=readFileSync(new URL('../../supabase/migrations/20260927133000_add_selective_slot_contributions.sql',import.meta.url),'utf8');
 const creditStart=creditMigration.indexOf('create or replace function coinops.credit_robot_v1_live_closed_slot(');
 await db.exec(creditMigration.slice(creditStart,creditMigration.indexOf('end $$;',creditStart)+8));
});
after(async()=>db.close());
async function intent({missed=false,quote=22,explicit=false}={}){
 const period=(await query(`select to_char(now()at time zone'America/Campo_Grande','YYYY-MM')p`))[0].p;
 const authorization={policy:'PRIORITY_MISSED_MARKET_V1',run_id:id(7),engine_id:id(6),slot_id:id(107),slot_number:7,
  operation_sequence:8,period,source_missed_at:'2026-11-01T04:00:28Z',quote_cap:quote,
  authorization_event_key:explicit?'REQUEST:7:8:EXPLICIT_OPERATION_V1':'REQUEST:7:8',
  ...(explicit?{recovery_priority:'EXPLICIT_OPERATION_V1'}:{})};
 const market={policy:'PRIORITY_MISSED_MARKET_V1',run_id:id(7),engine_id:id(6),slot_id:id(107),slot_number:7,
  operation_sequence:8,decision_id:decision,quote,reference_price:432279,reason:missed?'OPERATOR_MISSED_ENTRY':'PROSPECTIVE_CROSSED_ENTRY',period};
 await db.exec(`update coinops.robot_v1_live_runs set config_snapshot=${j({market_entry_intent:market,...(missed?{market_entry_authorization:authorization}:{})})};
 insert into coinops.robot_v1_strategy_decisions values('${decision}','${id(2)}','${id(3)}','${id(4)}','${id(1)}',
  '${id(5)}','${id(6)}','${id(7)}','${id(107)}','REAL',8,'OPEN_ENTRY_MARKET','PENDING',null,null);
 ${missed?`update coinops.robot_v1_live_slots set entry_state='MISSED',missed_at='2026-11-01T04:00:28Z'where slot_number=7;
 insert into coinops.robot_v1_live_events(run_id,trading_engine_id,event_key,event_type,slot_number,details)
 values('${id(7)}','${id(6)}',${q(authorization.authorization_event_key)},'MISSED_MARKET_ENTRY_REQUESTED',7,${j(authorization)});`:''}`);
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
test('explicit recovery still needs an exact immutable authorization and preserves gain counters',()=>tx(async()=>{
 await intent({missed:true,explicit:true});
 await db.exec(`update coinops.robot_v1_slot_gain_totals set monthly_gain_count=1,lifetime_gain_count=1 where slot_number=9`);
 const row=(await query(call()))[0];assert.equal(row.requested_quote,'22');
 assert.equal(row.config_snapshot.market_entry_authorization.recovery_priority,'EXPLICIT_OPERATION_V1');
 assert.equal(Number((await query(`select monthly_gain_count from coinops.robot_v1_slot_gain_totals where slot_number=9`))[0].monthly_gain_count),1);
}));

const align=(target=22,expected=18,owner=lease)=>`select coinops.align_live_recovery_order_cap('${id(7)}','${id(107)}',${expected},${target},5000,5000,'${owner}')e`;
async function capFixture(){await intent({missed:true,explicit:true});await db.exec(`update coinops.robot_v1_live_preparations set max_order_notional_brl=18;
 update coinops.robot_v1_live_slot_accounts set contribution_brl=18,market_pnl_brl=4,gain_count=1 where slot_number=7;`);}
test('unit cap alignment is exact/replayable and never changes capital, siblings, balances or total caps',()=>tx(async()=>{
 await capFixture();const before=(await query(`select sum(balance_brl)total from coinops.robot_v1_live_slot_accounts`))[0].total;
 assert.equal((await query(align()))[0].e.new_order_cap,22);assert.equal((await query(align()))[0].e.new_order_cap,22);
 assert.equal((await query(`select max_order_notional_brl c,configured_live_capital_brl capital,max_total_exposure_brl exposure from coinops.robot_v1_live_preparations`))[0].c,'22');
 assert.equal((await query(`select sum(balance_brl)total from coinops.robot_v1_live_slot_accounts`))[0].total,before);
 assert.equal((await query(`select hard_cap_quote c from coinops.trading_engines`))[0].c,'5000');
 assert.equal((await query(`select count(*)::int n from coinops.robot_v1_live_events where event_type='RECOVERY_ORDER_CAP_ALIGNED'`))[0].n,1);
}));
test('unit cap alignment refuses unapproved funds, missing authorization, noncompounding, lease/caps drift or OPEN',()=>tx(async()=>{
 await capFixture();await denied(align(23));await denied(align(22,17));await denied(align(22,18,id(88)));
 for(const change of [`update coinops.robot_v1_live_preparations set compounding_enabled=false`,
  `update coinops.robot_v1_live_slot_accounts set market_pnl_brl=0 where slot_number=7`,
  `delete from coinops.robot_v1_live_events`,
  `update coinops.robot_v1_live_slots set entry_state='OPEN'where slot_number=7`,
  `update coinops.account_quote_caps set hard_cap_quote=4999`]){
  await db.exec('savepoint case_change');await db.exec(change);await denied(align());await db.exec('rollback to case_change');
 }
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
  await denied(call());await denied(`select coinops.finalize_live_market_entry_reference('${id(999)}',1,'${lease}')`);await denied(align());
 });
});

async function partialFixture({credit=1}={}){
 const at=(await query('select now()::text at'))[0].at;
 const parent=liveClientOrderId(id(7),'BTC',7,8,'BUY',1,engine),next=liveClientOrderId(id(7),'BTC',7,8,'BUY',2,engine);
 const proof={policy:'ORPHANED_PARTIAL_RECOVERY_V1',run_id:id(7),engine_id:id(6),slot_id:id(107),slot_number:7,operation_sequence:8,
  source_order_id:id(80),source_client_order_id:parent,source_exchange_order_id:'123',source_quantity:.004,source_quote:2,
  source_fee_base:0,source_committed:2.001,quote:10.5,slot_balance:22,gain_rate:.055,spacing:.03,
  incident_key:'ROOT',incident_first_seen_at:at,authorization_event_key:'PARTIAL:7:8',authorized_at:at};
 await db.exec(`update coinops.trading_engines set kill_switch=true;update coinops.robot_v1_live_preparations set kill_switch=true;
  update coinops.robot_v1_live_runs set last_error='COINOPS_LIVE_TP_FILTER_UNPROTECTABLE',config_snapshot=${j({partial_entry_recovery_authorization:proof})};
  update coinops.robot_v1_live_slots set entry_state='OPEN',position_quantity=.004,position_committed_brl=2.001 where slot_number=7;
  insert into coinops.robot_v1_live_orders(id,run_id,slot_id,trading_engine_id,operator_id,exchange_account_id,slot_number,operation_sequence,side,purpose,
   revision,client_order_id,exchange_order_id,status,executed_quantity,cumulative_quote,trades_reconciled,requested_quantity,price)
   values('${id(80)}','${id(7)}','${id(107)}','${id(6)}','${id(1)}','${id(5)}',7,8,'BUY','ENTRY',1,${q(parent)},'123','CANCELED',.004,2,true,2,500);
  insert into coinops.robot_v1_live_fills values('${id(80)}',.004,2,.001,'BNB');
  insert into coinops.robot_v1_live_alerts(trading_engine_id,exchange_account_id,severity,alert_key,code,details,first_seen_at)
   values('${id(6)}','${id(5)}','CRITICAL','ROOT','COINOPS_LIVE_TP_FILTER_UNPROTECTABLE','{"root_code":"COINOPS_LIVE_TP_FILTER_UNPROTECTABLE","stage":"PROTECT_TP"}',${q(at)});
  insert into coinops.robot_v1_live_events(run_id,trading_engine_id,slot_number,event_key,event_type,details)
   values('${id(7)}','${id(6)}',7,'PARTIAL:7:8','PARTIAL_ENTRY_RECOVERY_REQUESTED',${j(proof)});
  insert into coinops.robot_v1_strategy_decisions(decision_id,trading_engine_id,cycle_id,slot_id,environment,operation_sequence,action_type,result,reason)
   values('${decision}','${id(6)}','${id(7)}','${id(107)}','REAL',8,'OPEN_ENTRY_MARKET','PENDING','ORPHANED_PARTIAL_RECOVERY_V1');
  insert into coinops.account_order_budget_reservations(client_order_id,exchange_account_id,operator_id,trading_engine_id,executor_shard_id,protection_orders)
   values(${q(parent)},'${id(5)}','${id(1)}','${id(6)}','executor-02',${credit});
  insert into coinops.account_order_budget_samples values('${id(5)}',(extract(epoch from now())*1000)::bigint,now(),'[{"intervalMs":10000}]');`);
 return{proof,parent,next,sql:`select(coinops.prepare_live_partial_entry_recovery('${id(7)}','${id(107)}',2,${q(next)},'${decision}','${lease}')).*`};
}
test('terminal tiny partial rescue is same-operation, exact, replayable; uses own budget and preserves all slots/gains/gates',()=>tx(async()=>{
 const f=await partialFixture(),before=(await query('select sum(balance_brl)b from coinops.robot_v1_live_slot_accounts'))[0].b;
 const o=(await query(f.sql))[0];assert.equal(o.requested_quote,'10.5');assert.equal(o.operation_sequence,8);
 assert.equal((await query(f.sql))[0].id,o.id);assert.equal((await query('select count(*)::int n from coinops.robot_v1_live_orders'))[0].n,2);
 assert.equal((await query('select sum(balance_brl)b from coinops.robot_v1_live_slot_accounts'))[0].b,before);
 assert.equal((await query('select kill_switch from coinops.trading_engines'))[0].kill_switch,true);
 assert.equal((await query(`select position_quantity from coinops.robot_v1_live_slots where slot_number=7`))[0].position_quantity,'.004'.replace(/^\./,'0.'));
}));
test('recovery reservation reuses exact source protection credit, never duplicates it and still obeys venue budget',async()=>{
 for(const credit of [0,1])await tx(async()=>{
  const f=await partialFixture({credit});await query(f.sql);
  const reserve=`select coinops.reserve_account_order_budget('${id(1)}','${id(5)}','${id(6)}',${q(f.next)},'${lease}')e`;
  await db.exec(`select set_config('fixture.budget_gate','NO_CAPACITY',true)`);assert.equal((await query(reserve))[0].e.code,'NO_CAPACITY');
  await db.exec(`select set_config('fixture.budget_gate','PASS',true)`);const r=(await query(reserve))[0].e;
  assert.equal(r.code,'PASS');assert.equal(r.cost,credit?1:2);assert.equal((await query(reserve))[0].e.replayed,true);
  assert.equal((await query('select sum(protection_orders)::int n from coinops.account_order_budget_reservations'))[0].n,1);
 });
});
test('partial recovery refuses missing authorization, changed fills, foreign identity, OPEN source, missing lease, cash/caps drift and another critical',async()=>{
 for(const change of [
  `delete from coinops.robot_v1_live_events`,
  `update coinops.robot_v1_live_orders set executed_quantity=.005`,
  `update coinops.robot_v1_live_orders set status='PARTIALLY_FILLED'`,
  `update coinops.robot_v1_live_runs set lease_until=now()-interval '1 second'`,
  `update coinops.robot_v1_live_slot_accounts set balance_brl=5 where slot_number=7`,
  `update coinops.exchange_accounts set kill_switch=true`,
  `update coinops.robot_v1_live_runs set last_error='DIFFERENT_FAILURE'`,
  `update coinops.account_quote_caps set hard_cap_quote=1`,
  `update coinops.robot_v1_live_alerts set code='DIFFERENT_FAILURE'`,
 ])await tx(async()=>{const f=await partialFixture();await db.exec(change);await denied(f.sql);
  assert.equal((await query('select count(*)::int n from coinops.robot_v1_live_orders'))[0].n,1);});
});
test('partial recovery functions are not exposed to anon/authenticated',async()=>{
 for(const role of ['anon','authenticated'])await tx(async()=>{const f=await partialFixture();await db.exec(`grant usage on schema coinops to ${role};set local role ${role}`);
  await denied(f.sql);await denied(`select coinops.authorized_partial_entry_recovery('${id(80)}','${lease}')`);});
});
test('combined original partial + rescue closes as exactly ONE gain, all fees included, replay preserves ledger',()=>tx(async()=>{
 const f=await partialFixture(),child=(await query(f.sql))[0],tp='TEST-TP-ONE-GAIN';
 await db.exec(`update coinops.robot_v1_live_orders set status='FILLED',executed_quantity=.021,cumulative_quote=10.5,trades_reconciled=true where id='${child.id}';
  insert into coinops.robot_v1_live_orders(id,run_id,slot_id,product_id,tenant_id,user_id,trading_engine_id,slot_number,operation_sequence,
   side,purpose,revision,client_order_id,requested_quantity,price,status,executed_quantity,cumulative_quote,trades_reconciled)
   values('${id(90)}','${id(7)}','${id(107)}','${id(2)}','${id(3)}','${id(4)}','${id(6)}',7,8,'SELL','TP',1,'${tp}',.025,527.5,'FILLED',.025,13.1875,true);
  insert into coinops.robot_v1_live_fills(order_id,quantity,quote_quantity,commission_brl,commission_asset)
   values('${child.id}',.021,10.5,.002,'BNB'),('${id(90)}',.025,13.1875,.003,'BNB');
  update coinops.robot_v1_live_slots set position_quantity=0,position_committed_brl=12.503 where slot_number=7;`);
 const sql=`select(coinops.credit_robot_v1_live_closed_slot('${id(7)}','${id(107)}',8,'${tp}',.001,'${lease}')).*`;
 const a=(await query(sql))[0];assert.equal(a.balance_brl,'22.6815');assert.equal(a.gain_count,1);assert.equal(a.fees_brl,'0.006');
 assert.deepEqual((await query(sql))[0],a);assert.equal((await query('select count(*)::int n from coinops.robot_v1_monthly_slot_gains'))[0].n,1);
 assert.equal((await query(`select count(*)::int n from coinops.robot_v1_live_events where event_type='SLOT_PROFIT_CREDITED'`))[0].n,1);
}));
