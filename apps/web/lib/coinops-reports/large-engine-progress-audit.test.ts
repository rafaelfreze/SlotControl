import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditReport } from "./report-engine.ts";
import { largeEngineProgressAudit } from "./large-engine-progress-audit.ts";
import { REPORT_VERSION } from "./filters.ts";

test("v26 exports unfinished durable progress without credential/lease data or fabricated freshness", () => {
  assert.equal(REPORT_VERSION, 27);
  const observed = "2026-10-16T18:00:00Z", last = "2026-10-16T17:54:00Z";
  const cp = { contract: "LARGE_ENGINE_PROGRESS_V1", run_id: "run", phase: "CREDIT_SLOTS", slot_count: 100,
    observed_at: observed, started_at: "2026-10-16T17:55:00Z", settled_orders: 100,
    credited_gains: 70, operation_total: 100, lease_owner: "private-fence", apiSecret: "never-export" };
  const report = buildAuditReport({ sources: { robot_v1_live_runs: [{ id: "run", asset: "SOL", symbol: "SOLBRL",
    status: "ACTIVE", slot_count: 100, created_at: last, last_reconciled_at: last, reconciliation_checkpoint: cp }],
    robot_v1_live_events: [{ run_id: "run", event_type: "RECONCILIATION_PROGRESS", observed_at: observed, details: cp }] },
    incompleteSources: [], warnings: [], generatedAt: observed, scope: { tenantId: "fixture", userId: "fixture" } },
    { start: "2026-10-16T00:00:00Z", end: "2026-10-17T00:00:00Z", assets: ["SOL"], environments: ["REAL"] });
  const row = report.datasets.live_execution.find(item => item.row_type === "RUN")!;
  assert.equal(row.last_reconciled_at, last);
  assert.deepEqual(row.reconciliation_checkpoint, largeEngineProgressAudit(cp));
  const serialized = JSON.stringify(report.datasets.live_execution);
  assert.doesNotMatch(serialized, /private-fence|never-export|lease_owner|apiSecret/);
  const rule = report.datasets.rules.find(item => item.parameter === "large_engine_normal_reconciliation")!;
  assert.match(String(rule.notes), /não renova data sem progresso/);
  assert.match(String(rule.notes), /não autoriza POST|nem autoriza POST/);
  assert.match(String(rule.notes), /PARTIALLY_FILLED.*prova SQL exata/);
  assert.match(String(rule.notes), /trades_reconciled não é alterada/);
});
