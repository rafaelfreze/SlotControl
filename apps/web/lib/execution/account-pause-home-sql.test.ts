import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";

// Isolated in-memory Postgres. Never connects to Supabase, reads env, or writes LIVE.
const requireFixture = createRequire(new URL("../../../../tools/testing/account-pause-sql/package.json", import.meta.url));
type Pg = { exec(sql: string): Promise<unknown>; query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>; close(): Promise<void> };
const { PGlite } = requireFixture("@electric-sql/pglite") as { PGlite: new () => Pg };
const db = new PGlite();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const migration = readFileSync(new URL("../../../../supabase/migrations/20261013145823_add_account_pause_home_preferences.sql", import.meta.url), "utf8");
const query = async (sql: string) => (await db.query(sql)).rows;
const command = (hidden: boolean, request: number, account = 2, operator = 1, user = 3) =>
  `select coinops.set_account_home_preference('${id(operator)}','${id(account)}','${id(user)}',${hidden},'${id(request)}',ARRAY['${id(4)}']::uuid[]) as value`;
before(async () => {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated;
    create schema coinops; grant usage on schema coinops to anon,authenticated,service_role;
    create table coinops.operators(id uuid primary key,user_id uuid,status text,kill_switch boolean);
    create table coinops.exchange_accounts(id uuid primary key,operator_id uuid,status text,kill_switch boolean);
    create table coinops.trading_engines(id uuid primary key,operator_id uuid,exchange_account_id uuid,environment text,status text,kill_switch boolean,strategy_config_pending boolean);
    create table coinops.robot_v1_live_runs(id uuid primary key,operator_id uuid,exchange_account_id uuid,trading_engine_id uuid,status text,last_error text,last_reconciled_at timestamptz);
    create table coinops.robot_v1_live_preparations(operator_id uuid,exchange_account_id uuid,trading_engine_id uuid,live_enabled boolean,kill_switch boolean);
    create table coinops.watchdog_checks(shard_id text primary key);
    insert into coinops.operators values('${id(1)}','${id(3)}','ACTIVE',false),('${id(11)}','${id(13)}','ACTIVE',false);
    insert into coinops.exchange_accounts values('${id(2)}','${id(1)}','ACTIVE',false),('${id(12)}','${id(11)}','ACTIVE',false);
    insert into coinops.trading_engines values('${id(4)}','${id(1)}','${id(2)}','REAL','ACTIVE',true,false);
    insert into coinops.robot_v1_live_runs values('${id(5)}','${id(1)}','${id(2)}','${id(4)}','PAUSED',null,now());
    insert into coinops.robot_v1_live_preparations values('${id(1)}','${id(2)}','${id(4)}',true,true);
    grant select on all tables in schema coinops to authenticated;
    grant select on all tables in schema coinops to service_role;`);
  await db.exec(migration);
});
after(async () => { await db.close(); });

test("preference RPC is transactional, idempotent and cannot change financial tables", async () => {
  await db.exec("set role service_role");
  const first = (await query(command(true, 20)))[0].value as { hidden: boolean };
  assert.equal(first.hidden, true);
  assert.equal(((await query(command(true, 20)))[0].value as { hidden: boolean }).hidden, true);
  assert.equal((await query("select count(*)::int n from coinops.account_home_preference_events"))[0].n, 1);
  await assert.rejects(query(command(false, 20)), /REQUEST_COLLISION/);
  await db.exec("reset role");
  assert.equal((await query("select status from coinops.robot_v1_live_runs"))[0].status, "PAUSED");
  assert.equal((await query("select kill_switch from coinops.trading_engines"))[0].kill_switch, true);
});
test("owner can read, another operator and anon cannot read or mutate preferences", async () => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${id(3)}',false)`);
  assert.equal((await query("select count(*)::int n from coinops.account_home_preferences"))[0].n, 1);
  await assert.rejects(query(command(false, 21)), /permission denied/);
  await assert.rejects(db.exec("update coinops.account_home_preferences set hidden=false"), /permission denied/);
  await db.exec(`select set_config('request.jwt.claim.sub','${id(13)}',false)`);
  assert.equal((await query("select count(*)::int n from coinops.account_home_preferences"))[0].n, 0);
  await db.exec("reset role; set role anon");
  await assert.rejects(query("select * from coinops.account_home_preferences"), /permission denied/);
  await assert.rejects(query(command(false, 22)), /permission denied/);
  await db.exec("reset role");
});
test("hidden preference never succeeds when a new engine, active run, stale read or gate race exists", async () => {
  for (const mutate of [
    "update coinops.robot_v1_live_runs set status='ACTIVE'",
    "update coinops.robot_v1_live_runs set last_error='FAULT'",
    "update coinops.robot_v1_live_runs set last_reconciled_at=now()-interval '4 minutes'",
    "update coinops.trading_engines set kill_switch=false",
    "update coinops.trading_engines set strategy_config_pending=true",
    "update coinops.robot_v1_live_preparations set live_enabled=false",
  ]) {
    await db.exec(`begin; ${mutate}; set local role service_role;`);
    await assert.rejects(query(command(true, 30)), /PROTECTION_UNPROVEN/);
    await db.exec("rollback");
  }
  await db.exec(`begin; insert into coinops.trading_engines values('${id(6)}','${id(1)}','${id(2)}','REAL','ACTIVE',false,false); set local role service_role;`);
  await assert.rejects(query(command(true, 31)), /INVENTORY_CHANGED/);
  await db.exec("rollback");
});
test("SHOW only changes display, immutable audit is append-only, scope is exact", async () => {
  await db.exec("set role service_role");
  await assert.rejects(query(command(false, 40, 12)), /SCOPE_DENIED/);
  assert.equal(((await query(command(false, 41)))[0].value as { hidden: boolean }).hidden, false);
  await assert.rejects(db.exec("delete from coinops.account_home_preference_events"), /permission denied/);
  await assert.rejects(db.exec("update coinops.account_home_preference_events set hidden=true"), /permission denied/);
  await db.exec("reset role");
  assert.equal((await query("select status from coinops.robot_v1_live_runs"))[0].status, "PAUSED");
  assert.equal((await query("select kill_switch from coinops.trading_engines"))[0].kill_switch, true);
});
