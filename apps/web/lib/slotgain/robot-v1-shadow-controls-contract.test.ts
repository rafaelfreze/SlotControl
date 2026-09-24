import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Shadow control audit uses the post-5.6 engine-scoped unique key", () => {
  const actions = readFileSync(new URL("../../app/automacao/robot-v1-actions.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../../../../supabase/migrations/20260924144559_finalize_multi_account_engine_idempotency.sql", import.meta.url), "utf8");
  assert.match(migration, /robot_v1_audit_events/);
  assert.match(actions, /onConflict: "trading_engine_id,idempotency_key"/);
  assert.match(actions, /trading_engine_id: config\.trading_engine_id/);
  assert.doesNotMatch(actions, /onConflict: "product_id,tenant_id,user_id,idempotency_key"/);
});
