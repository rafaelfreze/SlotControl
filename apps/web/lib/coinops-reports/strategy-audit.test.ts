import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAuditReport, REPORT_DATASET_KEYS, type AuditDatasets } from "./report-engine.ts";
import { buildStrategyAuditChecks, normalizeStrategyDecisions } from "./strategy-audit.ts";
import { missedLevelCauseLabel, missedLevelEvidence } from "./missed-level-evidence.ts";
import { buildReportPackage } from "./report-package.ts";

const now = "2026-09-23T13:00:00Z";
const context = { generatedAt: now, incompleteSources: [] as string[], filters: { start: "2026-09-23T00:00:00Z", end: "2026-09-24T00:00:00Z", assets: ["SOL" as const], environments: ["TESTNET" as const] } };
const empty = (): AuditDatasets => Object.fromEntries(REPORT_DATASET_KEYS.map((key) => [key, []])) as unknown as AuditDatasets;
const decision = { environment: "TESTNET", asset: "SOL", cycle_id: "run", decision_id: "decision-1", strategy_version: "4.1.0", slot_id: "slot-2", operation_id: "op", action_type: "ARM_NEXT_BUY", target_price: 117.78, created_at: "2026-09-23T12:59:00Z", dispatched_at: "2026-09-23T12:59:01Z", exchange_ack_at: "2026-09-23T12:59:02Z", completed_at: "2026-09-23T12:59:02Z", result: "COMPLETED", expected_next_state: "ARMED", observed_next_state: { market_price: 120 } };
const get = (data: AuditDatasets, code: string) => buildStrategyAuditChecks(data, context).find((row) => row.code === code);

test("decision evidence preserves timestamps, strategy and latency without secrets or fabricated history", () => {
  const result = normalizeStrategyDecisions([{ ...decision, target_notional: 10.09996, root_cause: "STALE_CACHED_RUN_DISCOVERY", observed_next_state: { first_cross_at: null, token: "private", order_resident_at: decision.exchange_ack_at } }])[0]!;
  assert.equal(result.decision_latency_ms, 2000); assert.equal(result.strategy_version, "4.1.0"); assert.equal(result.target_notional, 10.09996);
  assert.equal(result.first_cross_at, null); assert.equal(result.root_cause, "STALE_CACHED_RUN_DISCOVERY"); assert.ok(!JSON.stringify(result).includes("private"));
  assert.equal(normalizeStrategyDecisions([]).length, 0);
});

test("missing evidence, legacy versions and absent four-engine coverage cannot make LIVE parity ready", () => {
  const data = empty(); assert.equal(get(data, "STRATEGY_VERSION_PARITY")?.status, "WARNING"); assert.equal(get(data, "LIVE_STRATEGY_PARITY_READY")?.status, "WARNING");
  data.cycles = [{ environment: "TESTNET", asset: "SOL", cycle_id: "run", status: "ACTIVE", strategy_version: null }];
  data.decisions = normalizeStrategyDecisions([decision]);
  assert.equal(get(data, "STRATEGY_VERSION_PARITY")?.status, "WARNING"); assert.notEqual(get(data, "LIVE_STRATEGY_PARITY_READY")?.status, "PASS");
});

test("dispatch omissions, missing acknowledgements and duplicate decisions are detected", () => {
  const data = empty();
  data.decisions = normalizeStrategyDecisions([{ ...decision, created_at: "2026-09-23T12:00:00Z", dispatched_at: null, exchange_ack_at: null }]);
  assert.equal(get(data, "STRATEGY_DECISION_DISPATCH")?.status, "FAIL");
  data.decisions[0]!.dispatched_at = "2026-09-23T12:00:01Z";
  assert.equal(get(data, "STRATEGY_DECISION_ACK")?.status, "FAIL");
  data.decisions.push({ ...data.decisions[0] }); assert.equal(get(data, "STRATEGY_DECISION_IDEMPOTENCY")?.status, "FAIL");
});

test("SOL reentry118.97 has priority over117.78 and116.6; missed history is preserved", () => {
  const data = empty(); data.cycles = [{ environment: "TESTNET", asset: "SOL", cycle_id: "run", status: "ACTIVE", strategy_version: "4.1.0" }];
  data.decisions = normalizeStrategyDecisions([decision]);
  data.slots = [118.97, 117.78, 116.6].map((price, i) => ({ environment: "TESTNET", asset: "SOL", cycle_id: "run", slot_id: `slot-${i + 1}`, buy_price: price, entry_state: i === 1 ? "ARMED" : "PLANNED", status: "PENDING" }));
  assert.equal(get(data, "PRIORITY_REENTRY_MUST_BE_ARMED_BEFORE_LOWER_LEVEL")?.status, "FAIL");
  data.orders = [{ environment: "TESTNET", slot_id: "slot-2", side: "BUY", status: "PARTIALLY_FILLED", executed_quantity: .01 }];
  assert.equal(get(data, "PRIORITY_REENTRY_MUST_BE_ARMED_BEFORE_LOWER_LEVEL")?.status, "WARNING");
  data.orders = [];
  data.slots[0]!.entry_state = "ARMED"; data.slots[1]!.entry_state = "PLANNED";
  assert.equal(get(data, "PRIORITY_REENTRY_MUST_BE_ARMED_BEFORE_LOWER_LEVEL")?.status, "PASS");
  data.slots[0]!.entry_state = "MISSED"; data.slots[0]!.missed_at = "2026-09-23T12:30:07Z"; data.slots[1]!.entry_state = "ARMED";
  assert.equal(get(data, "MISSED_LEVEL_RECOVERY_EVIDENCE")?.status, "WARNING");
  assert.notEqual(get(data, "LIVE_STRATEGY_PARITY_READY")?.status, "PASS");
});

test("initial MARKET fill requires positive executed quantity, not a completed decision alone", () => {
  const data = empty(); data.cycles = [{ environment: "TESTNET", asset: "SOL", cycle_id: "run", status: "ACTIVE", started_at: "2026-09-23T12:00:00Z", strategy_version: "4.1.0" }];
  data.decisions = normalizeStrategyDecisions([{ ...decision, action_type: "OPEN_INITIAL_MARKET" }]);
  assert.notEqual(get(data, "NEW_CYCLE_MUST_HAVE_INITIAL_MARKET_FILL")?.status, "PASS");
  data.orders = [{ environment: "TESTNET", cycle_id: "run", purpose: "INITIAL", side: "BUY", status: "FILLED", executed_quantity: .084 }];
  assert.equal(get(data, "NEW_CYCLE_MUST_HAVE_INITIAL_MARKET_FILL")?.status, "PASS");
});

test("reported decision dataset and version2 package preserve exact persisted fields", () => {
  const report = buildAuditReport({ generatedAt: now, warnings: [], incompleteSources: [], scope: { tenantId: "tenant", userId: "user" }, sources: { robot_v1_strategy_decisions: [decision] } }, context.filters);
  assert.equal(report.datasets.decisions.length, 1);
  const pack = buildReportPackage(report, context.filters, now);
  assert.equal(pack.manifest.report_version, 2);
  assert.ok(pack.files.find((file) => file.name === "15_ESTRATEGIA_DECISOES.csv")?.content.includes("decision-1"));
  assert.equal(get(empty(), "LIVE_STRATEGY_PARITY_READY")?.live_enabled, false);
});

test("missed UI distinguishes8h06m28.543 collection gap from unknown price crossing and keeps historical event", () => {
  const evidence = missedLevelEvidence([
    { event_type: "MISSED_LEVEL", observed_at: "2026-09-23T12:30:07.235Z", details: { targetPrice: 118.97, marketPrice: 117.01 } },
    { event_type: "MISSED_LEVEL_DIAGNOSED", observed_at: now, details: { root_cause: "STALE_CACHED_RUN_DISCOVERY", filled_at: "2026-09-23T04:23:36.439Z", collected_at: "2026-09-23T12:30:04.982Z", latency_ms: 29_188_543, resolved_by_version: "4.1.0", first_cross_at: null } },
  ]);
  assert.equal(evidence.latencyMs, 29_188_543); assert.equal(evidence.firstCrossAt, null); assert.equal(evidence.targetPrice, 118.97); assert.equal(evidence.marketPrice, 117.01);
  assert.equal(evidence.observedAt, "2026-09-23T12:30:07.235Z"); assert.equal(evidence.resolvedByVersion, "4.1.0");
  assert.match(missedLevelCauseLabel(evidence.rootCause), /cache desatualizado/); assert.equal(missedLevelEvidence([]).latencyMs, null);
});

test("Testnet60s cadence begins at persisted adoption; prior5min checkpoints are not retroactively invalid", () => {
  const at = (time: string) => `2026-09-23T${time}:00Z`;
  const report = buildAuditReport({ generatedAt: at("12:20"), warnings: [], incompleteSources: [], scope: { tenantId: "tenant", userId: "user" }, sources: {
    robot_v1_testnet_runs: [{ id: "run", asset: "SOL", symbol: "SOLUSDC", status: "ACTIVE", created_at: at("12:00"), last_reconciled_at: at("12:19") }],
    robot_v1_testnet_events: [
      ...["12:00", "12:05", "12:10", "12:15", "12:16", "12:19"].map((time) => ({ run_id: "run", observed_at: at(time), event_type: "RECONCILED", event_key: time, details: {} })),
      { run_id: "run", observed_at: at("12:15"), event_type: "RECONCILIATION_STARTED", event_key: "fast", details: { expected_interval_seconds: 60, fallback_interval_seconds: 300, recovery_source: "FAST_REACTOR_RECONCILIATION" } },
    ],
  } }, { ...context.filters, start: at("12:00") });
  const gaps = report.datasets.alerts.filter((row) => row.code === "EXECUTION_GAP");
  assert.equal(gaps.length, 1); assert.equal(gaps[0]!.expected_interval_ms, 60_000); assert.equal(gaps[0]!.gap_ms, 180_000);
  assert.equal(report.datasets.rules.find((row) => row.parameter === "reconciliation_interval")?.value, 60);
  assert.equal(report.datasets.rules.find((row) => row.parameter === "reconciliation_fallback_interval")?.value, 300);
});
