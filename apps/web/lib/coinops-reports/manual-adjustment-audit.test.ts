import assert from "node:assert/strict";
import test from "node:test";
import { buildManualAdjustmentChecks } from "./manual-adjustment-audit.ts";
import type { AuditDatasets } from "./report-engine.ts";

const at = "2026-09-23T12:00:00.000Z";
const identity = { product_id: "p", tenant_id: "t", user_id: "u", environment: "TESTNET", asset: "SOL", slot_number: 7,
  physical_slot_id: "TESTNET:p:t:u:SOL:7" };
const original = { id: "gain-1", ...identity, kind: "MANUAL_TARGET_GAIN", gain_units: 1, currency: "USD", original_amount: 5,
  converted_amount_usdc: 5, balance_before_usdc: 100, balance_after_usdc: 105,
  monthly_before: 1, monthly_after: 2, lifetime_before: 10, lifetime_after: 11,
  open_position_at_time: true, position_committed_notional_usdc: 100,
  idempotency_key: "one-idempotency-key", created_at: at, reversal_of: null };
const reversal = { ...original, id: "reverse-1", kind: "REVERSAL", gain_units: -1, original_amount: -5,
  converted_amount_usdc: -5, balance_before_usdc: 105, balance_after_usdc: 100,
  monthly_before: 2, monthly_after: 1, lifetime_before: 11, lifetime_after: 10,
  idempotency_key: "reverse-key-unique", reversal_of: original.id };

test("auditoria reconcilia gain manual assinado e estorno sem lucro de mercado", () => {
  const datasets = { monthly_goals: [{ monthly_gain_count: 1, monthly_market_gain_count: 1, monthly_manual_gain_count: 0 }],
    gains: [{ gain_source: "MANUAL", net_gain: 0, gain_units: 1, operation_id: null }],
    operations: [], checks: [] } as unknown as AuditDatasets;
  const sources = { robot_v1_manual_adjustments: [original, reversal], robot_v1_monthly_slot_gains: [
    { ...identity, source_id: original.id, gain_units: 1, evidence_basis: "MANUAL_TARGET_GAIN" },
    { ...identity, source_id: reversal.id, gain_units: -1, evidence_basis: "MANUAL_GAIN_REVERSAL" },
  ], robot_v1_slot_accounts: [], robot_v1_real_prepared_slot_accounts: [], exchange_order_intents: [] };
  const checks = buildManualAdjustmentChecks(datasets, sources, [], at);
  const status = (code: string) => checks.find((row) => row.code === code)?.status;
  assert.equal(status("MANUAL_GAIN_RECONCILES"), "PASS");
  assert.equal(status("MANUAL_GAIN_COUNTS_TOWARD_TARGET"), "PASS");
  assert.equal(status("MANUAL_GAIN_DISTINGUISHED_FROM_MARKET"), "PASS");
  assert.equal(status("REVERSAL_AUDITABLE"), "PASS");
  assert.equal(status("ADJUSTMENT_IDEMPOTENT"), "PASS");
  assert.equal(status("OPEN_POSITION_UNCHANGED_BY_ADJUSTMENT"), "WARNING");
  assert.equal(status("PRODUCTION_NO_FINANCIAL_ACTION"), "WARNING");
  assert.equal(checks.length, 14);
});

test("auditoria não aprova fatos ausentes ou idempotência duplicada", () => {
  const datasets = { monthly_goals: [], gains: [], operations: [], checks: [] } as unknown as AuditDatasets;
  const sources = { robot_v1_manual_adjustments: [original, { ...original, id: "gain-2" }],
    robot_v1_monthly_slot_gains: [], robot_v1_slot_accounts: [], robot_v1_real_prepared_slot_accounts: [], exchange_order_intents: [] };
  const checks = buildManualAdjustmentChecks(datasets, sources, [], at);
  assert.equal(checks.find((row) => row.code === "ADJUSTMENT_IDEMPOTENT")?.status, "FAIL");
  assert.equal(checks.find((row) => row.code === "MANUAL_GAIN_RECONCILES")?.status, "FAIL");
});
