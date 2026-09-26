import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

// Actual PostgreSQL concurrency/RLS, only in a disposable loopback database.
const bin = process.env.COINOPS_AUDIT_PG_BIN ?? "C:/Program Files/PostgreSQL/17/bin";
const available = existsSync(join(bin, "initdb.exe"));
const directory = available ? mkdtempSync(join(tmpdir(), "coinops-shards-")) : "";
let port = 0;
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG"))),
  NODE_ENV: "test" as const, PGHOST: "127.0.0.1", PGPORT: "", PGUSER: "shard_audit",
  PGDATABASE: "postgres", PGPASSFILE: join(directory, "no-credentials") };
const args = (query: string) => ["-X", "-w", "-h", "127.0.0.1", "-p", String(port),
  "-U", "shard_audit", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-c", query];
const psql = (query: string) => execFileSync(join(bin, "psql.exe"), args(query),
  { env, windowsHide: true, encoding: "utf8", stdio: "pipe" }).replace(/\r/g, "").trim();
const operator = "11111111-1111-4111-8111-111111111111";
const user = "22222222-2222-4222-8222-222222222222";
const account = (index: number) => `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`;
const request = "44444444-4444-4444-8444-444444444444";
const assign = (index: number, count = 2, op = operator) => `select coinops.assign_executor_shard(
  '${op}','${account(index)}','Fixture ${index}','REAL',${count},'${request}')`;
const decision = (index: number, count = 2) => JSON.parse(psql(assign(index, count))) as
  { code: string; shardId?: string; executorIp?: string; capacityReserved?: boolean };
let baseline = "";

before(async () => {
  if (!available) return;
  const reservation = createServer();
  await new Promise<void>((done, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", done); });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("LOCAL_PG_PORT_UNAVAILABLE");
  port = address.port; env.PGPORT = String(port);
  await new Promise<void>((done, reject) => reservation.close((error) => error ? reject(error) : done()));
  execFileSync(join(bin, "initdb.exe"), ["-D", directory, "-U", "shard_audit", "-A", "trust", "--no-locale", "-E", "UTF8"],
    { env, windowsHide: true, stdio: "pipe" });
  execFileSync(join(bin, "pg_ctl.exe"), ["-D", directory, "-l", join(directory, "server.log"),
    "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"], { env, windowsHide: true, stdio: "ignore" });
  psql(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema coinops; create schema private; grant usage on schema coinops to service_role;
    create table coinops.operators(id uuid primary key,user_id uuid,status text);
    create table coinops.exchange_accounts(id uuid primary key,operator_id uuid,
      display_name text,status text,kill_switch boolean,is_legacy_default boolean,credential_ref text,executor_profile text,
      unique(id,operator_id));
    create table coinops.trading_engines(id uuid primary key,exchange_account_id uuid references coinops.exchange_accounts(id),
      environment text,status text,kill_switch boolean);
    create table coinops.operator_push_subscriptions(id uuid primary key);
    create table coinops.account_onboarding_checks(operator_id uuid,exchange_account_id uuid,check_key text,
      status text,evidence jsonb,created_by uuid,idempotency_key text,unique(exchange_account_id,idempotency_key));
    insert into coinops.operators values('${operator}','${user}','ACTIVE');
    insert into coinops.exchange_accounts(id,operator_id,display_name,status,kill_switch,is_legacy_default)
      select ('33333333-3333-4333-8333-'||lpad(n::text,12,'0'))::uuid,'${operator}',
        'Existing '||n,'ACTIVE',false,false from generate_series(1,4) n;
    insert into coinops.trading_engines(id,exchange_account_id,environment,status,kill_switch)
      select ('55555555-5555-4555-8555-'||lpad(n::text,12,'0'))::uuid,
        ('33333333-3333-4333-8333-'||lpad(least((n+1)/2,4)::text,12,'0'))::uuid,
        'REAL','ACTIVE',false from generate_series(1,7) n;
    grant select on coinops.operators to service_role;
    grant select,insert on coinops.exchange_accounts,coinops.account_onboarding_checks to service_role;`);
  psql(readFileSync(resolve("../../supabase/migrations/20260926180000_add_coinops_executor_capacity.sql"), "utf8"));
  psql(readFileSync(resolve("../../supabase/migrations/20260926192555_add_coinops_shard_assignment.sql"), "utf8"));
  psql(readFileSync(resolve("../../supabase/migrations/20260926194212_add_coinops_global_binance_identity.sql"), "utf8"));
  psql(readFileSync(resolve("../../supabase/migrations/20260926194558_protect_testnet_shard_capacity.sql"), "utf8"));
  psql(readFileSync(resolve("../../supabase/migrations/20260926202114_add_coinops_environment_capacity.sql"), "utf8"));
  psql(`insert into coinops.executor_shards(id,egress_ipv4) values('executor-02','192.0.2.2');
    insert into coinops.executor_capacity_samples(shard_id,observed_at,heartbeat_at,weight_observed_at,
      binance_weight_current,binance_weight_average,binance_weight_peak,binance_weight_samples,
      cpu_percent,ram_used_mb,ram_limit_mb,account_count,engine_count,registry_match)
    values('executor-01',now(),now(),now(),2200,2250,2400,3,5,147,961,4,7,true),
      ('executor-02',now(),now(),now(),2,3,4,3,1,90,961,0,0,true);`);
  baseline = psql(`select jsonb_build_object('accounts',(select jsonb_agg(to_jsonb(a) order by a.id)
    from coinops.exchange_accounts a where status='ACTIVE'),'engines',(select jsonb_agg(to_jsonb(e) order by e.id)
    from coinops.trading_engines e))`);
});
after(() => {
  if (available && existsSync(join(directory, "postmaster.pid")))
    execFileSync(join(bin, "pg_ctl.exe"), ["-D", directory, "-m", "fast", "-w", "stop"],
      { env, windowsHide: true, stdio: "pipe" });
});
const check = (name: string, fn: () => void | Promise<void>) => test(name,
  { skip: available ? false : "Local PostgreSQL unavailable" }, fn);

check("new account chooses healthy lowest-pressure shard before credentials or engines exist", () => {
  const assigned = decision(10);
  assert.equal(assigned.code, "ASSIGNED"); assert.equal(assigned.shardId, "executor-02");
  assert.equal(assigned.executorIp, "192.0.2.2"); assert.equal(assigned.capacityReserved, false);
  assert.equal(psql(`select status||':'||kill_switch::text||':'||onboarding_environment
    from coinops.exchange_accounts where id='${account(10)}'`), "INACTIVE:true:REAL");
  assert.equal(psql(`select count(*) from coinops.trading_engines where exchange_account_id='${account(10)}'`), "0");
});
check("parallel retry creates exactly one account, one audit and one immutable primary", async () => {
  const execute = promisify(execFile);
  const results = await Promise.all([1, 2].map(() => execute(join(bin, "psql.exe"), args(assign(11)),
    { env, windowsHide: true, encoding: "utf8" })));
  for (const result of results) assert.equal(JSON.parse(result.stdout).shardId, "executor-02");
  assert.equal(psql(`select count(*) from coinops.exchange_accounts where id='${account(11)}'`), "1");
  assert.equal(psql(`select count(*) from coinops.account_onboarding_checks where exchange_account_id='${account(11)}'`), "1");
});
check("direct shard reassignment and assigned-environment changes fail closed", () => {
  assert.throws(() => psql(`update coinops.exchange_accounts set executor_shard_id='executor-02' where id='${account(1)}'`),
    /COINOPS_SHARD_REASSIGNMENT_FORBIDDEN/);
  assert.throws(() => psql(`update coinops.exchange_accounts set executor_shard_id='executor-01' where id='${account(10)}'`),
    /COINOPS_SHARD_REASSIGNMENT_FORBIDDEN/);
  assert.throws(() => psql(`update coinops.exchange_accounts set onboarding_environment='TESTNET' where id='${account(10)}'`),
    /COINOPS_ADMIN_ENVIRONMENT_MISMATCH/);
  assert.throws(() => psql(assign(1)), /COINOPS_ADMIN_ACCOUNT_DENIED/);
});
check("capacity limits and stale telemetry deny admission without inserting an account", () => {
  psql("update coinops.executor_capacity_samples set binance_weight_peak=3200 where shard_id='executor-02'");
  assert.equal(decision(12).code, "CAPACITY_REQUIRED");
  assert.equal(psql(`select count(*) from coinops.exchange_accounts where id='${account(12)}'`), "0");
  psql("update coinops.executor_capacity_samples set heartbeat_at=now()-interval '3 minutes'");
  assert.equal(decision(13).code, "CAPACITY_UNKNOWN");
  assert.equal(decision(10).shardId, "executor-02");
  psql("update coinops.executor_capacity_samples set heartbeat_at=now(),binance_weight_peak=2400");
});
check("offline shard never migrates its assignment and foreign operator is denied", () => {
  psql("update coinops.executor_shards set enabled=false where id='executor-02'");
  assert.equal(decision(10).shardId, "executor-02");
  assert.throws(() => psql(assign(10, 2, user)), /COINOPS_ADMIN_OPERATOR_DENIED/);
  psql("update coinops.executor_shards set enabled=true where id='executor-02'");
});
check("RPC grants exclude anon and VIEWER/authenticated users", () => {
  assert.equal(psql(`select has_function_privilege('anon',
    'coinops.assign_executor_shard(uuid,uuid,text,text,integer,uuid)','EXECUTE')||':'||
    has_function_privilege('authenticated','coinops.assign_executor_shard(uuid,uuid,text,text,integer,uuid)','EXECUTE')`), "false:false");
  assert.equal(psql(`select has_function_privilege('service_role',
    'coinops.assign_executor_shard(uuid,uuid,text,text,integer,uuid)','EXECUTE')`), "t");
});
check("all existing four accounts and seven running engines remain exactly unchanged", () => {
  assert.equal(psql(`select jsonb_build_object('accounts',(select jsonb_agg(to_jsonb(a) order by a.id)
    from coinops.exchange_accounts a where status='ACTIVE'),'engines',(select jsonb_agg(to_jsonb(e) order by e.id)
    from coinops.trading_engines e))`), baseline);
});
check("offline, backlog, stale engine and resource alert codes stay shard-scoped", () => {
  psql(`insert into coinops.executor_capacity_alerts(shard_id,code,severity)
    select 'executor-02',code,'WARNING' from unnest(array['EXECUTOR_OFFLINE',
      'SCHEDULER_BACKLOG_WARNING','ENGINE_STALE','EXECUTOR_RESOURCE_WARNING']) code`);
  assert.equal(psql("select count(*) from coinops.executor_capacity_alerts where shard_id='executor-01'"), "0");
});

const identity = (index: number, hash = "a".repeat(64), environment = "REAL", op = operator) =>
  `select coinops.claim_binance_account_identity('${op}','${account(index)}','${environment}','${hash}')`;
check("physical Binance identity is global across shards, immutable and idempotent", () => {
  assert.equal(psql(identity(10)), "BOUND");
  assert.equal(psql(identity(10)), "BOUND");
  assert.equal(psql(identity(11)), "COINOPS_BINANCE_ACCOUNT_ALREADY_BOUND");
  assert.equal(psql(identity(10, "b".repeat(64))), "COINOPS_BINANCE_IDENTITY_CHANGED");
  assert.equal(psql(identity(10, "a".repeat(64), "TESTNET")), "COINOPS_ADMIN_ACCOUNT_DENIED");
  assert.equal(psql(identity(10, "a".repeat(64), "REAL", user)), "COINOPS_ADMIN_ACCOUNT_DENIED");
  assert.equal(psql(identity(10, "not-a-hash")), "COINOPS_BINANCE_IDENTITY_REQUIRED");
});
check("concurrent duplicate physical UID cannot bind two account UUIDs on distinct shards", async () => {
  assert.equal(decision(20, 1).shardId, "executor-01");
  assert.equal(psql(`select executor_shard_id from coinops.exchange_accounts where id='${account(11)}'`), "executor-02");
  const execute = promisify(execFile);
  const results = await Promise.all([11, 20].map((index) => execute(join(bin, "psql.exe"),
    args(identity(index, "c".repeat(64))), { env, windowsHide: true, encoding: "utf8" })));
  assert.deepEqual(results.map((result) => result.stdout.trim()).sort(),
    ["BOUND", "COINOPS_BINANCE_ACCOUNT_ALREADY_BOUND"].sort());
  assert.equal(psql(`select count(*) from coinops.binance_account_identity_bindings
    where identity_hash='${"c".repeat(64)}'`), "1");
});
check("identity writes are service-only and binding cannot be deleted or reassigned", () => {
  assert.equal(psql(`select has_table_privilege('authenticated','coinops.binance_account_identity_bindings','SELECT')
    ||':'||has_function_privilege('authenticated',
    'coinops.claim_binance_account_identity(uuid,uuid,text,text)','EXECUTE')`), "false:false");
  assert.equal(psql("set role service_role;" + identity(1, "d".repeat(64))).split("\n").at(-1), "BOUND");
  assert.throws(() => psql(`delete from coinops.binance_account_identity_bindings
    where exchange_account_id='${account(10)}'`), /COINOPS_BINANCE_IDENTITY_IMMUTABLE/);
  assert.throws(() => psql(`update coinops.binance_account_identity_bindings set identity_hash='${"e".repeat(64)}'
    where exchange_account_id='${account(10)}'`), /COINOPS_BINANCE_IDENTITY_IMMUTABLE/);
});
check("new Testnet assignment needs its own telemetry and its load never changes Production admission", () => {
  psql("update coinops.executor_capacity_samples set binance_weight_peak=1000 where shard_id='executor-02'");
  const assigned = JSON.parse(psql(assign(30, 1).replace("'REAL'", "'TESTNET'")));
  assert.equal(assigned.code, "CAPACITY_UNKNOWN");
  assert.equal(psql(`select count(*) from coinops.exchange_accounts where id='${account(30)}'`), "0");
  psql(`insert into coinops.exchange_accounts(id,operator_id,display_name,status,kill_switch,is_legacy_default,
      executor_shard_id,onboarding_environment)
    values('${account(30)}','${operator}','Fixture 30','ACTIVE',false,false,'executor-02','TESTNET');
    insert into coinops.trading_engines(id,exchange_account_id,environment,status,kill_switch)
    values('66666666-6666-4666-8666-666666666666','${account(30)}','TESTNET','ACTIVE',false);
    insert into coinops.executor_capacity_admissions(engine_id,shard_id,reserved_weight,expires_at)
    values('66666666-6666-4666-8666-666666666666','executor-02',9000,now()+interval '5 minutes');
    update coinops.executor_shards set enabled=false where id='executor-01';
    update coinops.executor_capacity_samples set binance_weight_peak=2400 where shard_id='executor-02'`);
  assert.equal(decision(31, 1).code, "ASSIGNED");
  assert.equal(psql(`select executor_shard_id from coinops.exchange_accounts where id='${account(31)}'`), "executor-02");
  assert.equal(JSON.parse(psql(assign(30, 1).replace("'REAL'", "'TESTNET'"))).shardId, "executor-02",
    "reading an existing assignment does not depend on new Testnet admission telemetry");
  psql("update coinops.executor_shards set enabled=true where id='executor-01'");
});

check("Testnet ASSIGN uses independent fresh telemetry, never a healthy Production fallback", () => {
  psql(`insert into coinops.executor_capacity_environment_samples(shard_id,environment,observed_at,heartbeat_at,
    weight_observed_at,binance_weight_current,binance_weight_average,binance_weight_peak,binance_weight_samples,
    cpu_percent,ram_used_mb,ram_limit_mb,account_count,engine_count,registry_match)
    values('executor-02','TESTNET',now(),now(),now(),20,25,30,3,5,147,961,0,0,true)`);
  assert.equal(JSON.parse(psql(assign(40, 1).replace("'REAL'", "'TESTNET'"))).shardId, "executor-02");
  psql("update coinops.executor_capacity_environment_samples set heartbeat_at=now()-interval '3 minutes'");
  assert.equal(JSON.parse(psql(assign(41, 1).replace("'REAL'", "'TESTNET'"))).code, "CAPACITY_UNKNOWN");
  assert.equal(psql(`select count(*) from coinops.exchange_accounts where id='${account(41)}'`), "0");
});
