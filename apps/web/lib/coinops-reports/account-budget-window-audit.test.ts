import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditReport } from "./report-engine.ts";

test("REAL export documents read-only window scheduling without inventing a financial recovery", () => {
  const input = { sources: {}, incompleteSources: [], warnings: [], generatedAt: "2026-10-13T11:14:23Z",
    scope: { tenantId: "fixture", userId: "fixture" } };
  const filters = { start: "2026-10-13T00:00:00Z", end: "2026-10-14T00:00:00Z",
    assets: ["BTC", "SOL"] as ("BTC" | "SOL")[], environments: ["REAL"] as ("REAL" | "SHADOW")[] };
  const report = buildAuditReport(input, filters);
  const rule = report.datasets.rules.find(row => row.parameter === "account_order_budget_window_retry");
  assert.equal(rule?.value, "VALIDATED_WINDOW_ALIGNED_READ_ONLY_RETRY");
  for (const text of [/serverTime-observedAt/, /5,5s/, /3 leituras\/35s/, /4s/, /Não prolonga amostra/,
    /não comprova recovery do Watchdog/, /financeiro ambíguo permanecem fail-closed/]) assert.match(String(rule?.notes), text);
  assert.equal(rule?.evidence_scope, "CURRENT_CODE_CONTRACT");
  assert.ok(!buildAuditReport(input, { ...filters, environments: ["SHADOW"] }).datasets.rules
    .some(row => row.parameter === "account_order_budget_window_retry"));
});
