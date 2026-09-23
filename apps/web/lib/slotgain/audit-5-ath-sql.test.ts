import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Disposable, loopback-only PostgreSQL. No Supabase config, .env or credentials.
const bin = process.env.COINOPS_AUDIT_PG_BIN ?? "C:/Program Files/PostgreSQL/17/bin";
const available = existsSync(join(bin, "initdb.exe"));
const directory = available ? mkdtempSync(join(tmpdir(), "coinops-audit-ath-")) : "";
const port = 55443;
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG"))), NODE_ENV: process.env.NODE_ENV,
  PGHOST: "127.0.0.1", PGPORT: String(port), PGUSER: "audit_owner", PGDATABASE: "postgres", PGPASSFILE: join(directory, "no-credentials") };
const args = ["-X", "-w", "-h", "127.0.0.1", "-p", String(port), "-U", "audit_owner", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"];
const sql = (query: string) => execFileSync(join(bin, "psql.exe"), [...args, "-c", query], { env, encoding: "utf8", windowsHide: true, stdio: "pipe" }).trim();
before(() => {
  if (!available) return;
  execFileSync(join(bin, "initdb.exe"), ["-D", directory, "-U", "audit_owner", "-A", "trust", "--no-locale", "-E", "UTF8"], { env, windowsHide: true, stdio: "pipe" });
  execFileSync(join(bin, "pg_ctl.exe"), ["-D", directory, "-l", join(directory, "server.log"), "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"], { env, windowsHide: true, stdio: "ignore" });
  sql(`create schema coinops; create role anon; create role authenticated; create role service_role;
    create table coinops.robot_v1_ath_profiles(id uuid default gen_random_uuid(),product_id uuid,tenant_id uuid,user_id uuid,
      environment text,asset text,config_version int default 1,next_config_version int,next_gain_rate numeric,
      next_normal_spacing_rate numeric,next_post_ath_spacing_rate numeric,ath_floor_reference numeric);
    create table coinops.robot_v1_ath_events(profile_id uuid,product_id uuid,tenant_id uuid,user_id uuid,environment text,asset text,
      event_key text,event_type text,details jsonb,observed_at timestamptz,unique(profile_id,event_key));
    insert into coinops.robot_v1_ath_profiles(environment,asset) values('REAL','BTC'),('REAL','SOL'),('TESTNET','SOL');`);
  execFileSync(join(bin, "psql.exe"), [...args, "-f", resolve("../../supabase/migrations/20260923231736_make_robot_v1_ath_config_audit_atomic.sql")], { env, windowsHide: true, stdio: "pipe" });
});
after(() => {
  if (available && existsSync(join(directory, "postmaster.pid"))) execFileSync(join(bin, "pg_ctl.exe"), ["-D", directory, "-m", "fast", "-w", "stop"], { env, windowsHide: true, stdio: "ignore" });
});
const check = (name: string, fn: () => void) => test(name, { skip: !available }, fn);
const save = `update coinops.robot_v1_ath_profiles set next_config_version=2,next_gain_rate=.012,next_normal_spacing_rate=.01,next_post_ath_spacing_rate=.05 where environment='REAL' and asset='BTC';`;
check("SQL ATH: preparation supports future percentages without enabling trading and isolates other profiles", () => {
  assert.equal(sql(`begin; ${save}
    update coinops.robot_v1_ath_profiles set next_config_version=2,next_gain_rate=.055,next_normal_spacing_rate=.015,next_post_ath_spacing_rate=.08 where environment='REAL' and asset='SOL';
    select count(*)=2 and bool_and((asset='BTC' and details->>'gain_rate'='0.012' and details->>'normal_spacing_rate'='0.01') or (asset='SOL' and details->>'gain_rate'='0.055' and details->>'normal_spacing_rate'='0.015')) from coinops.robot_v1_ath_events;
    select next_config_version is null from coinops.robot_v1_ath_profiles where environment='TESTNET'; rollback;`).split(/\r?\n/).filter((line) => line === "t").length, 2);
});
check("SQL ATH: identical retry creates no duplicate; activating pending config creates no save event", () => {
  assert.ok(sql(`begin; ${save} ${save}
    update coinops.robot_v1_ath_profiles set config_version=2,next_config_version=null,next_gain_rate=null,next_normal_spacing_rate=null,next_post_ath_spacing_rate=null where environment='REAL' and asset='BTC';
    select count(*)=1 from coinops.robot_v1_ath_events; rollback;`).split(/\r?\n/).includes("t"));
});
check("SQL ATH: crash rolls back both config and evidence; forbidden event insert rolls back config", () => {
  assert.throws(() => sql(`begin; ${save} select 1/0; commit;`));
  assert.equal(sql("select count(*) from coinops.robot_v1_ath_events"), "0");
  assert.equal(sql("select count(*) from coinops.robot_v1_ath_profiles where next_config_version is not null"), "0");
  assert.throws(() => sql(`begin;
    insert into coinops.robot_v1_ath_events(profile_id,event_key) select id,'STRATEGY_CONFIG_SAVED:2' from coinops.robot_v1_ath_profiles where environment='REAL' and asset='BTC';
    ${save} commit;`), /duplicate key/);
  assert.equal(sql("select count(*) from coinops.robot_v1_ath_profiles where next_config_version is not null"), "0");
});
check("SQL ATH: same-version payload mutation is rejected instead of rewriting audited config", () => {
  assert.throws(() => sql(`begin; ${save} update coinops.robot_v1_ath_profiles set next_gain_rate=.02 where environment='REAL' and asset='BTC'; rollback;`), /CONFIG_VERSION_OR_SCOPE_INVALID/);
});
