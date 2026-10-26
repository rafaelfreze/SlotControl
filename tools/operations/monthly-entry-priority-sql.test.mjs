import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../testing/account-pause-sql/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');const db=new PGlite();
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const q=s=>"'"+String(s).replaceAll("'","''")+"'";
const j=x=>q(JSON.stringify(x))+'::jsonb';
const query=async sql=>(await db.query(sql)).rows;
const hash='a'.repeat(64),lease=id(9);
before(async()=>{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create schema coinops;
 create function auth.jwt() returns jsonb language sql as $$select jsonb_build_object('role',current_setting('request.jwt.claim.role',true))$$;
 create table coinops.operators(id uuid,product_id uuid,tenant_id uuid,user_id uuid,status text,kill_switch boolean);
 create table coinops.exchange_accounts(id uuid,operator_id uuid,status text,kill_switch boolean);
 create table coinops.executor_shards(id text,enabled boolean);
 create table coinops.trading_engines(id uuid,operator_id uuid,exchange_account_id uuid,environment text,status text,
  symbol text,slot_count integer,executor_shard_id text,kill_switch boolean,strategy_config_pending boolean);
 create table coinops.robot_v1_live_runs(id uuid,product_id uuid,tenant_id uuid,user_id uuid,operator_id uuid,exchange_account_id uuid,
  trading_engine_id uuid,symbol text,asset text,quote_asset text,slot_count integer,status text,lease_owner uuid,lease_until timestamptz,last_error text,config_snapshot jsonb,
  entry_regime text default 'NORMAL',config_version integer default 3);
 create table coinops.robot_v1_live_preparations(trading_engine_id uuid,slot_count integer,live_enabled boolean,kill_switch boolean,monthly_target integer default 7);
 create table coinops.robot_v1_live_alerts(trading_engine_id uuid,severity text,resolved_at timestamptz);
 create table coinops.robot_v1_live_slots(id uuid primary key,run_id uuid,product_id uuid,tenant_id uuid,user_id uuid,operator_id uuid,
  exchange_account_id uuid,trading_engine_id uuid,slot_number integer,entry_state text,operation_sequence integer,target_buy_price numeric,
  entry_reference_price numeric,position_quantity numeric,operational_rank integer,missed_at timestamptz,entry_origin text);
 create table coinops.robot_v1_live_slot_accounts(trading_engine_id uuid,slot_number integer,gain_count integer,balance_brl numeric);
 create table coinops.robot_v1_slot_gain_totals(trading_engine_id uuid,slot_number integer,environment text,asset text,product_id uuid,
  tenant_id uuid,user_id uuid,operator_id uuid,exchange_account_id uuid,period_key text,lifetime_gain_count integer,monthly_gain_count integer);
 create table coinops.robot_v1_live_orders(run_id uuid,slot_id uuid,operation_sequence integer,status text,executed_quantity numeric,cumulative_quote numeric,trades_reconciled boolean);
 create table coinops.robot_v1_live_events(id uuid default gen_random_uuid(),run_id uuid,product_id uuid,tenant_id uuid,user_id uuid,operator_id uuid,exchange_account_id uuid,
  trading_engine_id uuid,quote_asset text,event_key text,event_type text,slot_number integer,details jsonb,observed_at timestamptz default now(),unique(run_id,event_key));
 grant usage on schema coinops,auth to service_role;
 grant select on all tables in schema coinops to service_role;
 grant update on coinops.robot_v1_live_runs,coinops.robot_v1_live_slots,
  coinops.trading_engines,coinops.robot_v1_live_preparations to service_role;
 grant insert on coinops.robot_v1_live_events to service_role;
 insert into coinops.operators values('${id(1)}','${id(2)}','${id(3)}','${id(4)}','ACTIVE',false);
 insert into coinops.exchange_accounts values('${id(5)}','${id(1)}','ACTIVE',false);
 insert into coinops.executor_shards values('executor-01',true),('executor-02',true);
 insert into coinops.trading_engines values('${id(6)}','${id(1)}','${id(5)}','REAL','ACTIVE','BTCBRL',25,'executor-01',false,false);
 insert into coinops.robot_v1_live_runs values('${id(7)}','${id(2)}','${id(3)}','${id(4)}','${id(1)}','${id(5)}','${id(6)}',
  'BTCBRL','BTC','BRL',25,'ACTIVE','${lease}',now()+interval '1 hour',null,'{}','NORMAL',3);
 insert into coinops.robot_v1_live_preparations values('${id(6)}',25,true,false,7);
 insert into coinops.robot_v1_live_slots select ('00000000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
  '${id(7)}','${id(2)}','${id(3)}','${id(4)}','${id(1)}','${id(5)}','${id(6)}',n,'PLANNED',3,1000-n,1000-n,0,n,null,'GRID' from generate_series(1,25) n;
 insert into coinops.robot_v1_live_slot_accounts select '${id(6)}',n,0,22 from generate_series(1,25) n;
 set request.jwt.claim.role='service_role';`);
 await db.exec(readFileSync(new URL('../../supabase/migrations/20261026140000_monthly_entry_priority_allocation.sql',import.meta.url),'utf8'));
});
after(async()=>{await db.close()});
const expected=async()=>JSON.parse((await query(`select jsonb_agg(jsonb_build_object('id',id,'n',slot_number,'state',entry_state,
 'sequence',operation_sequence,'price',target_buy_price,'reference',entry_reference_price,'position',position_quantity,
 'monthly',0,'lifetime',0) order by slot_number)::text as value from coinops.robot_v1_live_slots where run_id='${id(7)}'`))[0].value);
const assignments=()=>[{id:id(101),slotNumber:1,previousPrice:999,price:998,sourceId:id(102),sourceOrigin:'GRID',rank:2},
 {id:id(102),slotNumber:2,previousPrice:998,price:999,sourceId:id(101),sourceOrigin:'GRID',rank:1}];
const call=(ex,as=assignments(),le=lease,h=hash)=>`select coinops.allocate_live_monthly_entry_levels('${id(7)}','${le}','${h}',
 to_char(now() at time zone 'America/Campo_Grande','YYYY-MM'),${j(ex)},${j(as)},
 '${JSON.stringify({regime:'NORMAL',config_version:3,monthly_target:7,shard:'executor-01'})}'::jsonb) as proof`;
test('real event schema reproduces the original failure atomically; corrective migration makes it executable',async()=>{
 const columns=await query("select column_name from information_schema.columns where table_schema='coinops' and table_name='robot_v1_live_events'");
 assert.deepEqual(columns.map(c=>c.column_name).sort(),['id','run_id','product_id','tenant_id','user_id',
  'event_key','event_type','slot_number','details','observed_at','operator_id','exchange_account_id',
  'trading_engine_id','quote_asset'].sort());
 const ex=await expected();
 await assert.rejects(query(call(ex)),/column "asset" of relation "robot_v1_live_events" does not exist/);
 assert.deepEqual(await expected(),ex);
 assert.equal((await query('select count(*)::integer as n from coinops.robot_v1_live_events'))[0].n,0);
 assert.deepEqual((await query('select config_snapshot from coinops.robot_v1_live_runs'))[0].config_snapshot,{});
 await db.exec(readFileSync(new URL('../../supabase/migrations/20261026144000_fix_monthly_priority_event_schema.sql',import.meta.url),'utf8'));
});
test('atomic swap, exact source provenance, capital unchanged and idempotent replay',async()=>{
 const ex=await expected(),before=await query('select * from coinops.robot_v1_live_slot_accounts');
 await db.exec('set role service_role');
 let first;try{first=(await query(call(ex)))[0].proof;}finally{await db.exec('reset role');}
 assert.equal(first.policy,'MONTHLY_GAINS_V1');
 assert.equal(first.price_sources[id(102)].source_origin,'GRID');
 assert.equal((await query(`select target_buy_price from coinops.robot_v1_live_slots where id='${id(102)}'`))[0].target_buy_price,'999');
 const second=(await query(call(ex)))[0].proof;assert.deepEqual(second,first);
 assert.equal((await query('select count(*)::integer as n from coinops.robot_v1_live_events'))[0].n,1);
 assert.deepEqual(await query('select * from coinops.robot_v1_live_slot_accounts'),before);
});
test('missing lease, anonymous caller and stale/partial snapshot fail closed',async()=>{
 const ex=await expected();await assert.rejects(query(call(ex,[],id(88),'b'.repeat(64))),/LEASE_DENIED/);
 await assert.rejects(query(call(ex.slice(1),[],lease,'b'.repeat(64))),/INPUT_INVALID/);
 await db.exec("set request.jwt.claim.role='authenticated'");await assert.rejects(query(call(ex)),/SCOPE_DENIED/);
 await db.exec("set request.jwt.claim.role='service_role'");
 const stale=structuredClone(ex);stale[0].monthly=1;
 await assert.rejects(query(call(stale,[],lease,'b'.repeat(64))),/SNAPSHOT_CHANGED/);
});
test('OPEN and resident/partial BUY cannot be allocated or bypassed with a zero-fill assumption',async()=>{
 await db.exec(`update coinops.robot_v1_live_slots set entry_state='OPEN',position_quantity=1 where id='${id(103)}'`);
 const ex=await expected();const a=[{id:id(103),slotNumber:3,previousPrice:997,price:997,sourceId:id(103),sourceOrigin:'GRID',rank:3}];
 await assert.rejects(query(call(ex,a,lease,'c'.repeat(64))),/COMMITTED_SLOT/);
 await db.exec(`update coinops.robot_v1_live_slots set entry_state='PLANNED',position_quantity=0 where id='${id(103)}';
 insert into coinops.robot_v1_live_orders values('${id(7)}','${id(103)}',3,'PARTIALLY_FILLED',.001,1,true)`);
 await assert.rejects(query(call(await expected(),a,lease,'c'.repeat(64))),/COMMITTED_SLOT/);
 await db.exec('delete from coinops.robot_v1_live_orders');
});
test('new levels, forged provenance, foreign engine and crash rollback cannot change financial facts',async()=>{
 let ex=await expected();const a=[{id:id(103),slotNumber:3,previousPrice:997,price:998,sourceId:id(103),sourceOrigin:'GRID',rank:3}];
 await assert.rejects(query(call(ex,a,lease,'d'.repeat(64))),/NOT_A_PERMUTATION/);
 a[0].price=997;a[0].sourceOrigin='REENTRY';await assert.rejects(query(call(ex,a,lease,'d'.repeat(64))),/LEVEL_SOURCE_INVALID/);
 a[0].sourceOrigin='GRID';await db.exec(`update coinops.robot_v1_live_slots set trading_engine_id='${id(99)}' where id='${id(103)}'`);
 await assert.rejects(query(call(await expected(),a,lease,'d'.repeat(64))),/INCOMPLETE/);
 await db.exec(`update coinops.robot_v1_live_slots set trading_engine_id='${id(6)}' where id='${id(103)}'`);
 ex=await expected();await db.exec('begin');await query(call(ex,a,lease,'e'.repeat(64)));await db.exec('rollback');
 assert.deepEqual(await expected(),ex);assert.equal((await query('select count(*)::integer as n from coinops.robot_v1_live_events'))[0].n,1);
});
test('50/100 complete physical sets use the same transaction; PUBLIC/authenticated cannot execute it',async()=>{
 for(const count of [50,100]){
  const previous=(await query('select count(*)::integer as n from coinops.robot_v1_live_slots'))[0].n;
  await db.exec(`update coinops.trading_engines set slot_count=${count};update coinops.robot_v1_live_runs set slot_count=${count};
   update coinops.robot_v1_live_preparations set slot_count=${count};
   insert into coinops.robot_v1_live_slots select ('00000000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
    '${id(7)}','${id(2)}','${id(3)}','${id(4)}','${id(1)}','${id(5)}','${id(6)}',n,'PLANNED',3,1000-n,1000-n,0,n,null,'GRID'
    from generate_series(${previous+1},${count}) n;
   insert into coinops.robot_v1_live_slot_accounts select '${id(6)}',n,0,22 from generate_series(${previous+1},${count}) n;`);
  const ex=await expected(),a=ex.filter(s=>[4,5].includes(s.n)).map((s,i,arr)=>({id:s.id,slotNumber:s.n,
   previousPrice:s.price,price:arr[1-i].price,sourceId:arr[1-i].id,sourceOrigin:'GRID',rank:s.n}));
  const result=(await query(call(ex,a,lease,String(count===50?5:6).repeat(64))))[0].proof;
  assert.equal(result.policy,'MONTHLY_GAINS_V1');assert.equal((await expected()).length,count);
 }
 const signature='coinops.allocate_live_monthly_entry_levels(uuid,uuid,text,text,jsonb,jsonb,jsonb)';
 const grants=(await query(`select has_function_privilege('authenticated','${signature}','execute') as auth,
  has_function_privilege('anon','${signature}','execute') as anon,has_function_privilege('service_role','${signature}','execute') as service`))[0];
 assert.deepEqual(grants,{auth:false,anon:false,service:true});
});
