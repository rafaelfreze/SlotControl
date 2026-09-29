import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Disposable loopback-only PostgreSQL. It never reads Supabase or application
// credentials and cannot reach Production.
const bin = process.env.COINOPS_AUDIT_PG_BIN ?? "C:/Program Files/PostgreSQL/17/bin";
const available = existsSync(join(bin, "initdb.exe"));
const directory = available ? mkdtempSync(join(tmpdir(), "coinops-bulk-strategy-")) : "";
// Each Node test worker receives its own loopback port so parallel or resumed
// validation cannot collide with another disposable cluster.
const port = 49152 + (process.pid % 10_000);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG"))),
  NODE_ENV: process.env.NODE_ENV ?? "test",
  PGHOST: "127.0.0.1",
  PGPORT: String(port),
  PGUSER: "bulk_strategy_owner",
  PGDATABASE: "postgres",
  PGPASSFILE: join(directory, "no-credentials"),
};
const args = ["-X", "-w", "-h", "127.0.0.1", "-p", String(port),
  "-U", "bulk_strategy_owner", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"];
const psql = (query: string) => execFileSync(join(bin, "psql.exe"), [...args, "-c", query], {
  env, encoding: "utf8", windowsHide: true, stdio: "pipe",
}).replace(/\r/g, "").trim();
const runFile = (path: string) => execFileSync(join(bin, "psql.exe"), [...args, "-f", path], {
  env, encoding: "utf8", windowsHide: true, stdio: "pipe",
}).replace(/\r/g, "").trim();
const fixture = (name: string) => resolve("lib/execution/fixtures", name);

before(() => {
  if (!available) return;
  execFileSync(join(bin, "initdb.exe"), ["-D", directory, "-U", "bulk_strategy_owner",
    "-A", "trust", "--no-locale", "-E", "UTF8"], { env, windowsHide: true, stdio: "pipe" });
  execFileSync(join(bin, "pg_ctl.exe"), ["-D", directory, "-l", join(directory, "server.log"),
    "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"], { env, windowsHide: true, stdio: "ignore" });
  runFile(fixture("bulk-strategy-migration-setup.sql"));
  runFile(resolve("../../supabase/migrations/20260929105000_add_coinops_bulk_strategy_updates.sql"));
});

after(() => {
  if (available && existsSync(join(directory, "postmaster.pid"))) execFileSync(join(bin, "pg_ctl.exe"),
    ["-D", directory, "-m", "fast", "-w", "stop"], { env, windowsHide: true, stdio: "ignore" });
});

const check = (name: string, fn: () => void) => test(name, { skip: !available }, fn);

check("bulk SQL: RLS, grants and BUY gate remain service-scoped", () => {
  assert.equal(psql(`select count(*) from pg_class where oid in
    ('coinops.strategy_bulk_batches'::regclass,'coinops.strategy_bulk_engine_updates'::regclass)
    and relrowsecurity and relforcerowsecurity`), "2");
  assert.equal(psql("select has_table_privilege('anon','coinops.strategy_bulk_batches','SELECT')"), "f");
  assert.equal(psql("select has_function_privilege('authenticated','coinops.admit_strategy_bulk_next(uuid,uuid)','EXECUTE')"), "f");
  assert.equal(psql("select has_function_privilege('service_role','coinops.admit_strategy_bulk_next(uuid,uuid)','EXECUTE')"), "t");
  assert.equal(psql("select count(*) from pg_trigger where tgrelid='coinops.robot_v1_live_orders'::regclass and tgname='coinops_strategy_buy_gate' and not tgisinternal"), "1");
});

check("bulk SQL: idempotency, engine isolation, TP continuity and batch result", () => {
  runFile(fixture("bulk-strategy-migration-behavior.sql"));
  assert.equal(psql("select count(*) from coinops.strategy_bulk_batches"), "2");
  assert.equal(psql("select count(*) from coinops.strategy_bulk_batches where status='APPLIED'"), "1");
  assert.equal(psql("select count(*) from coinops.strategy_bulk_batches where status='PARTIAL'"), "1");
  assert.equal(psql("select count(*) from coinops.trading_engines where strategy_config_pending"), "1");
  assert.equal(psql("select count(*) from coinops.robot_v1_live_orders where side='SELL' and status='NEW'"), "1");
});

check("bulk SQL: 26 engines are admitted in bounded 25 plus 1 chunks", () => {
  runFile(fixture("bulk-strategy-migration-chunks.sql"));
  assert.equal(psql(`select admission_cursor||':'||selected_count||':'||status
    from coinops.strategy_bulk_batches where idempotency_key='a0000000-0000-0000-0000-000000000026'`),
    "26:26:APPLYING");
  assert.equal(psql(`select count(*) from coinops.strategy_bulk_engine_updates u join coinops.strategy_bulk_batches b
    on b.id=u.batch_id where b.idempotency_key='a0000000-0000-0000-0000-000000000026'`), "26");
  assert.equal(psql(`select count(*) from coinops.trading_engines where strategy_config_pending
    and id::text like '50000000-0000-0000-0000-0000000001%'`), "26");
});
