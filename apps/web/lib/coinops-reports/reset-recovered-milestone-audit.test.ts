import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditReport, type AuditInput } from "./report-engine.ts";
import { buildReportPackage } from "./report-package.ts";
import { REPORT_VERSION } from "./filters.ts";

const generatedAt = "2026-10-22T15:40:00.000Z";
const filters = { start: "2026-10-01T00:00:00Z", end: "2026-10-23T00:00:00Z",
  assets: ["BTC"] as ["BTC"], environments: ["REAL"] as ["REAL"] };
const owner = { operator_id: "operator-a", exchange_account_id: "account-a",
  trading_engine_id: "engine-a", executor_shard_id: "executor-01", quote_asset: "BRL" };
const previous = "11111111-1111-4111-8111-111111111111";
const successor = "22222222-2222-4222-8222-222222222222";
const eventKey = `RESET_RECOVERED:${previous}`;
const observedAt = "2026-10-02T12:01:00.000Z";
const historicalDetails = { previous_run_id: previous, open_positions: 1, resident_buy_count: 1 };
const input = (sources: AuditInput["sources"] = {}): AuditInput => ({ sources,
  incompleteSources: [], warnings: [], generatedAt, scope: { tenantId: "fixture", userId: "fixture" } });
function sources(): AuditInput["sources"] {
  return { robot_v1_live_runs: [
    { ...owner, id: previous, asset: "BTC", symbol: "BTCBRL", slot_count: 25, status: "COMPLETED",
      created_at: "2026-10-01T00:00:00Z", completed_at: "2026-10-02T12:00:00Z",
      config_snapshot: { slot_count: 25, report_version: 27, gain_rate: .055 } },
    { ...owner, id: successor, previous_run_id: previous, reset_idempotency_key: `RESET:${previous}:fixture`,
      asset: "BTC", symbol: "BTCBRL", slot_count: 25, status: "ACTIVE", last_error: null,
      created_at: "2026-10-02T12:00:01Z", last_reconciled_at: "2026-10-22T15:39:40Z",
      config_snapshot: { slot_count: 25, report_version: 28, gain_rate: .055, normal_spacing_rate: .02 } }],
    robot_v1_live_slots: Array.from({ length: 25 }, (_, index) => ({ ...owner, id: `slot-${index + 1}`,
      run_id: successor, slot_number: index + 1, entry_state: index < 5 ? "OPEN" : "PLANNED" })),
    robot_v1_live_events: [{ ...owner, id: "historical-milestone", run_id: successor, event_type: "RESET_RECOVERED",
      event_key: eventKey, observed_at: observedAt, slot_number: null, details: historicalDetails },
    { ...owner, id: "current-reconciliation", run_id: successor, event_type: "RECONCILED",
      event_key: "RECONCILED:2026-10-22T15:39", observed_at: "2026-10-22T15:39:30Z", slot_number: null,
      details: { next: "KILL_SWITCH", strategy_version: "fixture-version", open_positions: 5, resident_buy_count: 1 } }],
    robot_v1_live_alerts: [{ ...owner, id: "typed-mismatch", run_id: successor, asset: "BTC", symbol: "BTCBRL",
      code: "COINOPS_LIVE_EVENT_PERSIST_FAILED", severity: "CRITICAL", resolved_at: null,
      first_seen_at: "2026-10-22T15:28:00Z", last_seen_at: "2026-10-22T15:28:00Z",
      details: { stage: "AUDIT_EVENT", source: "ENGINE", root_code: "COINOPS_LIVE_EVENT_PERSIST_FAILED",
        audit_phase: "READBACK", audit_reason: "READBACK_MISMATCH", audit_event_type: "RESET_RECOVERED",
        audit_event_key: eventKey, audit_attempts: 1, audit_http_status: null, audit_provider_code: null } }] };
}

test("v29 declares first-writer reset milestone and narrow typed recovery without weakening generic audit comparisons", () => {
  assert.equal(REPORT_VERSION, 30);
  const report = buildAuditReport(input(), filters);
  const milestone = report.datasets.rules.find(row => row.parameter === "reset_recovered_milestone_persistence")!;
  const recovery = report.datasets.rules.find(row => row.parameter === "reset_recovered_mismatch_guarded_recovery")!;
  const observation = report.datasets.rules.find(row => row.parameter === "reset_recovery_milestone_observation")!;
  assert.equal(milestone.value, "VALIDATED_FIRST_WRITER_MILESTONE_NO_CURRENT_COUNT_REPLAY");
  assert.equal(recovery.value, "EXACT_TYPED_MILESTONE_PREDECESSOR_SUCCESSOR_AND_FINANCE_UNDER_CAS");
  assert.equal(observation.value, "BOUNDED_LEDGER_GET_CHECKPOINT_AND_PROVEN_STALE_RECOVERY");
  for (const rule of [milestone, recovery, observation]) {
    assert.equal(rule.version, 1);
    assert.equal(rule.environment, "REAL");
    assert.equal(rule.evidence_scope, "CURRENT_CODE_CONTRACT");
  }
  for (const expression of [/first-writer do successor run/, /escopo completo/, /shape exata/,
    /de 1 até slot_count/, /uma BUY residente/, /não escreve nem compara contagem atual com a histórica/,
    /comparação integral estrita no helper genérico/, /Nunca UPDATE do histórico/])
    assert.match(String(milestone.notes), expression);
  for (const expression of [/stage AUDIT_EVENT/, /audit_phase READBACK/, /audit_reason READBACK_MISMATCH/,
    /audit_event_type RESET_RECOVERED/, /explicitamente null/, /antes de first_seen e last_seen/,
    /predecessor COMPLETED/, /successor único ACTIVE/, /reset_idempotency_key exatos/,
    /RECONCILED novo e fresco/, /duas vezes/, /sob lease e CAS/, /Nenhum mismatch genérico/,
    /BLOCKED_SAFE somente no engine afetado/, /não executa recovery/])
    assert.match(String(recovery.notes), expression);
  for (const expression of [/2 conjuntos completos de até 5s/, /intervalo de 250ms/, /checkpoint normal/,
    /COINOPS_LIVE_LEDGER_READ_STALE/, /root_code COINOPS_LIVE_LEDGER_READ_UNAVAILABLE/,
    /read_path ledger\/reset_recovery_milestone exatos/, /antes e depois/, /marco pode ser posterior ao incidente/,
    /READBACK_MISMATCH, que exige marco anterior/, /não executa retry\/recovery/])
    assert.match(String(observation.notes), expression);
  const shadow = buildAuditReport(input(), { ...filters, environments: ["SHADOW"] });
  assert.ok(!shadow.datasets.rules.some(row => [milestone.parameter, recovery.parameter, observation.parameter].includes(row.parameter)));
});

test("v29 CSV/JSON keep historical milestone count one distinct from five current OPEN positions and preserve old versions", () => {
  const source = input(sources()), before = structuredClone(source);
  const report = buildAuditReport(source, filters);
  const pack = buildReportPackage(report, filters, generatedAt, "fixture-sha");
  assert.equal(pack.manifest.report_version, 30);
  assert.equal(pack.manifest.schema_version, "coinops/robot-v1/reports-v30-controlled-handoffs");
  assert.equal(pack.manifest.financial_writes_from_export, 0);
  assert.equal(pack.files.length, 27);
  const json = JSON.parse(pack.files.find(file => file.name === "AUDITORIA_COMPLETA.json")!.content);
  const live = json.datasets.live_execution as Record<string, unknown>[];
  const milestone = live.find(row => row.id === "historical-milestone")!;
  assert.deepEqual(milestone.details, historicalDetails);
  assert.equal(milestone.event_key, eventKey);
  assert.equal(milestone.observed_at, observedAt);
  assert.equal(milestone.run_id, successor);
  for (const [key, value] of Object.entries(owner)) assert.equal(milestone[key], value);
  assert.equal(live.filter(row => row.row_type === "SLOT" && row.entry_state === "OPEN").length, 5);
  assert.equal((live.find(row => row.id === "current-reconciliation")!.details as Record<string, unknown>).open_positions, 5);
  assert.equal((live.find(row => row.id === successor)!.config_snapshot as Record<string, unknown>).report_version, 28);
  assert.equal((live.find(row => row.id === previous)!.config_snapshot as Record<string, unknown>).report_version, 27);
  assert.equal(live.filter(row => row.event_key === eventKey).length, 1);
  const csv = pack.files.find(file => file.name === "LIVE_EXECUTION.csv")!.content;
  for (const value of ["historical-milestone", eventKey, observedAt, "open_positions", "resident_buy_count",
    "current-reconciliation", "READBACK_MISMATCH", "audit_http_status", "audit_provider_code"])
    assert.ok(csv.includes(value), value);
  const rulesCsv = pack.files.find(file => file.name === "11_REGRAS_CONFIGURACAO.csv")!.content;
  for (const parameter of ["reset_recovered_milestone_persistence", "reset_recovered_mismatch_guarded_recovery",
    "reset_recovery_milestone_observation"]) {
    assert.ok(rulesCsv.includes(parameter));
    assert.ok(json.datasets.rules.some((row: Record<string, unknown>) => row.parameter === parameter));
  }
  assert.deepEqual(source, before);
});

test("v29 preserves milestone read-outage checkpoint diagnosis without inventing absent events or stale recovery", () => {
  const readDetails = { stage: "AUDIT_EVENT", source: "ENGINE", root_code: "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE",
    read_path: "ledger/reset_recovery_milestone", read_attempts: 2, http_status: 503, provider_code: "PGRST003" };
  const rows = sources();
  rows.robot_v1_live_events = [];
  rows.robot_v1_live_alerts = [{ ...owner, id: "stale-read", run_id: successor, asset: "BTC", symbol: "BTCBRL",
    code: "COINOPS_LIVE_LEDGER_READ_STALE", severity: "CRITICAL", details: readDetails,
    first_seen_at: "2026-10-22T15:28:00Z", last_seen_at: "2026-10-22T15:28:00Z", resolved_at: null }];
  const source = input(rows), before = structuredClone(source);
  const report = buildAuditReport(source, filters);
  const pack = buildReportPackage(report, filters, generatedAt);
  const json = JSON.parse(pack.files.find(file => file.name === "AUDITORIA_COMPLETA.json")!.content);
  const alert = json.datasets.live_execution.find((row: Record<string, unknown>) => row.id === "stale-read");
  assert.deepEqual(alert.details, readDetails);
  assert.equal(alert.resolved_at, null);
  assert.equal(json.datasets.live_execution.some((row: Record<string, unknown>) => row.row_type === "EVENT"), false);
  assert.ok(report.datasets.alerts.some(row => row.code === "COINOPS_LIVE_LEDGER_READ_STALE" && row.is_active_issue === true));
  const csv = pack.files.find(file => file.name === "LIVE_EXECUTION.csv")!.content;
  for (const value of ["COINOPS_LIVE_LEDGER_READ_STALE", "ledger/reset_recovery_milestone", "read_attempts", "PGRST003"])
    assert.ok(csv.includes(value), value);
  assert.deepEqual(source, before);
});

test("v29 permits proven absence only in the stale GET contract, never by empty or incomplete report data", () => {
  for (const incomplete of [false, true]) {
    const rows = sources();
    rows.robot_v1_live_events = [];
    const source = input(rows);
    if (incomplete) source.incompleteSources = ["robot_v1_live_events:provider_unavailable"];
    const before = structuredClone(source);
    const report = buildAuditReport(source, filters);
    const observation = report.datasets.rules.find(row => row.parameter === "reset_recovery_milestone_observation")!;
    assert.equal(observation.evidence_scope, "CURRENT_CODE_CONTRACT");
    for (const expression of [/Marco válido ou ausência confirmada por GET completo nos dois passes/,
      /Ausência por erro, página incompleta ou dado inconclusivo nunca qualifica/,
      /Recuperação não insere o marco ausente/, /próximo tick normal protegido/])
      assert.match(String(observation.notes), expression);
    const mismatch = report.datasets.rules.find(row => row.parameter === "reset_recovered_mismatch_guarded_recovery")!;
    assert.match(String(mismatch.notes), /Exige marco first-writer válido observado antes de first_seen e last_seen/);
    assert.doesNotMatch(String(mismatch.notes), /ausência confirmada/);
    assert.equal(report.datasets.live_execution.some(row => row.row_type === "EVENT"), false);
    assert.equal(report.datasets.live_execution.find(row => row.id === "typed-mismatch")!.resolved_at, null);
    assert.equal(report.datasets.checks.some(row => row.status === "PASS" && String(row.check).includes("RESET_MILESTONE")), false);
    assert.deepEqual(source, before);
  }
});

test("v29 does not close a typed reset mismatch or invent recovery from historical milestone and fresh reconciliation alone", () => {
  const source = input(sources()), before = structuredClone(source);
  const report = buildAuditReport(source, filters);
  const alert = report.datasets.live_execution.find(row => row.id === "typed-mismatch")!;
  assert.equal(alert.resolved_at, null);
  assert.ok(report.datasets.alerts.some(row => row.code === "COINOPS_LIVE_EVENT_PERSIST_FAILED" && row.is_active_issue === true));
  assert.equal(report.datasets.live_execution.some(row => row.event_type === "LIVE_RESUMED"), false);
  assert.equal(Object.hasOwn(alert.details as Record<string, unknown>, "recovered_at"), false);
  const guard = report.datasets.rules.find(row => row.parameter === "audit_event_guarded_recovery")!;
  assert.equal(guard.version, 2);
  assert.match(String(guard.notes), /mismatch genérico permanece fechado/);
  assert.deepEqual(source, before);
});

test("v29 exports only the persisted recovery event and strips private data without rewriting first-writer history", () => {
  const rows = sources();
  rows.robot_v1_live_events.push({ ...owner, id: "verified-resume", run_id: successor, event_type: "LIVE_RESUMED",
    event_key: "LIVE_RESUMED:fixture", observed_at: "2026-10-22T15:39:45Z", slot_number: null,
    details: { executor_version: "fixture-version", source: "VERIFIED_READ_RECOVERY",
      recovered_alert_code: "COINOPS_LIVE_EVENT_PERSIST_FAILED", api_secret: "never-export-this" } });
  const source = input(rows), before = structuredClone(source);
  const report = buildAuditReport(source, filters);
  const pack = buildReportPackage(report, filters, generatedAt);
  const jsonText = pack.files.find(file => file.name === "AUDITORIA_COMPLETA.json")!.content;
  const json = JSON.parse(jsonText);
  const resume = json.datasets.live_execution.find((row: Record<string, unknown>) => row.id === "verified-resume");
  assert.deepEqual(resume.details, { executor_version: "fixture-version", source: "VERIFIED_READ_RECOVERY",
    recovered_alert_code: "COINOPS_LIVE_EVENT_PERSIST_FAILED" });
  assert.equal(json.datasets.live_execution.find((row: Record<string, unknown>) => row.id === "historical-milestone").details.open_positions, 1);
  assert.equal(json.datasets.live_execution.find((row: Record<string, unknown>) => row.id === "typed-mismatch").resolved_at, null);
  for (const text of [jsonText, pack.files.find(file => file.name === "LIVE_EXECUTION.csv")!.content])
    assert.doesNotMatch(text, /api_secret|never-export-this/);
  assert.deepEqual(source, before);
});
