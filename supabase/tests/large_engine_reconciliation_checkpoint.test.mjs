import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// PostgreSQL/WASM memory only: synthetic financial rows, no remote connection.
const load = createRequire(new URL('../../tools/testing/account-pause-sql/package.json', import.meta.url));
const { PGlite } = load('@electric-sql/pglite');
const db = new PGlite();
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const operator = id(1), account = id(2), engine = id(3), run = id(4), lease = id(5), user = id(6), product = id(7), tenant = id(8);
const prefix = `C2-${createHash('sha256').update(`${account}|${engine}`).digest('hex').slice(0, 10)}-`;
const rows = async sql => (await db.query(sql)).rows;
const one = async sql => (await rows(sql))[0];
const invoke = (phase = 'CREDIT_SLOTS', owner = lease, step = '.001') =>
  `select coinops.record_live_reconciliation_checkpoint('${run}','${owner}','${phase}',${step}) as v`;
const checkpoint = async (...args) => (await one(invoke(...args))).v;

before(async () => {
  await db.exec(readFileSync(new URL('./configurable_engine_slots_fixture.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../migrations/20261016161550_configurable_live_engine_slots.sql', import.meta.url), 'utf8'));
  await db.exec(`create table coinops.robot_v1_live_alerts(id uuid default gen_random_uuid(),operator_id uuid,
    exchange_account_id uuid,trading_engine_id uuid,severity text,resolved_at timestamptz);
    -- The migration also refreshes the canonical sync function's lease-clock
    -- guard; its rowtype is required even though these tests never call sync.
    create table coinops.robot_v1_live_fills(id uuid,order_id uuid,product_id uuid,tenant_id uuid,user_id uuid,
      symbol text,exchange_trade_id text,quantity numeric,quote_quantity numeric,commission numeric,
      commission_asset text,commission_brl numeric,fee_fx_source text,fee_fx_observed_at timestamptz,
      filled_at timestamptz,exchange_account_id uuid);
    create unique index checkpoint_events_unique on coinops.robot_v1_live_events(run_id,event_key);
    alter table coinops.robot_v1_live_alerts enable row level security;
    alter table coinops.robot_v1_live_alerts force row level security;
    grant select,insert,update,delete on coinops.robot_v1_live_alerts to service_role;
    revoke update,delete on coinops.robot_v1_live_events from service_role;
    insert into coinops.operators(id,product_id,tenant_id,user_id,status,kill_switch)
      values('${operator}','${product}','${tenant}','${user}','ACTIVE',false);
    insert into coinops.exchange_accounts(id,operator_id,status,kill_switch)
      values('${account}','${operator}','ACTIVE',false);
    insert into coinops.executor_shards(id,enabled) values('executor-03',true);
    insert into coinops.trading_engines(id,operator_id,exchange_account_id,environment,symbol,base_asset,
      quote_asset,status,kill_switch,executor_shard_id,slot_count,config,order_owner_prefix)
      values('${engine}','${operator}','${account}','REAL','SOLBRL','SOL','BRL','ACTIVE',false,
      'executor-03',100,'{"slot_count":100}','${prefix}');
    insert into coinops.robot_v1_live_preparations(product_id,tenant_id,user_id,operator_id,exchange_account_id,
      trading_engine_id,asset,symbol,quote_asset,slot_count,kill_switch,live_enabled)
      values('${product}','${tenant}','${user}','${operator}','${account}','${engine}','SOL','SOLBRL','BRL',100,false,true);
    insert into coinops.robot_v1_live_runs(id,product_id,tenant_id,user_id,operator_id,exchange_account_id,
      trading_engine_id,asset,symbol,quote_asset,status,slot_count,config_snapshot,lease_owner,lease_until,last_reconciled_at)
      values('${run}','${product}','${tenant}','${user}','${operator}','${account}','${engine}','SOL','SOLBRL','BRL',
      'ACTIVE',100,'{"slot_count":100}','${lease}',clock_timestamp()+interval '10 minutes',clock_timestamp()-interval '1 hour');
    insert into coinops.robot_v1_live_slots(id,run_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,
      trading_engine_id,quote_asset,slot_number,entry_state,operation_sequence,position_quantity)
      select ('00000000-0000-4000-8000-'||lpad((100+s)::text,12,'0'))::uuid,'${run}','${product}','${tenant}',
      '${user}','${operator}','${account}','${engine}','BRL',s,case when s<=2 then 'OPEN' else 'PLANNED' end,1,
      case when s<=2 then .02 else 0 end from generate_series(1,100)s;
    insert into coinops.robot_v1_live_slot_accounts(product_id,tenant_id,user_id,operator_id,exchange_account_id,
      trading_engine_id,asset,quote_asset,slot_number,balance_brl,gain_count)
      select '${product}','${tenant}','${user}','${operator}','${account}','${engine}','SOL','BRL',s,11,0 from generate_series(1,100)s;
    insert into coinops.robot_v1_live_orders(run_id,slot_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,
      trading_engine_id,quote_asset,slot_number,operation_sequence,side,purpose,client_order_id,exchange_order_id,
      status,requested_quantity,executed_quantity,price,trades_reconciled)
      select '${run}',id,'${product}','${tenant}','${user}','${operator}','${account}','${engine}','BRL',slot_number,1,
      'SELL','TP','${prefix}'||slot_number||'-S-aaaaaaaaaaaaaa',(1000+slot_number)::text,'NEW',.02,0,515,false
      from coinops.robot_v1_live_slots where run_id='${run}' and slot_number<=2;
    insert into coinops.robot_v1_live_orders(run_id,slot_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,
      trading_engine_id,quote_asset,slot_number,operation_sequence,side,purpose,client_order_id,exchange_order_id,
      status,requested_quantity,executed_quantity,price,trades_reconciled)
      select '${run}',id,'${product}','${tenant}','${user}','${operator}','${account}','${engine}','BRL',1,1,
      'BUY','INITIAL','${prefix}1-B-bbbbbbbbbbbbbb','2001','FILLED',.02,.02,500,true
      from coinops.robot_v1_live_slots where run_id='${run}' and slot_number=1;`);
  await db.exec(readFileSync(new URL('../migrations/20261016175026_large_engine_reconciliation_progress_checkpoint.sql', import.meta.url), 'utf8'));
  await db.exec(`select set_config('request.jwt.claim.role','service_role',false); set role service_role`);
});
after(async () => db.close());
function check(name, action) {
  test(name, async () => {
    await db.exec('begin');
    try { await action(); } finally { await db.exec('rollback'); }
  });
}

check('first checkpoint derives exact protected progress without changing full reconciliation or financial rows', async () => {
  const before = await one(`select last_reconciled_at from coinops.robot_v1_live_runs where id='${run}'`);
  const value = await checkpoint();
  assert.equal(value.contract, 'LARGE_ENGINE_PROGRESS_V1');
  assert.equal(value.run_id, run); assert.equal(value.operator_id, operator); assert.equal(value.exchange_account_id, account);
  assert.equal(value.trading_engine_id, engine); assert.equal(value.executor_shard_id, 'executor-03');
  assert.equal(value.slot_count, 100); assert.equal(value.quantity_step, .001);
  assert.equal(value.settled_orders, 1); assert.equal(value.credited_gains, 0); assert.equal(value.operation_total, 100);
  assert(!JSON.stringify(value).includes(lease));
  assert.deepEqual(await one(`select last_reconciled_at from coinops.robot_v1_live_runs where id='${run}'`), before);
  assert.equal(Number((await one(`select sum(balance_brl) as total from coinops.robot_v1_live_slot_accounts where trading_engine_id='${engine}'`)).total), 1100);
  assert.equal((await one(`select count(*)::int n from coinops.robot_v1_live_events where run_id='${run}'`)).n, 1);
});

check('replay or phase change without real progress cannot refresh observation time or create an event', async () => {
  const first = await checkpoint();
  assert.deepEqual(await checkpoint(), first);
  assert.deepEqual(await checkpoint('RECYCLE_SLOTS'), first);
  assert.equal((await one(`select count(*)::int n from coinops.robot_v1_live_events where run_id='${run}'`)).n, 1);
});

check('monotonic actual gains and operation progress preserve episode start and append immutable evidence', async () => {
  const first = await checkpoint();
  await db.exec(`update coinops.robot_v1_live_slot_accounts set gain_count=1 where trading_engine_id='${engine}' and slot_number=3`);
  const second = await checkpoint();
  assert.equal(second.started_at, first.started_at); assert.equal(second.credited_gains, 1);
  await db.exec(`update coinops.robot_v1_live_slots set operation_sequence=2 where run_id='${run}' and slot_number=3`);
  const third = await checkpoint('RECYCLE_SLOTS');
  assert.equal(third.started_at, first.started_at); assert.equal(third.operation_total, 101);
  assert.equal(third.phase, 'RECYCLE_SLOTS');
  assert.equal((await one(`select count(*)::int n from coinops.robot_v1_live_events where run_id='${run}'`)).n, 3);
  await assert.rejects(db.exec(`update coinops.robot_v1_live_events set details='{}' where run_id='${run}'`), /permission denied/);
});

check('counter regression rejects stale snapshot rather than extending checkpoint freshness', async () => {
  await db.exec(`update coinops.robot_v1_live_slot_accounts set gain_count=1 where trading_engine_id='${engine}' and slot_number=3`);
  await checkpoint();
  await db.exec(`update coinops.robot_v1_live_slot_accounts set gain_count=0 where trading_engine_id='${engine}' and slot_number=3`);
  await assert.rejects(checkpoint(), /LARGE_ENGINE_PROGRESS_UNSAFE/);
});

check('wrong or expired lease and wrong phase/quantity never write a checkpoint', async () => {
  await assert.rejects(checkpoint('CREDIT_SLOTS', id(999)), /LARGE_ENGINE_PROGRESS_LEASE_DENIED/);
});
check('expired lease remains closed', async () => {
  await db.exec(`update coinops.robot_v1_live_runs set lease_until=clock_timestamp()-interval '1 second' where id='${run}'`);
  await assert.rejects(checkpoint(), /LARGE_ENGINE_PROGRESS_LEASE_DENIED/);
});
for (const [phase, step] of [['ARM_ENTRY', '.001'], ['CREDIT_SLOTS', '0'], ['CREDIT_SLOTS', '2'], ['CREDIT_SLOTS', "'NaN'"]])
  check(`invalid phase/step ${phase}/${step} fails closed`, async () => {
    await assert.rejects(checkpoint(phase, lease, step), /LARGE_ENGINE_PROGRESS_INVALID/);
  });

check('a missing physical slot cannot be mistaken for a complete protected engine', async () => {
  await db.exec(`delete from coinops.robot_v1_live_slots where run_id='${run}' and slot_number=100`);
  await assert.rejects(checkpoint(), /LARGE_ENGINE_PROGRESS_UNSAFE/);
});
check('a missing financial account cannot be mistaken for zero principal or complete progress', async () => {
  await db.exec(`delete from coinops.robot_v1_live_slot_accounts where trading_engine_id='${engine}' and slot_number=100`);
  await assert.rejects(checkpoint(), /LARGE_ENGINE_PROGRESS_UNSAFE/);
});
check('an executed unreconciled fill cannot be checkpointed', async () => {
  await db.exec(`update coinops.robot_v1_live_orders set trades_reconciled=false where run_id='${run}' and side='BUY'`);
  await assert.rejects(checkpoint(), /LARGE_ENGINE_PROGRESS_UNSAFE/);
});
check('unknown/prepared order cannot be checkpointed despite protected TP', async () => {
  await db.exec(`update coinops.robot_v1_live_orders set status='PREPARED' where run_id='${run}' and side='BUY'`);
  await assert.rejects(checkpoint(), /LARGE_ENGINE_PROGRESS_UNSAFE/);
});
check('a missing TP cannot be hidden by a progress heartbeat', async () => {
  await db.exec(`update coinops.robot_v1_live_orders set status='CANCELED' where run_id='${run}' and slot_number=1 and side='SELL'`);
  await assert.rejects(checkpoint(), /LARGE_ENGINE_PROGRESS_UNSAFE/);
});
check('TP quantity mismatch or foreign namespace cannot prove protection', async () => {
  await db.exec(`update coinops.robot_v1_live_orders set requested_quantity=.019 where run_id='${run}' and slot_number=1 and side='SELL'`);
  await assert.rejects(checkpoint(), /LARGE_ENGINE_PROGRESS_UNSAFE/);
});
check('foreign order namespace cannot prove protection', async () => {
  await db.exec(`update coinops.robot_v1_live_orders set client_order_id='C2-0000000000-1-S-aaaaaaaaaaaaaa' where run_id='${run}' and slot_number=1 and side='SELL'`);
  await assert.rejects(checkpoint(), /LARGE_ENGINE_PROGRESS_UNSAFE/);
});
check('resident TP from an older operation cannot prove current protection', async () => {
  await db.exec(`update coinops.robot_v1_live_slots set operation_sequence=2 where run_id='${run}' and slot_number=1`);
  await assert.rejects(checkpoint(), /LARGE_ENGINE_PROGRESS_UNSAFE/);
});
check('a resident sell without its own remaining position is not a safe checkpoint', async () => {
  await db.exec(`update coinops.robot_v1_live_slots set position_quantity=0 where run_id='${run}' and slot_number=1`);
  await assert.rejects(checkpoint(), /LARGE_ENGINE_PROGRESS_UNSAFE/);
});
check('disabled/foreign shard and pending configuration do not receive healthy progress', async () => {
  await db.exec(`update coinops.trading_engines set executor_shard_id='executor-04' where id='${engine}'`);
  await assert.rejects(checkpoint(), /LARGE_ENGINE_PROGRESS_SCOPE_DENIED/);
});
check('real critical incident cannot be hidden by checkpoint', async () => {
  await db.exec(`insert into coinops.robot_v1_live_alerts(operator_id,exchange_account_id,trading_engine_id,severity)
    values('${operator}','${account}','${engine}','CRITICAL')`);
  await assert.rejects(checkpoint(), /LARGE_ENGINE_PROGRESS_UNSAFE/);
});
for (const field of ['run_id', 'operator_id', 'exchange_account_id', 'trading_engine_id', 'executor_shard_id', 'symbol', 'quote_asset', 'slot_count', 'quantity_step'])
  check(`foreign checkpoint ${field} cannot reset its episode`, async () => {
    const value = await checkpoint();
    value[field] = field === 'slot_count' ? 25 : field === 'quantity_step' ? .01 : field === 'executor_shard_id' ? 'executor-02' : 'foreign';
    await db.exec(`update coinops.robot_v1_live_runs set reconciliation_checkpoint='${JSON.stringify(value)}' where id='${run}'`);
    await assert.rejects(checkpoint(), /LARGE_ENGINE_PROGRESS_INVALID/);
  });
check('a legacy 25-slot engine cannot receive the large-engine exception', async () => {
  await db.exec(`insert into coinops.trading_engines(id,operator_id,exchange_account_id,environment,symbol,base_asset,
    quote_asset,status,kill_switch,executor_shard_id,slot_count,config)
    values('${id(601)}','${operator}','${account}','REAL','SOLBRL','SOL','BRL','ACTIVE',false,'executor-03',25,'{"slot_count":25}');
    insert into coinops.robot_v1_live_preparations(product_id,tenant_id,user_id,operator_id,exchange_account_id,
      trading_engine_id,asset,symbol,quote_asset,slot_count,kill_switch,live_enabled)
      values('${product}','${tenant}','${user}','${operator}','${account}','${id(601)}','SOL','SOLBRL','BRL',25,false,true);
    insert into coinops.robot_v1_live_runs(id,product_id,tenant_id,user_id,operator_id,exchange_account_id,
      trading_engine_id,asset,symbol,quote_asset,status,slot_count,config_snapshot,lease_owner,lease_until)
      values('${id(602)}','${product}','${tenant}','${user}','${operator}','${account}','${id(601)}','SOL','SOLBRL','BRL',
      'ACTIVE',25,'{"slot_count":25}','${lease}',clock_timestamp()+interval '10 minutes')`);
  await assert.rejects(rows(`select coinops.record_live_reconciliation_checkpoint('${id(602)}','${lease}','CREDIT_SLOTS',.001)`), /LARGE_ENGINE_PROGRESS_SCOPE_DENIED/);
});
check('paused engines cannot borrow an ACTIVE large-engine progress checkpoint', async () => {
  await db.exec(`update coinops.robot_v1_live_runs set status='PAUSED' where id='${run}'`);
  await assert.rejects(checkpoint(), /LARGE_ENGINE_PROGRESS_SCOPE_DENIED/);
});
check('pending strategy configuration cannot borrow progress freshness', async () => {
  await db.exec(`update coinops.trading_engines set strategy_config_pending=true where id='${engine}'`);
  await assert.rejects(checkpoint(), /LARGE_ENGINE_PROGRESS_UNSAFE/);
});
check('fifteen minute hard limit cannot be reset by retry, progress or a new lease', async () => {
  await checkpoint();
  await db.exec(`update coinops.robot_v1_live_runs set reconciliation_checkpoint=jsonb_set(reconciliation_checkpoint,
    '{started_at}',to_jsonb(clock_timestamp()-interval '16 minutes')) where id='${run}';
    update coinops.robot_v1_live_slot_accounts set gain_count=1 where trading_engine_id='${engine}' and slot_number=3`);
  await assert.rejects(checkpoint(), /LARGE_ENGINE_PROGRESS_STALE/);
});
check('only later completed reconciliation can start a new bounded episode', async () => {
  const first = await checkpoint();
  await db.exec(`update coinops.robot_v1_live_runs set last_reconciled_at=clock_timestamp()+interval '1 microsecond',
    reconciliation_checkpoint=jsonb_set(reconciliation_checkpoint,'{started_at}',to_jsonb(clock_timestamp()-interval '16 minutes'))
    where id='${run}'`);
  const next = await checkpoint();
  assert.notEqual(next.started_at, first.started_at);
  assert.equal(next.started_at, next.observed_at);
});

check('service-only invocation and existing RLS grants are preserved', async () => {
  const fn = await one(`select p.prosecdef,p.proconfig from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='coinops' and p.proname='record_live_reconciliation_checkpoint'`);
  assert.equal(fn.prosecdef, false); assert(fn.proconfig.includes('search_path=""'));
  assert.equal((await one(`select has_function_privilege('authenticated','coinops.record_live_reconciliation_checkpoint(uuid,uuid,text,numeric)','EXECUTE') as v`)).v, false);
  assert.equal((await one(`select has_function_privilege('anon','coinops.record_live_reconciliation_checkpoint(uuid,uuid,text,numeric)','EXECUTE') as v`)).v, false);
  await db.exec(`set local role authenticated`);
  await assert.rejects(checkpoint(), /permission denied/);
});
