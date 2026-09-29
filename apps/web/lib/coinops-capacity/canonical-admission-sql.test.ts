import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { DEFAULT_CAPACITY_POLICY } from "./capacity-manager.ts";

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
    create table coinops.operators(id uuid primary key, user_id uuid, status text);
    create table coinops.exchange_accounts(id uuid primary key, status text, executor_note text, operator_id uuid,
      display_name text,kill_switch boolean default true,is_legacy_default boolean default false,
      credential_ref text,executor_profile text,onboarding_environment text);
    create table coinops.trading_engines(id uuid primary key, exchange_account_id uuid references coinops.exchange_accounts(id),
      environment text, operator_id uuid, status text);
    create table coinops.operator_push_subscriptions(id uuid primary key);
    create table coinops.account_onboarding_checks(operator_id uuid,exchange_account_id uuid,check_key text,
      status text,evidence jsonb,created_by uuid,idempotency_key text);
    insert into coinops.operators values ('${account}','${account}','ACTIVE');
    insert into coinops.exchange_accounts(id,status,executor_note,operator_id) values ('${account}','ACTIVE','untouched','${account}');
    insert into coinops.trading_engines values ('${engine}','${account}','REAL','${account}','ACTIVE');`);
  execFileSync(join(bin, "psql.exe"), ["-X", "-w", "-h", "127.0.0.1", "-p", String(port),
    "-U", "capacity_audit", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
  { env, windowsHide: true, stdio: "pipe" });
  psql(readFileSync(resolve("../../supabase/migrations/20260926194558_protect_testnet_shard_capacity.sql"), "utf8"));
  psql(readFileSync(resolve("../../supabase/migrations/20260926202114_add_coinops_environment_capacity.sql"), "utf8"));
  psql(`create table coinops.watchdog_checks(shard_id text,checked_at timestamptz,
    blocked_engines int default 0,stale_engines int default 0,recovering_engines int default 0);
    grant select on coinops.watchdog_checks to service_role;`);
  psql(readFileSync(resolve("../../supabase/migrations/20260929212150_coinops_canonical_admission_policy.sql"), "utf8"));
});
after(() => {
  if (available && existsSync(join(directory, "postmaster.pid")))
    execFileSync(join(bin, "pg_ctl.exe"), ["-D", directory, "-m", "fast", "-w", "stop"],
      { env, windowsHide: true, stdio: "pipe" });
});
const check = (name: string, fn: () => void | Promise<void>) => test(name,
  { skip: available ? false : "Local PostgreSQL unavailable" }, fn);

const sha = "a".repeat(40), fingerprint = "b".repeat(64);
const preview = (shard = "executor-02", count = 1) => JSON.parse(psql(
  `select coinops.preview_executor_admission('${shard}','REAL',${count})`));
const change = (values: string, shard = "executor-02") => psql(
  `update coinops.executor_capacity_samples set ${values} where shard_id='${shard}'`);
const evidence = () => psql(`select coalesce(jsonb_agg(jsonb_build_object('shard_id',id,'ip',host(egress_ipv4),
  'status','PASS','config_status','PASS','actual_sha','${sha}','runtime_sha256','${fingerprint}',
  'node_version','v24.21.0','observed_at',now())),'[]') from coinops.executor_shards where enabled`);
const certify = (payload = evidence()) => psql(`select coinops.certify_executor_admission('${sha}','${fingerprint}',
  'v24.21.0','capacity-v2-20260929','${payload}'::jsonb)`);
const addSample = (shard: string, engines: number) => psql(`insert into coinops.executor_capacity_samples(
  shard_id,observed_at,heartbeat_at,weight_observed_at,binance_weight_current,binance_weight_average,
  binance_weight_peak,binance_weight_samples,cpu_percent,ram_used_mb,ram_limit_mb,account_count,engine_count,
  registry_match,executor_version) values('${shard}',now(),now(),now(),2200,2400,2500,15,5,153,961,${engines},${engines},true,'${sha}');
  insert into coinops.watchdog_checks(shard_id,checked_at) values('${shard}',now());`);

check("canonical policy preserves conservative reserve and new shard defaults", () => {
  const p = JSON.parse(psql("select coinops.executor_capacity_policy()"));
  assert.equal(p.admission_ratio+p.recovery_ratio,1);
  assert.equal(p.incremental_source,"CONSERVATIVE_UNCALIBRATED");
  assert.equal(p.binance_limit,DEFAULT_CAPACITY_POLICY.binanceLimitPerMinute);
  assert.equal(p.admission_ratio,DEFAULT_CAPACITY_POLICY.admissionRatio);
  assert.equal(p.observe_ratio,DEFAULT_CAPACITY_POLICY.observeRatio);
  assert.equal(p.warning_ratio,DEFAULT_CAPACITY_POLICY.warningRatio);
  assert.equal(p.capacity_ratio,DEFAULT_CAPACITY_POLICY.capacityRatio);
  assert.equal(p.cpu_max_percent,DEFAULT_CAPACITY_POLICY.cpuWarningPercent);
  assert.equal(p.ram_max_percent,DEFAULT_CAPACITY_POLICY.ramWarningPercent);
  assert.equal(p.telemetry_max_age_seconds*1000,DEFAULT_CAPACITY_POLICY.maxMetricAgeMs);
  assert.equal(p.reconciliation_max_ms,DEFAULT_CAPACITY_POLICY.reconciliationWarningMs);
  psql("insert into coinops.executor_shards(id,egress_ipv4) values('executor-02','192.0.2.2')");
  assert.equal(psql("select binance_limit_per_min||':'||admission_ratio||':'||incremental_engine_weight from coinops.executor_shards where id='executor-02'"),"6000:0.6500:900");
  assert.throws(()=>psql("update coinops.executor_shards set admission_ratio=.75 where id='executor-02'"),/POLICY_PARITY_REQUIRED/);
});
check("healthy samples alone cannot bypass runtime/config/Watchdog preflight", () => {
  addSample("executor-01",7); addSample("executor-02",6);
  assert.equal(preview().code,"CAPACITY_UNKNOWN");
  assert.throws(()=>certify("[]"),/FLEET_INCOMPLETE/);
  assert.equal(certify(),"ADMISSION_PREFLIGHT_PASS");
  assert.equal(preview().ready.ready,true);
});
check("six engines may admit seventh only at exactly measured conservative margin", () => {
  change("binance_weight_current=3000,binance_weight_average=2900,binance_weight_peak=3000");
  const yes=preview(); assert.equal(yes.code,"CAPACITY_OK");
  assert.equal(yes.projected_weight,3900); assert.equal(yes.recovery_headroom_weight,2100);
  assert.equal(yes.reserved_weight,0); assert.equal(yes.additional_engines,1);
  change("binance_weight_peak=3001");
  assert.equal(preview().code,"CAPACITY_REQUIRED");
  assert.equal(preview().projected_weight,3901);
});
check("observed executor02 six-engine incident is exact 89.97 percent, not an engine ceiling", () => {
  change("binance_weight_current=4034,binance_weight_average=3800,binance_weight_peak=4498");
  assert.equal(preview().projected_weight,5398);
  assert.equal(preview().projected_percent,89.97);
  assert.equal(preview("executor-02",2).projected_weight,6298);
  assert.equal(preview().reason,"PROJECTED_BINANCE_WEIGHT_ABOVE_ADMISSION_LIMIT");
});
check("existing executor01 seven engines stay intact and do not contaminate executor02", () => {
  change("binance_weight_current=4541,binance_weight_average=4000,binance_weight_peak=4903","executor-01");
  assert.equal(preview("executor-01").projected_weight,5803);
  change("binance_weight_current=2200,binance_weight_average=2400,binance_weight_peak=2500");
  assert.equal(preview().code,"CAPACITY_OK");
  assert.equal(psql(`select status||':'||executor_note from coinops.exchange_accounts where id='${account}'`),"ACTIVE:untouched");
  assert.equal(psql(`select status from coinops.trading_engines where id='${engine}'`),"ACTIVE");
});
check("transient peak holds admission, disappears with rolling evidence, sustained pressure stays blocked", () => {
  change("binance_weight_peak=4900");
  assert.equal(preview().pressure_phase,"TRANSIENT_SPIKE");
  assert.equal(preview().code,"CAPACITY_REQUIRED");
  change("binance_weight_peak=2800");
  assert.equal(preview().code,"CAPACITY_OK");
  change("binance_weight_current=4600,binance_weight_average=4600,binance_weight_peak=4900");
  assert.equal(preview().pressure_phase,"SUSTAINED_PRESSURE");
  assert.equal(preview().code,"CAPACITY_REQUIRED");
});
check("stale warning rows never latch admission and transport anomalies block new work", () => {
  change("binance_weight_current=2200,binance_weight_average=2400,binance_weight_peak=2500");
  psql("insert into coinops.executor_capacity_alerts(shard_id,code,severity) values('executor-02','CAPACITY_LIMIT','CRITICAL')");
  assert.equal(preview().code,"CAPACITY_OK");
  change("errors_last_5m=1"); assert.equal(preview().reason,"RECENT_TRANSPORT_ERRORS");
  change("errors_last_5m=0,cpu_percent=75"); assert.equal(preview().reason,"EXECUTOR_RESOURCE_HEADROOM_LOW");
  change("cpu_percent=5,scheduler_backlog=1"); assert.equal(preview().reason,"SCHEDULER_OR_RECONCILIATION_SLOW");
  change("scheduler_backlog=0,observed_at=now()-interval '3 minutes'"); assert.equal(preview().code,"CAPACITY_UNKNOWN");
  change("observed_at=now()");
});
check("runtime drift and shard-local Watchdog gaps fail closed without affecting sibling", () => {
  change("binance_weight_current=2200,binance_weight_average=2400,binance_weight_peak=2500","executor-01");
  change("executor_version='wrong'"); assert.equal(preview().reason,"RUNTIME_PARITY");
  assert.equal(preview("executor-01").code,"CAPACITY_OK");
  change(`executor_version='${sha}'`);
  psql("update coinops.watchdog_checks set checked_at=now()-interval '3 minutes' where shard_id='executor-02'");
  assert.equal(preview().reason,"WATCHDOG_DISCOVERY");
  psql("update coinops.watchdog_checks set checked_at=now() where shard_id='executor-02'");
});
check("executor03 inherits canonical policy but admits nothing before automatic certification", () => {
  psql("insert into coinops.executor_shards(id,egress_ipv4) values('executor-03','192.0.2.3')");
  addSample("executor-03",0); assert.equal(preview("executor-03").code,"CAPACITY_UNKNOWN");
  assert.equal(preview().code,"CAPACITY_OK");
  assert.equal(certify(),"ADMISSION_PREFLIGHT_PASS");
  assert.equal(preview("executor-03").code,"CAPACITY_OK");
});
check("actual serialized reservation is idempotent, single-headroom and RLS protected", () => {
  const reserve=()=>psql(`select coinops.reserve_executor_capacity('executor-01','${engine}')`);
  assert.equal(reserve(),"CAPACITY_OK"); assert.equal(reserve(),"CAPACITY_OK");
  assert.equal(psql(`select count(*) from coinops.executor_capacity_admissions where engine_id='${engine}'`),"1");
  assert.equal(preview("executor-01").reserved_weight,900);
  assert.equal(preview("executor-01").projected_weight,4300);
  assert.equal(preview("executor-02").reserved_weight,0);
  psql("update coinops.executor_capacity_admissions set expires_at=now()");
  assert.equal(preview("executor-01").projected_weight,3400);
  for(const name of ["executor_admission_release","executor_admission_attestations"])
    assert.equal(psql(`select has_table_privilege('authenticated','coinops.${name}','SELECT')||':'||relforcerowsecurity from pg_class where oid='coinops.${name}'::regclass`),"false:true");
  assert.equal(psql("select has_function_privilege('authenticated','coinops.certify_executor_admission(text,text,text,text,jsonb)','EXECUTE')"),"f");
});

check("ASSIGN shares the exact activation boundary and never activates the new account", () => {
  change("binance_weight_current=3100,binance_weight_average=3100,binance_weight_peak=3100","executor-01");
  change("binance_weight_current=3100,binance_weight_average=3100,binance_weight_peak=3100","executor-03");
  change("binance_weight_current=3000,binance_weight_average=2900,binance_weight_peak=3000");
  const id="33333333-3333-4333-8333-333333333333";
  const assign=()=>JSON.parse(psql(`select coinops.assign_executor_shard('${account}','${id}','Test local','REAL',1,'${id}')`));
  assert.equal(assign().shardId,"executor-02");
  assert.equal(assign().code,"ASSIGNED");
  assert.equal(psql(`select status||':'||kill_switch from coinops.exchange_accounts where id='${id}'`),"INACTIVE:true");
  assert.equal(psql(`select count(*) from coinops.account_onboarding_checks where exchange_account_id='${id}'`),"1");
  change("binance_weight_peak=3001");
  const other="44444444-4444-4444-8444-444444444444";
  assert.equal(JSON.parse(psql(`select coinops.assign_executor_shard('${account}','${other}','Blocked local','REAL',1,'${other}')`)).code,"CAPACITY_REQUIRED");
  assert.equal(psql(`select count(*) from coinops.exchange_accounts where id='${other}'`),"0");
});

check("TESTNET uses its own measured weight and cannot borrow Production margin", () => {
  psql(`insert into coinops.executor_capacity_environment_samples select s.*,'TESTNET','LEDGER_CREDENTIAL_BOUND_TRANSPORT'
    from coinops.executor_capacity_samples s where shard_id='executor-02';
    update coinops.executor_capacity_environment_samples set binance_weight_current=1000,binance_weight_average=1100,binance_weight_peak=1200`);
  const result=JSON.parse(psql("select coinops.preview_executor_admission('executor-02','TESTNET',1)"));
  assert.equal(result.code,"CAPACITY_OK"); assert.equal(result.projected_weight,2100);
  assert.equal(preview().code,"CAPACITY_REQUIRED");
  psql("update coinops.executor_capacity_environment_samples set weight_observed_at=now()-interval '3 minutes'");
  assert.equal(JSON.parse(psql("select coinops.preview_executor_admission('executor-02','TESTNET',1)")).code,"CAPACITY_UNKNOWN");
});

check("two concurrent reservations cannot spend the same remaining engine headroom", async () => {
  change("binance_weight_current=2900,binance_weight_average=2900,binance_weight_peak=2900","executor-01");
  const second="55555555-5555-4555-8555-555555555555";
  psql(`insert into coinops.trading_engines values('${second}','${account}','REAL','${account}','INACTIVE')`);
  const reserve=(id:string)=>new Promise<string>((resolveResult,reject)=>execFile(join(bin,"psql.exe"),
    ["-X","-w","-h","127.0.0.1","-p",String(port),"-U","capacity_audit","-d","postgres",
      "-v","ON_ERROR_STOP=1","-At","-c",`select coinops.reserve_executor_capacity('executor-01','${id}')`],
    {env,windowsHide:true,encoding:"utf8"},(error,out)=>error?reject(error):resolveResult(out.trim())));
  assert.deepEqual((await Promise.all([reserve(engine),reserve(second)])).sort(),["CAPACITY_OK","CAPACITY_REQUIRED"]);
  assert.equal(psql("select count(*) from coinops.executor_capacity_admissions where expires_at>now()"),"1");
});
