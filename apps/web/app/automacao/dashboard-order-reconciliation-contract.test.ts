import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../../../../supabase/migrations/20261013135419_add_dashboard_order_reconciliation_evidence.sql");
const previous = read("../../../../supabase/migrations/20260929214159_generalize_coinops_bulk_strategy_editor.sql");
const definition = (sql: string) => {
  const value = /create or replace function coinops\.dashboard_live_engine_reads\([\s\S]*?\$\$;/i.exec(sql)?.[0];
  assert.ok(value, "Canonical dashboard read function must exist");
  return value.replace(/\r\n/g, "\n");
};

test("dashboard RPC adds only fill-reconciliation evidence to the current immutable financial read contract", () => {
  const current = definition(migration);
  assert.equal(current.replace(",trades_reconciled", ""), definition(previous));
  assert.equal(current.match(/trades_reconciled/g)?.length, 1);
  assert.match(current, /reserved_notional_quote,trades_reconciled\s+from coinops\.robot_v1_live_orders/);
  assert.match(current, /language sql stable security invoker set search_path = ''/);
  assert.match(current, /returns table\(engine_id uuid, payload jsonb\)/);
  assert.match(current, /cardinality\(p_engine_ids\) between 1 and 32/);
});

test("additive read migration preserves owner grants RLS and every financial table", () => {
  const executable = migration.replace(/--[^\n]*(?:\n|$)/g, "\n");
  assert.match(executable, /^\s*begin;/i); assert.match(executable, /commit;\s*$/i);
  assert.doesNotMatch(executable, /\b(?:grant|revoke|security definer|update|insert|delete|drop|truncate|alter|create policy|enable row level security)\b/i);
  assert.doesNotMatch(executable, /\bpublic\./i);
  assert.equal(executable.match(/create or replace function/gi)?.length, 1);
});

test("both batch RPC and native fallback preserve optional fill evidence without inventing its default", () => {
  const fallback = read("./operator-presentation-server.ts"), types = read("./automation-mobile.tsx");
  const batch = read("./live-dashboard-batch.ts");
  assert.match(fallback, /query\("robot_v1_live_orders", "[^"\n]*,trades_reconciled"\)/);
  assert.match(types, /trades_reconciled\?: boolean/);
  assert.match(batch, /dashboard_live_engine_reads/);
  assert.doesNotMatch(fallback, /trades_reconciled\s*:\s*true/);
});
