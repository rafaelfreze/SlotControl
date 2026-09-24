import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

// Disposable, loopback-only PostgreSQL. Never load .env or connect to Supabase.
const bin = process.env.COINOPS_AUDIT_PG_BIN ?? "C:/Program Files/PostgreSQL/17/bin";
const available = existsSync(join(bin, "initdb.exe"));
const directory = available ? mkdtempSync(join(tmpdir(), "coinops-live-ledger-")) : "";
const port = 55446;
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG"))),
  NODE_ENV: process.env.NODE_ENV,
  PGHOST: "127.0.0.1", PGPORT: String(port), PGUSER: "live_audit_owner", PGDATABASE: "postgres",
  PGPASSFILE: join(directory, "no-credentials") };
const psqlArgs = ["-X", "-w", "-h", "127.0.0.1", "-p", String(port), "-U", "live_audit_owner",
  "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"];
const sql = (query: string) => execFileSync(join(bin, "psql.exe"), [...psqlArgs, "-c", query],
  { env, encoding: "utf8", windowsHide: true, stdio: "pipe" }).replace(/\r/g, "").trim();
const product = "11111111-1111-4111-8111-111111111111";
const tenant = "22222222-2222-4222-8222-222222222222";
const user = "33333333-3333-4333-8333-333333333333";
const run = "44444444-4444-4444-8444-444444444444";
const slot = "55555555-5555-4555-8555-555555555555";
const lease = "66666666-6666-4666-8666-666666666666";
const scope = `'${product}','${tenant}','${user}'`;
const scaffold = `
create role anon; create role authenticated; create role service_role bypassrls;
create schema coinops; create schema private;
create table public.product_tenants(product_id uuid,tenant_id uuid,primary key(product_id,tenant_id));
create function private.coinops_can_access_row(uuid,uuid,uuid) returns boolean language sql as $$ select true $$;
create function private.coinops_touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
create table coinops.robot_v1_live_preparations(
 id uuid primary key default gen_random_uuid(), product_id uuid not null,tenant_id uuid not null,
 user_id uuid not null,asset text,symbol text,slot_count integer,configured_live_capital_brl numeric,
 max_order_notional_brl numeric,max_total_exposure_brl numeric,live_enabled boolean default false,
 kill_switch boolean default true,config_version integer default 1,
 unique(product_id,tenant_id,user_id,asset),
 constraint robot_v1_live_preparations_kill_switch_check check(kill_switch),
 constraint robot_v1_live_preparations_live_enabled_check check(not live_enabled));
create table coinops.robot_v1_live_global_caps(product_id uuid,tenant_id uuid,user_id uuid,
 max_total_live_exposure_brl numeric,primary key(product_id,tenant_id,user_id));
create table coinops.robot_v1_live_slot_accounts(product_id uuid,tenant_id uuid,user_id uuid,
 asset text,slot_number integer,balance_brl numeric default 0,market_pnl_brl numeric default 0,
 manual_gain_brl numeric default 0,contribution_brl numeric default 0,fees_brl numeric default 0,
 gain_count integer default 0,primary key(product_id,tenant_id,user_id,asset,slot_number),
 constraint robot_v1_live_slot_balance_check check(balance_brl=market_pnl_brl+manual_gain_brl+contribution_brl-fees_brl));
create table coinops.robot_v1_strategy_decisions(product_id uuid,tenant_id uuid,user_id uuid,
 environment text,asset text,decision_id text,strategy_version text,cycle_id uuid,slot_id uuid,
 operation_id uuid,operation_sequence integer,action_type text,target_price numeric,
 target_notional numeric,priority integer,reason text,expected_next_state jsonb,
 created_at timestamptz default now(),
 constraint robot_v1_strategy_decisions_environment_check check(environment in ('SHADOW','TESTNET')));
create table coinops.robot_v1_testnet_runs(id uuid,product_id uuid,tenant_id uuid,user_id uuid,asset text);
create table coinops.robot_v1_testnet_slots(id uuid,run_id uuid);
create table coinops.robot_v1_cycles(id uuid,product_id uuid,tenant_id uuid,user_id uuid,asset text,execution_mode text);
create table coinops.robot_v1_slots(id uuid,cycle_id uuid);
create table coinops.robot_v1_monthly_slot_gains(environment text,source_id uuid,product_id uuid,
 tenant_id uuid,user_id uuid,asset text,slot_number integer,physical_slot_id text,
 credited_at timestamptz,effective_gain_at timestamptz,evidence_basis text,period_key text,
 gain_units integer default 1,
 constraint robot_v1_monthly_slot_gains_evidence_basis_check check(evidence_basis in ('SHADOW_CONFIRMED_TP_CLOSE')));
`;

before(() => {
  if (!available) return;
  execFileSync(join(bin, "initdb.exe"), ["-D", directory, "-U", "live_audit_owner", "-A", "trust",
    "--no-locale", "-E", "UTF8"], { env, windowsHide: true, stdio: "pipe" });
  execFileSync(join(bin, "pg_ctl.exe"), ["-D", directory, "-l", join(directory, "server.log"),
    "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"], { env, windowsHide: true, stdio: "ignore" });
  sql(scaffold);
  execFileSync(join(bin, "psql.exe"), [...psqlArgs, "-f",
    resolve("../../supabase/migrations/20260924041046_add_robot_v1_live_execution_ledger.sql")],
  { env, windowsHide: true, stdio: "pipe" });
});
after(() => {
  if (available && existsSync(join(directory, "postmaster.pid")))
    execFileSync(join(bin, "pg_ctl.exe"), ["-D", directory, "-m", "fast", "-w", "stop"],
      { env, windowsHide: true, stdio: "pipe" });
});

test("LIVE SQL: 25-slot activation, fills, fees, gain and idempotent closure",
  { skip: available ? false : "Local PostgreSQL unavailable" }, () => {
  sql(`insert into public.product_tenants values('${product}','${tenant}');
    insert into coinops.robot_v1_live_preparations
      (product_id,tenant_id,user_id,asset,symbol,slot_count,configured_live_capital_brl,
        max_order_notional_brl,max_total_exposure_brl)
      values(${scope},'BTC','BTCBRL',25,447,17.88,447);
    insert into coinops.robot_v1_live_global_caps values(${scope},716.75);
    insert into coinops.robot_v1_live_runs
      (id,product_id,tenant_id,user_id,asset,symbol,status,anchor_price,slot_notional_brl,
        gain_rate,entry_spacing,entry_regime,config_version,config_snapshot,strategy_version)
      values('${run}',${scope},'BTC','BTCBRL','PREPARING',437724,17.88,.012,.01,'NORMAL',2,'{}','4.3.1');
    insert into coinops.robot_v1_live_slots
      (id,run_id,product_id,tenant_id,user_id,slot_number,target_buy_price,entry_reference_price,operational_rank)
      select case when n=1 then '${slot}'::uuid else gen_random_uuid() end,'${run}',${scope},n,437724,437724,n
      from generate_series(1,25)n;
    insert into coinops.robot_v1_live_slot_accounts
      (product_id,tenant_id,user_id,asset,slot_number,balance_brl,contribution_brl)
      select ${scope},'BTC',n,17.88,17.88 from generate_series(1,25)n;`);
  assert.equal(sql(`select status from coinops.activate_robot_v1_live_cycle('${run}')`), "ACTIVE");
  sql(`update coinops.robot_v1_live_runs set lease_owner='${lease}',lease_until=now()+interval '10 minutes' where id='${run}';
    insert into coinops.robot_v1_strategy_decisions
      (product_id,tenant_id,user_id,environment,asset,decision_id,cycle_id,slot_id,action_type)
      values (${scope},'REAL','BTC','${"a".repeat(64)}','${run}','${slot}','BUY'),
        (${scope},'REAL','BTC','${"b".repeat(64)}','${run}','${slot}','SELL');`);
  const buy = "COR1-BTC-1-1-BUY-0123456789abcd";
  const sell = "COR1-BTC-1-1-SELL-0123456789abcd";
  const prepareBuy = `coinops.prepare_robot_v1_live_order('${run}','${slot}','BUY','INITIAL',1,
    '${buy}',null,17.88,null,'${"a".repeat(64)}','${lease}')`;
  const buyId = sql(`select id from ${prepareBuy}`);
  assert.equal(sql(`select id from ${prepareBuy}`), buyId);
  const filledAt = new Date().toISOString();
  const sync = (id: string, exchangeId: string, side: "BUY" | "SELL", quote: number) => {
    const trades = JSON.stringify([{ id: side === "BUY" ? "1" : "2", quantity: .00004,
      quoteQuantity: quote, commission: .000002, commissionAsset: "BNB",
      isBuyer: side === "BUY", filledAt }]);
    return sql(`select status from coinops.sync_robot_v1_live_order('${id}','${exchangeId}','FILLED',.00004,
      ${quote},'${trades}'::jsonb,
      5000,now(),'${lease}')`);
  };
  assert.equal(sync(buyId, "101", "BUY", 17.5), "FILLED");
  assert.equal(sync(buyId, "101", "BUY", 17.5), "FILLED");
  assert.equal(sql(`select position_quantity=0.00004 and position_committed_brl=17.51
    from coinops.robot_v1_live_slots where id='${slot}'`), "t");
  const sellId = sql(`select id from coinops.prepare_robot_v1_live_order('${run}','${slot}',
    'SELL','TP',1,'${sell}',.00004,null,445000,'${"b".repeat(64)}','${lease}')`);
  assert.equal(sync(sellId, "102", "SELL", 17.8), "FILLED");
  assert.equal(sync(sellId, "102", "SELL", 17.8), "FILLED");
  const credit = `coinops.credit_robot_v1_live_closed_slot('${run}','${slot}',1,'${sell}',.00001,'${lease}')`;
  assert.equal(sql(`select balance_brl=18.16 and market_pnl_brl=.30 and fees_brl=.02
    and gain_count=1 from ${credit}`), "t");
  assert.equal(sql(`select balance_brl=18.16 and gain_count=1 from ${credit}`), "t");
  assert.equal(sql(`select count(*) from coinops.robot_v1_monthly_slot_gains
    where environment='REAL' and asset='BTC' and slot_number=1`), "1");
  sql(`update coinops.robot_v1_live_global_caps set max_total_live_exposure_brl=726
    where product_id='${product}' and tenant_id='${tenant}' and user_id='${user}'`);
  const slotTwo = sql(`select id from coinops.robot_v1_live_slots where run_id='${run}' and slot_number=2`);
  assert.throws(() => sql(`select id from coinops.prepare_robot_v1_live_order('${run}',
    '${slotTwo}','BUY','ENTRY',1,'COR1-BTC-2-1-BUY-0123456789abcd',.00004,null,
    420000,'${"a".repeat(64)}','${lease}')`), /COINOPS_LIVE_HARD_CAP_INVALID/);
  assert.equal(sql(`select count(*) from coinops.robot_v1_live_orders`), "2");
});
