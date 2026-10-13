import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditReport } from "./report-engine.ts";
test("account funding diagnostic remains a native-currency read-only technical rule, not financial permission", () => {
  const report = buildAuditReport({ sources: {}, incompleteSources: [], warnings: [],
    generatedAt: "2026-10-13T13:00:00Z", scope: { tenantId: "fixture", userId: "fixture" } },
    { start: "2026-10-13T00:00:00Z", end: "2026-10-14T00:00:00Z", assets: ["BTC", "SOL"], environments: ["REAL"] });
  const rule = report.datasets.rules.find((row) => row.parameter === "account_full_operation_funding");
  assert.equal(rule?.value, "READ_ONLY_ACCOUNT_NATIVE_PRINCIPAL_COVERAGE");
  for (const text of ["contado uma vez", "todos os shards", "25 slots", "PREPARED", "não é novo gate", "não cria/cancela", "não provisão infinita"])
    assert.ok(String(rule?.notes).includes(text), text);
});
