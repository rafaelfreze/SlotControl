import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
const directory = new URL("../../../../supabase/migrations/", import.meta.url);
const filename = readdirSync(directory).find((name) => name.endsWith("_classify_pre_4_1_testnet_missed_levels.sql"))!;
const sql = readFileSync(new URL(filename, directory), "utf8");

test("temporal migration is additive, scope-bound, idempotent and does not write financial state", () => {
  const executable = sql.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(executable, /\b(update|delete|truncate|drop|alter|grant|revoke)\b/i);
  assert.deepEqual([...executable.matchAll(/insert\s+into\s+(\w+\.\w+)/gi)].map((row) => row[1]), ["coinops.robot_v1_testnet_events"]);
  assert.match(sql, /on conflict \(run_id,event_key\) do nothing/i);
  for (const guard of ["r.product_id=", "r.tenant_id=", "r.user_id=", "pg_advisory_xact_lock", "into strict tp", "into strict lower_buy", "into strict reconciled", "COINOPS_TEMPORAL_FILL_OWNERSHIP_NOT_PROVEN"]) assert.ok(sql.includes(guard), guard);
});

test("temporal migration proves the pre-deploy window but keeps exact cross and legacy version unknown", () => {
  assert.match(sql, /'first_cross_at',null/);
  assert.match(sql, /'original_created_at',null/);
  assert.match(sql, /'strategy_version_at_occurrence',null/);
  assert.match(sql, /'occurred_at_basis','TP_FILL_UNRECONCILED_WINDOW_START'/);
  assert.match(sql, /'resolved_at',reconciled\.observed_at/);
  assert.match(sql, /'occurred_by_at',lower_buy\.details->>'filledAt'/);
  assert.match(sql, /if not coalesce\(/);
  assert.match(sql, /'retroactive_fill_created',false/);
});
