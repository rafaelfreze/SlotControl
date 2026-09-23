import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditReport, type AuditFilters, type AuditInput } from "./report-engine.ts";
import { testnetClientOrderId } from "../execution/robot-v1-testnet-cycle.ts";
import { REPORT_FILES } from "./report-package.ts";
import { buildCsv } from "./export-format.ts";

const at = (minute: string) => `2026-09-23T12:${minute}:00Z`;
const owner = { tenant_id: "tenant", user_id: "user", product_id: "product" };
const run = "run-order-snapshot";
const cid = (slot: number, side: "BUY" | "SELL") => testnetClientOrderId(run, "SOL", slot, side, 1);
const filters: AuditFilters = { start: at("00"), end: at("11"), assets: ["SOL"], environments: ["TESTNET"] };
function fixture(): AuditInput {
  const order = (id: string, slot: number, side: "BUY" | "SELL", status: string, price: number, executed: number) => ({
    ...owner, id, run_id: run, slot_id: `s${slot}`, slot_number: slot, side, purpose: side === "SELL" ? "TP" : "ENTRY",
    revision: 1, operation_sequence: 1, client_order_id: cid(slot, side), exchange_order_id: id, status, price,
    requested_quantity: 1, requested_quote: null, executed_quantity: executed, cumulative_quote: executed * price,
    fee_base: 0, fee_quote: 0, fee_other: [], trades_reconciled: true, created_at: at("00"), updated_at: at("09"),
  });
  const orders = [order("buy", 1, "BUY", "FILLED", 10, 1), order("tp", 1, "SELL", "NEW", 10.05, 0),
    order("next", 2, "BUY", "NEW", 9.9, 0), order("old1", 3, "BUY", "CANCELED", 9.8, 0),
    order("old2", 4, "BUY", "CANCELED", 9.7, 0)];
  return { sources: {
    robot_v1_testnet_runs: [{ ...owner, id: run, asset: "SOL", symbol: "SOLUSDC", status: "ACTIVE",
      created_at: at("00"), slot_notional_usdc: 10, gain_rate: 0.005, entry_spacing: 0.01, last_reconciled_at: at("10") }],
    robot_v1_testnet_slots: Array.from({ length: 25 }, (_, i) => ({ ...owner, id: `s${i + 1}`, run_id: run,
      slot_number: i + 1, entry_state: i === 0 ? "OPEN" : i === 1 ? "ARMED" : "PLANNED", operation_sequence: 1,
      balance_usdc: 10, gain_count: 0, net_profit_usdc: 0, target_buy_price: 10 - i * 0.1 })),
    robot_v1_testnet_orders: orders,
    robot_v1_testnet_events: orders.map((o) => ({ ...owner, id: `${o.id}:state`, run_id: run, slot_number: o.slot_number,
      event_type: o.id === "buy" ? "BUY_FILLED" : `${o.side}_NEW`, event_key: `${o.id}:state`, observed_at: at("01"),
      details: { clientOrderId: o.client_order_id } })),
  }, incompleteSources: [], warnings: [], generatedAt: at("10"), scope: { tenantId: "tenant", userId: "user" } };
}

test("current report cannot resurrect two canceled BUYs from older NEW events", () => {
  const input = fixture(), unchanged = JSON.stringify(input);
  const report = buildAuditReport(input, filters), summary = report.datasets.summary[0]!;
  assert.equal(summary.open_operations, 1);
  assert.equal(summary.orders_open, 2);
  assert.equal(summary.committed_capital, 19.9);
  assert.equal(summary.capital_end, 250);
  assert.equal(summary.free_capital, 230.1);
  for (const row of report.datasets.orders.filter((o) => ["old1", "old2"].includes(String(o.local_order_id)))) {
    assert.equal(row.status_at_period_end, "CANCELED");
    assert.equal(row.status_at_period_end_basis, "PERSISTED_SNAPSHOT_AT_OR_BEFORE_CUTOFF");
  }
  assert.equal(JSON.stringify(input), unchanged);
});

test("historical cutoff cannot borrow the later cancellation snapshot", () => {
  const report = buildAuditReport(fixture(), { ...filters, end: at("08") });
  assert.equal(report.datasets.summary[0]!.orders_open, 4);
  assert.equal(report.datasets.summary[0]!.committed_capital, 39.4);
  const row = report.datasets.orders.find((o) => o.local_order_id === "old1")!;
  assert.equal(row.status, "CANCELED");
  assert.equal(row.status_at_period_end, "NEW");
  assert.equal(row.status_at_period_end_basis, "IMMUTABLE_ORDER_EVENT_BEFORE_CUTOFF");
});

test("cutoff is exclusive for both snapshots and events", () => {
  const report = buildAuditReport(fixture(), { ...filters, end: at("09") });
  assert.equal(report.datasets.summary[0]!.orders_open, 4);
  const input = fixture();
  input.sources.robot_v1_testnet_events.push({ ...owner, id: "canceled", run_id: run, slot_number: 3,
    event_type: "BUY_CANCELED", observed_at: at("09"), details: { clientOrderId: cid(3, "BUY") } });
  assert.equal(buildAuditReport(input, { ...filters, end: at("09") }).datasets.summary[0]!.orders_open, 4);
});

test("later immutable status and semantic cancellation events beat an older snapshot", () => {
  for (const eventType of ["BUY_CANCELED", "BUY_EXPIRED_IN_MATCH", "ATH_OWNED_BUY_CANCELLED",
    "MONTHLY_TARGET_HOLD", "BUY_REPLACED_FOR_REENTRY", "OLD_NEXT_BUY_CANCELED"]) {
    const input = fixture();
    Object.assign(input.sources.robot_v1_testnet_orders.find((o) => o.id === "old1")!, { status: "NEW", updated_at: at("02") });
    input.sources.robot_v1_testnet_events.push({ ...owner, id: "cancel-proof", run_id: run, slot_number: 3,
      event_type: eventType, observed_at: at("03"), details: { clientOrderId: cid(3, "BUY") } });
    const row = buildAuditReport(input, { ...filters, end: at("08") }).datasets.orders.find((o) => o.local_order_id === "old1")!;
    assert.equal(row.status_at_period_end, eventType === "BUY_EXPIRED_IN_MATCH" ? "EXPIRED_IN_MATCH" : "CANCELED", eventType);
    assert.equal(row.status_at_period_end_basis, "IMMUTABLE_ORDER_EVENT_BEFORE_CUTOFF");
  }
});

test("missing historical evidence stays UNKNOWN; another run cannot supply order status", () => {
  const input = fixture();
  input.sources.robot_v1_testnet_events = input.sources.robot_v1_testnet_events.filter((e) => e.slot_number !== 3);
  input.sources.robot_v1_testnet_events.push({ ...owner, id: "foreign", run_id: "another-run", slot_number: 3,
    event_type: "BUY_NEW", observed_at: at("03"), details: { clientOrderId: cid(3, "BUY") } });
  const report = buildAuditReport(input, { ...filters, end: at("08") });
  assert.equal(report.datasets.orders.find((o) => o.local_order_id === "old1")!.status_at_period_end, "UNKNOWN");
  assert.equal(report.datasets.summary[0]!.committed_capital, null);
});

test("04_ORDENS CSV separates current snapshot from historical status and evidence", () => {
  const definition = REPORT_FILES.find((file) => file.name === "04_ORDENS.csv")!;
  const row = buildAuditReport(fixture(), { ...filters, end: at("08") }).datasets.orders.find((o) => o.local_order_id === "old1")!;
  const csv = buildCsv([row], definition.columns);
  const [header, body] = csv.replace(/^\uFEFF/, "").trim().split("\r\n").map((line) => line.split(";").map((cell) => cell.slice(1, -1)));
  assert.equal(header!.length, definition.columns.length);
  assert.equal(body!.length, header!.length);
  for (const [key, expected] of [["status", "CANCELED"], ["status_at_period_end", "NEW"],
    ["status_at_period_end_basis", "IMMUTABLE_ORDER_EVENT_BEFORE_CUTOFF"],
    ["status_at_period_end_evidence_at", new Date(at("01")).toISOString()]]) {
    const index = definition.columns.findIndex((column) => column.key === key);
    assert.notEqual(index, -1);
    assert.equal(header![index], definition.columns[index]!.label);
    assert.equal(body![index], expected);
  }
});
