import test from "node:test";
import assert from "node:assert/strict";
import { buildTestnetMissedOccurrences, classifyMissedLevelTemporal, STRATEGY_4_1_EFFECTIVE_AT, summarizeTemporalMissed, type TemporalMissedOccurrence } from "./missed-level-temporal.ts";

function evidence(patch: Partial<TemporalMissedOccurrence> = {}) {
  return {
    asset: "BTC", cycle_id: "btc-cycle", slot: 1, source_event_id: "missed-btc", operation_id: null, operation_sequence: 2,
    target_price: 85480.48, event_type: "MISSED_LEVEL_DURING_REARM", first_cross_at: null,
    occurred_at: "2026-09-23T14:01:50.234Z", occurred_at_basis: "TP_FILL_UNRECONCILED_WINDOW_START",
    occurred_by_at: "2026-09-23T14:13:24.677Z", detected_at: "2026-09-23T14:32:24.651Z", created_at: null,
    strategy_version: null, detected_by_strategy_version: "4.1.0", strategy_effective_at: STRATEGY_4_1_EFFECTIVE_AT,
    root_cause: "STALE_CACHED_RUN_DISCOVERY", resolved_at: "2026-09-23T14:32:26.716628Z", resolved_by_version: "4.1.0",
    evidence_source: "TESTNET_TP_FILL+LOWER_BUY_FILL+VERSIONED_RECONCILIATION", ...patch,
  };
}

test("BTC pre-version exchange upper bound stays historical even when detected and inserted after deploy", () => {
  const row = classifyMissedLevelTemporal(evidence({ created_at: "2026-09-23T16:00:00Z" }));
  assert.equal(row.temporal_classification, "HISTORICAL_PRE_4_1");
  assert.equal(row.first_cross_at, null); assert.equal(row.strategy_version, null);
  assert.equal(row.is_active_issue, false); assert.equal(row.occurred_at_basis, "TP_FILL_UNRECONCILED_WINDOW_START");
  assert.deepEqual(summarizeTemporalMissed([row]), { historicalCount: 1, currentVersionCount: 0, activeIssueCount: 0, unresolvedCount: 0, regressionCount: 0, externalCount: 0 });
});

test("SOL known pre-version observation is historical, without inventing an exact crossing", () => {
  const row = classifyMissedLevelTemporal(evidence({ asset: "SOL", occurred_at: "2026-09-23T04:23:36.439Z", occurred_by_at: "2026-09-23T07:44:48.036Z", detected_at: "2026-09-23T12:30:07.190Z" }));
  assert.equal(row.temporal_classification, "HISTORICAL_PRE_4_1"); assert.equal(row.first_cross_at, null);
  assert.equal(row.is_active_issue, false);
});

test("a TP before rollout with no pre-rollout crossing bound is unresolved, not historical by assumption", () => {
  const row = classifyMissedLevelTemporal(evidence({ occurred_by_at: null }));
  assert.equal(row.temporal_classification, "UNRESOLVED"); assert.equal(row.is_active_issue, true);
});

test("a proven post-version engine issue is an active regression; current version alone proves nothing", () => {
  const row = classifyMissedLevelTemporal(evidence({ first_cross_at: "2026-09-23T15:01:00Z", occurred_at: "2026-09-23T15:01:00Z", occurred_by_at: null, occurred_at_basis: "EXCHANGE_FIRST_CROSS", detected_at: "2026-09-23T15:02:00Z", root_cause: "ADAPTER_DISPATCH_FAILURE", resolved_at: null, resolved_by_version: null }));
  assert.equal(row.temporal_classification, "POST_4_1_REGRESSION"); assert.equal(row.is_active_issue, true);
  assert.equal(summarizeTemporalMissed([row]).regressionCount, 1);
});

test("external classification requires specific external evidence, not only a label", () => {
  const input = evidence({ occurred_at: "2026-09-23T15:01:00Z", occurred_at_basis: "EXCHANGE_FIRST_CROSS", occurred_by_at: null, detected_at: "2026-09-23T15:02:00Z", root_cause: "EXCHANGE_OUTAGE", resolved_at: null, resolved_by_version: null });
  assert.equal(classifyMissedLevelTemporal(input).temporal_classification, "UNRESOLVED");
  assert.equal(classifyMissedLevelTemporal({ ...input, external_evidence: "exchange incident record and failed request" }).temporal_classification, "POST_4_1_EXTERNAL");
});

test("history with no verified remediation remains attention; contradictory clocks fail closed", () => {
  assert.equal(classifyMissedLevelTemporal(evidence({ resolved_at: null })).is_active_issue, true);
  assert.equal(classifyMissedLevelTemporal(evidence({ evidence_source: null })).is_active_issue, true);
  assert.equal(classifyMissedLevelTemporal(evidence({ resolved_at: "2026-09-23T14:10:00Z" })).is_active_issue, true);
  assert.equal(classifyMissedLevelTemporal(evidence({ resolved_at: "2026-09-23T14:31:40Z" })).is_active_issue, true);
  assert.equal(classifyMissedLevelTemporal(evidence({ resolved_by_version: "legacy", resolved_at: "2026-09-23T14:10:00Z" })).is_active_issue, true);
  const contradiction = classifyMissedLevelTemporal(evidence({ first_cross_at: "2026-09-23T15:00:00Z" }));
  assert.equal(contradiction.temporal_classification, "UNRESOLVED"); assert.equal(contradiction.is_active_issue, true);
});

test("diagnosis enriches its original occurrence without becoming a second missed event", () => {
  const events = [
    { id: "missed-btc", run_id: "btc-cycle", slot_number: 1, event_type: "MISSED_LEVEL_DURING_REARM", observed_at: "2026-09-23T14:32:24.662368Z", details: { operation_sequence: 2, detected_at: "2026-09-23T14:32:24.651Z", strategy_version: "4.1.0", targetPrice: 85480.48 } },
    { id: "diagnosis", run_id: "btc-cycle", slot_number: 1, event_type: "MISSED_LEVEL_DIAGNOSED", observed_at: "2026-09-23T16:00:00Z", details: { ...evidence(), original_event_id: "missed-btc" } },
  ];
  const before = JSON.stringify(events);
  const rows = buildTestnetMissedOccurrences(events, { asset: "BTC", cycleId: "btc-cycle" });
  assert.equal(rows.length, 1); assert.equal(rows[0]!.temporal_classification, "HISTORICAL_PRE_4_1");
  assert.equal(rows[0]!.created_at, null); assert.equal(rows[0]!.detected_at, "2026-09-23T14:32:24.651Z");
  assert.equal(JSON.stringify(events), before);
});

test("old resolved history cannot resolve a new missed on the same slot or another asset/cycle", () => {
  const events = [
    { id: "missed-btc", run_id: "btc-cycle", slot_number: 1, event_type: "MISSED_LEVEL_DURING_REARM", observed_at: "2026-09-23T14:32:24Z", details: { operation_sequence: 2 } },
    { id: "old-diagnosis", run_id: "btc-cycle", slot_number: 1, event_type: "MISSED_LEVEL_DIAGNOSED", observed_at: "2026-09-23T16:00:00Z", details: { ...evidence(), original_event_id: "missed-btc" } },
    { id: "new-missed", run_id: "btc-cycle", slot_number: 1, event_type: "MISSED_LEVEL_DURING_REARM", observed_at: "2026-09-23T17:00:00Z", details: { operation_sequence: 3 } },
    { id: "sol-missed", run_id: "sol-cycle", slot_number: 1, event_type: "MISSED_LEVEL", observed_at: "2026-09-23T17:00:00Z", details: {} },
  ];
  const rows = buildTestnetMissedOccurrences(events, { asset: "BTC", cycleId: "btc-cycle" });
  assert.equal(rows.length, 2); assert.equal(rows[0]!.is_active_issue, false);
  assert.equal(rows[1]!.temporal_classification, "UNRESOLVED"); assert.equal(rows[1]!.is_active_issue, true);
});

test("current OPEN/ARMED slots with history are not modified; absent event evidence is not a green motor", () => {
  const slots = [{ slot_number: 1, missed_at: "2026-09-23T12:30:07Z", operation_sequence: 3, entry_state: "OPEN", target_buy_price: 118.97 }];
  const before = JSON.stringify(slots);
  const rows = buildTestnetMissedOccurrences([], { asset: "SOL", cycleId: "sol-cycle", fallbackSlots: slots });
  assert.equal(rows.length, 1); assert.equal(rows[0]!.is_active_issue, true);
  assert.equal(JSON.stringify(slots), before); assert.equal(slots[0]!.entry_state, "OPEN");
});

test("a filtered source containing two diagnoses still represents one original event, not two insertions", () => {
  const rows = buildTestnetMissedOccurrences([
    { id: "old-diagnosis", run_id: "btc-cycle", slot_number: 1, event_type: "MISSED_LEVEL_DIAGNOSED", observed_at: "2026-09-23T14:36:30Z", details: { operation_sequence: 2, targetPrice: 85480.48, detected_at: "2026-09-23T14:32:24.618+00:00" } },
    { id: "new-diagnosis", run_id: "btc-cycle", slot_number: 1, event_type: "MISSED_LEVEL_DIAGNOSED", observed_at: "2026-09-23T16:00:00Z", created_at: "2026-09-23T16:00:00Z", details: { ...evidence(), original_event_id: "missed-btc", original_created_at: null } },
  ], { asset: "BTC", cycleId: "btc-cycle" });
  assert.equal(rows.length, 1); assert.equal(rows[0]!.source_event_id, "missed-btc");
  assert.equal(rows[0]!.created_at, null); assert.equal(rows[0]!.temporal_classification, "HISTORICAL_PRE_4_1");
});
