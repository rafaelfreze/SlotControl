import assert from "node:assert/strict";
import { test } from "node:test";
import { auditNextBuyCapitalRefresh } from "./next-buy-capital-refresh-audit.ts";
import { buildAuditReport } from "./report-engine.ts";
import { buildReportPackage } from "./report-package.ts";
import type { AuditRow } from "./trigger-audit.ts";

const scope = { operator_id: "operator", exchange_account_id: "account", trading_engine_id: "engine", run_id: "run", slot_number: 2 };
const planAt = "2026-09-28T03:00:00Z", doneAt = "2026-09-28T03:00:30Z";
const payload = { refresh_key: "old:new:0.49", old_client_order_id: "old", new_client_order_id: "new",
  old_quantity: .13, new_quantity: .49, price: 119.79, old_notional_quote: 15.5727, new_notional_quote: 58.6971,
  slot_balance_quote: 59.76, quote_asset: "USDT", operation_sequence: 1, capital_sources: ["allocation"] };
function fixture(): AuditRow[] {
  return [
    { ...scope, row_type: "EVENT", id: "plan", event_type: "NEXT_BUY_CAPITAL_REFRESH_PLANNED", observed_at: planAt, details: { ...payload } },
    { ...scope, row_type: "EVENT", id: "confirmed", event_type: "NEXT_BUY_CAPITAL_REFRESH_CONFIRMED", observed_at: doneAt,
      details: { ...payload, old_status: "CANCELED", old_executed_quantity: 0, new_status: "NEW", exchange_reconciled_at: doneAt } },
    { ...scope, row_type: "ORDER", id: "old-order", client_order_id: "old", side: "BUY", purpose: "ENTRY", operation_sequence: 1,
      price: 119.79, requested_quantity: .13, status: "CANCELED", executed_quantity: 0, trades_reconciled: true },
    { ...scope, row_type: "ORDER", id: "new-order", client_order_id: "new", side: "BUY", purpose: "ENTRY", operation_sequence: 1,
      price: 119.79, requested_quantity: .49, status: "NEW", executed_quantity: 0, trades_reconciled: true },
  ];
}
const result = (rows: AuditRow[], incomplete: string[] = []) => auditNextBuyCapitalRefresh(rows, incomplete)[0]!;

test("refresh report passes only the persisted owned zero-fill same-price replacement chain", () => {
  const check = result(fixture());
  assert.equal(check.status, "PASS");
  assert.equal(check.refresh_key, payload.refresh_key);
  assert.match(String(check.evidence_scope), /NOT_CURRENT_BINANCE/);
});

test("refresh report: absent occurrence, incomplete source, missing fields and crash remain WARNING", () => {
  assert.equal(result([]).status, "WARNING");
  assert.equal(result(fixture().filter((row) => row.event_type !== "NEXT_BUY_CAPITAL_REFRESH_CONFIRMED")).status, "WARNING");
  assert.equal(result(fixture().filter((row) => row.event_type !== "NEXT_BUY_CAPITAL_REFRESH_PLANNED")).status, "WARNING");
  assert.equal(result(fixture(), ["robot_v1_live_events:row_limit_20000"]).status, "WARNING");
  for (const field of ["old_executed_quantity", "exchange_reconciled_at", "capital_sources", "slot_balance_quote", "refresh_key"]) {
    const rows = fixture(); delete (rows[1]!.details as AuditRow)[field];
    assert.equal(result(rows).status, "WARNING", field);
  }
  const rows = fixture(); delete rows[2]!.trades_reconciled;
  assert.equal(result(rows).status, "WARNING");
});

test("refresh report fails proven partial-fill, price/quantity drift, wrong side or operation", () => {
  for (const mutation of [
    (rows: AuditRow[]) => { rows[2]!.executed_quantity = .001; },
    (rows: AuditRow[]) => { rows[2]!.status = "FILLED"; },
    (rows: AuditRow[]) => { rows[2]!.trades_reconciled = false; },
    (rows: AuditRow[]) => { rows[3]!.price = 120; },
    (rows: AuditRow[]) => { rows[3]!.requested_quantity = .5; },
    (rows: AuditRow[]) => { rows[3]!.side = "SELL"; rows[3]!.purpose = "TP"; },
    (rows: AuditRow[]) => { rows[3]!.operation_sequence = 2; },
    (rows: AuditRow[]) => { (rows[1]!.details as AuditRow).old_executed_quantity = .001; },
    (rows: AuditRow[]) => { (rows[1]!.details as AuditRow).new_client_order_id = "old"; },
  ]) {
    const rows = fixture(); mutation(rows);
    assert.equal(result(rows).status, "FAIL");
    assert.equal(result(rows, ["robot_v1_live_orders:unavailable"]).status, "FAIL");
  }
});

test("refresh report never borrows another account, engine, run or slot order", () => {
  for (const field of ["operator_id", "exchange_account_id", "trading_engine_id", "run_id", "slot_number"]) {
    const rows = fixture(); rows[3]![field] = "another";
    assert.equal(result(rows).status, "WARNING", field);
  }
  const rows = fixture(); rows[1]!.trading_engine_id = "another";
  assert.equal(auditNextBuyCapitalRefresh(rows, []).length, 2);
  assert.ok(auditNextBuyCapitalRefresh(rows, []).every((row) => row.status === "WARNING"));
});

test("refresh report preserves historical proof after replacement fills or is canceled later", () => {
  for (const status of ["FILLED", "CANCELED", "PARTIALLY_FILLED"]) {
    const rows = fixture(); rows[3]!.status = status; rows[3]!.executed_quantity = .49;
    assert.equal(result(rows).status, "PASS");
  }
  const duplicate = fixture(); duplicate.push({ ...duplicate[1], id: "duplicate" });
  assert.equal(result(duplicate).status, "FAIL");
});

test("refresh report remains native for BTC/SOL and BRL/USDT and exports complete evidence", () => {
  for (const asset of ["BTC", "SOL"] as const) for (const quote of ["BRL", "USDT"]) {
    const rows = fixture();
    for (const row of rows) { row.asset = asset; row.quote_asset = quote; if (row.details) (row.details as AuditRow).quote_asset = quote; }
    const generatedAt = "2026-09-28T03:01:00Z";
    const filters = { start: "2026-09-28T00:00:00Z", end: "2026-09-29T00:00:00Z", assets: [asset], environments: ["REAL" as const] };
    const report = buildAuditReport({ generatedAt, scope: { tenantId: "tenant", userId: "user" }, warnings: [], incompleteSources: [], sources: {
      robot_v1_live_runs: [{ id: "run", asset, symbol: `${asset}${quote}` }],
      robot_v1_live_events: rows.filter((row) => row.row_type === "EVENT"),
      robot_v1_live_orders: rows.filter((row) => row.row_type === "ORDER"),
    } }, filters);
    assert.equal(report.datasets.checks.find((row) => row.code === "NEXT_BUY_CAPITAL_REFRESH_AUDIT")?.status, "PASS");
    assert.ok(report.datasets.rules.some((row) => row.parameter === "next_buy_applied_capital_refresh"));
    const pack = buildReportPackage(report, filters, generatedAt);
    const csv = pack.files.find((file) => file.name === "LIVE_EXECUTION.csv")!.content;
    assert.match(csv, /NEXT_BUY_CAPITAL_REFRESH_CONFIRMED/);
    for (const field of Object.keys(payload)) assert.ok(csv.includes(field), field);
    assert.equal(pack.manifest.report_version, 22);
    assert.equal(pack.manifest.financial_writes_from_export, 0);
  }
});
