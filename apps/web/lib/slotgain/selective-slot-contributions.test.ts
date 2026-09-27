import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve("../..");
const migration = readFileSync(resolve(root,
  "supabase/migrations/20260927133000_add_selective_slot_contributions.sql"), "utf8");
const route = readFileSync(resolve(root, "apps/web/app/api/coinops-live-adjustments/route.ts"), "utf8");
const ui = readFileSync(resolve(root, "apps/web/app/automacao/live-adjustments-center.tsx"), "utf8");

test("selective contribution is an audited service-only ledger contract", () => {
  assert.match(migration, /robot_v1_live_selective_contribution_batches/);
  assert.match(migration, /robot_v1_live_selective_contribution_allocations/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /force row level security/);
  assert.match(migration, /revoke all on function coinops\.apply_live_selective_contribution[\s\S]+authenticated/);
  assert.match(migration, /grant execute on function coinops\.apply_live_selective_contribution[\s\S]+to service_role/);
  assert.match(migration, /pg_advisory_xact_lock/);
});

test("selective write never invokes an exchange order path", () => {
  const applyOnly = migration.split("-- Same official TP settlement")[0];
  assert.doesNotMatch(applyOnly, /robot_v1_live_orders|robot_v1_live_order_intents|create_order|cancel_order/i);
  assert.doesNotMatch(route, /create_order|cancel_order|["']MARKET["']|operatorExecutorAdmin<[^>]+>\("\/v1\/orders/i);
  assert.match(route, /noExchangeWrite: true/);
});

test("OPEN allocation is pending and official TP settlement applies it once", () => {
  assert.match(migration, /case when v_slot\.entry_state='OPEN' then 'PENDING' else 'APPLIED' end/);
  assert.match(migration, /where trading_engine_id=v_run\.trading_engine_id and slot_number=v_slot\.slot_number and status='PENDING'/);
  assert.match(migration, /SELECTIVE_CONTRIBUTION_APPLIED/);
  assert.match(migration, /if v_slot\.last_credited_sell_client_order_id=p_tp_client_order_id then return v_account/);
});

test("admin UI exposes explicit selection, filters, custom split and preview", () => {
  for (const label of ["Selecionar slots", "Igual entre selecionados", "Personalizar valores",
    "Com aporte pendente", "APORTE PENDENTE", "Pré-visualizar · sem ordens"])
    assert.ok(ui.includes(label), `missing UI contract: ${label}`);
  assert.match(ui, /Array\.from\(\{ length: 25 \}/);
});
