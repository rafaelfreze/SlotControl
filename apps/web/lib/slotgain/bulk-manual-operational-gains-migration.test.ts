import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../../../supabase/migrations/20260903202836_add_asset_manual_operational_gain_batches.sql",
    import.meta.url
  ),
  "utf8"
);

test("manual gain batches select only the authoritative eligible MAIN scope below the threshold", () => {
  assert.match(migration, /slot\.operational_gains < normalized_below_gains/);
  assert.match(migration, /pool\.pool = 'MAIN'/);
  assert.match(migration, /and pool\.enabled/);
  assert.match(migration, /and pool\.funded/);
  assert.match(migration, /slot\.slot_number between 1 and 25/);
  assert.match(migration, /count\(\*\) filter \(where candidate\.status = 'aberto'\)/);
});

test("manual gain batch preview uses the same compound source of truth as one-slot gain", () => {
  assert.match(migration, /private\.coinops_compound_operational_value_usdt/);
  assert.match(migration, /coinops\.apply_asset_manual_operational_gains\(/);
  assert.doesNotMatch(migration, /set\s+real_gains\s*=/i);
  assert.match(migration, /slot_after\.real_gains is distinct from slot_before\.real_gains/);
  assert.match(migration, /position_notional_usdt is distinct from slot_before\.position_notional_usdt/);
  assert.match(migration, /COINOPS_MANUAL_GAINS_BATCH_ITEM_POSTCONDITION_FAILED/);
});

test("manual gain batches are previewed before confirmation and protected from stale or duplicate writes", () => {
  assert.match(migration, /status in \('PREPARED', 'COMPLETED', 'CANCELLED', 'STALE', 'EXPIRED'\)/);
  assert.match(migration, /expires_at <= timezone\('utc', now\(\)\)/);
  assert.match(migration, /COINOPS_MANUAL_GAINS_BATCH_STALE/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /for update of pool, slot/);
  assert.match(migration, /confirmation_idempotency_key/);
  assert.match(migration, /already_applied', true/);
});

test("historical manual gain batch table remains scoped and RLS-protected", () => {
  assert.match(migration, /force row level security/);
  assert.match(migration, /asset_manual_operational_gain_batches_owner_select/);
  assert.match(migration, /private\.coinops_can_access_row\(product_id, tenant_id, user_id\)/);
  assert.match(migration, /revoke all on function coinops\.prepare_asset_manual_operational_gains_batch/);
  assert.match(migration, /grant execute on function coinops\.confirm_asset_manual_operational_gains_batch/);
});
