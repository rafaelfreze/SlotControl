import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

// Real disposable loopback PostgreSQL only. No linked Supabase or external credentials.
const bin = process.env.COINOPS_AUDIT_PG_BIN ?? "C:/Program Files/PostgreSQL/17/bin";
const available = existsSync(join(bin, "initdb.exe"));
const directory = available ? mkdtempSync(join(tmpdir(), "coinops-asset-health-")) : "";
const migration = readFileSync(resolve("../../supabase/migrations/20260927110357_add_coinops_asset_health.sql"), "utf8");
const tables = ["collector_state", "snapshots", "current", "events", "deliveries"].map((name) => `asset_health_${name}`);
let port = 0;
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG"))),
  NODE_ENV: process.env.NODE_ENV ?? "test", PGHOST: "127.0.0.1", PGPORT: "",
  PGUSER: "asset_health_audit", PGDATABASE: "postgres", PGPASSFILE: join(directory, "no-credentials")
};
const args = (query: string) => ["-X", "-w", "-h", "127.0.0.1", "-p", String(port), "-U", "asset_health_audit",
  "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-c", query];
const psql = (query: string) => execFileSync(join(bin, "psql.exe"), args(query),
  { env, windowsHide: true, encoding: "utf8", stdio: "pipe" }).replace(/\r/g, "").trim();
const concurrentSql = async (query: string) => (await promisify(execFile)(join(bin, "psql.exe"), args(query),
  { env, windowsHide: true, encoding: "utf8" })).stdout.replace(/\r/g, "").trim();
const token = "11111111-1111-4111-8111-111111111111";
const otherToken = "22222222-2222-4222-8222-222222222222";
const subscription = "33333333-3333-4333-8333-333333333333";
const json = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const assessment = (asset: string, status = "HEALTHY", minutesAgo = 2, metrics: unknown[] = []) => ({
  asset, status, evaluatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  metrics, reasons: ["Public source evidence"], trigger: "scheduled", previousStatus: null
});
const finish = (snapshots: unknown[], cadences: object = {}, claimToken = token) =>
  `select coinops.asset_health_finish('${claimToken}',${json(snapshots)},${json(cadences)},25)`;
const reset = () => psql(`truncate coinops.asset_health_deliveries,coinops.asset_health_events,
  coinops.asset_health_current,coinops.asset_health_snapshots;
  update coinops.asset_health_collector_state set last_run_at=null,last_success_at=null,status='NOT_RUN',
    lease_token=null,lease_until=null,source_failures=0,cadence_completed_at='{}',last_error_code=null;`);
const claim = () => {
  psql("update coinops.asset_health_collector_state set last_run_at=now()-interval '21 minutes'");
  assert.equal(psql(`set role service_role; select coinops.asset_health_claim('${token}')`).split("\n").at(-1), "t");
};
const check = (name: string, fn: () => void | Promise<void>) => test(name,
  { skip: available ? false : "Local PostgreSQL unavailable; SQL not proven" }, fn);

before(async () => {
  if (!available) return;
  const reservation = createServer();
  await new Promise<void>((done, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", done); });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("LOCAL_PG_PORT_UNAVAILABLE");
  port = address.port; env.PGPORT = String(port);
  await new Promise<void>((done, reject) => reservation.close((error) => error ? reject(error) : done()));
  execFileSync(join(bin, "initdb.exe"), ["-D", directory, "-U", "asset_health_audit", "-A", "trust", "--no-locale", "-E", "UTF8"],
    { env, windowsHide: true, stdio: "pipe" });
  execFileSync(join(bin, "pg_ctl.exe"), ["-D", directory, "-l", join(directory, "server.log"),
    "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"], { env, windowsHide: true, stdio: "ignore" });
  psql(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema coinops; grant usage on schema coinops to anon,authenticated,service_role;
    create table coinops.operator_push_subscriptions(id uuid primary key);
    insert into coinops.operator_push_subscriptions values('${subscription}');
    create table coinops.trading_engines(id text primary key,status text);
    insert into coinops.trading_engines values('untouched','ACTIVE');`);
  psql(migration);
});
after(() => {
  if (available && existsSync(join(directory, "postmaster.pid")))
    execFileSync(join(bin, "pg_ctl.exe"), ["-D", directory, "-m", "fast", "-w", "stop"],
      { env, windowsHide: true, stdio: "pipe" });
});

test("migration is additive, isolated from trading, and server-only", () => {
  assert.doesNotMatch(migration, /coinops\.(?:trading_engines|exchange_accounts|robot_v1|live_|strategy_|executor_capacity)/i);
  assert.doesNotMatch(migration, /security\s+definer|drop\s+(?:table|column)|truncate/i);
  for (const table of tables) {
    assert.match(migration, new RegExp(`alter table coinops\\.${table} enable row level security`, "i"));
    assert.match(migration, new RegExp(`alter table coinops\\.${table} force row level security`, "i"));
  }
});

check("all asset-health tables/RPCs deny anon and authenticated; server history is append-only", () => {
  for (const role of ["anon", "authenticated"]) {
    for (const table of tables) for (const permission of ["SELECT", "INSERT", "UPDATE", "DELETE"])
      assert.equal(psql(`select has_table_privilege('${role}','coinops.${table}','${permission}')`), "f");
    for (const signature of ["asset_health_claim(uuid)", "asset_health_finish(uuid,jsonb,jsonb,integer)", "asset_health_fail(uuid,text,integer)"])
      assert.equal(psql(`select has_function_privilege('${role}','coinops.${signature}','EXECUTE')`), "f");
  }
  assert.equal(psql("select count(*) from pg_class where relnamespace='coinops'::regnamespace and relname like 'asset_health_%' and relkind='r' and relrowsecurity and relforcerowsecurity"), "5");
  assert.throws(() => psql("set role authenticated; select * from coinops.asset_health_current"), /permission denied/);
  assert.equal(psql("select has_table_privilege('service_role','coinops.asset_health_snapshots','UPDATE')"), "f");
  assert.equal(psql("select has_table_privilege('service_role','coinops.asset_health_events','DELETE')"), "f");
});

check("simultaneous collectors acquire exactly one lease and obey 20-minute request spacing", async () => {
  reset();
  const results = await Promise.all([token, otherToken].map((value) =>
    concurrentSql(`set role service_role; select coinops.asset_health_claim('${value}')`)));
  assert.deepEqual(results.map((value) => value.split("\n").at(-1)).sort(), ["f", "t"]);
  psql("update coinops.asset_health_collector_state set lease_until=now()-interval '1 second'");
  assert.equal(psql(`select coinops.asset_health_claim('${otherToken}')`), "f", "expired lease does not bypass spacing");
  psql("update coinops.asset_health_collector_state set last_run_at=now()-interval '21 minutes'");
  assert.equal(psql(`select coinops.asset_health_claim('${otherToken}')`), "t");
  assert.equal(psql("select round(extract(epoch from lease_until-last_run_at)) from coinops.asset_health_collector_state"), "300");
});

check("wrong/expired/displaced collector cannot publish or mark another collector failed", () => {
  reset(); claim();
  assert.equal(psql(finish([assessment("BTC")], {}, otherToken)), "f");
  assert.equal(psql(`select coinops.asset_health_fail('${otherToken}','IGNORED')`), "f");
  psql("update coinops.asset_health_collector_state set lease_until=now()-interval '1 second'");
  assert.equal(psql(finish([assessment("BTC")])), "f");
  assert.equal(psql(`select coinops.asset_health_fail('${token}','IGNORED')`), "f");
  assert.equal(psql("select count(*) from coinops.asset_health_snapshots"), "0");
  psql("update coinops.asset_health_collector_state set last_run_at=now()-interval '21 minutes'");
  assert.equal(psql(`select coinops.asset_health_claim('${otherToken}')`), "t");
  assert.equal(psql(finish([assessment("BTC")])), "f");
  assert.equal(psql("select lease_token from coinops.asset_health_collector_state"), otherToken);
});

check("bootstrap/same status do not notify; transitions are audited once and history cannot mutate", () => {
  reset(); claim();
  assert.equal(psql(`set role service_role; ${finish([assessment("BTC"), assessment("SOL")])}`).split("\n").at(-1), "t");
  assert.equal(psql("select count(*) from coinops.asset_health_events"), "0");
  assert.equal(psql(finish([assessment("BTC")])), "f", "same finish cannot replay");
  claim(); assert.equal(psql(finish([assessment("BTC", "HEALTHY", 1)])), "t");
  assert.equal(psql("select count(*) from coinops.asset_health_events"), "0");
  claim(); assert.equal(psql(finish([assessment("BTC", "ATTENTION", 0)])), "t");
  assert.equal(psql("select status_before||':'||status_after||':'||jsonb_array_length(reasons) from coinops.asset_health_events"), "HEALTHY:ATTENTION:1");
  assert.equal(psql("select count(*) from coinops.asset_health_snapshots"), "4");
  assert.equal(psql("select assessment->>'status' from coinops.asset_health_current where asset='SOL'"), "HEALTHY");
  assert.throws(() => psql("update coinops.asset_health_snapshots set status='HEALTHY'"), /ASSET_HEALTH_HISTORY_IMMUTABLE/);
  assert.throws(() => psql("delete from coinops.asset_health_events"), /ASSET_HEALTH_HISTORY_IMMUTABLE/);
});

check("invalid mixed-asset batch rolls back snapshots, current, events and cadence together", () => {
  reset(); claim();
  assert.throws(() => psql(finish([assessment("BTC"), assessment("SOL", "INVALID")], { FAST: new Date().toISOString() })), /ASSET_HEALTH_INVALID_ASSESSMENT/);
  assert.equal(psql("select (select count(*) from coinops.asset_health_snapshots)||':'||(select count(*) from coinops.asset_health_current)||':'||status||':'||cadence_completed_at from coinops.asset_health_collector_state"), "0:0:RUNNING:{}");
  assert.throws(() => psql(finish([assessment("BTC"), assessment("BTC")])), /ASSET_HEALTH_DUPLICATE_ASSET/);
  assert.throws(() => psql(finish([assessment("ETH")])), /ASSET_HEALTH_INVALID_ASSESSMENT/);
});

check("partial public source failure produces DEGRADED, merges cadences, preserves other asset and trading", () => {
  reset(); claim();
  const structural = new Date(Date.now() - 60_000).toISOString();
  assert.equal(psql(finish([assessment("BTC"), assessment("SOL")], { STRUCTURAL: structural })), "t");
  claim();
  const fast = new Date().toISOString();
  assert.equal(psql(finish([assessment("SOL", "INSUFFICIENT_DATA", 0, [
    { status: "SOURCE_UNAVAILABLE", source: { id: "solana-rpc" } },
    { status: "DATA_STALE", source: { id: "solana-rpc" } },
    { status: "SOURCE_UNAVAILABLE", optional: true, source: { id: "client-diversity-unsupported" } }
  ])], { FAST: fast })), "t");
  assert.equal(psql("select status||':'||source_failures||':'||(last_success_at is not null) from coinops.asset_health_collector_state"), "DEGRADED:1:true");
  assert.equal(psql("select cadence_completed_at->>'STRUCTURAL' from coinops.asset_health_collector_state"), structural);
  assert.equal(psql("select cadence_completed_at->>'FAST' from coinops.asset_health_collector_state"), fast);
  assert.equal(psql("select assessment->>'status' from coinops.asset_health_current where asset='BTC'"), "HEALTHY");
  assert.equal(psql("select status from coinops.trading_engines where id='untouched'"), "ACTIVE");
});

check("failure is fenced, error is sanitized, and last successful snapshot survives", () => {
  reset(); claim(); assert.equal(psql(finish([assessment("BTC")])), "t");
  const snapshotId = psql("select snapshot_id from coinops.asset_health_current");
  claim();
  assert.equal(psql(`select coinops.asset_health_fail('${token}','Bearer private-value')`), "t");
  assert.equal(psql("select status||':'||last_error_code||':'||(last_success_at is not null) from coinops.asset_health_collector_state"), "FAILED:ASSET_HEALTH_COLLECTION_FAILED:true");
  assert.equal(psql("select snapshot_id from coinops.asset_health_current"), snapshotId);
  assert.equal(psql(`select coinops.asset_health_fail('${token}','DUPLICATE')`), "f");
});

check("stale observation and cadence cannot overwrite newer completed evidence", () => {
  reset(); claim();
  assert.equal(psql(finish([assessment("BTC", "HEALTHY", 0)], { FAST: new Date().toISOString() })), "t");
  claim();
  assert.throws(() => psql(finish([assessment("BTC", "ATTENTION", 5)])), /ASSET_HEALTH_OBSERVATION_NOT_NEWER/);
  assert.throws(() => psql(finish([assessment("SOL")], { FAST: new Date(Date.now() - 60_000).toISOString() })), /ASSET_HEALTH_INVALID_CADENCE/);
  assert.throws(() => psql(finish([assessment("SOL")], { UNKNOWN: new Date().toISOString() })), /ASSET_HEALTH_INVALID_CADENCE/);
  assert.equal(psql("select count(*) from coinops.asset_health_snapshots"), "1");
});

check("delivery unique event/device and conditional lease prevent concurrent duplicate sends", async () => {
  reset(); claim(); assert.equal(psql(finish([assessment("BTC")])), "t");
  claim(); assert.equal(psql(finish([assessment("BTC", "ATTENTION", 0)])), "t");
  const eventId = psql("select id from coinops.asset_health_events");
  psql(`set role service_role; insert into coinops.asset_health_deliveries(event_id,subscription_id) values('${eventId}','${subscription}')`);
  assert.throws(() => psql(`insert into coinops.asset_health_deliveries(event_id,subscription_id) values('${eventId}','${subscription}')`), /duplicate key/);
  const leases = await Promise.all([token, otherToken].map((value) => concurrentSql(`set role service_role;
    update coinops.asset_health_deliveries set status='SENDING',lease_token='${value}',lease_until=now()+interval '1 minute',attempt_count=attempt_count+1
    where event_id='${eventId}' and status='PENDING' and (lease_until is null or lease_until<now()) returning id`)));
  assert.equal(leases.filter((value) => value.includes("UPDATE 1")).length, 1);
  assert.equal(psql("select attempt_count from coinops.asset_health_deliveries"), "1");
  const owner = psql("select lease_token from coinops.asset_health_deliveries");
  const nonOwner = owner === token ? otherToken : token;
  assert.equal(psql(`update coinops.asset_health_deliveries set status='SENT',sent_at=now() where lease_token='${nonOwner}' and lease_until>now()`), "UPDATE 0");
  assert.equal(psql(`update coinops.asset_health_deliveries set status='SENT',sent_at=now() where lease_token='${owner}' and lease_until>now()`), "UPDATE 1");
});
