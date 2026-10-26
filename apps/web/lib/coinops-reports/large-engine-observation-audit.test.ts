import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditReport } from "./report-engine.ts";
import { buildReportPackage } from "./report-package.ts";
import { REPORT_VERSION } from "./filters.ts";

const generatedAt = "2026-10-16T19:30:00Z";
const filters = { start: "2026-10-16T00:00:00Z", end: "2026-10-17T00:00:00Z",
  assets: ["SOL"] as ["SOL"], environments: ["REAL"] as ["REAL"] };
test("v27 records the owned observation protocol without inventing capacity, history or an authorization cache", () => {
  assert.equal(REPORT_VERSION, 31);
  const report = buildAuditReport({ sources: {}, incompleteSources: [], warnings: [], generatedAt,
    scope: { tenantId: "fixture", userId: "fixture" } }, filters);
  const rule = report.datasets.rules.find(row => row.parameter === "large_engine_owned_observation_protocol")!;
  assert.equal(rule.evidence_scope, "CURRENT_CODE_CONTRACT");
  assert.equal(rule.value, "COHERENT_OWNED_ORDER_AND_FILLS_GET_ONLY");
  for (const expression of [/Somente N>25/, /\/v1\/observe-order/, /ordem e fills coerentes/,
    /fill\/cancel ambíguo/, /fail-closed/, /não reutiliza saldo, ordens, filtros ou permissões/,
    /Legacy25 mantém query\/trades/, /não.*certifica capacidade/, /Ausência de evidência não é PASS/])
    assert.match(String(rule.notes), expression);
  assert.equal(report.datasets.live_execution.length, 0);
});
test("v27 preserves the new transient read path and legacy25 evidence in existing CSV/JSON datasets only", () => {
  const details = { stage: "RECONCILE_ORDERS", source: "ENGINE", root_code: "EXECUTOR_ORDER_OBSERVATION_INCOMPLETE",
    read_path: "/v1/observe-order", read_attempts: 4, http_status: 503 };
  const last = "2026-10-16T19:29:00Z";
  const run = { id: "run-25", asset: "SOL", symbol: "SOLBRL", slot_count: 25, status: "ACTIVE",
    last_reconciled_at: last, created_at: last, config_snapshot: { slot_count: 25, normal_spacing_rate: .03, gain_rate: .055 } };
  const before = structuredClone(run);
  const report = buildAuditReport({ sources: { robot_v1_live_runs: [run], robot_v1_live_alerts: [{ id: "alert",
    asset: "SOL", trading_engine_id: "engine-large", exchange_account_id: "account-a", executor_shard_id: "executor-03",
    code: "COINOPS_LIVE_TRANSIENT_EXECUTOR_READ", details, first_seen_at: generatedAt, last_seen_at: generatedAt, resolved_at: null }] },
    incompleteSources: [], warnings: [], generatedAt, scope: { tenantId: "fixture", userId: "fixture" } }, filters);
  assert.deepEqual(report.datasets.live_execution.find(row => row.row_type === "ALERT")?.details, details);
  const exported = report.datasets.live_execution.find(row => row.row_type === "RUN")!;
  assert.equal(exported.slot_count, 25); assert.equal(exported.last_reconciled_at, last);
  assert.deepEqual(exported.config_snapshot, before.config_snapshot); assert.deepEqual(run, before);
  const pack = buildReportPackage(report, filters, generatedAt, "fixture-sha");
  assert.equal(pack.manifest.report_version, 31);
  assert.equal(pack.manifest.schema_version, "coinops/robot-v1/reports-v30-controlled-handoffs");
  assert.equal(pack.manifest.financial_writes_from_export, 0);
});
