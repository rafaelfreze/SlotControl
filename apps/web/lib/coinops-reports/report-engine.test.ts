import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildAuditReport, REPORT_DATASET_KEYS, type AuditInput, type AuditFilters } from "./report-engine.ts";
import { auditExecutionGaps, auditTriggerWindows, type TriggerWindow } from "./trigger-audit.ts";
import { STRATEGY_4_1_EFFECTIVE_AT } from "./missed-level-temporal.ts";
import { buildPreLiveAuditGate } from "./pre-live-audit.ts";

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

test("physical Shadow account reconciles manual capital without classifying it as market profit", () => {
  const input = fixture();
  Object.assign(input.sources.robot_v1_slot_accounts[0]!, { balance_usdc: 17.1, manual_gain_usdc: 5, contribution_usdc: 2, gain_count: 3 });
  input.sources.robot_v1_manual_adjustments = [{ ...owner, environment: "SHADOW", asset: "SOL", slot_number: 1,
    physical_slot_id: "SHADOW:config-sol:1", gain_units: 1, kind: "MANUAL_TARGET_GAIN", id: "manual-1", converted_amount_usdc: 5, created_at: at("02:00") }];
  const check = buildAuditReport(input, filters).datasets.checks.find((row) => row.code === "PHYSICAL_SLOT_ACCOUNT_RECONCILES" && row.physical_slot_number === 1);
  assert.equal(check?.status, "PASS");
  input.sources.robot_v1_slot_accounts[0]!.balance_usdc = 17.2;
  assert.equal(buildAuditReport(input, filters).datasets.checks.find((row) => row.code === "PHYSICAL_SLOT_ACCOUNT_RECONCILES" && row.physical_slot_number === 1)?.status, "FAIL");
});

const temporalFilters: AuditFilters = { start: STRATEGY_4_1_EFFECTIVE_AT, end: "2026-09-24T04:00:00Z", assets: ["SOL"], environments: ["TESTNET"], temporalWindow: "SINCE_STRATEGY_4_1" };
function temporalFixture() {
  const input = addTestnet(fixture()); input.generatedAt = "2026-09-23T14:40:00Z";
  Object.assign(input.sources.robot_v1_testnet_runs[0]!, { strategy_version: "4.1.0", last_reconciled_at: "2026-09-23T14:39:55Z" });
  Object.assign(input.sources.robot_v1_testnet_slots[0]!, { entry_state: "MISSED", missed_at: "2026-09-23T12:30:07.235Z", operation_sequence: 2 });
  input.sources.robot_v1_strategy_decisions = [{ ...owner, environment: "TESTNET", asset: "SOL", cycle_id: "run-1", decision_id: "v4.1-wait", strategy_version: "4.1.0", action_type: "WAIT", created_at: "2026-09-23T14:39:55Z", dispatched_at: "2026-09-23T14:39:55Z", completed_at: "2026-09-23T14:39:55Z", result: "COMPLETED", observed_next_state: { market_price: 10 } }];
  input.sources.robot_v1_testnet_events.push(
    { ...owner, id: "old-missed", run_id: "run-1", slot_number: 1, event_type: "MISSED_LEVEL_DURING_REARM", observed_at: "2026-09-23T12:30:07.235Z", details: { operationSequence: 2, targetPrice: 118.97, marketPrice: 117.01 } },
    { ...owner, id: "diagnosis", run_id: "run-1", slot_number: 1, event_type: "MISSED_LEVEL_DIAGNOSED", observed_at: "2026-09-23T14:38:00Z", details: { original_event_id: "old-missed", operation_sequence: 2, occurred_at: "2026-09-23T04:23:36.439Z", occurred_at_basis: "TP_FILL_UNRECONCILED_WINDOW_START", occurred_by_at: "2026-09-23T12:30:07.235Z", detected_at: "2026-09-23T12:30:07.235Z", first_cross_at: null, root_cause: "STALE_CACHED_RUN_DISCOVERY", resolved_by_version: "4.1.0", resolved_at: "2026-09-23T14:33:00Z", evidence_source: "persisted original event + reconciler commit" } },
    ...Array.from({ length: 9 }, (_, i) => ({ ...owner, id: `reconciled-${i}`, run_id: "run-1", event_type: "RECONCILED", observed_at: `2026-09-23T14:${String(31 + i).padStart(2, "0")}:55Z`, details: {} })),
  );
  return input;
}

test("temporal v3 report preserves one historical incident without counting late diagnosis as a new failure", () => {
  const input = temporalFixture(), before = JSON.stringify(input), report = buildAuditReport(input, temporalFilters);
  const summary = report.datasets.summary[0]!, occurrence = report.datasets.missed_temporal[0]!;
  assert.equal(report.datasets.missed_temporal.length, 1); assert.equal(occurrence.context_only, true); assert.equal(occurrence.temporal_classification, "HISTORICAL_PRE_4_1");
  assert.equal(occurrence.first_cross_at, null); assert.equal(occurrence.is_active_issue, false); assert.equal(occurrence.strategy_version, null);
  assert.equal(summary.historical_missed, 1); assert.equal(summary.missed_since_strategy, 0); assert.equal(summary.missed_levels, 0); assert.equal(summary.active_missed, 0);
  assert.equal(summary.active_errors, 0); assert.equal(summary.operational_reentry_waiting, 1); assert.equal(summary.operational_next_buy, 1); assert.equal(summary.operational_planned, 23);
  assert.equal(summary.health, "ATENÇÃO"); // Fixture 4.1 lacks the new monthly ledger; no false 4.2 PASS.
  for (const code of ["NO_NEW_ENGINE_MISSED_LEVELS", "HISTORICAL_MISSED_NOT_ACTIVE", "CURRENT_SLOT_STATE_NOT_OVERRIDDEN_BY_HISTORY", "MISSED_LEVEL_RECOVERY_EVIDENCE"]) assert.equal(report.datasets.checks.find((row) => row.code === code)?.status, "PASS", code);
  const currentSlot = report.datasets.slots.find((row) => row.slot_id === "t-slot-1")!;
  assert.equal(currentSlot.persisted_entry_state, "MISSED"); assert.equal(currentSlot.operational_state, "REENTRY_WAITING");
  assert.equal(report.datasets.events.find((row) => row.event_id === "diagnosis")?.is_active_issue, false);
  assert.equal(JSON.stringify(input), before); assert.ok(!report.datasets.events.some((row) => row.event_id === "old-missed"));
});

test("historical missed never overrides current OPEN, ARMED or PLANNED state and never erases balances", () => {
  for (const [raw, expected] of [["OPEN", "OPEN"], ["ARMED", "NEXT_BUY"], ["PLANNED", "PLANNED"]]) {
    const input = temporalFixture(), slot = input.sources.robot_v1_testnet_slots[0]!; slot.entry_state = raw;
    const result = buildAuditReport(input, temporalFilters).datasets.slots.find((row) => row.slot_id === slot.id)!;
    assert.equal(result.entry_state, raw); assert.equal(result.operational_state, expected); assert.equal(result.current_balance, 10.05); assert.equal(result.historical_missed_count, 1);
  }
});

test("a new engine missed after 4.1 remains a real FAIL instead of borrowing the old remediation", () => {
  const input = temporalFixture();
  input.sources.robot_v1_testnet_events.push({ ...owner, id: "new-missed", run_id: "run-1", slot_number: 1, event_type: "MISSED_LEVEL", observed_at: "2026-09-23T14:39:00Z", details: { operation_sequence: 3, occurred_at: "2026-09-23T14:38:30Z", first_cross_at: "2026-09-23T14:38:30Z", root_cause: "ENGINE_RECONCILIATION_DELAY", strategy_version_at_occurrence: "4.1.0", evidence_source: "exchange-cross+reconciler" } });
  const report = buildAuditReport(input, temporalFilters), summary = report.datasets.summary[0]!;
  assert.equal(summary.historical_missed, 1); assert.equal(summary.missed_since_strategy, 1); assert.equal(summary.active_missed, 1); assert.equal(summary.health, "DIVERGÊNCIA ATIVA");
  assert.equal(report.datasets.checks.find((row) => row.code === "NO_NEW_ENGINE_MISSED_LEVELS")?.status, "FAIL");
  assert.equal(report.datasets.missed_temporal.find((row) => row.operation_sequence === 3)?.resolved_by_version, null);
});

test("missing temporal evidence remains WARNING and cannot certify the current version", () => {
  const input = temporalFixture(); input.sources.robot_v1_testnet_events = []; input.incompleteSources = ["robot_v1_testnet_events"];
  const report = buildAuditReport(input, temporalFilters);
  assert.equal(report.datasets.checks.find((row) => row.code === "NO_NEW_ENGINE_MISSED_LEVELS")?.status, "WARNING");
  assert.ok(!String(report.datasets.summary[0]!.health).startsWith("Motor OK"));
});

test("since-strategy gains use proven TP time while late ledger credit stays unchanged and explicit", () => {
  const input = temporalFixture();
  input.sources.robot_v1_testnet_events.find((row) => row.event_type === "SLOT_CLOSED")!.observed_at = "2026-09-23T14:33:00Z";
  const sell = input.sources.robot_v1_testnet_orders.find((row) => row.side === "SELL")!;
  const trade = { ...owner, id: "late-fill", run_id: "run-1", slot_number: 1, event_type: "TESTNET_FILL_OBSERVED", observed_at: "2026-09-23T14:32:25Z", details: { clientOrderId: sell.client_order_id, filledAt: "2026-09-23T14:01:00Z", side: "SELL" } };
  input.sources.robot_v1_testnet_events.push(trade);
  const report = buildAuditReport(input, temporalFilters), summary = report.datasets.summary[0]!;
  assert.equal(summary.since_strategy_gains_by_fill, 0); assert.equal(summary.ledger_credits_observed_since_strategy, 1); assert.equal(summary.gains, 1); assert.equal(summary.fills, 0);
  assert.equal(report.datasets.events.find((row) => row.event_id === "late-fill")?.context_only, true);
  assert.equal(report.datasets.gains[0]!.gain_at, "2026-09-23T14:33:00.000Z"); assert.equal(report.datasets.gains[0]!.exchange_gain_at, "2026-09-23T14:01:00Z");
  assert.equal(report.datasets.capital[0]!.timestamp, "2026-09-23T14:33:00.000Z");
  trade.details.filledAt = "2026-09-23T14:32:21Z";
  const genuine = buildAuditReport(input, temporalFilters).datasets.summary[0]!;
  assert.equal(genuine.since_strategy_gains_by_fill, 1); assert.equal(genuine.fills, 1);
});

test("current proven slot count, single BUY and resident TP violations turn health red, not yellow", () => {
  const cases: Array<[string, (input: AuditInput) => void]> = [
    ["SLOT_COUNT_25", (input) => { input.sources.robot_v1_testnet_slots.pop(); }],
    ["SINGLE_ACTIVE_ENTRY", (input) => { input.sources.robot_v1_testnet_slots[2]!.entry_state = "ARMED"; }],
    ["OPEN_POSITION_HAS_RESIDENT_TP", (input) => { input.sources.robot_v1_testnet_slots[0]!.entry_state = "OPEN"; }],
    ["TP_HAS_POSITION", (input) => { input.sources.robot_v1_testnet_orders.push({ ...owner, id: "orphan-tp", run_id: "run-1", slot_id: "t-slot-4", slot_number: 4, revision: 1, side: "SELL", purpose: "TP", status: "NEW", requested_quantity: 1, executed_quantity: 0, price: 10, created_at: "2026-09-23T14:37:00Z" }); }],
  ];
  for (const [code, mutate] of cases) {
    const input = temporalFixture(); mutate(input);
    const report = buildAuditReport(input, temporalFilters), summary = report.datasets.summary[0]!;
    assert.equal(report.datasets.checks.find((row) => row.code === code)?.status, "FAIL", code);
    assert.equal(summary.health, "DIVERGÊNCIA ATIVA", code); assert.ok(Number(summary.invariant_failures) > 0, code); assert.ok(Number(summary.active_errors) > 0, code);
  }
});

test("exported event details preserve forensic identity and both versions without secrets", () => {
  const input = temporalFixture(), diagnosis = input.sources.robot_v1_testnet_events.find((row) => row.id === "diagnosis")!;
  Object.assign(diagnosis.details as Record<string, unknown>, { operation_id: "testnet:run-1:1:2", strategy_version_at_occurrence: null, detected_by_strategy_version: "4.1.0", apiKey: "SECRET_NOT_EXPORTABLE" });
  const report = buildAuditReport(input, temporalFilters), details = report.datasets.events.find((row) => row.event_id === "diagnosis")!.details as Record<string, unknown>;
  assert.equal(details.operation_id, "testnet:run-1:1:2"); assert.equal(details.original_event_id, "old-missed");
  assert.ok(Object.hasOwn(details, "strategy_version_at_occurrence")); assert.equal(details.strategy_version_at_occurrence, null); assert.equal(details.detected_by_strategy_version, "4.1.0");
  assert.ok(!JSON.stringify(report).includes("SECRET_NOT_EXPORTABLE"));
});
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

test("TP and recycle at the same candle close prefer the actual TP, regardless of UUID ordering", () => {
  const input = fixture();
  input.sources.robot_v1_audit_events.push(
    { ...owner, id: "entry", cycle_id: "cycle-1", slot_id: "slot-6", event_type: "BUY_TRIGGERED", observed_at: at("01:17"), next_state: { takeProfitPrice: 114.37, operationSequence: 2 } },
    { ...owner, id: "0-recycle-first-lexically", cycle_id: "cycle-1", slot_id: "slot-6", event_type: "SLOT_RECYCLED", observed_at: at("01:36"), next_state: { operationSequence: 3 } },
    { ...owner, id: "z-tp-after-lexically", cycle_id: "cycle-1", slot_id: "slot-6", event_type: "TP_TRIGGERED", observed_at: at("01:36"), next_state: { operationSequence: 2, targetPrice: 114.37, observedHigh: 114.53 } }
  );
  input.sources.robot_v1_market_candles.push({ ...owner, symbol: "SOLUSDC", candle_open_at: at("01:35"), candle_close_at: at("01:36"), high_price: 114.53, low_price: 114.23 });
  const report = buildAuditReport(input, filters);
  const trigger = report.datasets.market.find((row) => row.trigger_type === "TP" && row.slot === 6)!;
  assert.equal(trigger.result, "OBSERVED"); assert.equal(trigger.observed_action, "TP_TRIGGERED");
  assert.equal(trigger.observed_at, at("01:36")); assert.equal(trigger.ended_at, "2026-09-22T01:36:00.001Z");
  assert.equal(report.datasets.checks.find((row) => row.code === "ARMED_TRIGGER_ACTIONS")?.status, "PASS");
  // The deployed legacy BUY/TP events did not carry their operation sequence.
  // Preserve that absence while still recognizing the persisted same-slot TP.
  for (const event of input.sources.robot_v1_audit_events.filter((row) => ["entry", "z-tp-after-lexically"].includes(String(row.id)))) {
    delete (event.next_state as Record<string, unknown>).operationSequence;
  }
  assert.equal(buildAuditReport(input, filters).datasets.market.find((row) => row.trigger_type === "TP" && row.slot === 6)?.result, "OBSERVED");
});

test("a later TP cannot override a legitimate earlier recycle boundary", () => {
  const input = fixture();
  input.sources.robot_v1_audit_events.push(
    { ...owner, id: "entry", cycle_id: "cycle-1", slot_id: "slot-6", event_type: "BUY_TRIGGERED", observed_at: at("01:17"), next_state: { takeProfitPrice: 114.37, operationSequence: 2 } },
    { ...owner, id: "recycle", cycle_id: "cycle-1", slot_id: "slot-6", event_type: "SLOT_RECYCLED", observed_at: at("01:35"), next_state: { operationSequence: 3 } },
    { ...owner, id: "later-tp", cycle_id: "cycle-1", slot_id: "slot-6", event_type: "TP_TRIGGERED", observed_at: at("01:36"), next_state: { operationSequence: 2, targetPrice: 114.37 } }
  );
  input.sources.robot_v1_market_candles.push({ ...owner, symbol: "SOLUSDC", candle_open_at: at("01:34"), candle_close_at: at("01:35"), high_price: 114.53, low_price: 114.23 });
  const trigger = buildAuditReport(input, filters).datasets.market.find((row) => row.trigger_type === "TP" && row.slot === 6)!;
  assert.equal(trigger.result, "MISSING_ACTION"); assert.equal(trigger.observed_action, null);
  assert.equal(trigger.ended_at, "2026-09-22T01:35:00.001Z");
});

test("same-time action preference cannot borrow another physical slot, cycle or known operation sequence", () => {
  const input = fixture();
  input.sources.robot_v1_audit_events.push(
    { ...owner, id: "entry", cycle_id: "cycle-1", slot_id: "slot-6", event_type: "BUY_TRIGGERED", observed_at: at("01:17"), next_state: { takeProfitPrice: 114.37, operationSequence: 2 } },
    { ...owner, id: "0-recycle", cycle_id: "cycle-1", slot_id: "slot-6", event_type: "SLOT_RECYCLED", observed_at: at("01:36"), next_state: { operationSequence: 3 } },
    { ...owner, id: "wrong-operation", cycle_id: "cycle-1", slot_id: "slot-6", event_type: "TP_TRIGGERED", observed_at: at("01:36"), next_state: { operationSequence: 3 } },
    { ...owner, id: "wrong-slot", cycle_id: "cycle-1", slot_id: "slot-7", event_type: "TP_TRIGGERED", observed_at: at("01:36"), next_state: { operationSequence: 2 } },
    { ...owner, id: "wrong-cycle", cycle_id: "other-cycle", slot_id: "slot-6", event_type: "TP_TRIGGERED", observed_at: at("01:36"), next_state: { operationSequence: 2 } }
  );
  input.sources.robot_v1_market_candles.push({ ...owner, symbol: "SOLUSDC", candle_open_at: at("01:35"), candle_close_at: at("01:36"), high_price: 114.53, low_price: 114.23 });
  const trigger = buildAuditReport(input, filters).datasets.market.find((row) => row.trigger_type === "TP" && row.slot === 6)!;
  assert.equal(trigger.result, "MISSING_ACTION"); assert.equal(trigger.observed_action, null);
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
test("Testnet terminal reset exports the full rollover evidence and links both cycles", () => {
  const input = addTestnet(fixture());
  Object.assign(input.sources.robot_v1_testnet_runs![0]!, { status: "COMPLETED", completed_at: at("01:02"), completion_reason: "LAST_OPEN_TP_FILLED", reset_started_at: at("01:01"), recovery_source: "CRON_RECONCILIATION" });
  input.sources.robot_v1_testnet_runs!.push({ ...owner, id: "run-2", previous_run_id: "run-1", asset: "SOL", symbol: "SOLUSDC", status: "ACTIVE", anchor_price: 10.1, slot_notional_usdc: 10, gain_rate: .005, entry_spacing: .01, created_at: at("01:02"), reset_started_at: at("01:01"), reset_completed_at: at("01:03"), recovery_source: "CRON_RECONCILIATION" });
  input.sources.robot_v1_testnet_events!.push({ ...owner, id: "reset", run_id: "run-2", slot_number: null, event_type: "RESET_COMPLETED", event_key: "reset-complete", observed_at: at("01:03"), details: { reset_after_last_tp: true, old_next_buy_canceled: true, new_cycle_started: true, initial_reentry_filled: true, new_tp_created: true, next_buy_armed: true, reset_latency_ms: 120000, recovery_source: "CRON_RECONCILIATION" } });
  const report = buildAuditReport(input, { ...filters, environments: ["TESTNET"] });
  const oldCycle = report.datasets.cycles.find((row) => row.cycle_id === "run-1")!;
  const reset = report.datasets.events.find((row) => row.event_type === "RESET_COMPLETED")!;
  assert.equal(oldCycle.next_cycle_id, "run-2"); assert.equal(oldCycle.reset_reason, "LAST_OPEN_TP_FILLED");
  assert.equal(reset.reset_after_last_tp, true); assert.equal(reset.initial_reentry_filled, true); assert.equal(reset.next_buy_armed, true);
  assert.equal(reset.reset_latency_ms, 120000); assert.equal(reset.recovery_source, "CRON_RECONCILIATION");
});
test("local slot recycle exports prior entry, compounding and physical ownership evidence", () => {
  const input = fixture();
  input.sources.robot_v1_audit_events!.push({ ...owner, id: "reentry", config_id: "config-sol", cycle_id: "cycle-1", slot_id: "slot-1", event_type: "SLOT_REENTRY_ARMED", observed_at: at("01:31"), idempotency_key: "reentry-1", next_state: { physicalSlotNumber: 1, previousEntryPrice: 10, reentryPrice: 10, balanceBefore: 10.05, balanceAfter: 10.1, gainCountBefore: 1, gainCountAfter: 2, otherOpenPositions: 1, localRecycleVsGlobalReset: "LOCAL_REENTRY" } });
  const report = buildAuditReport(input, filters), event = report.datasets.events.find((row) => row.event_type === "SLOT_REENTRY_ARMED")!;
  assert.equal(event.previous_entry_price, 10); assert.equal(event.reentry_price, 10); assert.equal(event.balance_after, 10.1); assert.equal(event.physical_slot_number, 1);
  assert.equal(report.datasets.checks.find((row) => row.code === "GAIN_WITH_OTHER_OPEN_MUST_PRESERVE_SLOT_REENTRY")?.status, "PASS");
});

function repairedBtcReentryFixture() {
  const input = fixture(); input.generatedAt = "2026-09-23T18:00:00Z";
  for (const rows of Object.values(input.sources)) for (const row of rows) {
    if (row.asset === "SOL") row.asset = "BTC";
    if (row.symbol === "SOLUSDC") row.symbol = "BTCUSDC";
  }
  for (const slot of input.sources.robot_v1_slots!) if (slot.entry_state === "ARMED") slot.entry_state = "PLANNED";
  Object.assign(input.sources.robot_v1_slots![4]!, { operation_sequence: 2, buy_price: 83788.15, entry_state: "ARMED" });
  const event = { ...owner, id: "historical-one-tick", config_id: "config-sol", cycle_id: "cycle-1", slot_id: "slot-5",
    event_type: "SLOT_REENTRY_PLANNED", observed_at: "2026-09-23T16:06:59.999Z", idempotency_key: "historical-one-tick",
    previous_state: { previousEntryPrice: 83788.15 },
    next_state: { balanceAfter: 10.0470184, reentryPrice: 83788.14, gainCountAfter: 1, operationSequence: 2, otherOpenPositions: 2, physicalSlotNumber: 5 } };
  const repair = { ...owner, id: "proven-tick-repair", config_id: "config-sol", cycle_id: "cycle-1", slot_id: "slot-5",
    event_type: "SHADOW_TICK_DRIFT_REPAIRED", observed_at: "2026-09-23T17:50:26.082Z", idempotency_key: "proven-tick-repair",
    previous_state: { buyPrice: 83788.14 }, next_state: { reason: "PREVIOUS_CONFIRMED_ENTRY_TICK_RESTORED", buyPrice: 83788.15, operationSequence: 2 } };
  input.sources.robot_v1_audit_events!.push(event, repair);
  const btcFilters: AuditFilters = { start: "2026-09-23T00:00:00Z", end: input.generatedAt, assets: ["BTC"], environments: ["SHADOW"] };
  return { input, event, repair, btcFilters };
}
const reentryCodes = ["GAIN_WITH_OTHER_OPEN_MUST_PRESERVE_SLOT_REENTRY", "LOCAL_REENTRY_RULE"];

test("raw Shadow reentry preserves previous_state evidence and missing price is never zero", () => {
  const { input, event, btcFilters } = repairedBtcReentryFixture();
  input.sources.robot_v1_audit_events = [event];
  event.previous_state.previousEntryPrice = 85489.38; event.next_state.reentryPrice = 85489.38;
  let report = buildAuditReport(input, btcFilters);
  assert.equal(report.datasets.events[0]!.previous_entry_price, 85489.38);
  for (const code of reentryCodes) assert.equal(report.datasets.checks.find((row) => row.code === code)?.status, "PASS", code);
  event.previous_state = {} as typeof event.previous_state;
  report = buildAuditReport(input, btcFilters);
  assert.equal(report.datasets.events[0]!.previous_entry_price, null);
  for (const code of reentryCodes) assert.equal(report.datasets.checks.find((row) => row.code === code)?.status, "WARNING", code);
});

test("one-tick reentry violation stays historical FAIL while exact repair proof removes only active failure", () => {
  const { input, btcFilters } = repairedBtcReentryFixture();
  const report = buildAuditReport(input, btcFilters);
  const event = report.datasets.events.find((row) => row.event_id === "historical-one-tick")!;
  assert.equal(event.previous_entry_price, 83788.15); assert.equal(event.reentry_price, 83788.14);
  assert.equal(event.reentry_recovery_event_id, "proven-tick-repair");
  const checks = report.datasets.checks.filter((row) => reentryCodes.includes(String(row.code)));
  for (const check of checks) {
    assert.equal(check.status, "FAIL"); assert.equal(check.active_failures, 0); assert.equal(check.recovered_historical_failures, 1);
  }
  const gate = buildPreLiveAuditGate({ ...report.datasets, checks, summary: [] }, []);
  assert.equal(gate.status, "WARNING"); assert.equal(gate.recovered_historical_failures, 2); assert.equal(gate.live_enabled, false);
});

test("reentry repair must match cycle, physical slot, sequence, chronology and both prices", () => {
  const variants: Array<(fixture: ReturnType<typeof repairedBtcReentryFixture>) => void> = [
    ({ input }) => { input.sources.robot_v1_audit_events = input.sources.robot_v1_audit_events!.filter((row) => row.event_type !== "SHADOW_TICK_DRIFT_REPAIRED"); },
    ({ repair }) => { repair.cycle_id = "other-cycle"; },
    ({ repair }) => { repair.slot_id = "slot-3"; },
    ({ repair }) => { repair.next_state.operationSequence = 3; },
    ({ repair }) => { repair.previous_state.buyPrice = 83788.13; },
    ({ repair }) => { repair.next_state.buyPrice = 83788.16; },
    ({ repair }) => { repair.observed_at = "2026-09-23T16:00:00Z"; },
    ({ input }) => { input.sources.robot_v1_slots![4]!.buy_price = 83788.14; },
  ];
  for (const modify of variants) {
    const f = repairedBtcReentryFixture(); modify(f);
    const report = buildAuditReport(f.input, f.btcFilters);
    const checks = report.datasets.checks.filter((row) => reentryCodes.includes(String(row.code)));
    for (const check of checks) { assert.equal(check.status, "FAIL"); assert.equal(check.active_failures, 1); }
    assert.equal(buildPreLiveAuditGate({ ...report.datasets, checks, summary: [] }, []).status, "FAIL");
  }
});

test("immutable operation can confirm repaired entry after slot reuse but price repair cannot excuse lost capital", () => {
  const { input, event, btcFilters } = repairedBtcReentryFixture();
  input.sources.robot_v1_slots![4]!.operation_sequence = 3;
  input.sources.robot_v1_slot_operations!.push({ ...owner, id: "repaired-entry", cycle_id: "cycle-1", slot_id: "slot-5",
    symbol: "BTCUSDC", physical_slot_number: 5, operation_sequence: 2, entry_price: 83788.15,
    opened_at: "2026-09-23T17:55:00Z", allocation_usdc: 10.0470184, executed_quantity: .00011 });
  let report = buildAuditReport(input, btcFilters);
  assert.equal(report.datasets.events.find((row) => row.event_id === event.id)?.reentry_recovery_event_id, "proven-tick-repair");
  Object.assign(event.previous_state, { balanceBefore: 11 });
  report = buildAuditReport(input, btcFilters);
  const checks = report.datasets.checks.filter((row) => reentryCodes.includes(String(row.code)));
  assert.equal(checks.find((row) => row.code === "GAIN_WITH_OTHER_OPEN_MUST_PRESERVE_SLOT_REENTRY")?.active_failures, 1);
  assert.equal(buildPreLiveAuditGate({ ...report.datasets, checks, summary: [] }, []).status, "FAIL");
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

test("manual OPEN gain is capital and target credit, never market P&L or a fictitious operation", () => {
  const input = fixture(), account = input.sources.robot_v1_slot_accounts[0]!;
  Object.assign(account, { balance_usdc: "15.1", manual_gain_usdc: "5", contribution_usdc: "0", gain_count: 3 });
  input.sources.robot_v1_manual_adjustments = [{ ...owner, id: "manual-1", product_id: "product",
    environment: "SHADOW", asset: "SOL", slot_number: 1, physical_slot_id: "SHADOW:config-sol:1",
    kind: "MANUAL_TARGET_GAIN", gain_units: 1, currency: "USD", original_amount: 5,
    converted_amount_usdc: 5, balance_before_usdc: 10.1, balance_after_usdc: 15.1,
    monthly_before: 2, monthly_after: 3, lifetime_before: 2, lifetime_after: 3,
    open_position_at_time: true, position_committed_notional_usdc: 10,
    reason: "meta operacional", created_at: at("02:00"), idempotency_key: "manual-fixture-key-1" }];
  input.sources.robot_v1_monthly_slot_gains = [1, 2].map((index) => ({ ...owner, environment: "SHADOW",
    asset: "SOL", slot_number: 1, physical_slot_id: "SHADOW:config-sol:1", source_id: `op-${index}`,
    credited_at: at(index === 1 ? "01:00" : "01:30"), effective_gain_at: at(index === 1 ? "01:00" : "01:30"),
    period_key: "2026-09", evidence_basis: "SHADOW_CONFIRMED_TP_CLOSE", gain_units: 1 }));
  input.sources.robot_v1_monthly_slot_gains.push({ ...owner, environment: "SHADOW", asset: "SOL",
    slot_number: 1, physical_slot_id: "SHADOW:config-sol:1", source_id: "manual-1", credited_at: at("02:00"),
    effective_gain_at: at("02:00"), period_key: "2026-09", evidence_basis: "MANUAL_TARGET_GAIN", gain_units: 1 });
  const report = buildAuditReport(input, filters);
  const summary = report.datasets.summary.find((row) => row.environment === "SHADOW" && row.asset === "SOL")!;
  assert.equal(summary.capital_end, 255.1);
  assert.equal(summary.realized_pnl, .1);
  assert.equal(summary.manual_gain_usdc, 5);
  assert.equal(summary.manual_gains, 1);
  assert.equal(report.datasets.operations.filter((row) => row.operation_id === "manual-1").length, 0);
  assert.equal(report.datasets.gains.find((row) => row.adjustment_id === "manual-1")?.net_gain, 0);
  assert.equal(report.datasets.monthly_goals.find((row) => row.environment === "SHADOW" && row.asset === "SOL"
    && row.physical_slot_number === 1)?.monthly_manual_gain_count, 1);
  assert.equal(report.datasets.manual_adjustments.length, 1);
});
test("repeated Testnet fills of one physical slot use unique exchange order IDs", () => {
  const input = addTestnet(fixture());
  const first = input.sources.robot_v1_testnet_events![0]!;
  input.sources.robot_v1_testnet_events!.push({ ...first, id: "bfilled-reentry", event_key: "bfilled-reentry",
    observed_at: at("01:20"), details: { clientOrderId: "COV1-SOL-1-2-BUY-distinct" } });
  const report = buildAuditReport(input, { ...filters, environments: ["TESTNET"] });
  assert.equal(report.datasets.checks.find((row) => row.code === "TERMINAL_EVENTS_UNIQUE")?.status, "PASS");
  input.sources.robot_v1_testnet_events!.push({ ...first, id: "bfilled-duplicate", event_key: "bfilled-duplicate",
    observed_at: at("01:21") });
  assert.equal(buildAuditReport(input, { ...filters, environments: ["TESTNET"] }).datasets.checks
    .find((row) => row.code === "TERMINAL_EVENTS_UNIQUE")?.status, "FAIL");
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
test("persisted LIVE BRL cycle is reported as LIVE, never as blocked or BTCUSDT", () => {
  const input = fixture();
  input.sources.robot_v1_live_runs = [{ ...owner, id: "live-sol", asset: "SOL", symbol: "SOLBRL",
    status: "ACTIVE", created_at: at("00:00"), last_reconciled_at: at("02:59") }];
  input.sources.robot_v1_live_slots = Array.from({ length: 25 }, (_, i) => ({ ...owner,
    id: `live-slot-${i + 1}`, run_id: "live-sol", slot_number: i + 1,
    entry_state: i === 0 ? "OPEN" : "PLANNED" }));
  input.sources.robot_v1_live_orders = [{ ...owner, id: "live-buy", run_id: "live-sol",
    slot_id: "live-slot-1", client_order_id: "COR1-SOL-1-1-BUY-0123456789abcd",
    side: "BUY", status: "FILLED", created_at: at("01:00") }];
  input.sources.robot_v1_live_fills = [{ ...owner, id: "live-fill", order_id: "live-buy",
    filled_at: at("01:01"), exchange_trade_id: "123", quantity: ".01" }];
  const report = buildAuditReport(input, { ...filters, environments: ["REAL"] });
  assert.equal(report.datasets.summary[0]?.mode, "LIVE SPOT RESTRITO");
  assert.equal(report.datasets.summary[0]?.symbol, "SOLBRL");
  assert.equal(report.datasets.summary[0]?.quote_asset, "BRL");
  assert.equal(report.datasets.summary[0]?.fills, 1);
  assert.equal(report.datasets.checks.find((row) => row.code === "PRODUCTION_LIVE_LEDGER")?.status, "PASS");
  assert.equal(report.datasets.checks.find((row) => row.code === "PRODUCTION_LIVE_BLOCKED")?.status, "WARNING");
  assert.ok(report.datasets.live_execution.some((row) => row.row_type === "FILL"));
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
