import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

// Disposable loopback PostgreSQL. No Supabase URL, exchange credential or LIVE order.
const bin = process.env.COINOPS_AUDIT_PG_BIN ?? "C:/Program Files/PostgreSQL/17/bin";
const available = existsSync(join(bin, "initdb.exe"));
const directory = available ? mkdtempSync(join(tmpdir(), "coinops-capacity-")) : "";
let port = 0;
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG"))),
  NODE_ENV: process.env.NODE_ENV ?? "test",
  PGHOST: "127.0.0.1", PGPORT: "", PGUSER: "capacity_audit", PGDATABASE: "postgres",
  PGPASSFILE: join(directory, "no-credentials") };
const psql = (query: string) => execFileSync(join(bin, "psql.exe"),
  ["-X", "-w", "-h", "127.0.0.1", "-p", String(port), "-U", "capacity_audit", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-At", "-c", query],
  { env, windowsHide: true, encoding: "utf8", stdio: "pipe" }).replace(/\r/g, "").trim();
const account = "11111111-1111-4111-8111-111111111111";
const engine = "22222222-2222-4222-8222-222222222222";
const sql = readFileSync(resolve("../../supabase/migrations/20260926180000_add_coinops_executor_capacity.sql"), "utf8");

before(async () => {
  if (!available) return;
  const reservation = createServer();
  await new Promise<void>((resolvePort, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolvePort);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("LOCAL_PG_PORT_UNAVAILABLE");
  port = address.port; env.PGPORT = String(port);
  await new Promise<void>((done, reject) => reservation.close((error) => error ? reject(error) : done()));
  execFileSync(join(bin, "initdb.exe"), ["-D", directory, "-U", "capacity_audit", "-A", "trust",
    "--no-locale", "-E", "UTF8"], { env, windowsHide: true, stdio: "pipe" });
  execFileSync(join(bin, "pg_ctl.exe"), ["-D", directory, "-l", join(directory, "server.log"),
    "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"], { env, windowsHide: true, stdio: "ignore" });
  psql(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema coinops; create schema private; grant usage on schema coinops to service_role;
    create table coinops.exchange_accounts(id uuid primary key, status text, executor_note text);
    create table coinops.trading_engines(id uuid primary key, exchange_account_id uuid references coinops.exchange_accounts(id), environment text);
    create table coinops.operator_push_subscriptions(id uuid primary key);
    insert into coinops.exchange_accounts values ('${account}','ACTIVE','untouched');
    insert into coinops.trading_engines values ('${engine}','${account}','REAL');`);
  execFileSync(join(bin, "psql.exe"), ["-X", "-w", "-h", "127.0.0.1", "-p", String(port),
    "-U", "capacity_audit", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
  { env, windowsHide: true, stdio: "pipe" });
});
after(() => {
  if (available && existsSync(join(directory, "postmaster.pid")))
    execFileSync(join(bin, "pg_ctl.exe"), ["-D", directory, "-m", "fast", "-w", "stop"],
      { env, windowsHide: true, stdio: "pipe" });
});
const check = (name: string, fn: () => void) => test(name,
  { skip: available ? false : "Local PostgreSQL unavailable" }, fn);

check("capacity migration preserves existing account/engine and assigns one fixed-IP shard", () => {
  assert.equal(psql(`select executor_shard_id||':'||status||':'||executor_note
    from coinops.exchange_accounts where id='${account}'`), "executor-01:ACTIVE:untouched");
  assert.equal(psql(`select count(*) from coinops.trading_engines where id='${engine}' and environment='REAL'`), "1");
  assert.equal(psql("select egress_ipv4 from coinops.executor_shards where id='executor-01'"), "46.101.104.48");
});
check("admission fails closed without telemetry and allows fresh healthy measured headroom", () => {
  assert.equal(psql(`select coinops.reserve_executor_capacity('executor-01','${engine}')`), "CAPACITY_UNKNOWN");
  psql(`insert into coinops.executor_capacity_samples(shard_id,observed_at,heartbeat_at,weight_observed_at,
    binance_weight_current,binance_weight_average,binance_weight_peak,binance_weight_samples,
    cpu_percent,ram_used_mb,ram_limit_mb,account_count,engine_count,registry_match)
    values('executor-01',now(),now(),now(),2200,2250,2400,3,5,147,961,1,1,true)`);
  assert.equal(psql(`select coinops.reserve_executor_capacity('executor-01','${engine}')`), "CAPACITY_OK");
  assert.equal(psql(`select count(*) from coinops.executor_capacity_admissions where engine_id='${engine}'`), "1");
});
check("projected Binance pressure, stale heartbeat and missing CPU each block new admission", () => {
  psql("update coinops.executor_capacity_samples set binance_weight_peak=3400");
  assert.equal(psql(`select coinops.reserve_executor_capacity('executor-01','${engine}')`), "CAPACITY_REQUIRED");
  psql("update coinops.executor_capacity_samples set binance_weight_peak=2400,heartbeat_at=now()-interval '3 minutes'");
  assert.equal(psql(`select coinops.reserve_executor_capacity('executor-01','${engine}')`), "CAPACITY_UNKNOWN");
  psql("update coinops.executor_capacity_samples set heartbeat_at=now(),cpu_percent=null");
  assert.equal(psql(`select coinops.reserve_executor_capacity('executor-01','${engine}')`), "CAPACITY_UNKNOWN");
});
check("RLS and grants deny authenticated clients capacity writes and reservations", () => {
  const grants = psql(`select has_table_privilege('authenticated','coinops.executor_capacity_samples','INSERT')
    || ':' || has_function_privilege('authenticated','coinops.reserve_executor_capacity(text,uuid)','EXECUTE')`);
  assert.equal(grants, "false:false");
  assert.equal(psql("select relforcerowsecurity from pg_class where oid='coinops.executor_capacity_samples'::regclass"), "t");
});
check("resolved capacity incident reopens with a fresh fingerprint, while repeat observations do not", () => {
  const first = psql(`insert into coinops.executor_capacity_alerts(shard_id,code,severity)
    values('executor-01','BINANCE_WEIGHT_WARNING','WARNING') returning first_seen_at`)
    .split("\n")[0];
  psql(`update coinops.executor_capacity_alerts set last_seen_at=now()
    where shard_id='executor-01' and code='BINANCE_WEIGHT_WARNING'`);
  assert.equal(psql(`select first_seen_at from coinops.executor_capacity_alerts
    where shard_id='executor-01' and code='BINANCE_WEIGHT_WARNING'`), first);
  psql(`update coinops.executor_capacity_alerts set resolved_at=now()
    where shard_id='executor-01' and code='BINANCE_WEIGHT_WARNING'`);
  psql("select pg_sleep(0.02)");
  psql(`update coinops.executor_capacity_alerts set resolved_at=null
    where shard_id='executor-01' and code='BINANCE_WEIGHT_WARNING'`);
  assert.notEqual(psql(`select first_seen_at from coinops.executor_capacity_alerts
    where shard_id='executor-01' and code='BINANCE_WEIGHT_WARNING'`), first);
});
