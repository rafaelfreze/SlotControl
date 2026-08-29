import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../../../supabase/migrations/20260829180712_fix_official_baseline_activation_alias_conflict.sql",
    import.meta.url
  ),
  "utf8"
);

const snapshotConflictMigration = readFileSync(
  new URL(
    "../../../../supabase/migrations/20260829181002_fix_official_baseline_activation_snapshot_conflict.sql",
    import.meta.url
  ),
  "utf8"
);

test("baseline activation keeps the baseline record distinct from the slot lateral alias", () => {
  assert.match(
    migration,
    /existing_baseline coinops\.monitoring_baselines%rowtype/
  );
  assert.match(
    migration,
    /select \* into existing_baseline from coinops\.monitoring_baselines/
  );
  assert.match(migration, /existing_baseline\.idempotency_key/);
  assert.match(migration, /existing\.slot_id/);
  assert.match(migration, /existing\.operational_value/);
  assert.doesNotMatch(
    migration,
    /existing coinops\.monitoring_baselines%rowtype/
  );
  assert.doesNotMatch(
    migration,
    /select \* into existing from coinops\.monitoring_baselines/
  );
});

test("alias correction does not change the financial reconciliation contract", () => {
  assert.match(migration, /COINOPS_BASELINE_STATE_CHANGED/);
  assert.match(migration, /COINOPS_BASELINE_POST_SNAPSHOT_RECONCILIATION_FAILED/);
  assert.match(migration, /financial_state_preserved',true/);
  assert.match(migration, /operational_total_before/);
  assert.match(migration, /operational_total_after/);
  assert.match(migration, /patrimony_before/);
  assert.match(migration, /patrimony_after/);
});

test("baseline snapshot conflict targets the explicit unique constraint", () => {
  assert.match(
    snapshotConflictMigration,
    /on conflict on constraint cycle_daily_snapshots_cycle_id_snapshot_date_key do nothing/
  );
  assert.doesNotMatch(
    snapshotConflictMigration,
    /on conflict\(cycle_id,snapshot_date\) do nothing/
  );
  assert.match(
    snapshotConflictMigration,
    /existing_baseline coinops\.monitoring_baselines%rowtype/
  );
  assert.match(
    snapshotConflictMigration,
    /COINOPS_BASELINE_POST_SNAPSHOT_RECONCILIATION_FAILED/
  );
});
