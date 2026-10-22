import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditReport } from "./report-engine.ts";
import { REPORT_VERSION } from "./filters.ts";
test("v23 preserves physical cash and signed historical proof without claiming fill or resetting strategy", () => {
  assert.equal(REPORT_VERSION, 29);
  const report = buildAuditReport({ sources: {}, incompleteSources: [], warnings: [],
    generatedAt: "2026-10-07T14:00:00Z", scope: { tenantId: "fixture", userId: "fixture" } },
    { start: "2026-10-07T00:00:00Z", end: "2026-10-08T00:00:00Z", assets: ["BTC", "SOL"], environments: ["REAL"] });
  const cash = report.datasets.rules.find(row => row.parameter === "physical_spot_quote_balance");
  assert.equal(cash?.value, "FRESH_PHYSICAL_SPOT_BEFORE_NEW_BUY");
  assert.match(String(cash?.notes), /30s/);
  assert.match(String(cash?.notes), /preserva TP\/fills\/reconciliação/);
  assert.match(String(cash?.notes), /não gain\/fill/);
  const recovery = report.datasets.rules.find(row => row.parameter === "unsent_entry_recovery");
  assert.equal(recovery?.version, 3);
  assert.match(String(recovery?.notes), /arquivado, não apagado/);
  assert.match(String(recovery?.notes), /journal do runtime fixado/);
  const fees = report.datasets.rules.find(row => row.parameter === "physical_spot_bnb_fee_reserve");
  assert.equal(fees?.value, "FRESH_SPOT_BNB_HOLD_BEFORE_BUY_NO_TP_CHANGE");
  assert.match(String(fees?.notes), /estritamente >0\.00001/);
  assert.match(String(fees?.notes), /30s/);
  assert.match(String(fees?.notes), /preserva TP\/fills\/reconciliação/);
  assert.match(String(fees?.notes), /503 genérico e timeout não/);
  assert.match(String(fees?.source), /ENTRY_BNB_FEE_BALANCE_HOLD\/ENTRY_BNB_FEE_BALANCE_AVAILABLE/);
  assert.match(String(fees?.notes), /BNB_FEE_READ.*5min/);
  assert.match(String(fees?.notes), /resume exige evidência BNB fresca sob lease\/CAS/);
  assert.match(String(fees?.notes), /HOLD\/AVAILABLE não são gain\/fill/);
});
