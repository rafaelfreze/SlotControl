import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditReport, type AuditInput } from "./report-engine.ts";
import { buildReportPackage } from "./report-package.ts";
import { REPORT_VERSION } from "./filters.ts";

const generatedAt = "2026-10-21T13:40:00.000Z";
const filters = { start: "2026-10-21T00:00:00Z", end: "2026-10-22T00:00:00Z",
  assets: ["SOL"] as ["SOL"], environments: ["REAL"] as ["REAL"] };
const owner = { operator_id: "operator-a", exchange_account_id: "account-a",
  trading_engine_id: "engine-a", executor_shard_id: "executor-01" };
const input = (sources: AuditInput["sources"] = {}): AuditInput => ({ sources,
  incompleteSources: [], warnings: [], generatedAt, scope: { tenantId: "fixture", userId: "fixture" } });

test("v28 declares final-event-only bounded persistence and exact guarded recovery without authorizing finance", () => {
  assert.equal(REPORT_VERSION, 28);
  const report = buildAuditReport(input(), filters);
  const persistence = report.datasets.rules.find(row => row.parameter === "final_audit_event_persistence")!;
  const recovery = report.datasets.rules.find(row => row.parameter === "audit_event_guarded_recovery")!;
  assert.equal(persistence.version, 1);
  assert.equal(persistence.value, "IMMUTABLE_SCOPED_WRITE_READBACK_BOUNDED_RETRY");
  assert.equal(recovery.version, 1);
  assert.equal(recovery.value, "FRESH_RECONCILIATION_AND_SETTLED_FINANCE_UNDER_CAS");
  for (const rule of [persistence, recovery]) {
    assert.equal(rule.environment, "REAL");
    assert.equal(rule.evidence_scope, "CURRENT_CODE_CONTRACT");
  }
  for (const expression of [/payload capturado imutável/, /observed_at já persistido preservado/,
    /2 conjuntos de escrita\/readback/, /orçamento de 5s por conjunto/, /limite de 2,5s para escrita/,
    /um upsert sem GET extra/,
    /ACK incerto exige GET/, /comparação integral/, /somente a escrita idempotente do evento/,
    /nunca presume HTTP 503/, /não recria evento ausente nem fabrica freshness/])
    assert.match(String(persistence.notes), expression);
  for (const expression of [/COINOPS_LIVE_EVENT_PERSIST_FAILED em AUDIT_EVENT/, /root_code exato/,
    /RECONCILED novo e fresco/, /COMPLETED e zero dispatch pendente/, /duas vezes/,
    /sob lease e CAS/, /BLOCKED_SAFE somente no engine afetado/, /não executa recovery/])
    assert.match(String(recovery.notes), expression);
  assert.equal(report.datasets.live_execution.length, 0);
  const shadow = buildAuditReport(input(), { ...filters, environments: ["SHADOW"] });
  assert.ok(!shadow.datasets.rules.some(row => [persistence.parameter, recovery.parameter].includes(row.parameter)));
});

test("v28 CSV/JSON preserve typed audit diagnostics and scoped identity without financial effects or private data", () => {
  const details = { stage: "AUDIT_EVENT", source: "ENGINE", root_code: "COINOPS_LIVE_EVENT_PERSIST_FAILED",
    audit_phase: "WRITE", audit_reason: "TRANSIENT_EXHAUSTED", audit_event_type: "RECONCILED",
    audit_event_key: "RECONCILED:2026-10-21T13:28", audit_attempts: 2,
    audit_http_status: 503, audit_provider_code: "PGRST003" };
  const run = { ...owner, id: "run-a", asset: "SOL", symbol: "SOLUSDT", slot_count: 25,
    status: "ACTIVE", created_at: "2026-10-01T00:00:00Z", last_reconciled_at: "2026-10-21T13:39:30Z",
    config_snapshot: { slot_count: 25, report_version: 27, gain_rate: .055, normal_spacing_rate: .03 } };
  const source = input({ robot_v1_live_runs: [run], robot_v1_live_alerts: [{ ...owner, id: "typed-alert",
    run_id: run.id, asset: "SOL", symbol: run.symbol, code: "COINOPS_LIVE_EVENT_PERSIST_FAILED",
    severity: "CRITICAL", details: { ...details, api_secret: "never-export-this" },
    first_seen_at: "2026-10-21T13:28:00Z", last_seen_at: "2026-10-21T13:28:00Z", resolved_at: null }] });
  const before = structuredClone(source);
  const report = buildAuditReport(source, filters);
  const pack = buildReportPackage(report, filters, generatedAt, "fixture-sha");
  assert.equal(pack.manifest.report_version, 28);
  assert.equal(pack.manifest.schema_version, "coinops/robot-v1/reports-v28-final-audit-event-recovery");
  assert.equal(pack.manifest.financial_writes_from_export, 0);
  assert.equal(pack.files.length, 27);
  const jsonText = pack.files.find(file => file.name === "AUDITORIA_COMPLETA.json")!.content;
  const csv = pack.files.find(file => file.name === "LIVE_EXECUTION.csv")!.content;
  const rulesCsv = pack.files.find(file => file.name === "11_REGRAS_CONFIGURACAO.csv")!.content;
  const json = JSON.parse(jsonText);
  const alert = json.datasets.live_execution.find((row: Record<string, unknown>) => row.id === "typed-alert");
  assert.deepEqual(alert.details, details);
  for (const [key, value] of Object.entries(owner)) assert.equal(alert[key], value);
  assert.equal(alert.resolved_at, null);
  assert.equal(json.datasets.live_execution.find((row: Record<string, unknown>) => row.row_type === "RUN").config_snapshot.report_version, 27);
  for (const text of [jsonText, csv]) {
    for (const field of Object.keys(details)) assert.ok(text.includes(field), field);
    assert.doesNotMatch(text, /never-export-this|api_secret/);
  }
  for (const parameter of ["final_audit_event_persistence", "audit_event_guarded_recovery"]) {
    assert.ok(rulesCsv.includes(parameter));
    assert.ok(json.datasets.rules.some((row: Record<string, unknown>) => row.parameter === parameter));
  }
  assert.deepEqual(source, before);
});

test("v28 keeps legacy provider cause and missing event unknown even with a later reconciled healthy run", () => {
  const details = { stage: "AUDIT_EVENT", source: "ENGINE", root_code: "COINOPS_LIVE_EVENT_PERSIST_FAILED" };
  const source = input({ robot_v1_live_runs: [{ ...owner, id: "run-a", asset: "SOL", symbol: "SOLUSDT",
    status: "ACTIVE", slot_count: 25, last_error: null, last_reconciled_at: "2026-10-21T13:39:30Z",
    created_at: "2026-10-01T00:00:00Z" }], robot_v1_live_events: [{ ...owner, id: "later-observation",
    run_id: "run-a", event_type: "RECONCILED", event_key: "RECONCILED:2026-10-21T13:39",
    observed_at: "2026-10-21T13:39:00Z", details: { next: "KILL_SWITCH", strategy_version: "fixture-version" } }],
    robot_v1_live_alerts: [{ ...owner, id: "legacy-alert", run_id: "run-a", asset: "SOL", symbol: "SOLUSDT",
      code: "COINOPS_LIVE_EVENT_PERSIST_FAILED", details, severity: "CRITICAL",
      first_seen_at: "2026-10-21T13:28:00Z", last_seen_at: "2026-10-21T13:28:00Z", resolved_at: null }] });
  const before = structuredClone(source);
  const report = buildAuditReport(source, filters);
  const pack = buildReportPackage(report, filters, generatedAt);
  const json = JSON.parse(pack.files.find(file => file.name === "AUDITORIA_COMPLETA.json")!.content);
  const alert = json.datasets.live_execution.find((row: Record<string, unknown>) => row.id === "legacy-alert");
  assert.deepEqual(alert.details, details);
  assert.equal(alert.resolved_at, null);
  for (const field of ["audit_http_status", "audit_provider_code", "audit_event_key", "audit_attempts", "recovered_at"])
    assert.equal(Object.hasOwn(alert.details, field), false, field);
  const events = json.datasets.live_execution.filter((row: Record<string, unknown>) => row.row_type === "EVENT");
  assert.equal(events.length, 1);
  assert.equal(events[0].event_key, "RECONCILED:2026-10-21T13:39");
  assert.equal(events.some((row: Record<string, unknown>) => row.event_key === "RECONCILED:2026-10-21T13:28"), false);
  assert.ok(report.datasets.alerts.some(row => row.code === "COINOPS_LIVE_EVENT_PERSIST_FAILED" && row.is_active_issue === true));
  assert.deepEqual(source, before);
});
