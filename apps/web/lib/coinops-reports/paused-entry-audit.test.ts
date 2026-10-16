import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildAuditReport, type AuditFilters, type AuditInput } from "./report-engine.ts";
import { auditPausedEntryEvidence, pausedProtectionDetails } from "./paused-entry-audit.ts";
import { buildReportPackage } from "./report-package.ts";
import { REPORT_VERSION } from "./filters.ts";
import type { AuditRow } from "./trigger-audit.ts";

const at = "2026-10-13T12:00:00.000Z";
const scope = { operator_id: "operator-A", exchange_account_id: "account-A", trading_engine_id: "engine-A", executor_shard_id: "executor-02" };
const proof = { source: "OPERATOR_CONTROL", protection_verified: true, quantity_step: .001,
  open_positions: 1, resident_buy_count: 0, canceled_buy_count: 0 };
const filters: AuditFilters = { start: "2026-10-13T00:00:00.000Z", end: "2026-10-14T00:00:00.000Z", environments: ["REAL"], assets: ["SOL"] };
const rows = (): AuditRow[] => [{ ...scope, row_type: "RUN", id: "run-A", status: "PAUSED", asset: "SOL", symbol: "SOLBRL" },
  { ...scope, row_type: "EVENT", id: "pause", run_id: "run-A", event_type: "LIVE_PAUSED", observed_at: at, details: { ...proof } }];
const check = (values = rows(), incomplete: string[] = []) => auditPausedEntryEvidence(values, incomplete)[0]!;

test("pause audit scope is persisted attestation, never certification of present Binance or financial permission", () => {
  assert.equal(check().status, "PASS");
  assert.equal(check().evidence_scope, "PERSISTED_PAUSE_ATTESTATION_AND_ORDER_LEDGER_NOT_CURRENT_BINANCE");
  assert.ok(String(check().explanation).includes("não comprova Binance atual"));
  assert.equal(check(rows().slice(0, 1)).status, "WARNING");
  assert.equal(check(rows(), ["robot_v1_live_orders:timed_out"]).status, "WARNING");
});

test("pause proof derives its maximum from the run snapshot, not a global 25 cap", () => {
  const hundred = rows();
  hundred[0].slot_count = 100;
  (hundred[1].details as AuditRow).open_positions = 100;
  assert.equal(check(hundred).status, "PASS");
  (hundred[1].details as AuditRow).open_positions = 101;
  assert.equal(check(hundred).status, "FAIL");
  assert.equal(check([{ ...hundred[0], slot_count: 25 }, hundred[1]]).status, "FAIL");
});

test("pending/unknown order or unreconciled fill cannot certify a protected pause; resident BUY contradicts it", () => {
  for (const status of ["PREPARED", "UNKNOWN", "SUBMITTING", "PENDING_CANCEL"]) {
    assert.equal(check([...rows(), { ...scope, row_type: "ORDER", run_id: "run-A", status, side: "BUY" }]).status, "WARNING");
  }
  assert.equal(check([...rows(), { ...scope, row_type: "ORDER", run_id: "run-A", status: "FILLED", side: "SELL",
    executed_quantity: 1, trades_reconciled: false }]).status, "WARNING");
  assert.equal(check([...rows(), { ...scope, row_type: "ORDER", run_id: "run-A", status: "NEW", side: "BUY" }]).status, "FAIL");
  const invalid = rows(); (invalid[1]!.details as AuditRow).protection_verified = false;
  assert.equal(check(invalid).status, "FAIL");
  for (const patch of [{ resident_buy_count: -1 }, { open_positions: 26 }, { open_positions: 1.5 }, { quantity_step: 0 }]) {
    const values = rows(); Object.assign(values[1]!.details as AuditRow, patch); assert.equal(check(values).status, "FAIL");
  }
});

test("same symbol/account across engines and shards cannot borrow a sibling pause proof", () => {
  const values = rows(); values[1]!.trading_engine_id = "engine-B"; values[1]!.executor_shard_id = "executor-03";
  assert.equal(check(values).status, "WARNING");
  const siblingBuy = { ...scope, trading_engine_id: "engine-B", executor_shard_id: "executor-03",
    row_type: "ORDER", run_id: "run-A", side: "BUY", status: "NEW" };
  assert.equal(check([...rows(), siblingBuy]).status, "PASS", "sibling evidence is not attributed to engine A");
});

test("pause protection detail allowlist preserves counters and rejects credentials, nested data and fake zeros", () => {
  assert.deepEqual(pausedProtectionDetails({ ...proof, api_key: "private", headers: { authorization: "Bearer private" },
    unknownFinancialPayload: { amount: 9 }, source: { token: "private" } }), { protection_verified: true,
    quantity_step: .001, open_positions: 1, resident_buy_count: 0, canceled_buy_count: 0 });
  assert.deepEqual(pausedProtectionDetails({ protection_verified: "true", quantity_step: "n/a", open_positions: null }),
    { quantity_step: null, open_positions: null });
});

test("v24 exports pause contract, proof CSV/JSON and gain after pause without reset or hiding critical alerts", () => {
  assert.equal(REPORT_VERSION, 26);
  const input: AuditInput = { sources: { robot_v1_live_runs: [{ ...scope, id: "run-A", asset: "SOL", symbol: "SOLBRL",
    status: "PAUSED", created_at: at, last_reconciled_at: at }], robot_v1_live_events: [
    { ...scope, id: "pause", run_id: "run-A", event_type: "LIVE_PAUSED", observed_at: at, details: { ...proof, credential: "private" } },
    { ...scope, id: "reconcile", run_id: "run-A", event_type: "RECONCILED", observed_at: "2026-10-13T12:01:00Z",
      details: { ...proof, next: "ENTRIES_PAUSED", source: "LIVE_CONTROL", headers: { cookie: "private" } } },
    { ...scope, id: "gain", run_id: "run-A", slot_number: 1, event_type: "SLOT_PROFIT_CREDITED", observed_at: "2026-10-13T12:02:00Z",
      details: { tp_client_order_id: "tp-owned", buy_quote: 10, sell_quote: 11, gross_pnl_quote: 1,
        fees_quote: .1, net_pnl_quote: .9, dust_basis_quote: 0, balance_after_quote: 10.9 } }],
    robot_v1_live_orders: [{ ...scope, id: "buy", run_id: "run-A", slot_id: "slot-A", slot_number: 1,
      operation_sequence: 1, side: "BUY", purpose: "ENTRY", client_order_id: "buy-owned", status: "FILLED",
      executed_quantity: 1, trades_reconciled: true }, { ...scope, id: "tp", run_id: "run-A", slot_id: "slot-A", slot_number: 1,
      operation_sequence: 1, side: "SELL", purpose: "TP", client_order_id: "tp-owned", status: "FILLED",
      executed_quantity: 1, trades_reconciled: true }],
    robot_v1_live_fills: [{ ...scope, id: "fill-buy", order_id: "buy", filled_at: "2026-10-13T11:00:00Z" },
      { ...scope, id: "fill-tp", order_id: "tp", filled_at: "2026-10-13T12:01:30Z" }],
    robot_v1_live_alerts: [{ ...scope, id: "critical", asset: "SOL", severity: "CRITICAL", code: "COINOPS_TP_OWNERSHIP_UNKNOWN",
      first_seen_at: at, last_seen_at: at, resolved_at: null }] },
    scope: { tenantId: "fixture", userId: "fixture" }, warnings: [], incompleteSources: [], generatedAt: "2026-10-13T12:03:00Z" };
  const report = buildAuditReport(input, filters);
  const rule = report.datasets.rules.find((row) => row.parameter === "intentional_entry_pause_protection");
  assert.equal(rule?.value, "NEW_BUY_OFF_EXISTING_TP_FILLS_GAINS_CONTINUE");
  for (const term of ["não reseta", "não retoma automaticamente", "crédito de gain exatamente uma vez", "25 slots"])
    assert.ok(String(rule?.notes).toLowerCase().includes(term.toLowerCase()), term);
  const visibility = report.datasets.rules.find((row) => row.parameter === "paused_account_home_visibility");
  assert.ok(String(visibility?.notes).includes("reaparecem"));
  assert.ok(report.datasets.alerts.some((row) => row.code === "COINOPS_TP_OWNERSHIP_UNKNOWN" && row.is_active_issue === true));
  assert.equal(report.datasets.summary[0]!.gains, 1); assert.equal(report.datasets.summary[0]!.realized_pnl, .9);
  assert.equal(report.datasets.summary[0]!.active_errors, 1);
  assert.equal(report.datasets.live_execution.find((row) => row.id === "pause")?.event_type, "LIVE_PAUSED");
  assert.deepEqual(report.datasets.live_execution.find((row) => row.id === "reconcile")?.details,
    { ...proof, next: "ENTRIES_PAUSED", source: "LIVE_CONTROL" });
  const pack = buildReportPackage(report, filters, input.generatedAt, "fixture-sha");
  assert.equal(pack.manifest.report_version, 26);
  const json = pack.files.find((file) => file.name === "AUDITORIA_COMPLETA.json")!.content;
  const csv = pack.files.find((file) => file.name === "LIVE_EXECUTION.csv")!.content;
  for (const output of [json, csv]) {
    for (const field of ["LIVE_PAUSED", "RECONCILED", "protection_verified", "quantity_step", "open_positions", "resident_buy_count"])
      assert.ok(output.includes(field), field);
    assert.ok(!output.includes("private"));
  }
});

test("pause report never adds an exchange/financial read or account preference collection", () => {
  const source = readFileSync(new URL("./paused-entry-audit.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fetch\(|createOrder|cancelOrder|createServiceRoleClient|resumeLiveRun|from\(/);
});

test("explicit canonical resume stays auditable with exact engine/run identity, not a new financial operation", () => {
  const generatedAt = "2026-10-13T12:03:00Z";
  const report = buildAuditReport({ sources: { robot_v1_live_runs: [{ ...scope, id: "run-A", asset: "SOL",
    symbol: "SOLBRL", status: "ACTIVE", created_at: at, last_reconciled_at: at }], robot_v1_live_events: [
    { ...scope, id: "resume", run_id: "run-A", event_type: "LIVE_RESUMED", observed_at: at,
      details: { source: "OPERATOR_CONTROL", protection_verified: true } }],
  }, scope: { tenantId: "fixture", userId: "fixture" }, warnings: [], incompleteSources: [], generatedAt }, filters);
  const resume = report.datasets.live_execution.find((row) => row.id === "resume");
  assert.ok(resume);
  assert.equal(resume.event_type, "LIVE_RESUMED"); assert.equal(resume.run_id, "run-A");
  for (const key of ["operator_id", "exchange_account_id", "trading_engine_id", "executor_shard_id"] as const)
    assert.equal(resume[key], scope[key]);
  const pack = buildReportPackage(report, filters, generatedAt, "fixture-sha");
  for (const filename of ["LIVE_EXECUTION.csv", "AUDITORIA_COMPLETA.json"])
    assert.ok(pack.files.find((file) => file.name === filename)?.content.includes("LIVE_RESUMED"));
});
