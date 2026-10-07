import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditReport } from "./report-engine.ts";
import { REPORT_VERSION } from "./filters.ts";
test("report v17 distinguishes unsent evidence from a fill and declares the fenced recovery contract", () => {
  assert.equal(REPORT_VERSION, 19);
  const report = buildAuditReport({ sources: {}, incompleteSources: [], warnings: [],
    generatedAt: "2026-10-04T20:00:00Z", scope: { tenantId: "fixture", userId: "fixture" } },
    { start: "2026-10-04T00:00:00Z", end: "2026-10-05T00:00:00Z", assets: ["BTC", "SOL"], environments: ["REAL"] });
  const rule = report.datasets.rules.find(row => row.parameter === "unsent_entry_recovery");
  assert.equal(rule?.evidence_scope, "CURRENT_CODE_CONTRACT");
  assert.equal(rule?.value, "SIGNED_NO_FETCH_OR_FENCED_DURABLE_ABSENCE_AND_EXACT_GET");
  assert.match(String(rule?.notes), /não comprova/);
});
