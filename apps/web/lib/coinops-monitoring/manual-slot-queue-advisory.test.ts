import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../../../supabase/migrations/20260830125542_make_official_slot_queue_advisory.sql",
    import.meta.url
  ),
  "utf8"
);
const actionSource = readFileSync(
  new URL("../../app/dashboard/actions.ts", import.meta.url),
  "utf8"
);
const finalDecision = migration.slice(
  migration.lastIndexOf("return jsonb_build_object")
);
const openSlotSource = actionSource.slice(
  actionSource.indexOf("export async function openSlot"),
  actionSource.indexOf("export async function registerGain")
);
const registerGainSource = actionSource.slice(
  actionSource.indexOf("export async function registerGain"),
  actionSource.indexOf("export async function resetSlot")
);

test("fila oficial recomenda sem bloquear a escolha manual", () => {
  assert.ok(migration.includes("recommendation_code := 'ALL_TARGETS_MET'"));
  assert.ok(migration.includes("recommendation_code := 'NO_ELIGIBLE_SLOT'"));
  assert.ok(migration.includes("else 'NOT_NEXT_PRIORITY'"));
  assert.ok(finalDecision.includes("'allowed', true"));
  assert.ok(
    finalDecision.includes(
      "'recommended', coalesce(expected_slot_id = p_slot_id, false)"
    )
  );
  assert.ok(
    openSlotSource.includes(
      "officialEligibility?.active && !officialEligibility.allowed"
    )
  );
});

test("bloqueios estruturais e escopo autenticado continuam protegidos", () => {
  for (const code of [
    "NO_ACTIVE_CYCLE",
    "SLOT_NOT_ENABLED_OR_FUNDED",
    "SLOT_ALREADY_OPEN",
    "SLOT_NOT_ACTIVE_FOR_CYCLE",
    "RESERVE_NOT_ALLOWED"
  ]) {
    assert.ok(migration.includes(`'code', '${code}'`));
  }
  assert.equal(migration.match(/'allowed', false/g)?.length, 5);
  assert.ok(migration.includes("security definer"));
  assert.ok(migration.includes("set search_path = ''"));
  assert.ok(migration.includes("from private.coinops_current_scope()"));
  assert.ok(
    migration.includes(
      "grant execute on function coinops.validate_official_slot_entry(uuid)"
    )
  );
  assert.ok(migration.includes("to authenticated;"));
});

test("abertura mantém concorrência e fechamento mantém RPC financeiro", () => {
  assert.ok(
    openSlotSource.includes("getSlotFromForm(supabase, user.id, formData)")
  );
  assert.ok(openSlotSource.includes('.eq("user_id", user.id)'));
  assert.ok(openSlotSource.includes('.neq("status", "aberto")'));
  assert.ok(openSlotSource.includes('addHistory("Abertura"'));
  assert.ok(registerGainSource.includes("register_asset_real_gain"));
  assert.ok(registerGainSource.includes('addHistory("Gain"'));
});
