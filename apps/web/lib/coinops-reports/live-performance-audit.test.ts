import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAuditReport, type AuditFilters, type AuditInput } from "./report-engine.ts";
import { buildLivePerformanceEvidence } from "./live-performance-audit.ts";
import type { DomainRegistry } from "../execution/operator-context.ts";

const at = (time: string) => `2026-09-24T${time}:00.000Z`;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const registry: DomainRegistry = {
  operator: { id: id(1), product_id: id(2), tenant_id: id(3), user_id: id(4), status: "ACTIVE", kill_switch: false },
  accounts: [{ id: id(5), operator_id: id(1), display_name: "Conta sintética", status: "ACTIVE", is_legacy_default: true, kill_switch: false }],
  engines: [{ id: id(6), operator_id: id(1), exchange_account_id: id(5), environment: "REAL", base_asset: "BTC", quote_asset: "BRL",
    symbol: "BTCBRL", status: "ACTIVE", kill_switch: true, hard_cap_quote: 450, legacy_compatible: true }],
};
const scope = { product_id: id(2), tenant_id: id(3), user_id: id(4), operator_id: id(1), exchange_account_id: id(5), trading_engine_id: id(6), quote_asset: "BRL" };
const filters: AuditFilters = { start: at("00:00"), end: at("23:59"), assets: ["BTC"], environments: ["REAL"] };
function fixture(): AuditInput {
  return { registry, generatedAt: at("15:00"), scope: { tenantId: id(3), userId: id(4) }, warnings: [], incompleteSources: [], sources: {
    robot_v1_live_runs: [{ ...scope, id: "run", asset: "BTC", symbol: "BTCBRL", status: "ACTIVE", created_at: at("00:00"), last_reconciled_at: at("14:59"), gain_rate: .012 }],
    robot_v1_live_slots: Array.from({ length: 25 }, (_, i) => ({ ...scope, id: `slot-${i + 1}`, run_id: "run", slot_number: i + 1,
      entry_state: i === 0 ? "OPEN" : i === 1 ? "ARMED" : "PLANNED", position_committed_quote: i === 0 ? 18 : 0 })),
    robot_v1_live_slot_accounts: Array.from({ length: 25 }, (_, i) => ({ ...scope, asset: "BTC", slot_number: i + 1,
      balance_quote: i === 0 ? 18.1812 : 18, market_pnl_quote: i === 0 ? .216 : 0,
      fees_quote: i === 0 ? .0348 : 0, contribution_quote: 18, manual_gain_quote: 0, gain_count: i === 0 ? 1 : 0 })),
    robot_v1_live_orders: [
      { ...scope, id: "buy", run_id: "run", slot_id: "slot-1", slot_number: 1, operation_sequence: 1, side: "BUY", purpose: "INITIAL", status: "FILLED", client_order_id: "owned-buy-1", executed_quantity: .00004, cumulative_quote: 18, created_at: at("01:00") },
      { ...scope, id: "tp", run_id: "run", slot_id: "slot-1", slot_number: 1, operation_sequence: 1, side: "SELL", purpose: "TP", status: "FILLED", client_order_id: "owned-tp-1", price: 455400, executed_quantity: .00004, cumulative_quote: 18.216, created_at: at("01:01") },
      { ...scope, id: "next-buy", run_id: "run", slot_id: "slot-2", slot_number: 2, operation_sequence: 1, side: "BUY", purpose: "NEXT_ENTRY", status: "NEW", client_order_id: "owned-buy-2", reserved_notional_quote: 16.7494, cumulative_quote: 0, created_at: at("14:19") },
    ],
    robot_v1_live_fills: [{ ...scope, id: "buy-fill", order_id: "buy", exchange_trade_id: "1", filled_at: at("01:00") },
      { ...scope, id: "tp-fill", order_id: "tp", exchange_trade_id: "2", filled_at: at("14:18") }],
    robot_v1_live_events: [{ ...scope, id: "profit", run_id: "run", slot_number: 1, event_type: "SLOT_PROFIT_CREDITED", event_key: "owned-tp-1:CREDITED", observed_at: at("14:19"),
      details: { tp_client_order_id: "owned-tp-1", buy_quote_brl: 18, sell_quote_brl: 18.216, gross_pnl_brl: .216, fees_brl: .0348, net_pnl_brl: .1812, dust_basis_brl: 0, balance_after_brl: 18.1812 } },
      { ...scope, id: "reconcile", run_id: "run", event_type: "RECONCILED", observed_at: at("14:58") }],
    robot_v1_live_alerts: [{ ...scope, id: "alert", asset: "BTC", severity: "CRITICAL", code: "READ_STATE_FAILED", first_seen_at: at("14:44"), last_seen_at: at("14:44"), resolved_at: null }],
  } };
}

test("LIVE report: credited BTC TP populates period gain, operation, native net P&L and critical alert", () => {
  const report = buildAuditReport(fixture(), filters), row = report.datasets.summary[0]!;
  assert.equal(row.gains, 1); assert.equal(row.operations, 1); assert.equal(row.realized_pnl, .1812);
  assert.equal(row.capital_end, 450.1812); assert.equal(row.capital_start, null);
  assert.equal(row.committed_capital, 34.7494);
  assert.equal(row.errors, 1); assert.equal(row.active_errors, 1); assert.equal(row.health, "ERRO_REGISTRADO");
  assert.equal(row.last_execution, at("14:59")); assert.equal(row.last_reconciliation, at("14:59"));
  assert.equal(row.buys, 1); assert.equal(row.take_profits, 1);
  assert.equal(report.datasets.operations[0]!.closed_at, at("14:18"));
  assert.equal(report.datasets.operations[0]!.credited_at, at("14:19"));
  assert.equal(report.datasets.gains[0]!.gain_source, "MARKET");
  assert.equal(report.datasets.alerts[0]!.recorded_severity, "CRITICAL");
});

test("LIVE price invariant report fails on active alert and keeps resolved evidence historical", () => {
  const data = fixture();
  data.sources.robot_v1_live_alerts!.push({ ...scope, id: "price-alert", asset: "BTC",
    severity: "CRITICAL", code: "COINOPS_STRATEGY_PRICE_INVARIANT_FAILED",
    first_seen_at: at("14:45"), last_seen_at: at("14:45"), resolved_at: null });
  assert.equal(buildAuditReport(data, filters).datasets.checks.find((row) => row.code === "STRATEGY_PRICE_INVARIANT")?.status, "FAIL");
  data.sources.robot_v1_live_alerts!.at(-1)!.resolved_at = at("14:50");
  const report = buildAuditReport(data, filters);
  assert.equal(report.datasets.checks.find((row) => row.code === "STRATEGY_PRICE_INVARIANT")?.status, "WARNING");
  assert.ok(report.datasets.live_execution.some((row) => row.row_type === "ALERT" && row.id === "price-alert"));
});

test("LIVE report: time window excludes prior gain and future checkpoint without using lifetime as profit", () => {
  const data = fixture();
  const after = buildAuditReport(data, { ...filters, start: at("14:20") }).datasets.summary[0]!;
  assert.equal(after.gains, 0); assert.equal(after.operations, 0); assert.equal(after.realized_pnl, 0);
  assert.equal(after.lifetime_market_pnl_quote, .216);
  const before = buildAuditReport(data, { ...filters, end: at("14:00") }).datasets.summary[0]!;
  assert.equal(before.gains, 0); assert.equal(before.realized_pnl, 0);
  assert.equal(before.last_execution, null); assert.equal(before.last_reconciliation, null);
  assert.equal(before.capital_end, null);
});

test("LIVE report: event replay and multiple TP fills count one operation at final exchange fill", () => {
  const data = fixture();
  data.sources.robot_v1_live_events!.push({ ...data.sources.robot_v1_live_events![0]! });
  data.sources.robot_v1_live_fills!.push({ ...scope, id: "tp-fill-early", order_id: "tp", filled_at: at("14:17") });
  const result = buildLivePerformanceEvidence(data.sources);
  assert.equal(result.operations.length, 1); assert.equal(result.operations[0]!.closed_at, at("14:18"));
});

test("LIVE report: failed events are errors and a credit cannot borrow another run or physical slot TP", () => {
  const data = fixture();
  data.sources.robot_v1_live_events!.push({ ...scope, id: "failed", run_id: "run", event_type: "RECONCILIATION_FAILED", observed_at: at("14:50") });
  assert.equal(buildAuditReport(data, filters).datasets.summary[0]!.errors, 2);
  data.sources.robot_v1_live_orders![1]!.slot_number = 2;
  const invalid = buildAuditReport(data, filters);
  assert.equal(invalid.datasets.summary[0]!.realized_pnl, null);
  assert.equal(invalid.datasets.summary[0]!.operations, 0);
});

test("LIVE report: SELL without immutable credit or fill is incomplete, never invented period profit", () => {
  for (const key of ["robot_v1_live_events", "robot_v1_live_fills"]) {
    const data = fixture(); data.sources[key] = [];
    const report = buildAuditReport(data, filters);
    assert.equal(report.datasets.summary[0]!.realized_pnl, null);
    assert.equal(report.datasets.summary[0]!.operations, 0);
    assert.ok(report.incompleteSources.some((source) => source.startsWith("live_performance:")));
  }
});

test("LIVE report: losses, retained dust, manual gains and contributions cannot inflate market gains", () => {
  const data = fixture(), details = data.sources.robot_v1_live_events![0]!.details as Record<string, unknown>;
  Object.assign(details, { sell_quote_brl: 17.9, gross_pnl_brl: -.09, net_pnl_brl: -.1248, dust_basis_brl: .01, balance_after_brl: 17.8652 });
  data.sources.robot_v1_live_slot_accounts![0]!.manual_gain_quote = 500;
  data.sources.robot_v1_live_slot_accounts![0]!.contribution_quote = 900;
  data.sources.robot_v1_live_slot_accounts![0]!.gain_count = 42;
  const report = buildAuditReport(data, filters), row = report.datasets.summary[0]!;
  assert.equal(row.realized_pnl, -.1248); assert.equal(row.gains, 0); assert.equal(row.operations, 1);
  assert.equal(row.manual_gains, 0); assert.equal(report.datasets.capital[0]!.cash_delta_quote, -.1348);
  assert.equal(report.datasets.capital[0]!.balance_before, 18);
});

test("LIVE report: native USDT market retains the same exact accounting without BRL conversion", () => {
  const data = fixture();
  data.registry = structuredClone(registry);
  Object.assign(data.registry.engines[0]!, { symbol: "BTCUSDT", quote_asset: "USDT" });
  for (const rows of Object.values(data.sources)) for (const row of rows) Object.assign(row, { quote_asset: "USDT", ...(row.symbol ? { symbol: "BTCUSDT" } : {}) });
  const report = buildAuditReport(data, filters), row = report.datasets.summary[0]!;
  assert.equal(row.quote_asset, "USDT"); assert.equal(row.realized_pnl, .1812);
  assert.equal(report.datasets.operations[0]!.symbol, "BTCUSDT");
  assert.equal(report.datasets.capital[0]!.dust_cost_quote, 0);
});
