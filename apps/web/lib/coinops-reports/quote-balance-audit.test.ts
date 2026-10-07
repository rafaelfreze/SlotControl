import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditReport } from "./report-engine.ts";
import { REPORT_VERSION } from "./filters.ts";
test("v21 preserves physical cash and signed historical proof without claiming fill or resetting strategy", () => {
  assert.equal(REPORT_VERSION, 21);
  const report = buildAuditReport({ sources: {}, incompleteSources: [], warnings: [],
    generatedAt: "2026-10-07T14:00:00Z", scope: { tenantId: "fixture", userId: "fixture" } },
    { start: "2026-10-07T00:00:00Z", end: "2026-10-08T00:00:00Z", assets: ["BTC", "SOL"], environments: ["REAL"] });
  const cash = report.datasets.rules.find(row => row.parameter === "physical_spot_quote_balance");
  assert.equal(cash?.value, "FRESH_PHYSICAL_SPOT_BEFORE_NEW_BUY");
  assert.match(String(cash?.notes), /30s/);
  assert.match(String(cash?.notes), /preserva TP\/fills\/reconciliação/);
  assert.match(String(cash?.notes), /não gain\/fill/);
  const recovery = report.datasets.rules.find(row => row.parameter === "unsent_entry_recovery");
  assert.equal(recovery?.version, 2);
  assert.match(String(recovery?.notes), /arquivado, não apagado/);
  assert.match(String(recovery?.notes), /journal do runtime fixado/);
});
