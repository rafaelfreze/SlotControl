import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildAuditReport, REPORT_DATASET_KEYS, type AuditInput, type AuditFilters } from "./report-engine.ts";
import { auditExecutionGaps, auditTriggerWindows, type TriggerWindow } from "./trigger-audit.ts";

const at = (time: string) => `2026-09-22T${time}:00.000Z`;
const filters: AuditFilters = { start: at("00:00"), end: at("03:00"), assets: ["SOL"], environments: ["SHADOW"] };
const owner = { tenant_id: "tenant-a", user_id: "user-a" };
function fixture(): AuditInput {
  const cfg = { ...owner, id: "config-sol", asset: "SOL", symbol: "SOLUSDC", execution_mode: "SHADOW", capital_usdc: "250", slot_count: 25, gain_rate: "0.005", entry_spacing: "0.01", kill_switch: false, pause_new_entries: false, created_at: at("00:00"), updated_at: at("00:00"), shadow_test_started_at: at("00:00"), last_engine_at: at("02:59"), last_market_price: "10.02", last_market_observed_at: at("02:59") };
  return { generatedAt: at("03:00"), scope: { tenantId: "tenant-a", userId: "user-a" }, warnings: [], incompleteSources: [], sources: {
    robot_v1_configs: [cfg], robot_v1_cycles: [{ ...owner, id: "cycle-1", config_id: cfg.id, asset: "SOL", symbol: "SOLUSDC", execution_mode: "SHADOW", capital_usdc: "250", slot_notional_usdc: "10", gain_rate: "0.005", entry_spacing: "0.01", status: "POSITIONS_ACTIVE", started_at: at("00:00"), completed_at: null }],
    robot_v1_slots: Array.from({ length: 25 }, (_, index) => ({ ...owner, id: `slot-${index + 1}`, cycle_id: "cycle-1", slot_number: index + 1, logical_level: index + 1, operation_sequence: index === 0 ? 3 : 1,
      symbol: "SOLUSDC", entry_state: index === 1 ? "ARMED" : index === 0 ? "NONE" : "PLANNED", status: index === 0 ? "TP_ACTIVE" : "PENDING", buy_status: index === 0 ? "FILLED" : "PENDING", take_profit_status: index === 0 ? "PENDING" : "NONE",
      buy_price: 10 - index * .1, average_fill_price: index === 0 ? 10 : null, executed_quantity: index === 0 ? 1 : 0, requested_quantity: 1, allocation_usdc: index === 0 ? 10.1 : 10, take_profit_price: index === 0 ? 10.05 : null,
      buy_triggered_at: index === 0 ? at("01:35") : null, armed_at: index === 1 ? at("00:00") : null, buy_client_order_id: `buy-${index + 1}`, sell_client_order_id: index === 0 ? "sell-1-3" : null, updated_at: at("02:59") })),
    robot_v1_slot_accounts: Array.from({ length: 25 }, (_, index) => ({ ...owner, config_id: cfg.id, slot_number: index + 1, initial_balance_usdc: "10", balance_usdc: index === 0 ? "10.1" : "10", gain_count: index === 0 ? 2 : 0, gross_profit_usdc: index === 0 ? ".12" : "0", fees_usdc: index === 0 ? ".02" : "0", net_profit_usdc: index === 0 ? ".1" : "0", updated_at: at("01:30") })),
    robot_v1_slot_operations: [1, 2].map((sequence) => ({ ...owner, id: `op-${sequence}`, cycle_id: "cycle-1", slot_id: "slot-1", physical_slot_number: 1, logical_level: sequence, operation_sequence: sequence, symbol: "SOLUSDC", allocation_usdc: sequence === 1 ? "10" : "10.05", entry_price: "10", executed_quantity: "1", take_profit_price: "10.06", gross_quote_pnl: ".06", estimated_quote_fees: ".01", net_quote_pnl: ".05", opened_at: sequence === 1 ? at("00:30") : at("01:05"), closed_at: sequence === 1 ? at("01:00") : at("01:30"), buy_client_order_id: `historic-buy-${sequence}`, sell_client_order_id: `historic-sell-${sequence}` })),
    robot_v1_slot_profit_credits: [1, 2].map((sequence) => ({ ...owner, operation_id: `op-${sequence}`, config_id: cfg.id, slot_number: 1, previous_balance_usdc: sequence === 1 ? "10" : "10.05", new_balance_usdc: sequence === 1 ? "10.05" : "10.1", net_profit_usdc: ".05", credited_at: "2026-09-23T00:00:00Z" })),
    robot_v1_audit_events: [{ ...owner, id: "start", config_id: cfg.id, cycle_id: "cycle-1", event_type: "CYCLE_STARTED", previous_state: {}, next_state: { capital: 250, anchorPrice: 10 }, observed_at: at("00:00"), idempotency_key: "start" }],
    robot_v1_market_candles: [], robot_v1_testnet_runs: [], robot_v1_testnet_slots: [], robot_v1_testnet_orders: [], robot_v1_testnet_events: []
  } };
}
function addTestnet(input: AuditInput) {
  const id = (slot: number, side: string, revision = 1) => `COV1-SOL-${slot}-${revision}-${side}-${createHash("sha256").update(`coinops-testnet|run-1|${slot}|${side}|${revision}`).digest("hex").slice(0, 18)}`;
  input.sources.robot_v1_testnet_runs = [{ ...owner, id: "run-1", asset: "SOL", symbol: "SOLUSDC", status: "ACTIVE", slot_notional_usdc: 10, gain_rate: .005, entry_spacing: .01, created_at: at("00:00"), last_reconciled_at: at("02:59") }];
  input.sources.robot_v1_testnet_slots = Array.from({ length: 25 }, (_, i) => ({ ...owner, id: `t-slot-${i + 1}`, run_id: "run-1", slot_number: i + 1, entry_state: i === 0 ? "CLOSED" : i === 1 ? "ARMED" : "PLANNED", balance_usdc: i === 0 ? 10.05 : 10, gain_count: i === 0 ? 1 : 0, net_profit_usdc: i === 0 ? .05 : 0, target_buy_price: 10 - i * .1 }));
  input.sources.robot_v1_testnet_orders = [
    { ...owner, id: "tb", run_id: "run-1", slot_id: "t-slot-1", slot_number: 1, side: "BUY", purpose: "INITIAL", revision: 1, client_order_id: id(1, "BUY"), exchange_order_id: "exchange-b", status: "FILLED", requested_quantity: null, requested_quote: 10, executed_quantity: 1, cumulative_quote: 10, fee_base: 0, fee_quote: 0, fee_other: [], trades_reconciled: true, created_at: at("00:05"), updated_at: at("00:06") },
    { ...owner, id: "ts", run_id: "run-1", slot_id: "t-slot-1", slot_number: 1, side: "SELL", purpose: "TP", revision: 1, client_order_id: id(1, "SELL"), exchange_order_id: "exchange-s", status: "FILLED", requested_quantity: 1, price: 10.05, executed_quantity: 1, cumulative_quote: 10.05, fee_base: 0, fee_quote: 0, fee_other: [], trades_reconciled: true, created_at: at("00:07"), updated_at: at("01:00") },
    { ...owner, id: "tb2", run_id: "run-1", slot_id: "t-slot-2", slot_number: 2, side: "BUY", purpose: "ENTRY", revision: 1, client_order_id: id(2, "BUY"), exchange_order_id: "exchange-b2", status: "NEW", requested_quantity: 1, price: 9.9, executed_quantity: 0, cumulative_quote: 0, created_at: at("00:08"), updated_at: at("00:08") }
  ];
  input.sources.robot_v1_testnet_events = [
    { ...owner, id: "bfilled", run_id: "run-1", slot_number: 1, event_type: "BUY_FILLED", event_key: "bfilled", observed_at: at("00:06"), details: { clientOrderId: id(1, "BUY") } },
    { ...owner, id: "sfilled", run_id: "run-1", slot_number: 1, event_type: "SELL_FILLED", event_key: "sfilled", observed_at: at("01:00"), details: { clientOrderId: id(1, "SELL") } },
    { ...owner, id: "sclosed", run_id: "run-1", slot_number: 1, event_type: "SLOT_CLOSED", event_key: "closed", observed_at: at("01:01"), details: { profitUsdc: .05, balanceUsdc: 10.05, gainCount: 1 } }
  ];
  return input;
}
test("report has all versioned datasets; source reads are deterministic and inputs unchanged", () => {
  const input = fixture(), before = JSON.stringify(input), first = buildAuditReport(input, filters);
  assert.deepEqual(Object.keys(first.datasets), REPORT_DATASET_KEYS); assert.equal(JSON.stringify(first), JSON.stringify(buildAuditReport(input, filters))); assert.equal(JSON.stringify(input), before);
});

test("failed initialization remains a historical error without inventing overlapping active grids", () => {
  const input = fixture();
  for (const [index, reason] of [null, "GRID_SLOT_INSERT_23502"].entries()) input.sources.robot_v1_cycles.push({ ...input.sources.robot_v1_cycles[0], id: `failed-${index}`, status: "FAILED", started_at: at(index ? "00:02" : "00:01"), completed_at: null, completion_reason: reason });
  const report = buildAuditReport(input, filters);
  const checks = report.datasets.checks.filter((row) => row.code === "PHYSICAL_SLOTS_25" && String(row.cycle_id).startsWith("failed-"));
  assert.equal(checks.length, 2); assert.ok(checks.every((row) => row.status === "WARNING"));
  assert.equal(report.datasets.checks.find((row) => row.code === "CYCLES_DO_NOT_OVERLAP")?.status, "PASS");
  assert.equal(report.datasets.alerts.filter((row) => row.source === "robot_v1_cycles" && row.severity === "ERROR").length, 2);
  input.sources.robot_v1_cycles[1]!.status = "POSITIONS_ACTIVE";
  const invalid = buildAuditReport(input, filters);
  assert.equal(invalid.datasets.checks.find((row) => row.code === "PHYSICAL_SLOTS_25" && row.cycle_id === "failed-0")?.status, "FAIL");
  assert.equal(invalid.datasets.checks.find((row) => row.code === "CYCLES_DO_NOT_OVERLAP")?.status, "FAIL");
});

test("historical cycle completion stops triggers even without a terminal event", () => {
  const input = fixture();
  Object.assign(input.sources.robot_v1_cycles[0]!, { status: "CYCLE_COMPLETE", completed_at: at("00:10"), completion_reason: "TEST_RESTARTED" });
  input.sources.robot_v1_audit_events.push({ ...owner, id: "early-buy", cycle_id: "cycle-1", slot_id: "slot-1", event_type: "BUY_TRIGGERED", observed_at: at("00:01"), next_state: { takeProfitPrice: 10.05 } });
  input.sources.robot_v1_market_candles.push({ ...owner, symbol: "SOLUSDC", candle_open_at: at("00:20"), candle_close_at: at("00:21"), high_price: 11, low_price: 10 });
  const report = buildAuditReport(input, filters), trigger = report.datasets.market.find((row) => row.trigger_type === "TP")!;
  assert.equal(trigger.ended_at, "2026-09-22T00:10:00.001Z"); assert.notEqual(trigger.result, "MISSING_ACTION");
  assert.ok(!report.datasets.alerts.some((row) => row.code === "TRIGGER_ACTION_NOT_FOUND"));
});

test("a slot snapshot from a reset cycle cannot reserve current capital or create open PnL", () => {
  const input = fixture();
  input.sources.robot_v1_cycles.push({ ...input.sources.robot_v1_cycles[0], id: "legacy-cycle", status: "CYCLE_COMPLETE", completed_at: at("01:00"), completion_reason: "TEST_RESTARTED" });
  input.sources.robot_v1_slots.push({ ...input.sources.robot_v1_slots[0], id: "legacy-slot", cycle_id: "legacy-cycle", operation_sequence: 1, buy_triggered_at: at("00:05"), allocation_usdc: 10 });
  const report = buildAuditReport(input, filters), summary = report.datasets.summary[0]!;
  assert.equal(summary.open_operations, 1); assert.equal(summary.committed_capital, 20); assert.equal(summary.open_pnl, .02);
  const preserved = report.datasets.slots.find((row) => row.slot_id === "legacy-slot")!;
  assert.equal(preserved.status, "TP_ACTIVE"); assert.equal(preserved.context_active, false);
  assert.equal(preserved.context_ended_at, at("01:00"));
  const operation = report.datasets.operations.find((row) => row.slot_id === "legacy-slot")!;
  assert.equal(operation.closed_at, null); assert.equal(operation.context_ended_at, at("01:00"));
});

test("a proven missing action stays FAIL even when another trigger has incomplete candles", () => {
  const input = fixture();
  input.sources.robot_v1_audit_events.push(
    { ...owner, id: "buy-arm", cycle_id: "cycle-1", slot_id: "slot-2", event_type: "NEXT_BUY_ARMED", observed_at: at("00:01"), next_state: { buyPrice: 9.8 } },
    { ...owner, id: "tp-arm", cycle_id: "cycle-1", slot_id: "slot-1", event_type: "BUY_TRIGGERED", observed_at: at("00:01"), next_state: { takeProfitPrice: 11.05 } }
  );
  input.sources.robot_v1_market_candles.push({ ...owner, symbol: "SOLUSDC", candle_open_at: at("00:20"), candle_close_at: at("00:21"), high_price: 10, low_price: 9.6 });
  const report = buildAuditReport(input, filters);
  assert.ok(report.datasets.market.some((row) => row.result === "INCOMPLETE"));
  assert.equal(report.datasets.checks.find((row) => row.code === "ARMED_TRIGGER_ACTIONS")?.status, "FAIL");
});
test("period is end-exclusive; immutable credit uses operation time despite migration backfill", () => {
  const report = buildAuditReport(fixture(), { ...filters, start: at("01:00"), end: at("01:30") });
  assert.equal(report.datasets.gains.length, 1); assert.equal(report.datasets.gains[0]!.operation_id, "op-1"); assert.equal(report.datasets.capital.length, 1);
  assert.equal(report.datasets.capital[0]!.credited_at, "2026-09-23T00:00:00.000Z"); assert.equal(report.datasets.capital[0]!.timestamp, at("01:00"));
  assert.equal(report.datasets.summary[0]!.capital_start, 250); assert.equal(report.datasets.summary[0]!.capital_end, 250.05);
});
test("summary realized profit, gains and per-slot compound balance reconcile", () => {
  const report = buildAuditReport(fixture(), filters), summary = report.datasets.summary[0]!;
  assert.equal(summary.realized_pnl, .1); assert.equal(summary.gains, 2); assert.equal(summary.capital_end, 250.1); assert.equal(report.datasets.gains.at(-1)!.cumulative_slot_gains, 2);
  assert.equal(report.datasets.capital.at(-1)!.balance_after, 10.1); assert.equal(report.datasets.checks.find((row) => row.code === "COMPOUNDING_BALANCE_FORMULA")!.status, "PASS");
});
test("Shadow, Testnet and asset filters cannot mix ledgers", () => {
  const input = addTestnet(fixture());
  const shadow = buildAuditReport(input, filters); assert.ok(shadow.datasets.operations.every((row) => row.environment === "SHADOW")); assert.equal(shadow.datasets.orders.length, 0);
  const testnet = buildAuditReport(input, { ...filters, environments: ["TESTNET"] }); assert.equal(testnet.datasets.summary[0]!.realized_pnl, .05); assert.equal(testnet.datasets.gains.length, 1); assert.equal(testnet.datasets.orders.length, 3);
  const btc = buildAuditReport(input, { ...filters, assets: ["BTC"] }); assert.equal(btc.datasets.operations.length, 0); assert.equal(btc.datasets.cycles.length, 0);
});
test("current snapshot balances do not replace historical open positions", () => {
  const report = buildAuditReport(fixture(), { ...filters, start: at("00:00"), end: at("00:45") });
  assert.equal(report.datasets.summary[0]!.capital_end, 250); assert.equal(report.datasets.summary[0]!.open_operations, 1); assert.equal(report.datasets.summary[0]!.committed_capital, null);
  assert.equal(report.datasets.summary[0]!.gains, 0);
});
test("negative closed operations remain losses and are not gains", () => {
  const input = fixture(); input.sources.robot_v1_slot_operations![0]!.net_quote_pnl = "-.05";
  const report = buildAuditReport(input, filters); assert.equal(report.datasets.gains.length, 1); assert.equal(report.datasets.summary[0]!.gains, 1); assert.equal(report.datasets.summary[0]!.realized_pnl, 0);
});
test("a report before the robot existed cannot invent opening capital or health", () => {
  const report = buildAuditReport(fixture(), { ...filters, start: "2026-09-01T00:00:00Z", end: "2026-09-05T00:00:00Z" });
  assert.equal(report.datasets.summary[0]!.capital_start, null); assert.equal(report.datasets.summary[0]!.capital_end, null); assert.equal(report.datasets.summary[0]!.health, "SEM_EVIDENCIA");
});
test("next resident Testnet BUY reserves fictitious capital", () => {
  const report = buildAuditReport(addTestnet(fixture()), { ...filters, environments: ["TESTNET"] });
  assert.equal(report.datasets.summary[0]!.committed_capital, 9.9); assert.ok(Math.abs(Number(report.datasets.summary[0]!.free_capital) - 240.15) < 1e-8);
});
test("cycles retain completion/reset reasons and exact next cycle relationship", () => {
  const input = fixture(); Object.assign(input.sources.robot_v1_cycles![0]!, { completed_at: at("02:00"), status: "CYCLE_COMPLETE", completion_reason: "AUTO_RESET_NO_OPEN_SHADOW_POSITIONS" });
  input.sources.robot_v1_audit_events!.push({ ...owner, id: "restart", config_id: "config-sol", cycle_id: "cycle-2", event_type: "CYCLE_RESTARTED", previous_state: { cycleId: "cycle-1", reason: "AUTO_RESET_NO_OPEN_SHADOW_POSITIONS" }, next_state: { cycleId: "cycle-2" }, observed_at: at("02:00"), idempotency_key: "restart" });
  const cycle = buildAuditReport(input, filters).datasets.cycles[0]!; assert.equal(cycle.next_cycle_id, "cycle-2"); assert.equal(cycle.reset_reason, "AUTO_RESET_NO_OPEN_SHADOW_POSITIONS");
});
test("Single Active Entry and 25 physical slots detect breaches without changing strategy", () => {
  const input = fixture(); input.sources.robot_v1_slots![2]!.entry_state = "ARMED"; input.sources.robot_v1_slots!.pop();
  const checks = buildAuditReport(input, filters).datasets.checks;
  assert.equal(checks.find((row) => row.code === "SINGLE_ACTIVE_ENTRY")!.status, "FAIL"); assert.equal(checks.find((row) => row.code === "PHYSICAL_SLOTS_25")!.status, "FAIL");
});
test("Testnet ownership verifies deterministic ID, run and physical slot", () => {
  const input = addTestnet(fixture()), report = buildAuditReport(input, { ...filters, environments: ["TESTNET"] }); assert.ok(report.datasets.orders.every((row) => row.ownership_verified));
  input.sources.robot_v1_testnet_orders![0]!.client_order_id = "manual-order";
  assert.equal(buildAuditReport(input, { ...filters, environments: ["TESTNET"] }).datasets.checks.find((row) => row.code === "TESTNET_OWNERSHIP")!.status, "FAIL");
});
test("duplicate operation IDs and terminal events fail audit", () => {
  const input = fixture(); input.sources.robot_v1_slot_operations!.push({ ...input.sources.robot_v1_slot_operations![0]! });
  for (let i = 0; i < 2; i++) input.sources.robot_v1_audit_events!.push({ ...owner, id: `terminal-${i}`, config_id: "config-sol", cycle_id: "cycle-1", slot_id: "slot-1", event_type: "SLOT_PROFIT_CREDITED", next_state: { operationId: "op-1" }, observed_at: at("01:00"), idempotency_key: `different-${i}` });
  const report = buildAuditReport(input, filters); assert.equal(report.datasets.checks.find((row) => row.code === "OPERATION_IDS_UNIQUE")!.status, "FAIL"); assert.equal(report.datasets.checks.find((row) => row.code === "TERMINAL_EVENTS_UNIQUE")!.status, "FAIL");
});
test("missing accounting evidence creates warning and unknown capital, never a false pass", () => {
  const input = fixture(); input.incompleteSources.push("robot_v1_slot_profit_credits:truncated");
  const report = buildAuditReport(input, filters); assert.equal(report.datasets.summary[0]!.capital_end, null); assert.equal(report.datasets.checks.find((row) => row.code === "PERIOD_CAPITAL_LEDGER")!.status, "WARNING");
});
test("Real remains read-only; external observations and Shadow intents are never CoinOps real trades", () => {
  const input = addTestnet(fixture()); input.sources.exchange_connections = [{ ...owner, exchange: "BINANCE_SPOT", connection_status: "READ_ONLY", api_key_masked: "never-export" }];
  input.sources.exchange_order_intents = [{ ...owner, side: "BUY", symbol: "SOLUSDT", status: "SIMULATED" }];
  const report = buildAuditReport(input, { ...filters, environments: ["REAL"] }); assert.equal(report.datasets.orders.length, 0); assert.equal(report.datasets.operations.length, 0); assert.equal(report.datasets.summary[0]!.mode, "READ_ONLY / LIVE BLOCKED");
  assert.equal(report.datasets.checks.find((row) => row.code === "PRODUCTION_LIVE_BLOCKED")!.status, "PASS"); assert.equal(report.datasets.checks.find((row) => row.code === "PRODUCTION_HTTP_WRITE_HISTORY")!.status, "WARNING"); assert.ok(!JSON.stringify(report).includes("never-export"));
});
test("tenant mismatch is fail closed", () => {
  const input = fixture(); input.sources.robot_v1_slots![0]!.tenant_id = "another-tenant"; assert.throws(() => buildAuditReport(input, filters), /SCOPE_MISMATCH/);
});
test("a persisted Production order reference must fail the read-only guard audit", () => {
  const input = fixture(); input.sources.exchange_order_intents = [{ ...owner, id: "unexpected", execution_mode: "LIVE", exchange_order_id: "unexpected-exchange-id", asset: "SOL", symbol: "SOLUSDT", status: "FILLED", created_at: at("01:00"), updated_at: at("01:01") }];
  const report = buildAuditReport(input, { ...filters, environments: ["REAL"] });
  assert.equal(report.datasets.checks.find((row) => row.code === "PRODUCTION_PERSISTED_WRITE_GUARD")!.status, "FAIL"); assert.equal(report.datasets.real.filter((row) => row.row_type === "PRODUCTION_WRITE_GUARD_VIOLATION").length, 1);
});
test("a historical report never presents a future engine checkpoint as its last execution", () => {
  const report = buildAuditReport(fixture(), { ...filters, end: at("01:30") }); assert.equal(report.datasets.summary[0]!.last_execution, null);
});
test("rule contract allows an operational extension in the same report delivery", () => {
  const input = fixture(); input.sources.robot_v1_configs![0]!.new_safety_limit = 42;
  const report = buildAuditReport(input, filters, [{ parameter: "new_safety_limit", field: "new_safety_limit", unit: "USDC", version: 2 }]);
  assert.equal(report.datasets.rules.find((row) => row.parameter === "new_safety_limit")!.value, 42); assert.throws(() => buildAuditReport(input, filters, [{ parameter: "capital", field: "new_safety_limit", unit: "USDC", version: 1 }]), /RULE_DUPLICATE/);
});
test("event payloads retain operational evidence but never credential fields", () => {
  const input = fixture(); input.sources.robot_v1_audit_events![0]!.next_state = { clientOrderId: "allowed-id", api_key: "secret-api-value", authorization: "Bearer secret", reason: "password=secret" };
  const output = JSON.stringify(buildAuditReport(input, filters)); assert.ok(output.includes("allowed-id")); assert.ok(!output.includes("secret-api-value")); assert.ok(!output.includes("Bearer secret")); assert.ok(!output.includes("password=secret"));
});
const window: TriggerWindow = { environment: "SHADOW", asset: "SOL", symbol: "SOLUSDC", cycleId: "cycle-1", slot: 2, type: "BUY", price: 10, armedAt: at("00:00"), endedAt: at("01:00") };
const candle = { symbol: "SOLUSDC", candle_open_at: at("00:05"), candle_close_at: "2026-09-22T00:05:59.999Z", open_price: 10.1, high_price: 10.2, low_price: 9.9, close_price: 10 };
test("missing trigger identifies first crossed armed BUY and expected action", () => {
  const result = auditTriggerWindows([window], [candle], { complete: true, start: filters.start, end: filters.end })[0]!;
  assert.equal(result.result, "MISSING_ACTION"); assert.equal(result.first_cross_at, candle.candle_open_at); assert.equal(result.expected_action, "BUY_TRIGGERED"); assert.equal(result.missed_level, true);
});
test("a candle before arming cannot trigger a retroactive BUY", () => {
  const result = auditTriggerWindows([{ ...window, armedAt: at("00:06") }], [candle], { complete: true, start: filters.start, end: filters.end })[0]!;
  assert.equal(result.first_cross_at, null); assert.notEqual(result.result, "MISSING_ACTION");
});
test("same-candle BUY and TP is ambiguous, not an invented missed action", () => {
  const result = auditTriggerWindows([{ ...window, pairedTarget: 10.1 }], [candle], { complete: true, start: filters.start, end: filters.end })[0]!;
  assert.equal(result.result, "AMBIGUOUS"); assert.equal(result.missed_level, false);
});
test("missing event pages and candle gaps cannot produce false conclusive checks", () => {
  assert.equal(auditTriggerWindows([window], [candle], { complete: true, eventsComplete: false, start: filters.start, end: filters.end })[0]!.result, "INCOMPLETE");
  assert.equal(auditTriggerWindows([{ ...window, price: 1 }], [candle], { complete: true, start: filters.start, end: filters.end })[0]!.result, "INCOMPLETE");
});
test("Testnet never uses Production candle crosses as proof of execution", () => {
  assert.equal(auditTriggerWindows([{ ...window, environment: "TESTNET" }], [candle], { complete: true, start: filters.start, end: filters.end })[0]!.result, "INCOMPARABLE_MARKET");
});
test("recent cross remains pending during normal engine interval", () => {
  assert.equal(auditTriggerWindows([window], [candle], { complete: true, start: filters.start, end: at("00:08") })[0]!.result, "PENDING_ENGINE_WINDOW");
});
test("cron gap detects persisted execution spacing, not trade frequency", () => {
  const gaps = auditExecutionGaps([at("00:00"), at("00:05"), at("00:25")], 300_000, { start: filters.start, end: filters.end, source: "RECONCILED", environment: "TESTNET" });
  assert.equal(gaps.length, 1); assert.equal(gaps[0]!.gap_ms, 1_200_000);
});
test("persisted diagnostics export fictitious account balances and permission probe separately from stream uptime", () => {
  const input = addTestnet(fixture()); input.sources.report_runtime_observations = [{ ...owner, id: "observation-1", event_key: "diagnostic", environment: "TESTNET", source: "TESTNET_DIAGNOSTIC", status: "COMPLETED", observed_at: at("02:00"), observation_version: 1,
    metrics: { balances: [{ asset: "USDC", free: 10000, locked: 10, total: 10010 }], permissions: { USER_DATA: true, TRADE: true, USER_STREAM: true }, account: { can_trade: true }, stream_observation_kind: "SUBSCRIPTION_PERMISSION_PROBE" } }];
  const report = buildAuditReport(input, { ...filters, environments: ["TESTNET"] });
  assert.equal(report.datasets.testnet.find((row) => row.row_type === "FICTITIOUS_ACCOUNT_BALANCE")!.free, 10000); assert.equal(report.datasets.testnet.find((row) => row.row_type === "ACCOUNT_DIAGNOSTIC")!.stream_observation_kind, "SUBSCRIPTION_PERMISSION_PROBE");
});
