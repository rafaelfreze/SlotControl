import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../../../supabase/migrations/20260830141201_add_bulk_asset_external_contributions.sql",
    import.meta.url
  ),
  "utf8"
);
const ambiguityFixMigration = readFileSync(
  new URL(
    "../../../../supabase/migrations/20260830142944_fix_bulk_external_contribution_batch_id_ambiguity.sql",
    import.meta.url
  ),
  "utf8"
);
const action = readFileSync(
  new URL("../../app/plano-crescimento/actions.ts", import.meta.url),
  "utf8"
);
const component = readFileSync(
  new URL("../../app/plano-crescimento/btc-ladder-section.tsx", import.meta.url),
  "utf8"
);
const planPage = readFileSync(
  new URL("../../app/plano-crescimento/page.tsx", import.meta.url),
  "utf8"
);
const historyPage = readFileSync(
  new URL("../../app/historico/page.tsx", import.meta.url),
  "utf8"
);
const historyClient = readFileSync(
  new URL("../../app/historico/historico-client.tsx", import.meta.url),
  "utf8"
);

test("bulk contribution accepts any positive per-slot amount for BTC or SOL", () => {
  assert.match(migration, /private\.coinops_normalize_growth_asset\(p_asset\)/);
  assert.match(migration, /normalized_amount is null or normalized_amount <= 0/);
  assert.doesNotMatch(migration, /normalized_amount\s*>\s*(?:3|5|10|20|250)\b/);
  assert.match(component, /Você pode usar qualquer valor positivo por slot/);
  for (const amount of [3, 5, 10, 20]) {
    assert.equal(Number((amount * 25).toFixed(8)), amount * 25);
  }
});

test("bulk contribution targets the complete funded MAIN pool, including OPEN", () => {
  assert.match(migration, /pool\.pool = 'MAIN'/);
  assert.match(migration, /and pool\.enabled/);
  assert.match(migration, /and pool\.funded/);
  assert.match(migration, /slot\.slot_number between 1 and 25/);
  assert.match(migration, /target_slot_ids is distinct from normalized_expected_slot_ids/);
  assert.match(migration, /count\(\*\) filter \(where slot\.status = 'aberto'\)/);
  assert.match(component, /Todos os \{bulkSlotCount\}/);
  assert.match(component, /inclusive os \{bulkOpenSlotCount\} OPEN/);
  assert.match(planPage, /slot\.baseline_id === activeBaselineId/);
});

test("batch is atomic, idempotent and reuses the authoritative single-slot RPC", () => {
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /for update of pool, slot/);
  assert.match(migration, /coinops\.apply_asset_external_contribution\(/);
  assert.match(migration, /COINOPS_IDEMPOTENCY_CONFLICT/);
  assert.match(migration, /already_applied', true/);
  assert.match(migration, /COINOPS_BULK_CONTRIBUTION_BATCH_POSTCONDITION_FAILED/);
  assert.match(action, /apply_asset_external_contribution_batch/);
  assert.match(action, /p_expected_slot_ids: uniqueExpectedSlotIds/);
  assert.match(component, /name="expectedSlotIds"/);
  assert.match(action, /confirmBulk/);
});

test("batch preserves gains, positions and the official queue tie-breaker", () => {
  for (const field of [
    "real_gains",
    "operational_gains",
    "added_gains",
    "realized_profit",
    "position_notional_usdt",
    "position_gain_unit_usdt",
    "position_quantity",
    "position_opened_at",
    "preco_entrada",
    "preco_alvo"
  ]) {
    assert.match(migration, new RegExp(`slot_after\\.${field} is distinct from slot_before\\.${field}`));
  }
  assert.match(
    migration,
    /when new\.entry_type = 'EXTERNAL_CONTRIBUTION' then p\.last_operated_at/
  );
  assert.match(migration, /progress_after\.cycle_progress is distinct from progress_before\.cycle_progress/);
});

test("batch header and child rows remain owner-scoped and auditable", () => {
  assert.match(migration, /asset_external_contribution_batches_owner_select/);
  assert.match(migration, /baseline_id uuid not null references coinops\.monitoring_baselines/);
  assert.match(migration, /force row level security/);
  assert.match(migration, /private\.coinops_can_access_row\(product_id, tenant_id, user_id\)/);
  assert.match(migration, /bulk_batch_id = batch_id/);
  assert.match(migration, /bulkSequence/);
  assert.match(migration, /grant execute on function coinops\.apply_asset_external_contribution_batch/);
  assert.match(migration, /to authenticated/);
});

test("bulk contribution is represented once in plan and global history", () => {
  assert.match(planPage, /asset_external_contribution_batches/);
  assert.match(planPage, /bulk_total_amount_usdt: batch\?\.total_amount_usdt/);
  assert.match(historyPage, /\.is\("bulk_batch_id", null\)/);
  assert.match(historyPage, /action: "Aporte em lote"/);
  assert.match(historyPage, /totalAmount/);
  assert.match(historyClient, /"ID Lote"/);
  assert.match(historyClient, /"Total do Lote"/);
});

test("batch id hotfix removes PL/pgSQL ambiguity without changing financial rules", () => {
  const functionStart = "create or replace function coinops.apply_asset_external_contribution_batch(";
  const functionEnd = "$batch$;";
  const originalFunction = migration.slice(
    migration.indexOf(functionStart),
    migration.indexOf(functionEnd, migration.indexOf(functionStart)) + functionEnd.length
  );
  const fixedFunction = ambiguityFixMigration.slice(
    ambiguityFixMigration.indexOf(functionStart),
    ambiguityFixMigration.indexOf(functionEnd, ambiguityFixMigration.indexOf(functionStart)) + functionEnd.length
  );

  assert.match(fixedFunction, /bulk_contribution_batch_id uuid := gen_random_uuid\(\);/);
  assert.doesNotMatch(fixedFunction, /(^|\n)\s*batch_id uuid :=/);
  assert.doesNotMatch(fixedFunction, /'bulkBatchId',\s*batch_id\b/);
  assert.doesNotMatch(fixedFunction, /contribution\.bulk_batch_id = batch_id\b/);
  assert.doesNotMatch(fixedFunction, /batch_row\.id = batch_id\b/);
  assert.equal(
    fixedFunction.replaceAll("bulk_contribution_batch_id", "batch_id"),
    originalFunction
  );
});
