// Real PostgreSQL planner/query fixtures in a disposable PGlite database.
// No remote client, credentials, exchange transport or operational config.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('./account-pause-sql/package.json', import.meta.url));
const { PGlite } = require('@electric-sql/pglite');
const db = new PGlite();
const migration = readFileSync(new URL('../../supabase/migrations/20261031112500_live_capital_audit_event_lookup.sql', import.meta.url), 'utf8');
const run = '11111111-1111-4111-8111-111111111111';
const sibling = '22222222-2222-4222-8222-222222222222';
const types = ['NEXT_BUY_CAPITAL_REFRESH_PLANNED', 'NEXT_BUY_CAPITAL_REFRESH_CONFIRMED'];
const select = `select id,run_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,quote_asset,
 observed_at,event_type,slot_number,details from coinops.robot_v1_live_events
 where product_id=$1 and tenant_id=$2 and user_id=$3 and operator_id=$4 and exchange_account_id=$5
 and trading_engine_id=$6 and quote_asset=$7 and run_id=$8 and event_type=any($9)
 order by event_type,observed_at,id limit $10 offset $11`;
const parameters = ['product', 'tenant', 'user', 'operator', 'account', 'engine', 'BRL', run, types, 500, 0];
const rows = async (query, params=[]) => (await db.query(query, params)).rows;
let snapshot;
const hash = async () => (await rows(`select md5(string_agg(to_jsonb(e)::text,',' order by id)) hash from coinops.robot_v1_live_events e`))[0].hash;
before(async () => {
 await db.exec(`create schema coinops;
 create table coinops.robot_v1_live_events(id bigint primary key,run_id uuid,product_id text,tenant_id text,user_id text,
 operator_id text,exchange_account_id text,trading_engine_id text,quote_asset text,observed_at timestamptz,
 event_type text,slot_number int,details jsonb);
 alter table coinops.robot_v1_live_events enable row level security;
 create index old_scoped on coinops.robot_v1_live_events(operator_id,exchange_account_id,trading_engine_id,run_id,observed_at desc);
 insert into coinops.robot_v1_live_events
 select i,'${run}','product','tenant','user','operator','account','engine','BRL','2026-10-31T10:00:00Z',
 'RECONCILED',null,'{"source":"fixture"}' from generate_series(1,12000)i;
 insert into coinops.robot_v1_live_events
 select 12000+i,'${run}','product','tenant','user','operator','account','engine','BRL','2026-10-31T10:00:00Z',
 case when i%2=0 then '${types[0]}' else '${types[1]}' end,1,jsonb_build_object('refresh_key',i) from generate_series(1,502)i;
 insert into coinops.robot_v1_live_events
 select 13000+i,'${sibling}','product','tenant','user','operator','account','sibling-engine','BRL','2026-10-31T10:00:00Z',
 '${types[0]}',1,'{}' from generate_series(1,25)i;
 insert into coinops.robot_v1_live_events values
 (14000,'${run}','other-product','tenant','user','operator','account','engine','BRL',now(),'${types[0]}',1,'{}'),
 (14001,'${run}','product','other-tenant','user','operator','account','engine','BRL',now(),'${types[0]}',1,'{}'),
 (14002,'${run}','product','tenant','other-user','operator','account','engine','BRL',now(),'${types[0]}',1,'{}'),
 (14003,'${run}','product','tenant','user','other-operator','account','engine','BRL',now(),'${types[0]}',1,'{}'),
 (14004,'${run}','product','tenant','user','operator','other-account','engine','BRL',now(),'${types[0]}',1,'{}'),
 (14005,'${run}','product','tenant','user','operator','account','other-engine','BRL',now(),'${types[0]}',1,'{}'),
 (14006,'${run}','product','tenant','user','operator','account','engine','USDT',now(),'${types[0]}',1,'{}');
 analyze coinops.robot_v1_live_events;`);
 snapshot = await hash();
 await db.exec(migration);
 await db.exec('analyze coinops.robot_v1_live_events');
});
after(async () => { await db.close(); });
test('indexed audit preserves full scope, deterministic pagination and both event types', async () => {
 const first=await rows(select,parameters);
 const second=await rows(select,[...parameters.slice(0,10),500]);
 assert.equal(first.length,500);assert.equal(second.length,2);
 const all=[...first,...second];
 assert.deepEqual(all.map(e=>Number(e.id)).sort((a,b)=>a-b),Array.from({length:502},(_,i)=>12001+i));
 const keys=all.map(e=>`${e.event_type}:${e.observed_at.toISOString()}:${String(e.id).padStart(6,'0')}`);
 assert.deepEqual(keys,[...keys].sort());
 assert.deepEqual([...new Set(all.map(e=>e.event_type))].sort(),[...types].sort());
 assert.ok(all.every(e=>e.run_id===run&&e.trading_engine_id==='engine'&&e.quote_asset==='BRL'));
 const plan=await rows('explain (analyze,format json) '+select,parameters);
 assert.match(JSON.stringify(plan),/robot_v1_live_events_run_type_time_idx/);
 assert.doesNotMatch(JSON.stringify(plan),/"Index Name":"old_scoped"/);
});
test('generic prepared planning uses the selective index with parameterized event types', async () => {
 await db.exec(`set plan_cache_mode=force_generic_plan;
 prepare capital_audit(text,text,text,text,text,text,text,uuid,text[],int,int) as ${select};`);
 const execute=`execute capital_audit('product','tenant','user','operator','account','engine','BRL',
 '${run}',array['${types[0]}','${types[1]}'],500,0)`;
 for(let i=0;i<6;i++) assert.equal((await rows(execute)).length,500);
 const plan=await rows('explain (format json) '+execute);
 assert.match(JSON.stringify(plan),/robot_v1_live_events_run_type_time_idx/);
 const counters=(await rows("select custom_plans,generic_plans from pg_prepared_statements where name='capital_audit'"))[0];
 assert.ok(Number(counters.generic_plans)>=6);assert.equal(Number(counters.custom_plans),0);
 await db.exec('deallocate capital_audit; reset plan_cache_mode');
});
test('repeat migration preserves history and RLS; empty audit stays a complete empty read', async () => {
 await db.exec(migration);
 assert.equal(await hash(),snapshot);
 const metadata=(await rows(`select i.indisvalid,i.indisready,i.indisunique,c.relrowsecurity
 from pg_index i join pg_class t on t.oid=i.indexrelid join pg_class c on c.oid=i.indrelid
 where t.relname='robot_v1_live_events_run_type_time_idx'`))[0];
 assert.deepEqual(metadata,{indisvalid:true,indisready:true,indisunique:false,relrowsecurity:true});
 assert.deepEqual(await rows(select,[...parameters.slice(0,7),'33333333-3333-4333-8333-333333333333',...parameters.slice(8)]),[]);
});
