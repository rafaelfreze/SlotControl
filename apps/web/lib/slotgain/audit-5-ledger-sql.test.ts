import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Dedicated disposable PostgreSQL. Never reads .env, Supabase config or credentials.
const bin = process.env.COINOPS_AUDIT_PG_BIN ?? "C:/Program Files/PostgreSQL/17/bin";
const available = existsSync(join(bin, "initdb.exe"));
const directory = available ? mkdtempSync(join(tmpdir(), "coinops-audit-ledger-")) : "";
const port = 55441;
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG"))),
  NODE_ENV: process.env.NODE_ENV ?? "test",
  PGHOST: "127.0.0.1", PGPORT: String(port), PGUSER: "audit_owner", PGDATABASE: "postgres",
  PGPASSFILE: join(directory, "no-credentials") };
const args = ["-X", "-w", "-h", "127.0.0.1", "-p", String(port), "-U", "audit_owner", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"];
const sql = (query: string) => execFileSync(join(bin, "psql.exe"), [...args, "-c", query], { env, encoding: "utf8", windowsHide: true, stdio: "pipe" }).replace(/\r/g, "").trim();
const migration = resolve("../../supabase/migrations/20260923221727_add_robot_v1_manual_slot_adjustments.sql");
const fixMigration = resolve("../../supabase/migrations/20260923231728_harden_robot_v1_manual_adjustments.sql");
const partialMigration = resolve("../../supabase/migrations/20260923231731_harden_robot_v1_testnet_partial_accounting.sql");
const submissionMigration = resolve("../../supabase/migrations/20260923231734_guard_testnet_order_submission.sql");
const ids = { product: "11111111-1111-4111-8111-111111111111", tenant: "22222222-2222-4222-8222-222222222222", user: "33333333-3333-4333-8333-333333333333", config: "44444444-4444-4444-8444-444444444444", run: "55555555-5555-4555-8555-555555555555", slot: "66666666-6666-4666-8666-666666666666" };
const scope = `'${ids.product}','${ids.tenant}','${ids.user}'`;

// Only prerequisite fixtures are synthetic; the 4.4 migration, tables, RPC,
// constraints, triggers and policies under audit execute verbatim in PostgreSQL.
const bootstrap = `
create role anon; create role authenticated; create role service_role bypassrls;
create schema coinops; create schema private; create schema auth;
grant usage on schema coinops, private, auth to authenticated, service_role, anon;
create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;
create function private.coinops_touch_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now(); return new; end$$;
create function private.coinops_can_access_row(p uuid,t uuid,u uuid) returns boolean language sql as $$
 select p::text=current_setting('audit.product',true) and t::text=current_setting('audit.tenant',true) and u::text=current_setting('audit.user',true)$$;
create table public.product_tenants(product_id uuid,tenant_id uuid,primary key(product_id,tenant_id));
insert into public.product_tenants values ('${ids.product}','${ids.tenant}');
create table coinops.robot_v1_configs(id uuid primary key,product_id uuid,tenant_id uuid,user_id uuid,asset text,execution_mode text,strategy_lease_until timestamptz,strategy_version text default '4.3.1');
create table coinops.robot_v1_slot_accounts(config_id uuid,slot_number integer,product_id uuid,tenant_id uuid,user_id uuid,initial_balance_usdc numeric(28,12),balance_usdc numeric(28,12),net_profit_usdc numeric(28,12) default 0,gain_count integer default 0 check(gain_count>=0),updated_at timestamptz, constraint robot_v1_slot_accounts_balanced check(balance_usdc=initial_balance_usdc+net_profit_usdc));
create table coinops.robot_v1_cycles(id uuid,config_id uuid,status text,started_at timestamptz);
create table coinops.robot_v1_slots(cycle_id uuid,slot_number integer,status text,buy_price numeric,executed_quantity numeric);
create table coinops.robot_v1_testnet_runs(id uuid primary key,product_id uuid,tenant_id uuid,user_id uuid,asset text,status text,lease_until timestamptz,previous_run_id uuid,created_at timestamptz default now(),strategy_version text default '4.3.1',lease_owner uuid);
create table coinops.robot_v1_testnet_slots(id uuid primary key,run_id uuid,product_id uuid,tenant_id uuid,user_id uuid,slot_number integer,entry_state text,operation_sequence integer,balance_usdc numeric(20,8),gain_count integer default 0 check(gain_count>=0),target_buy_price numeric,entry_reference_price numeric,net_profit_usdc numeric(20,8) default 0,last_take_profit_price numeric,last_credited_sell_client_order_id text);
create table coinops.robot_v1_testnet_orders(id uuid default gen_random_uuid(),run_id uuid,slot_id uuid,operation_sequence integer,side text,status text,cumulative_quote numeric,price numeric,quantity numeric,
 product_id uuid default '${ids.product}',tenant_id uuid default '${ids.tenant}',user_id uuid default '${ids.user}',slot_number integer default 1,
 executed_quantity numeric default 0,fee_base numeric default 0,fee_quote numeric default 0,fee_other jsonb default '[]',trades_reconciled boolean default true,
 purpose text default 'TP',revision integer default 1,client_order_id text,exchange_order_id text default '123',updated_at timestamptz default now());
create table coinops.robot_v1_testnet_events(id uuid primary key default gen_random_uuid(),run_id uuid,product_id uuid,tenant_id uuid,user_id uuid,event_key text,event_type text,slot_number integer,details jsonb default '{}',observed_at timestamptz default now(),unique(run_id,event_key));
create table coinops.robot_v1_ath_profiles(product_id uuid,tenant_id uuid,user_id uuid,environment text,asset text,config_version integer);
create table coinops.robot_v1_monthly_slot_gains(environment text,source_id uuid,product_id uuid,tenant_id uuid,user_id uuid,asset text,slot_number integer,physical_slot_id text,credited_at timestamptz,effective_gain_at timestamptz,evidence_basis text,period_key text,primary key(environment,source_id), constraint robot_v1_monthly_slot_gains_environment_check check(environment in('SHADOW','TESTNET')),constraint robot_v1_monthly_slot_gains_evidence_basis_check check(evidence_basis in('SHADOW_CONFIRMED_TP_CLOSE','TESTNET_EXCHANGE_FILL','TESTNET_CREDIT_FALLBACK')));
alter table coinops.robot_v1_monthly_slot_gains enable row level security;
alter table coinops.robot_v1_monthly_slot_gains force row level security;
create policy gain_owner on coinops.robot_v1_monthly_slot_gains for select to authenticated using(private.coinops_can_access_row(product_id,tenant_id,user_id));
grant select on coinops.robot_v1_monthly_slot_gains to authenticated;
insert into coinops.robot_v1_configs(id,product_id,tenant_id,user_id,asset,execution_mode,strategy_lease_until) values('${ids.config}',${scope},'SOL','SHADOW',null);
insert into coinops.robot_v1_slot_accounts(config_id,slot_number,product_id,tenant_id,user_id,initial_balance_usdc,balance_usdc) values('${ids.config}',1,${scope},100,100);
insert into coinops.robot_v1_testnet_runs(id,product_id,tenant_id,user_id,asset,status) values('${ids.run}',${scope},'SOL','ACTIVE');
insert into coinops.robot_v1_testnet_slots(id,run_id,product_id,tenant_id,user_id,slot_number,entry_state,operation_sequence,balance_usdc,gain_count,target_buy_price,entry_reference_price,net_profit_usdc)
 values('${ids.slot}','${ids.run}',${scope},1,'OPEN',1,100,0,100,100,0);
insert into coinops.robot_v1_testnet_orders(run_id,slot_id,operation_sequence,side,status,cumulative_quote,price,quantity,executed_quantity,client_order_id)
 values('${ids.run}','${ids.slot}',1,'BUY','FILLED',100,100,1,1,'AUDIT-BUY-1'),('${ids.run}','${ids.slot}',1,'SELL','NEW',0,100.5,1,0,'AUDIT-SELL-1');
insert into coinops.robot_v1_ath_profiles values(${scope},'SHADOW','SOL',1),(${scope},'TESTNET','SOL',1),(${scope},'REAL','SOL',1);
`;

before(() => {
  if (!available) return;
  execFileSync(join(bin, "initdb.exe"), ["-D", directory, "-U", "audit_owner", "-A", "trust", "--no-locale", "-E", "UTF8"], { env, windowsHide: true, stdio: "pipe" });
  execFileSync(join(bin, "pg_ctl.exe"), ["-D", directory, "-l", join(directory, "server.log"), "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"], { env, windowsHide: true, stdio: "ignore" });
  sql(bootstrap);
  execFileSync(join(bin, "psql.exe"), [...args, "-f", migration], { env, windowsHide: true, stdio: "pipe" });
  const monthlySource=readFileSync(resolve("../../supabase/migrations/20260923181111_add_robot_v1_monthly_slot_gain_ledger.sql"),"utf8");
  const monthlyStart=monthlySource.indexOf("create function coinops.record_robot_v1_testnet_monthly_gain()");
  const monthlyEnd=monthlySource.indexOf("-- Backfill only facts",monthlyStart);
  sql(monthlySource.slice(monthlyStart,monthlyEnd));
  if (process.env.COINOPS_AUDIT_BASELINE !== "1") {
    execFileSync(join(bin, "psql.exe"), [...args, "-f", fixMigration], { env, windowsHide: true, stdio: "pipe" });
    execFileSync(join(bin, "psql.exe"), [...args, "-f", partialMigration], { env, windowsHide: true, stdio: "pipe" });
    sql(`insert into coinops.robot_v1_testnet_orders(run_id,slot_id,operation_sequence,side,status,cumulative_quote,price,quantity,executed_quantity,client_order_id)
      values('${ids.run}','${ids.slot}',99,'BUY','PREPARED',0,100,1,0,'AUDIT-LEGACY-PREPARED')`);
    execFileSync(join(bin, "psql.exe"), [...args, "-f", submissionMigration], { env, windowsHide: true, stdio: "pipe" });
  }
});
const leaseOwner="88888888-8888-4888-8888-888888888888";
const closeFill=`update coinops.robot_v1_testnet_orders set purpose='INITIAL' where side='BUY';
 update coinops.robot_v1_testnet_orders set status='FILLED',executed_quantity=1,cumulative_quote=102,price=102 where side='SELL';`;
const acquireLease=`update coinops.robot_v1_testnet_runs set lease_owner='${leaseOwner}',lease_until=now()+interval '5 minutes';`;
const settle=`coinops.credit_robot_v1_testnet_closed_slot('${ids.run}','${ids.slot}',1,'AUDIT-SELL-1',0.001,'${leaseOwner}')`;
check("SQL: atomic TP settlement preserves manual contribution and is idempotent", () => {
 const result=tx(`select id from ${call()}; ${closeFill} ${acquireLease}
 select id from ${settle}; select id from ${settle}; select id from ${settle};
 select balance_usdc=107 and contribution_usdc=5 and net_profit_usdc=2 and gain_count=1 and entry_state='CLOSED' from coinops.robot_v1_testnet_slots;
 select count(*)=1 from coinops.robot_v1_testnet_events where event_type='SLOT_CLOSED';
 select lifetime_gain_count=1 and market_gain_count=1 and manual_gain_count=0 from coinops.robot_v1_slot_gain_totals`);
 assert.equal(result.split("\n").filter(x=>x==="t").length,3);
});
check("SQL: legacy event-before-credit crash recovery adds profit once on current manual equity", () => {
 const result=tx(`${closeFill}
 insert into coinops.robot_v1_testnet_events(run_id,product_id,tenant_id,user_id,event_key,event_type,slot_number,details)
 values('${ids.run}',${scope},'AUDIT-SELL-1:SLOT_CLOSED','SLOT_CLOSED',1,'{"operationSequence":1,"profitUsdc":2,"balanceUsdc":102,"gainCount":1,"quantityStep":0.001}');
 select id from ${call({lifetime:"1",monthly:"1"})}; ${acquireLease}
 select id from ${settle}; select id from ${settle};
 select balance_usdc=107 and gain_count=1 and net_profit_usdc=2 from coinops.robot_v1_testnet_slots;
 select lifetime_gain_count=1 from coinops.robot_v1_slot_gain_totals`);
 assert.equal(result.split("\n").filter(x=>x==="t").length,2);
});
check("SQL: settlement rejects expired lease and insufficient fills", () => {
 assert.throws(()=>tx(`${closeFill} ${acquireLease} update coinops.robot_v1_testnet_runs set lease_until=now()-interval '1 second'; select id from ${settle}`),/SETTLEMENT_LEASE_INVALID/);
 assert.throws(()=>tx(`${closeFill} ${acquireLease} update coinops.robot_v1_testnet_orders set executed_quantity=0.5 where side='SELL'; select id from ${settle}`),/SETTLEMENT_EVIDENCE_INVALID/);
});
check("SQL: crash after TP credit rolls back balance, event and monthly gain together", () => {
 assert.throws(()=>tx(`${closeFill} ${acquireLease} select id from ${settle}; do $$begin raise exception 'AUDIT_SETTLEMENT_CRASH'; end$$`),/AUDIT_SETTLEMENT_CRASH/);
 assert.equal(sql("select (select balance_usdc=100 and entry_state='OPEN' from coinops.robot_v1_testnet_slots) and (select count(*)=0 from coinops.robot_v1_testnet_events) and (select count(*)=0 from coinops.robot_v1_monthly_slot_gains)"),"t");
});
check("SQL: canceled partial TP closing proof settles through the real monthly trigger", () => {
 const result=tx(`${closeFill} update coinops.robot_v1_testnet_orders set status='CANCELED' where client_order_id='AUDIT-SELL-1'; ${acquireLease}
 select id from ${settle}; select id from ${settle};
 select balance_usdc=102 and gain_count=1 and entry_state='CLOSED' from coinops.robot_v1_testnet_slots;
 select monthly_gain_count=1 and market_gain_count=1 from coinops.robot_v1_slot_gain_totals;
 select details#>>'{execution,closingSellClientOrderId}'='AUDIT-SELL-1' from coinops.robot_v1_testnet_events where event_type='SLOT_CLOSED'`);
 assert.equal(result.split("\n").filter(x=>x==="t").length,3);
});
check("SQL: submission permit is one-shot and legacy PREPARED remains GET-only", () => {
 const result=tx(`select submission_guarded_at is not null from coinops.robot_v1_testnet_orders where client_order_id='AUDIT-LEGACY-PREPARED';
 update coinops.robot_v1_testnet_orders set status='PREPARED' where client_order_id='AUDIT-SELL-1';
 with claimed as(update coinops.robot_v1_testnet_orders set submission_guarded_at=clock_timestamp()
 where client_order_id='AUDIT-SELL-1' and status='PREPARED' and submission_guarded_at is null returning id) select count(*)=1 from claimed;
 with claimed as(update coinops.robot_v1_testnet_orders set submission_guarded_at=clock_timestamp()
 where client_order_id='AUDIT-SELL-1' and status='PREPARED' and submission_guarded_at is null returning id) select count(*)=0 from claimed`);
 assert.equal(result.split("\n").filter(x=>x==="t").length,3);
 assert.throws(()=>tx("update coinops.robot_v1_testnet_orders set submission_guarded_at=null where client_order_id='AUDIT-LEGACY-PREPARED'"),/SUBMISSION_GUARD_IMMUTABLE/);
});
check("SQL: rolling deployment inserts without new field are guarded, explicit null gets one permit", () => {
 const result=tx(`insert into coinops.robot_v1_testnet_orders(client_order_id,status) values('AUDIT-OLD-RUNTIME','PREPARED');
 insert into coinops.robot_v1_testnet_orders(client_order_id,status,submission_guarded_at) values('AUDIT-NEW-RUNTIME','PREPARED',null);
 select submission_guarded_at is not null from coinops.robot_v1_testnet_orders where client_order_id='AUDIT-OLD-RUNTIME';
 select submission_guarded_at is null from coinops.robot_v1_testnet_orders where client_order_id='AUDIT-NEW-RUNTIME'`);
 assert.equal(result.split("\n").filter(x=>x==="t").length,2);
});
after(() => {
  if (available && existsSync(join(directory, "postmaster.pid"))) execFileSync(join(bin, "pg_ctl.exe"), ["-D", directory, "-m", "fast", "-w", "stop"], { env, windowsHide: true, stdio: "pipe" });
});
function check(name: string, fn: () => void | Promise<void>) { return test(name, { skip: available ? false : "Local PostgreSQL unavailable: SQL execution NOT verified" }, fn); }
const tx = (body: string) => sql(`begin; set local request.jwt.claim.role='service_role'; ${body}; rollback;`);
const call = (overrides: Partial<{ kind: string; currency: string; amount: string; gain: string; fxRate: string; fxSource: string; fxAt: string; key: string; reversal: string; balance: string; lifetime: string; monthly: string; environment: string }> = {}) => {
 const v={kind:"MANUAL_CONTRIBUTION",currency:"USD",amount:"5",gain:"0",fxRate:"null",fxSource:"null",fxAt:"null",key:"audit-ledger-key-0001",reversal:"null",balance:"100",lifetime:"0",monthly:"0",environment:"TESTNET",...overrides};
 return `coinops.apply_robot_v1_manual_adjustment(${scope},'${ids.user}','${v.environment}','SOL',1,'${v.kind}',${v.gain},'${v.currency}',${v.amount},${v.fxRate},${v.fxSource},${v.fxAt},'Audit fixture',null,${v.reversal},'${v.key}',${v.balance},${v.lifetime},${v.monthly})`;
};
check("SQL: OPEN contribution preserves position/TP and next equity credits profit exactly once", () => {
 const result=tx(`create temp table positions as select * from coinops.robot_v1_testnet_orders;
 select id from ${call()};
 select balance_usdc=105 and contribution_usdc=5 and gain_count=0 from coinops.robot_v1_testnet_slots;
 select count(*)=0 from ((select * from positions except select * from coinops.robot_v1_testnet_orders) union all (select * from coinops.robot_v1_testnet_orders except select * from positions)) d;
 update coinops.robot_v1_testnet_slots set balance_usdc=balance_usdc+2,net_profit_usdc=net_profit_usdc+2;
 select balance_usdc=107 and net_profit_usdc=2 from coinops.robot_v1_testnet_slots`);
 assert.equal(result.split("\n").filter(x=>x==="t").length,3);
});
check("SQL: idempotent adjustment + reversal preserve two immutable rows", () => {
 const result=tx(`select id from ${call({kind:"MANUAL_TARGET_GAIN",gain:"2"})}; select id from ${call({kind:"MANUAL_TARGET_GAIN",gain:"2"})};
 select id from ${call({kind:"REVERSAL",amount:"0",balance:"105",lifetime:"2",monthly:"2",reversal:"(select id from coinops.robot_v1_manual_adjustments limit 1)",key:"audit-reversal-key-001"})};
 select balance_usdc=100 and manual_gain_usdc=0 and gain_count=0 from coinops.robot_v1_testnet_slots;
 select count(*)=2 from coinops.robot_v1_manual_adjustments;
 select lifetime_gain_count=0 and monthly_gain_count=0 from coinops.robot_v1_slot_gain_totals`);
 assert.equal(result.split("\n").filter(x=>x==="t").length,3);
});
check("SQL: missing FX source fails closed", () => {
 assert.throws(()=>tx(`select id from ${call({currency:"BRL",amount:"50",fxRate:"5",fxAt:"now()"})}`),/FX_STALE_OR_INVALID/);
});
check("SQL: NaN FX cannot corrupt ledger and balance", () => {
 assert.throws(()=>tx(`select id from ${call({currency:"BRL",amount:"50",fxRate:"'NaN'::numeric",fxAt:"now()",fxSource:"'BINANCE_SPOT_USDCBRL_ASK'"})}`),/FX_STALE_OR_INVALID/);
});
check("SQL: BRL conversion is auditable and cannot increment gain", () => {
 const result=tx(`select id from ${call({currency:"BRL",amount:"50",fxRate:"5",fxAt:"now()",fxSource:"'BINANCE_SPOT_USDCBRL_ASK'"})};
 select balance_usdc=110 and contribution_usdc=10 and gain_count=0 from coinops.robot_v1_testnet_slots;
 select converted_amount_usdc=10 and fx_rate=5 and gain_units=0 and strategy_version='4.3.1' from coinops.robot_v1_manual_adjustments`);
 assert.equal(result.split("\n").filter(x=>x==="t").length,2);
});
check("SQL: stale/future FX fails atomically", () => {
 for(const fxAt of ["now()-interval '121 seconds'","now()+interval '11 seconds'"])
  assert.throws(()=>tx(`select id from ${call({currency:"BRL",amount:"50",fxRate:"5",fxAt,fxSource:"'BINANCE_SPOT_USDCBRL_ASK'"})}`),/FX_STALE_OR_INVALID/);
 assert.equal(sql("select count(*) from coinops.robot_v1_manual_adjustments"),"0");
});
check("SQL: rejected stale preview and idempotency conflict leave balance unchanged", () => {
 assert.throws(()=>tx(`select id from ${call({balance:"99"})}`),/PREVIEW_STALE/);
 assert.throws(()=>tx(`select id from ${call()}; select id from ${call({amount:"6"})}`),/IDEMPOTENCY_CONFLICT/);
 assert.equal(sql("select balance_usdc=100 from coinops.robot_v1_testnet_slots"),"t");
});
check("SQL: terminal partial BUY retains its original committed quote in adjustment evidence", () => {
 const result=tx(`update coinops.robot_v1_testnet_orders set status='CANCELED' where side='BUY';
 select id from ${call()}; select position_committed_notional_usdc=100 and open_position_at_time from coinops.robot_v1_manual_adjustments`);
 assert.equal(result.split("\n").filter(x=>x==="t").length,1);
});
check("SQL: ARMED partial BUY is an existing position and its fills remain immutable", () => {
 const result=tx(`update coinops.robot_v1_testnet_slots set entry_state='ARMED';
 update coinops.robot_v1_testnet_orders set status='PARTIALLY_FILLED',executed_quantity=0.4,cumulative_quote=40 where client_order_id='AUDIT-BUY-1';
 create temp table positions as select * from coinops.robot_v1_testnet_orders;
 select id from ${call()};
 select open_position_at_time and position_committed_notional_usdc=40 and balance_after_usdc=105 from coinops.robot_v1_manual_adjustments;
 select entry_state='ARMED' and balance_usdc=105 and gain_count=0 from coinops.robot_v1_testnet_slots;
 select count(*)=0 from ((select * from positions except select * from coinops.robot_v1_testnet_orders) union all (select * from coinops.robot_v1_testnet_orders except select * from positions)) d`);
 assert.equal(result.split("\n").filter(x=>x==="t").length,3);
});
check("SQL: completed SELL removes open evidence even if slot projection lags", () => {
 const result=tx(`${closeFill} select id from ${call()};
 select not open_position_at_time and position_committed_notional_usdc is null from coinops.robot_v1_manual_adjustments`);
 assert.equal(result.split("\n").filter(x=>x==="t").length,1);
});
check("SQL: Shadow partial execution is preserved as committed position", () => {
 const result=tx(`insert into coinops.robot_v1_cycles values(gen_random_uuid(),'${ids.config}','POSITIONS_ACTIVE',now());
 insert into coinops.robot_v1_slots select id,1,'PARTIALLY_FILLED',100,0.4 from coinops.robot_v1_cycles;
 select id from ${call({environment:"SHADOW"})};
 select open_position_at_time and position_committed_notional_usdc=40 from coinops.robot_v1_manual_adjustments;
 select status='PARTIALLY_FILLED' and buy_price=100 and executed_quantity=0.4 from coinops.robot_v1_slots`);
 assert.equal(result.split("\n").filter(x=>x==="t").length,2);
});
check("SQL: engine leases reject concurrent equity changes for Shadow and Testnet", () => {
 assert.throws(()=>tx(`update coinops.robot_v1_testnet_runs set lease_until=now()+interval '30 seconds'; select id from ${call()}`),/ENGINE_BUSY/);
 assert.throws(()=>tx(`update coinops.robot_v1_configs set strategy_lease_until=now()+interval '30 seconds'; select id from ${call({environment:"SHADOW"})}`),/ENGINE_BUSY/);
});
check("SQL: Shadow CLOSED and OPEN account equations preserve frozen fill", () => {
 for(const isOpen of [false,true]) {
  const result=tx(`${isOpen?`insert into coinops.robot_v1_cycles values(gen_random_uuid(),'${ids.config}','POSITIONS_ACTIVE',now()); insert into coinops.robot_v1_slots select id,1,'TP_ACTIVE',100,1 from coinops.robot_v1_cycles;`:""}
  select id from ${call({environment:"SHADOW",kind:"MANUAL_TARGET_GAIN",gain:"1"})};
  update coinops.robot_v1_slot_accounts set balance_usdc=balance_usdc+2,net_profit_usdc=net_profit_usdc+2;
  select balance_usdc=107 and initial_balance_usdc=100 and net_profit_usdc=2 and manual_gain_usdc=5 from coinops.robot_v1_slot_accounts;
  select open_position_at_time=${isOpen} from coinops.robot_v1_manual_adjustments`);
  assert.equal(result.split("\n").filter(x=>x==="t").length,2);
 }
});
check("SQL: crash after adjustment rolls back account, ledger and gains together", () => {
 assert.throws(()=>tx(`select id from ${call({kind:"MANUAL_TARGET_GAIN",gain:"1"})}; do $$begin raise exception 'AUDIT_INJECTED_CRASH'; end$$`),/AUDIT_INJECTED_CRASH/);
 assert.equal(sql("select (select count(*)=0 from coinops.robot_v1_manual_adjustments) and (select count(*)=0 from coinops.robot_v1_monthly_slot_gains) and (select balance_usdc=100 from coinops.robot_v1_testnet_slots)"),"t");
});
check("SQL: ledger update and delete are immutable even for owner", () => {
 for(const mutation of ["update coinops.robot_v1_manual_adjustments set reason='changed'","delete from coinops.robot_v1_manual_adjustments"])
  assert.throws(()=>tx(`select id from ${call()}; ${mutation}`),/ADJUSTMENT_IMMUTABLE/);
});
check("SQL: authenticated/anon cannot call privileged adjustment RPC", () => {
 for(const role of ["authenticated","anon"])
  assert.throws(()=>sql(`begin; set local role ${role}; select id from ${call()}; rollback`),/permission denied for function/);
});
check("SQL: owner SELECT is scoped and client INSERT is forbidden", () => {
 const result=tx(`select id from ${call()}; set local role authenticated;
 set local audit.product='${ids.product}'; set local audit.tenant='${ids.tenant}'; set local "audit.user"='${ids.user}';
 select count(*)=1 from coinops.robot_v1_manual_adjustments;
 set local audit.tenant='77777777-7777-4777-8777-777777777777'; select count(*)=0 from coinops.robot_v1_manual_adjustments;
 reset role; select not has_table_privilege('authenticated','coinops.robot_v1_manual_adjustments','INSERT')`);
 assert.equal(result.split("\n").filter(x=>x==="t").length,3);
});
check("SQL: Testnet cycle carry plus reversal never duplicates principal or makes cycle gains negative", () => {
 const result=tx(`select id from ${call({kind:"MANUAL_TARGET_GAIN",gain:"2"})};
 update coinops.robot_v1_testnet_runs set status='COMPLETED';
 insert into coinops.robot_v1_testnet_runs(id,product_id,tenant_id,user_id,asset,status,previous_run_id,created_at)
 values('77777777-7777-4777-8777-777777777777',${scope},'SOL','ACTIVE','${ids.run}',now()+interval '1 second');
 insert into coinops.robot_v1_testnet_slots(id,run_id,product_id,tenant_id,user_id,slot_number,entry_state,operation_sequence,balance_usdc,gain_count,target_buy_price,entry_reference_price)
 values(gen_random_uuid(),'77777777-7777-4777-8777-777777777777',${scope},1,'PLANNED',1,105,0,100,100);
 select id from ${call({kind:"REVERSAL",amount:"0",balance:"105",lifetime:"2",monthly:"2",reversal:"(select id from coinops.robot_v1_manual_adjustments limit 1)",key:"audit-reversal-key-001"})};
 select balance_usdc=100 and manual_gain_usdc=0 and gain_count=0 from coinops.robot_v1_testnet_slots where run_id='77777777-7777-4777-8777-777777777777';
 select lifetime_gain_count=0 from coinops.robot_v1_slot_gain_totals`);
 assert.equal(result.split("\n").filter(x=>x==="t").length,2);
});
check("SQL: prepare REAL only adjusts isolated accounting and cannot touch Testnet/Shadow", () => {
 const result=tx(`select id from ${call({environment:"REAL",balance:"0"})};
 select balance_usdc=5 and contribution_usdc=5 from coinops.robot_v1_real_prepared_slot_accounts;
 select balance_usdc=100 from coinops.robot_v1_testnet_slots;
 select balance_usdc=100 from coinops.robot_v1_slot_accounts`);
 assert.equal(result.split("\n").filter(x=>x==="t").length,3);
});
check("SQL: concurrent retries serialize and rolled-back attempts leave no residue", async () => {
 const run=(query:string)=>new Promise<string>((resolve,reject)=>{
  const child=spawn(join(bin,"psql.exe"),[...args,"-c",query],{env,windowsHide:true}); let output="",error="";
  child.stdout.on("data",chunk=>{output+=chunk;}); child.stderr.on("data",chunk=>{error+=chunk;});
  child.on("error",reject); child.on("close",code=>code===0?resolve(output):reject(new Error(error)));
 });
 const transaction=`begin; set local request.jwt.claim.role='service_role'; select id from ${call()}; select pg_sleep(0.1); select count(*)=1 from coinops.robot_v1_manual_adjustments; rollback`;
 const results=await Promise.all([run(transaction),run(transaction),run(transaction)]);
 assert.ok(results.every(result=>result.replace(/\r/g,"").split("\n").includes("t")));
 assert.equal(sql("select count(*) from coinops.robot_v1_manual_adjustments"),"0");
});
check("SQL: month rollover reversal restores original month without subtracting current gains", () => {
 const result=tx(`
 insert into coinops.robot_v1_manual_adjustments(product_id,tenant_id,user_id,created_by,environment,asset,slot_number,physical_slot_id,
 kind,gain_units,currency,original_amount,converted_amount_usdc,balance_before_usdc,balance_after_usdc,monthly_before,monthly_after,lifetime_before,lifetime_after,
 period_key,open_position_at_time,reason,idempotency_key,request_fingerprint,strategy_version)
 values(${scope},'${ids.user}','TESTNET','SOL',1,'TESTNET:${ids.product}:${ids.tenant}:${ids.user}:SOL:1','MANUAL_TARGET_GAIN',1,'USD',5,5,95,100,0,1,0,1,
 to_char(now() at time zone 'America/Campo_Grande'-interval '1 month','YYYY-MM'),false,'Prior month fixture','audit-prior-month-001','fixture','4.3.1');
 insert into coinops.robot_v1_monthly_slot_gains(environment,source_id,product_id,tenant_id,user_id,asset,slot_number,physical_slot_id,credited_at,effective_gain_at,evidence_basis,period_key,gain_units)
 select environment,id,product_id,tenant_id,user_id,asset,slot_number,physical_slot_id,now(),now(),'MANUAL_TARGET_GAIN',period_key,gain_units from coinops.robot_v1_manual_adjustments;
 insert into coinops.robot_v1_monthly_slot_gains(environment,source_id,product_id,tenant_id,user_id,asset,slot_number,physical_slot_id,credited_at,effective_gain_at,evidence_basis,period_key,gain_units)
 select 'TESTNET',gen_random_uuid(),${scope},'SOL',1,physical_slot_id,now(),now(),'TESTNET_EXCHANGE_FILL',to_char(now() at time zone 'America/Campo_Grande','YYYY-MM'),1 from coinops.robot_v1_manual_adjustments cross join generate_series(1,2);
 update coinops.robot_v1_testnet_slots set gain_count=3,manual_gain_usdc=5;
 select id from ${call({kind:"REVERSAL",amount:"0",balance:"100",lifetime:"3",monthly:"2",reversal:"(select id from coinops.robot_v1_manual_adjustments limit 1)",key:"audit-reversal-key-001"})};
 select lifetime_gain_count=2 and monthly_gain_count=2 and manual_gain_count=0 and market_gain_count=2 from coinops.robot_v1_slot_gain_totals;
 select balance_usdc=95 and gain_count=2 from coinops.robot_v1_testnet_slots`);
 assert.equal(result.split("\n").filter(x=>x==="t").length,2);
});
check("SQL: 2,500 seeded adjustment/reversal attempts reconcile exactly with immutable ledger", () => {
 const result=tx(`do $$ declare i integer; seed bigint:=448155; amount numeric; kind text; units integer; balance numeric; gains integer;
 a coinops.robot_v1_manual_adjustments; begin
 for i in 1..2000 loop
  seed:=(seed*1664525+1013904223)%4294967296; amount:=((seed%100000)+1)::numeric/100000000;
  units:=case when seed%3=0 then 1 else 0 end; kind:=case when units=1 then 'MANUAL_TARGET_GAIN' else 'MANUAL_CONTRIBUTION' end;
  select balance_usdc,gain_count into balance,gains from coinops.robot_v1_testnet_slots;
  select * into a from coinops.apply_robot_v1_manual_adjustment(${scope},'${ids.user}','TESTNET','SOL',1,kind,units,'USD',amount,null,null,null,
   'Seeded audit',null,null,'audit-seed-448155-'||i,balance,gains,gains);
  -- Immediate duplicate exercises the real database replay branch.
  perform coinops.apply_robot_v1_manual_adjustment(${scope},'${ids.user}','TESTNET','SOL',1,kind,units,'USD',amount,null,null,null,
   'Seeded audit',null,null,'audit-seed-448155-'||i,balance,gains,gains);
  if i%4=0 then
   perform coinops.apply_robot_v1_manual_adjustment(${scope},'${ids.user}','TESTNET','SOL',1,'REVERSAL',0,'USD',0,null,null,null,
    'Seeded reversal',null,a.id,'audit-reverse-448155-'||i,a.balance_after_usdc,a.lifetime_after,a.monthly_after);
  end if;
  if (select balance_usdc from coinops.robot_v1_testnet_slots)<>(select 100+sum(converted_amount_usdc) from coinops.robot_v1_manual_adjustments)
    or (select gain_count from coinops.robot_v1_testnet_slots)<>(select coalesce(sum(gain_units),0) from coinops.robot_v1_monthly_slot_gains) then
   raise exception 'AUDIT_LEDGER_EQUATION_FAILED_AT_%',i;
  end if;
 end loop; end$$;
 select count(*)=2500 from coinops.robot_v1_manual_adjustments;
 select balance_usdc=100+manual_gain_usdc+contribution_usdc and net_profit_usdc=0 from coinops.robot_v1_testnet_slots`);
 assert.equal(result.split("\n").filter(x=>x==="t").length,2);
});
