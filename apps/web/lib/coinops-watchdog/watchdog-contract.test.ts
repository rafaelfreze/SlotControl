import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const migration = readFileSync(new URL("../../../../supabase/migrations/20260926233241_add_coinops_server_watchdog.sql", import.meta.url), "utf8");
const vercel = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8")) as {
  crons: Array<{ path: string; schedule: string }> };

test("watchdog cron runs server-side every minute", () => {
  assert.ok(root);
  assert.deepEqual(vercel.crons.find((item) => item.path === "/api/cron/coinops-watchdog"),
    { path: "/api/cron/coinops-watchdog", schedule: "* * * * *" });
});
test("incident storage deduplicates open episodes and denies client writes", () => {
  assert.match(migration, /create unique index watchdog_one_open_incident[\s\S]*where resolved_at is null/i);
  assert.match(migration, /alter table coinops\.watchdog_incidents force row level security/i);
  assert.match(migration, /revoke all on coinops\.watchdog_checks,coinops\.watchdog_incidents from public,anon,authenticated/i);
  assert.match(migration, /grant select,insert,update on coinops\.watchdog_checks,coinops\.watchdog_incidents to service_role/i);
});
