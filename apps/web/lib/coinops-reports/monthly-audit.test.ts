import assert from "node:assert/strict";
import test from "node:test";

import { buildMonthlyAuditRows } from "./monthly-audit.ts";
import { buildMonthlyGoalChecks } from "./monthly-audit-checks.ts";
import { REPORT_DATASET_KEYS, type AuditDatasets, type AuditFilters } from "./report-engine.ts";

const config = { id: "config-sol", product_id: "product", tenant_id: "tenant", user_id: "user", asset: "SOL" };
const physical = "SHADOW:config-sol:5";
const credits = ["2026-09-10T12:00:00Z", "2026-09-20T12:00:00Z"].map((effective_gain_at, index) => ({
  environment: "SHADOW", asset: "SOL", slot_number: 5, physical_slot_id: physical,
  source_id: `op-${index + 1}`, effective_gain_at, credited_at: effective_gain_at,
  period_key: "2026-09", evidence_basis: "SHADOW_CONFIRMED_TP_CLOSE"
}));
const accounts = Array.from({ length: 25 }, (_, index) => ({ config_id: config.id, slot_number: index + 1,
  balance_usdc: index === 4 ? 10.1 : 10 }));
const filters: AuditFilters = { start: "2026-09-01T04:00:00Z", end: "2026-10-03T04:00:00Z", assets: ["SOL"], environments: ["SHADOW"] };
const rows = () => buildMonthlyAuditRows({ filters, observationEnd: filters.end, generatedAt: "2026-10-02T12:00:00Z",
  incomplete: false, credits, configs: [config], cycles: [{ id: "cycle-sol", config_id: config.id, started_at: "2026-09-01T12:00:00Z" }],
  shadowSlots: [], shadowAccounts: accounts, runs: [], testnetSlots: [] });

test("monthly audit preserves September facts and re-enables the same physical slot in October", () => {
  const report = rows();
  assert.equal(report.length, 50);
  const september = report.find((row) => row.period_key === "2026-09" && row.physical_slot_number === 5)!;
  const october = report.find((row) => row.period_key === "2026-10" && row.physical_slot_number === 5)!;
  assert.equal(september.monthly_gain_count, 2);
  assert.equal(september.monthly_target_reached, true);
  assert.equal(september.eligible_for_new_entry, false);
  assert.equal(september.current_balance, null);
  assert.equal(october.monthly_gain_count, 0);
  assert.equal(october.lifetime_gain_count, 2);
  assert.equal(october.operational_rank, 1);
  assert.equal(october.eligible_for_new_entry, true);
  assert.equal(october.current_balance, 10.1);
  assert.equal(october.physical_slot_id, september.physical_slot_id);
});

test("monthly checks require source reconciliation and observed month rollover", () => {
  const monthly_goals = rows();
  const data = Object.fromEntries(REPORT_DATASET_KEYS.map((key) => [key, []])) as unknown as AuditDatasets;
  data.monthly_goals = monthly_goals;
  data.checks = ["SINGLE_ACTIVE_ENTRY", "PRIORITY_REENTRY_MUST_BE_ARMED_BEFORE_LOWER_LEVEL"]
    .map((code) => ({ code, status: "PASS", environment: "SHADOW", asset: "SOL" }));
  const source = { robot_v1_monthly_slot_gains: credits, robot_v1_configs: [config],
    robot_v1_slot_profit_credits: credits.map((row) => ({ operation_id: row.source_id, config_id: config.id,
      slot_number: row.slot_number, credited_at: row.credited_at })),
    robot_v1_slot_operations: credits.map((row) => ({ id: row.source_id, closed_at: row.effective_gain_at })) };
  const checks = buildMonthlyGoalChecks(data, source, [], "2026-10-02T12:00:00Z");
  const status = (code: string) => checks.find((row) => row.code === code)?.status;
  assert.equal(status("MONTHLY_GAIN_COUNT_RECONCILES"), "PASS");
  assert.equal(status("NEW_MONTH_REENABLES_SLOT"), "PASS");
  assert.equal(status("LIFETIME_GAIN_NEVER_RESETS"), "PASS");
  assert.equal(status("RANK_DESCENDING_BY_LIFETIME_GAINS"), "PASS");
  assert.equal(status("PHYSICAL_SLOT_ID_IMMUTABLE"), "PASS");
  assert.equal(status("PRICE_PRIORITY_PRESERVED"), "PASS");
  assert.equal(status("SHADOW_TESTNET_MONTHLY_TARGET_PARITY"), "WARNING");
  assert.equal(buildMonthlyGoalChecks(data, source, ["robot_v1_monthly_slot_gains:row_limit_50000"], "2026-10-02T12:00:00Z")
    .find((row) => row.code === "MONTHLY_GAIN_COUNT_RECONCILES")?.status, "WARNING");
});

test("monthly audit preserves pre-4.2 reentry but flags any new post-adoption entry", () => {
  const data = Object.fromEntries(REPORT_DATASET_KEYS.map((key) => [key, []])) as unknown as AuditDatasets;
  data.monthly_goals = Array.from({ length: 25 }, (_, index) => ({ environment: "TESTNET", asset: "SOL",
    physical_slot_number: index + 1, period_key: "2026-09", monthly_gain_count: index === 4 ? 2 : 0,
    monthly_gain_target: 2, monthly_target_reached: index === 4, eligible_for_new_entry: index !== 4,
    operational_rank: index === 4 ? null : index < 4 ? index + 1 : index,
    lifetime_gain_count: index === 4 ? 2 : 0, physical_slot_id: `SOL:${index + 1}` }));
  const source = {
    robot_v1_monthly_slot_gains: [],
    robot_v1_testnet_runs: [{ id: "run-sol", asset: "SOL" }],
    robot_v1_strategy_decisions: [{ environment: "TESTNET", asset: "SOL", strategy_version: "4.2", created_at: "2026-09-23T18:22:00Z" }],
    robot_v1_testnet_orders: [
      { run_id: "run-sol", slot_number: 5, side: "SELL", purpose: "TP", status: "FILLED", operation_sequence: 1, revision: 1 },
      { run_id: "run-sol", slot_number: 5, side: "SELL", purpose: "TP", status: "FILLED", operation_sequence: 2, revision: 1 },
      { run_id: "run-sol", slot_number: 5, side: "BUY", created_at: "2026-09-23T16:42:00Z" }
    ],
    robot_v1_testnet_events: [
      { run_id: "run-sol", slot_number: 5, event_type: "SLOT_CLOSED", observed_at: "2026-09-23T14:55:00Z", details: { profitUsdc: 0.05, operationSequence: 1 } },
      { run_id: "run-sol", slot_number: 5, event_type: "SLOT_CLOSED", observed_at: "2026-09-23T16:07:00Z", details: { profitUsdc: 0.05, operationSequence: 2 } },
      { run_id: "run-sol", slot_number: 5, event_type: "SLOT_REENTRY_PLANNED", observed_at: "2026-09-23T16:07:01Z" }
    ]
  };
  const status = (code: string) => buildMonthlyGoalChecks(data, source, [], "2026-09-23T19:00:00Z")
    .find((row) => row.code === code)?.status;
  assert.equal(status("TARGET_REACHED_SLOT_HAS_NO_NEW_ENTRY"), "PASS");
  assert.equal(status("TARGET_REACHED_SLOT_HAS_NO_REENTRY"), "PASS");
  source.robot_v1_testnet_orders.push({ run_id: "run-sol", slot_number: 5, side: "BUY", created_at: "2026-09-23T18:30:00Z" });
  assert.equal(status("TARGET_REACHED_SLOT_HAS_NO_NEW_ENTRY"), "FAIL");
  source.robot_v1_testnet_events.push({ run_id: "run-sol", slot_number: 5, event_type: "SLOT_REENTRY_PLANNED", observed_at: "2026-09-23T18:31:00Z" });
  assert.equal(status("TARGET_REACHED_SLOT_HAS_NO_REENTRY"), "FAIL");
});
