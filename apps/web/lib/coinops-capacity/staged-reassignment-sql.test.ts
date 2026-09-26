import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

// Intentionally isolated PostgreSQL. No remote URL, secrets or Binance calls.
const bin = process.env.COINOPS_AUDIT_PG_BIN ?? "C:/Program Files/PostgreSQL/17/bin";
const available = existsSync(join(bin, "initdb.exe"));
const directory = available ? mkdtempSync(join(tmpdir(), "coinops-staged-")) : "";
let port = 0;
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG"))),
  NODE_ENV: "test" as const, PGHOST: "127.0.0.1", PGPORT: "", PGUSER: "staged_audit",
  PGDATABASE: "postgres", PGPASSFILE: join(directory, "no-credentials") };
const args = (query: string) => ["-X", "-w", "-h", "127.0.0.1", "-p", String(port),
  "-U", "staged_audit", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-c", query];
const psql = (query: string) => execFileSync(join(bin, "psql.exe"), args(query),
  { env, windowsHide: true, encoding: "utf8", stdio: "pipe" }).replace(/\r/g, "").trim();
const operator = "11111111-1111-4111-8111-111111111111";
const actor = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const request = "44444444-4444-4444-8444-444444444444";
const move = (n: number, preview = false, retired = true, target = "executor-02", op = operator) =>
  `select coinops.reassign_staged_executor_shard('${op}','${id(n)}','executor-01','${target}','${request}',${preview},${retired})`;
const parsed = (sql: string) => JSON.parse(psql(sql));
const snapshot = () => psql(`select jsonb_build_object('accounts',(select jsonb_agg(to_jsonb(a) order by id)
  from coinops.exchange_accounts a where id in ('${id(1)}','${id(2)}','${id(3)}','${id(4)}')),
  'engines',(select jsonb_agg(to_jsonb(e) order by id) from coinops.trading_engines e where exchange_account_id
    in ('${id(1)}','${id(2)}','${id(3)}','${id(4)}')))`);
let baseline = "";
function stage(n: number) {
  psql(`insert into coinops.exchange_accounts(id,operator_id,display_name,status,kill_switch,is_legacy_default,credential_ref)
    values('${id(n)}','${operator}','Never traded','INACTIVE',true,false,'fixture-${n}');
    insert into coinops.trading_engines values('${id(n)}','${operator}','${id(n)}','REAL','INACTIVE',true);
    insert into coinops.robot_v1_live_runs values('${id(n)}','${id(n)}','PREPARING',null);
    insert into coinops.robot_v1_live_slots(exchange_account_id,entry_state,position_quantity,position_committed_brl,operation_sequence)
      select '${id(n)}','PLANNED',0,0,1 from generate_series(1,25);`);
}
before(async () => {
  if (!available) return;
  const socket = createServer();
  await new Promise<void>((done, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", done); });
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("LOCAL_PG_PORT_UNAVAILABLE");
  port = address.port; env.PGPORT = String(port);
  await new Promise<void>((done, reject) => socket.close((error) => error ? reject(error) : done()));
  execFileSync(join(bin, "initdb.exe"), ["-D", directory, "-U", "staged_audit", "-A", "trust", "--no-locale", "-E", "UTF8"],
    { env, windowsHide: true, stdio: "pipe" });
  execFileSync(join(bin, "pg_ctl.exe"), ["-D", directory, "-l", join(directory, "server.log"),
    "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"], { env, windowsHide: true, stdio: "ignore" });
  psql(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema coinops; create schema private; grant usage on schema coinops to service_role;
    create table coinops.operators(id uuid primary key,user_id uuid,status text);
    create table coinops.exchange_accounts(id uuid primary key,operator_id uuid,display_name text,status text,
      kill_switch boolean,is_legacy_default boolean,credential_ref text,executor_profile text,unique(id,operator_id));
    create table coinops.trading_engines(id uuid primary key,operator_id uuid,exchange_account_id uuid references coinops.exchange_accounts,
      environment text,status text,kill_switch boolean);
    create table coinops.operator_push_subscriptions(id uuid primary key);
    create table coinops.account_onboarding_checks(operator_id uuid,exchange_account_id uuid,check_key text,status text,
      evidence jsonb,created_by uuid,idempotency_key text,checked_at timestamptz default now(),unique(exchange_account_id,idempotency_key));
    create table coinops.robot_v1_live_runs(id uuid primary key,exchange_account_id uuid,status text,lease_until timestamptz);
    create table coinops.robot_v1_testnet_runs(id uuid primary key,exchange_account_id uuid);
    create table coinops.robot_v1_live_orders(id uuid primary key,exchange_account_id uuid,status text);
    create table coinops.robot_v1_live_fills(id uuid primary key,exchange_account_id uuid);
    create table coinops.robot_v1_live_slots(id uuid default gen_random_uuid(),exchange_account_id uuid,entry_state text,
      position_quantity numeric,position_committed_brl numeric,operation_sequence integer,
      last_take_profit_price numeric,last_credited_sell_client_order_id text);
    insert into coinops.operators values('${operator}','${actor}','ACTIVE'),('${actor}','${actor}','ACTIVE');
    insert into coinops.exchange_accounts(id,operator_id,display_name,status,kill_switch,is_legacy_default)
      select ('33333333-3333-4333-8333-'||lpad(n::text,12,'0'))::uuid,'${operator}','LIVE '||n,'ACTIVE',false,false from generate_series(1,4)n;
    insert into coinops.trading_engines select gen_random_uuid(),'${operator}',
      ('33333333-3333-4333-8333-'||lpad(least((n+1)/2,4)::text,12,'0'))::uuid,'REAL','ACTIVE',false from generate_series(1,7)n;`);
  for (const migration of ["20260926180000_add_coinops_executor_capacity.sql", "20260926192555_add_coinops_shard_assignment.sql",
    "20260926194212_add_coinops_global_binance_identity.sql", "20260926201333_add_coinops_staged_shard_reassignment.sql"])
    psql(readFileSync(resolve("../../supabase/migrations", migration), "utf8"));
  psql(`insert into coinops.executor_shards(id,egress_ipv4) values('executor-02','192.0.2.2'),('executor-03','192.0.2.3');
    insert into coinops.executor_capacity_samples(shard_id,observed_at,heartbeat_at,weight_observed_at,
      binance_weight_current,binance_weight_average,binance_weight_peak,binance_weight_samples,
      cpu_percent,ram_used_mb,ram_limit_mb,account_count,engine_count,registry_match)
    select s,now(),now(),now(),2,3,4,3,1,90,961,0,0,true from unnest(array['executor-02','executor-03'])s;`);
  baseline = snapshot();
});
after(() => { if (available && existsSync(join(directory, "postmaster.pid")))
  execFileSync(join(bin, "pg_ctl.exe"), ["-D", directory, "-m", "fast", "-w", "stop"], { env, windowsHide: true, stdio: "pipe" }); });
const check = (name: string, fn: () => void | Promise<void>) => test(name, { skip: available ? false : "Local PostgreSQL unavailable" }, fn);

check("prepared account keeps all 25 slots, run, engine and physical identity while requiring new credential", () => {
  stage(100);
  psql(`select coinops.claim_binance_account_identity('${operator}','${id(100)}','REAL','${"a".repeat(64)}')`);
  const rows = psql(`select jsonb_agg(to_jsonb(s) order by id) from coinops.robot_v1_live_slots s where exchange_account_id='${id(100)}'`);
  assert.equal(parsed(move(100, true, false)).code, "READY_TO_REASSIGN");
  assert.equal(psql(`select executor_shard_id from coinops.exchange_accounts where id='${id(100)}'`), "executor-01");
  assert.throws(() => psql(move(100, false, false)), /SOURCE_REGISTRY_RETIREMENT_REQUIRED/);
  assert.equal(parsed(move(100)).code, "REASSIGNED");
  assert.equal(psql(`select status||':'||kill_switch||':'||executor_shard_id from coinops.exchange_accounts where id='${id(100)}'`), "INACTIVE:true:executor-02");
  assert.equal(psql(`select status from coinops.robot_v1_live_runs where id='${id(100)}'`), "PREPARING");
  assert.equal(psql(`select jsonb_agg(to_jsonb(s) order by id) from coinops.robot_v1_live_slots s where exchange_account_id='${id(100)}'`), rows);
  assert.equal(psql(`select status||':'||(evidence->>'executor_shard_id') from coinops.account_onboarding_checks
    where exchange_account_id='${id(100)}' and check_key='BINANCE_CREDENTIAL'`), "PENDING:executor-02");
  assert.equal(psql(`select count(*) from coinops.binance_account_identity_bindings where exchange_account_id='${id(100)}'`), "1");
});
check("idempotent replay after activation does not modify any state", () => {
  psql(`update coinops.exchange_accounts set status='ACTIVE',kill_switch=false where id='${id(100)}'`);
  assert.equal(parsed(move(100, true, false)).replayed, true);
  assert.equal(parsed(move(100)).replayed, true);
  assert.equal(psql(`select count(*) from coinops.account_onboarding_checks where exchange_account_id='${id(100)}'`), "2");
});
check("LIVE account and engine, prior order/fill, residual position, executed cycle or active lease are denied", () => {
  assert.throws(() => psql(move(1)), /STAGED_REASSIGNMENT_DENIED/);
  const mutations = [
    (n: number) => `update coinops.trading_engines set status='ACTIVE' where id='${id(n)}'`,
    (n: number) => `insert into coinops.robot_v1_live_orders values('${id(n)}','${id(n)}','REJECTED')`,
    (n: number) => `insert into coinops.robot_v1_live_fills values('${id(n)}','${id(n)}')`,
    (n: number) => `update coinops.robot_v1_live_slots set position_quantity=.000000000001 where exchange_account_id='${id(n)}'`,
    (n: number) => `update coinops.robot_v1_live_slots set position_committed_brl=.01 where exchange_account_id='${id(n)}'`,
    (n: number) => `update coinops.robot_v1_live_slots set operation_sequence=2 where exchange_account_id='${id(n)}'`,
    (n: number) => `update coinops.robot_v1_live_runs set status='STOPPED' where id='${id(n)}'`,
    (n: number) => `update coinops.robot_v1_live_runs set lease_until=now()+interval '1 minute' where id='${id(n)}'`,
    (n: number) => `insert into coinops.executor_capacity_admissions(engine_id,shard_id,reserved_weight,expires_at)
      values('${id(n)}','executor-01',900,now()+interval '1 minute')`,
  ];
  mutations.forEach((mutation, i) => { const n = 110 + i; stage(n); psql(mutation(n));
    assert.throws(() => psql(move(n)), /STAGED_REASSIGNMENT_(DENIED|TRADING_HISTORY)/); });
});
check("foreign tenant, direct primary update and private capability injection are denied", () => {
  stage(130);
  assert.throws(() => psql(move(130, false, true, "executor-02", actor)), /ADMIN_ACCOUNT_DENIED/);
  assert.throws(() => psql(`update coinops.exchange_accounts set executor_shard_id='executor-02' where id='${id(130)}'`), /SHARD_REASSIGNMENT_FORBIDDEN/);
  assert.throws(() => psql(`set role service_role; insert into private.coinops_staged_shard_move_capabilities
    values('${id(130)}','executor-01','executor-02',txid_current())`), /permission denied/);
  assert.equal(psql(`select has_function_privilege('authenticated','coinops.reassign_staged_executor_shard(uuid,uuid,text,text,uuid,boolean,boolean)','execute')`), "f");
});
check("stale/offline/full destination refuses ownership changes", () => {
  stage(131);
  psql("update coinops.executor_capacity_samples set heartbeat_at=now()-interval '3 minutes' where shard_id='executor-02'");
  assert.throws(() => psql(move(131)), /CAPACITY_UNKNOWN/);
  psql("update coinops.executor_capacity_samples set heartbeat_at=now(),binance_weight_peak=3200 where shard_id='executor-02'");
  assert.throws(() => psql(move(131)), /CAPACITY_REQUIRED/);
  psql("update coinops.executor_capacity_samples set binance_weight_peak=4 where shard_id='executor-02'; update coinops.executor_shards set enabled=false where id='executor-02'");
  assert.throws(() => psql(move(131)), /CAPACITY_UNKNOWN/);
  psql("update coinops.executor_shards set enabled=true where id='executor-02'");
});
check("parallel repeated assignment has one result and conflicting destinations cannot both win", async () => {
  stage(140); stage(141);
  const execute = promisify(execFile);
  const run = (sql: string) => execute(join(bin, "psql.exe"), args(sql), { env, windowsHide: true, encoding: "utf8" });
  const replay = await Promise.all([run(move(140)), run(move(140))]);
  assert.deepEqual(replay.map((result) => JSON.parse(result.stdout).replayed).sort(), [false, true]);
  const conflict = await Promise.allSettled([run(move(141)), run(move(141, false, true, "executor-03"))]);
  assert.equal(conflict.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(psql(`select count(*) from coinops.account_onboarding_checks where exchange_account_id='${id(141)}'`), "2");
});
check("existing four LIVE accounts and seven engines stay byte-for-byte identical", () => assert.equal(snapshot(), baseline));
