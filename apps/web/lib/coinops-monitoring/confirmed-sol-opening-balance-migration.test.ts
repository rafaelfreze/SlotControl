import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../../../supabase/migrations/20260829175923_record_confirmed_sol_opening_balances.sql",
    import.meta.url
  ),
  "utf8"
);

test("confirmed SOL capital is recorded only as an audited opening balance", () => {
  assert.match(migration, /s\.slot_number between 11 and 25/);
  assert.match(migration, /target_count<>15/);
  assert.match(migration, /target_total<>375\.00000000/);
  assert.match(migration, /'OPENING_BALANCE'/);
  assert.match(migration, /'USER_CONFIRMED_SOL_FUNDING_2026_08_29'/);
  assert.match(migration, /'REAL_PRE_BASELINE_CAPITAL'/);
  assert.doesNotMatch(migration, /insert into coinops\.btc_external_contributions/i);
});

test("migration fails closed and proves that slot state stays immutable", () => {
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /for update of s/);
  assert.match(migration, /COINOPS_CONFIRMED_SOL_OPENING_STATE_CHANGED/);
  assert.match(migration, /COINOPS_CONFIRMED_SOL_OPENING_POSTCONDITION_FAILED/);
  assert.match(migration, /slot_state_after<>slot_state_before/);
  assert.doesNotMatch(migration, /update\s+coinops\.slots/i);
  assert.doesNotMatch(migration, /delete\s+from\s+coinops\.slots/i);
});

test("migration remains safe to replay and portable to clean environments", () => {
  assert.match(migration, /if target_count=0 then/);
  assert.match(migration, /on conflict do nothing/);
  assert.match(migration, /COINOPS_CONFIRMED_SOL_OPENING_EXISTING_BALANCE_MISMATCH/);
  assert.match(migration, /COINOPS_CONFIRMED_SOL_OPENING_BASELINE_ALREADY_EXISTS/);
});
