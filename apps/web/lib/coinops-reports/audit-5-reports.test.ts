import assert from "node:assert/strict";
import test from "node:test";
import { auditMonthlyEntryEvidence, hasMonthlyTargetPolicy } from "./monthly-entry-evidence.ts";
import { buildManualAdjustmentChecks } from "./manual-adjustment-audit.ts";
import type { AuditDatasets } from "./report-engine.ts";
import { buildPreLiveAuditGate } from "./pre-live-audit.ts";

test("monthly audit keeps policy adoption after 4.2 and rejects malformed versions", () => {
  for (const version of ["4.2", "4.3", "4.3.1", "5.0"]) assert.equal(hasMonthlyTargetPolicy(version), true);
  for (const version of ["4.1.1", "4.20-unknown", "unknown", null]) assert.equal(hasMonthlyTargetPolicy(version), false);
});

test("monthly audit uses the signed ledger at entry time, not the first crossing or current total", () => {
  const input = { adoptedAt: Date.parse("2026-09-01T00:00:00Z"),
    goals: [{ physical_slot_number: 5, period_key: "2026-09", monthly_gain_target: 2 }],
    credits: [
      { slot_number: 5, period_key: "2026-09", gain_units: 2, credited_at: "2026-09-10T12:00:00Z" },
      { slot_number: 5, period_key: "2026-09", gain_units: -1, credited_at: "2026-09-11T12:00:00Z" },
    ] };
  assert.equal(auditMonthlyEntryEvidence({ ...input, events: [{ slot: 5, at: "2026-09-12T12:00:00Z" }] }), "PASS");
  assert.equal(auditMonthlyEntryEvidence({ ...input, events: [{ slot: 5, at: "2026-09-10T13:00:00Z" }] }), "FAIL");
  assert.equal(auditMonthlyEntryEvidence({ ...input, events: [{ slot: 5, at: "2026-09-11T12:00:00Z" }] }), "WARNING");
  assert.equal(auditMonthlyEntryEvidence({ ...input, events: [{ slot: 5, at: "2026-10-01T04:00:00Z" }] }), "WARNING");
});

test("FX reversal retains original quote evidence instead of requiring a new FX quote", () => {
  const identity = { environment: "TESTNET", asset: "SOL", slot_number: 1, product_id: "p", tenant_id: "t", user_id: "u" };
  const original = { ...identity, id: "a", kind: "MANUAL_CONTRIBUTION", currency: "BRL", gain_units: 0,
    original_amount: 50, converted_amount_usdc: 10, fx_source: "BINANCE_SPOT_USDCBRL_ASK", fx_rate: 5,
    fx_observed_at: "2026-09-01T12:00:00Z", created_at: "2026-09-01T12:00:10Z", idempotency_key: "a" };
  const reversed = { ...original, id: "b", kind: "REVERSAL", reversal_of: "a", original_amount: -50,
    converted_amount_usdc: -10, created_at: "2026-09-23T12:00:00Z", idempotency_key: "b" };
  const data = { operations: [], checks: [], gains: [], monthly_goals: [] } as unknown as AuditDatasets;
  const status = (rows: typeof original[]) => buildManualAdjustmentChecks(data,
    { robot_v1_manual_adjustments: rows, robot_v1_monthly_slot_gains: [] }, [], reversed.created_at)
    .find((row) => row.code === "FX_SOURCE_VALID")?.status;
  assert.equal(status([original, reversed]), "PASS");
  assert.equal(status([reversed]), "FAIL");
  assert.equal(status([original, { ...reversed, fx_rate: Infinity }]), "FAIL");
  assert.equal(status([{ ...original, fx_observed_at: "2026-09-01T12:01:30Z" }]), "FAIL");
});

test("pre-LIVE gate distinguishes proven recovery, missing evidence, and active failure without enabling LIVE", () => {
  const data = { cycles: ["SHADOW", "TESTNET"].flatMap((environment) => ["BTC", "SOL"].map((asset) => ({ environment, asset, status: "ACTIVE" }))),
    checks: [{ code: "PRODUCTION_LIVE_BLOCKED", status: "PASS" }, { code: "PRODUCTION_PERSISTED_WRITE_GUARD", status: "PASS" }] } as unknown as AuditDatasets;
  assert.equal(buildPreLiveAuditGate(data, []).status, "WARNING"); // Safety alone is not operational coverage.
  data.checks.push({ code: "STRATEGY_DECISION_DISPATCH", status: "FAIL", active_failures: 0, recovered_historical_failures: 1 });
  assert.equal(buildPreLiveAuditGate(data, []).status, "WARNING");
  data.checks.push({ code: "OPEN_POSITION_HAS_RESIDENT_TP", status: "FAIL", active_failures: 0 });
  const gate = buildPreLiveAuditGate(data, []);
  assert.equal(gate.status, "FAIL");
  assert.equal(gate.live_enabled, false);
  assert.equal(gate.production_write_enabled, false);
  data.checks = data.checks.slice(0, 2);
  assert.equal(buildPreLiveAuditGate(data, ["orders:unavailable"]).status, "WARNING");
});
