import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditReport } from "./report-engine.ts";
import { REPORT_VERSION } from "./filters.ts";

test("v18 publishes the observation and recurrence contract without claiming missing evidence is zero", () => {
  assert.equal(REPORT_VERSION, 18);
  const report = buildAuditReport({ sources: {}, incompleteSources: [], warnings: [],
    generatedAt: "2026-10-05T12:00:00Z", scope: { tenantId: "fixture", userId: "fixture" } },
  { start: "2026-10-05T00:00:00Z", end: "2026-10-06T00:00:00Z", assets: ["BTC", "SOL"], environments: ["REAL"] });
  const rule = report.datasets.rules.find(row => row.parameter === "normal_trading_observation_retry");
  assert.equal(rule?.value, "READ_ONLY_BOUNDED_RETRY_WITH_PERSISTENT_CHECKPOINT");
  assert.equal(rule?.evidence_scope, "CURRENT_CODE_CONTRACT");
  assert.match(String(rule?.notes), /UNKNOWN, não 0%/);
  assert.match(String(rule?.notes), /RECURRENCE_REGRESSION/);
});
