import assert from "node:assert/strict";
import test from "node:test";
import { buildMonthlyGoalChecks } from "./monthly-audit-checks.ts";
import { buildPreLiveAuditGate } from "./pre-live-audit.ts";
import { REPORT_DATASET_KEYS, type AuditDatasets } from "./report-engine.ts";
import type { AuditRow } from "./trigger-audit.ts";

const now = "2026-09-23T12:00:00Z";
const empty = () => Object.fromEntries(REPORT_DATASET_KEYS.map((key) => [key, []])) as unknown as AuditDatasets;
const goals = (later: number): AuditRow[] => [
  { environment: "SHADOW", asset: "SOL", period_key: "2026-08", physical_slot_number: 1,
    lifetime_gain_count: 100, next_reset_at: "2026-09-01T04:00:00Z" },
  { environment: "SHADOW", asset: "SOL", period_key: "2026-09", physical_slot_number: 1,
    lifetime_gain_count: later, next_reset_at: "2026-10-01T04:00:00Z" },
];
const reversal = { environment: "SHADOW", asset: "SOL", slot_number: 1, evidence_basis: "MANUAL_GAIN_REVERSAL",
  gain_units: -1, effective_gain_at: "2026-09-01T04:00:00Z", credited_at: "2026-09-02T12:00:00Z", period_key: "2026-09" };
const lifetime = (later: number, facts: AuditRow[]) => {
  const data = empty(); data.monthly_goals = goals(later);
  return buildMonthlyGoalChecks(data, { robot_v1_monthly_slot_gains: facts }, [], now)
    .find((row) => row.code === "LIFETIME_GAIN_NEVER_RESETS")?.status;
};

test("audit 5: one reversal cannot excuse an arbitrary lifetime loss", () => {
  assert.equal(lifetime(99, [reversal]), "PASS");
  assert.equal(lifetime(1, [reversal]), "FAIL");
  assert.equal(lifetime(99, []), "FAIL");
  assert.equal(lifetime(99, [reversal, { ...reversal, evidence_basis: "SHADOW_CONFIRMED_TP_CLOSE", gain_units: 1 }]), "FAIL");
  assert.equal(lifetime(99, [{ ...reversal, evidence_basis: "SHADOW_CONFIRMED_TP_CLOSE" }]), "FAIL");
});

test("audit 5: lifetime uses effective period boundaries and refuses incomplete temporal evidence", () => {
  assert.equal(lifetime(99, [{ ...reversal, credited_at: "2026-10-02T12:00:00Z" }]), "PASS");
  assert.equal(lifetime(99, [{ ...reversal, effective_gain_at: "2026-09-01T03:59:59.999Z" }]), "FAIL");
  assert.equal(lifetime(99, [{ ...reversal, effective_gain_at: null }]), "WARNING");
});

test("audit 5: monthly parity checks every physical slot in both environments", () => {
  const data = empty();
  data.monthly_goals = ["SHADOW", "TESTNET"].flatMap((environment) => Array.from({ length: 25 }, (_, i) => ({
    environment, asset: "SOL", period_key: "2026-09", physical_slot_number: i + 1, monthly_gain_target: 2,
  })));
  const status = () => buildMonthlyGoalChecks(data, { robot_v1_monthly_slot_gains: [] }, [], now)
    .find((row) => row.code === "SHADOW_TESTNET_MONTHLY_TARGET_PARITY")?.status;
  assert.equal(status(), "PASS");
  data.monthly_goals[49]!.monthly_gain_target = 99;
  assert.equal(status(), "FAIL");
  data.monthly_goals[49]!.monthly_gain_target = 2;
  data.monthly_goals[49]!.physical_slot_number = 24;
  assert.equal(status(), "FAIL");
  data.monthly_goals.pop();
  assert.equal(status(), "WARNING");
});

test("audit 5: truncated signed ledger cannot prove monthly entry or reentry violation", () => {
  const data = empty();
  data.monthly_goals = [{ environment: "TESTNET", asset: "SOL", period_key: "2026-09",
    physical_slot_number: 1, monthly_gain_target: 2 }];
  const source = {
    robot_v1_monthly_slot_gains: [{ ...reversal, environment: "TESTNET", gain_units: 2, evidence_basis: "MANUAL_TARGET_GAIN" }],
    robot_v1_strategy_decisions: [{ environment: "TESTNET", asset: "SOL", strategy_version: "4.3.1", created_at: "2026-09-01T04:00:00Z" }],
    robot_v1_testnet_runs: [{ id: "run", asset: "SOL" }],
    robot_v1_testnet_orders: [{ run_id: "run", side: "BUY", slot_number: 1, created_at: "2026-09-03T12:00:00Z" }],
    robot_v1_testnet_events: [{ run_id: "run", event_type: "SLOT_REENTRY_PLANNED", slot_number: 1, observed_at: "2026-09-03T12:00:00Z" }],
  };
  for (const code of ["TARGET_REACHED_SLOT_HAS_NO_NEW_ENTRY", "TARGET_REACHED_SLOT_HAS_NO_REENTRY"]) {
    assert.equal(buildMonthlyGoalChecks(data, source, [], now).find((row) => row.code === code)?.status, "FAIL");
    assert.equal(buildMonthlyGoalChecks(data, source, ["robot_v1_monthly_slot_gains:row_limit_50000"], now)
      .find((row) => row.code === code)?.status, "WARNING");
  }
});

function gateFixture(): AuditDatasets {
  const data = empty();
  data.checks = ["PRODUCTION_LIVE_BLOCKED", "PRODUCTION_PERSISTED_WRITE_GUARD", "OPERATION_IDS_UNIQUE",
    "EVENT_IDEMPOTENCY_UNIQUE", "TERMINAL_EVENTS_UNIQUE", "COMPOUNDING_RECONCILES", "SOURCE_COMPLETENESS"]
    .map((code) => ({ code, status: "PASS" }));
  for (const environment of ["SHADOW", "TESTNET"]) {
    data.checks.push(...["TP_HAS_POSITION", "TP_NOT_DUPLICATED"].map((code) => ({ code, environment, status: "PASS" })));
    for (const asset of ["BTC", "SOL"]) {
      data.cycles.push({ environment, asset, status: "ACTIVE" });
      data.summary.push({ environment, asset, active_errors: 0 });
      data.checks.push(...["SLOT_COUNT_25", "SINGLE_ACTIVE_ENTRY", "OPEN_POSITION_HAS_RESIDENT_TP", "STRATEGY_VERSION_PARITY",
        "STRATEGY_DECISION_IDEMPOTENCY", "STRATEGY_DECISION_DISPATCH", "MONTHLY_GAIN_COUNT_RECONCILES",
        "TARGET_REACHED_SLOT_HAS_NO_NEW_ENTRY", "TARGET_REACHED_SLOT_HAS_NO_REENTRY", "RANK_DESCENDING_BY_LIFETIME_GAINS",
        "ENVIRONMENT_CONFIG_ISOLATED", "CONFIG_SNAPSHOT_MATCHES_EXECUTION", "GAIN_PCT_MATCHES_CONFIG"]
        .map((code) => ({ code, environment, asset, status: "PASS" })));
    }
  }
  data.checks.push({ code: "TESTNET_OWNERSHIP", environment: "TESTNET", status: "PASS" });
  data.checks.push(...["BTC", "SOL"].map((asset) => ({ code: "SHADOW_TESTNET_MONTHLY_TARGET_PARITY", environment: "SHADOW/TESTNET", asset, status: "PASS" })));
  return data;
}

test("audit 5: pre-LIVE PASS requires scoped invariant coverage, not just safety flags", () => {
  const data = gateFixture();
  assert.equal(buildPreLiveAuditGate(data, []).status, "PASS");
  const scoped = data.checks.find((row) => row.code === "OPEN_POSITION_HAS_RESIDENT_TP" && row.environment === "TESTNET" && row.asset === "SOL")!;
  scoped.asset = "BTC";
  const missing = buildPreLiveAuditGate(data, []);
  assert.equal(missing.status, "WARNING");
  assert.ok((missing.missing_required_checks as string[]).includes("TESTNET:SOL:OPEN_POSITION_HAS_RESIDENT_TP"));
  data.checks = data.checks.slice(0, 2);
  assert.equal(buildPreLiveAuditGate(data, []).status, "WARNING");
});

test("audit 5: gate preserves historical recovery and active runtime errors", () => {
  const data = gateFixture();
  data.checks.push({ code: "STRATEGY_DECISION_DISPATCH", status: "FAIL", active_failures: 0, recovered_historical_failures: 1 });
  assert.equal(buildPreLiveAuditGate(data, []).status, "WARNING");
  data.summary[0]!.active_errors = 1;
  assert.equal(buildPreLiveAuditGate(data, []).status, "FAIL");
  assert.equal(buildPreLiveAuditGate(data, []).live_enabled, false);
  assert.equal(buildPreLiveAuditGate(data, []).production_write_enabled, false);
});
