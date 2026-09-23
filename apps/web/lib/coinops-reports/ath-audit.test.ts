import test from "node:test";
import assert from "node:assert/strict";
import { buildAthAudit } from "./ath-audit.ts";
import type { AuditDatasets } from "./report-engine.ts";

const at = "2026-09-23T12:00:00.000Z";
function fixture() {
  const profile = { id: "profile", environment: "TESTNET", asset: "BTC", config_version: 1,
    gain_rate: .005, normal_spacing_rate: .01, post_ath_spacing_rate: .02,
    regime: "POST_ATH", ath_price: 105, ath_source: "BINANCE_BTCUSDC_CONFIRMED_1D_FULL_HISTORY",
    ath_verified_at: at, ath_history_candle_count: 1000, transition_key: "confirmed" };
  const run = { id: "run", asset: "BTC", status: "ACTIVE", created_at: at, config_version: 1,
    gain_rate: .005, entry_spacing: .02, entry_regime: "POST_ATH",
    config_snapshot: { gain_rate: .005, normal_spacing_rate: .01, post_ath_spacing_rate: .02 } };
  const slots = Array.from({ length: 25 }, (_, index) => ({ id: `slot-${index + 1}`, run_id: "run",
    slot_number: index + 1, entry_state: "PLANNED", entry_origin: "GRID",
    post_ath_group: index >= 10 ? "PRIMARY" : "RESERVE",
    post_ath_group_rank: index >= 10 ? index - 9 : 10 - index,
    operational_rank: index >= 10 ? index - 9 : 25 - index }));
  const monthly = slots.map((slot) => ({ environment: "TESTNET", asset: "BTC", cycle_id: "run",
    physical_slot_number: slot.slot_number, physical_slot_id: `physical-${String(slot.slot_number).padStart(2, "0")}`,
    lifetime_gain_count: slot.slot_number, monthly_gain_count: 0, period_key: "2026-09" }));
  return { profile, run, slots, monthly };
}

test("ATH audit proves persisted Top15 and retains WARNING for unobserved floor/reset", () => {
  const { profile, run, slots, monthly } = fixture();
  const source = { robot_v1_ath_profiles: [profile], robot_v1_ath_events: [],
    robot_v1_testnet_runs: [run], robot_v1_testnet_slots: slots };
  const result = buildAthAudit({ monthly_goals: monthly, checks: [] } as unknown as AuditDatasets, source, [], at);
  const status = (code: string) => result.checks.find((row) => row.code === code)?.status;
  assert.equal(status("POST_ATH_PRIMARY_SELECTS_TOP_15"), "PASS");
  assert.equal(status("POST_ATH_PRIMARY_EXECUTES_ASCENDING_WITHIN_TOP15"), "PASS");
  assert.equal(status("POST_ATH_RESERVE_EXECUTES_DESCENDING"), "PASS");
  assert.equal(status("POST_ATH_SPACING_MATCHES_CONFIG"), "PASS");
  assert.equal(status("ATH_SOURCE_FRESH"), "PASS");
  assert.equal(status("GLOBAL_RESET_PRESERVES_REGIME"), "WARNING");
  assert.equal(status("FLOOR_RESTORES_NORMAL"), "WARNING");
  assert.equal(status("ATH_SIMULATION_DETERMINISTIC"), "WARNING");
  assert.equal(result.rows.filter((row) => row.row_type === "SLOT").length, 25);
});

test("ATH audit fails a mutated group without claiming historical market proof", () => {
  const { profile, run, slots, monthly } = fixture();
  slots[10]!.post_ath_group = "RESERVE";
  const result = buildAthAudit({ monthly_goals: monthly, checks: [] } as unknown as AuditDatasets,
    { robot_v1_ath_profiles: [profile], robot_v1_ath_events: [], robot_v1_testnet_runs: [run],
      robot_v1_testnet_slots: slots }, [], at);
  assert.equal(result.checks.find((row) => row.code === "POST_ATH_PRIMARY_SELECTS_TOP_15")?.status, "FAIL");
});
