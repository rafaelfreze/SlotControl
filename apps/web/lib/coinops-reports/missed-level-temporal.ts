/** Read-only temporal evidence. This module never plans or dispatches an order. */
export const STRATEGY_4_1_DEPLOYMENT_READY_AT = "2026-09-23T14:31:34.826Z";
// First RECONCILIATION_STARTED carrying the deployed 4.1 commit. READY alone
// proves availability, not that the new adapter actually processed a run.
export const STRATEGY_4_1_EFFECTIVE_AT = "2026-09-23T14:32:20.558Z";
export const STRATEGY_4_1_COMMIT = "7530824fa194fe2faf9bc87d87fa5b7c02647bf0";
export type TemporalClassification = "HISTORICAL_PRE_4_1" | "POST_4_1_REGRESSION" | "POST_4_1_EXTERNAL" | "UNRESOLVED";
export type TestnetMissedEvent = {
  id?: string; event_id?: string; run_id?: string; cycle_id?: string; asset?: string;
  slot_number?: number | null; slot?: number | null; event_type: string;
  observed_at?: string; timestamp?: string; created_at?: string | null; details?: unknown;
};
type FallbackSlot = { slot_number: number; missed_at: string | null; operation_sequence?: number; target_buy_price?: number | string };
type Context = { asset?: string; cycleId?: string; fallbackSlots?: FallbackSlot[] };
export type TemporalMissedOccurrence = {
  asset: string; cycle_id: string; slot: number | null; source_event_id: string | null;
  operation_id: string | null; operation_sequence: number | null; target_price: number | null;
  event_type: string; first_cross_at: string | null; occurred_at: string | null;
  occurred_at_basis: string | null; occurred_by_at: string | null; detected_at: string | null;
  created_at: string | null; strategy_version: string | null; detected_by_strategy_version: string | null;
  strategy_effective_at: string; root_cause: string | null; resolved_at: string | null;
  resolved_by_version: string | null; evidence_source: string | null;
  temporal_classification: TemporalClassification; is_active_issue: boolean;
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" && value ? value : null;
const instant = (value: unknown) => text(value) && Number.isFinite(Date.parse(String(value))) ? String(value) : null;
const time = (value: unknown) => instant(value) ? Date.parse(String(value)) : NaN;
const numeric = (value: unknown) => value != null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const original = (type: string) => type === "MISSED_LEVEL" || type === "MISSED_LEVEL_DURING_REARM";
const diagnosed = (type: string) => type === "MISSED_LEVEL_DIAGNOSED";
const engineCauses = new Set(["STALE_CACHED_RUN_DISCOVERY", "DELAYED_TP_RECONCILIATION", "ENGINE_RECONCILIATION_DELAY", "ENGINE_PRIORITY_VIOLATION", "ADAPTER_DISPATCH_FAILURE", "STRATEGY_DECISION_NOT_DISPATCHED"]);
const externalCauses = new Set(["EXCHANGE_OUTAGE", "EXCHANGE_REJECTED_ORDER", "TESTNET_RESET", "EXCHANGE_FILTER_CHANGE"]);

export function classifyMissedLevelTemporal(input: Omit<TemporalMissedOccurrence, "temporal_classification" | "is_active_issue"> & { external_evidence?: string | null }): TemporalMissedOccurrence {
  const boundary = time(input.strategy_effective_at);
  const first = time(input.first_cross_at), occurred = time(input.occurred_at), upper = time(input.occurred_by_at), detected = time(input.detected_at);
  const windowStart = input.occurred_at_basis === "TP_FILL_UNRECONCILED_WINDOW_START";
  // A TP starts the causal window, but does NOT prove the market crossed then.
  // A pre-version upper bound (e.g. a lower Testnet fill) does prove the incident
  // already existed. Database insertion/diagnosis time is deliberately absent.
  const contradiction = Number.isFinite(first) && Number.isFinite(upper) && first > upper
    || Number.isFinite(occurred) && Number.isFinite(upper) && occurred > upper
    || Number.isFinite(first) && Number.isFinite(detected) && first > detected;
  const pre = first < boundary || upper < boundary || detected < boundary || !windowStart && occurred < boundary;
  const post = first >= boundary || occurred >= boundary;
  const classification: TemporalClassification = contradiction || pre && post ? "UNRESOLVED" : pre ? "HISTORICAL_PRE_4_1"
    : post && engineCauses.has(input.root_cause || "") ? "POST_4_1_REGRESSION"
    : post && externalCauses.has(input.root_cause || "") && input.external_evidence ? "POST_4_1_EXTERNAL" : "UNRESOLVED";
  // A remediation must be evidenced, not merely the timestamp of this report.
  const resolutionProven = Boolean(input.resolved_by_version && input.resolved_at && input.evidence_source && input.root_cause)
    && time(input.resolved_at) >= Math.max(Number.isFinite(first) ? first : -Infinity, Number.isFinite(occurred) ? occurred : -Infinity,
      Number.isFinite(upper) ? upper : -Infinity, input.resolved_by_version === "4.1.0" ? boundary : -Infinity);
  const { external_evidence: _external, ...occurrence } = input;
  return { ...occurrence, temporal_classification: classification, is_active_issue: classification === "UNRESOLVED" || !resolutionProven };
}

/** One occurrence per original event; additive diagnoses only enrich that event.
 * An old diagnosis can never overwrite a later occurrence of the same slot. */
export function buildTestnetMissedOccurrences(events: TestnetMissedEvent[], context: Context = {}): TemporalMissedOccurrence[] {
  const rows = events.filter((event) => original(event.event_type) || diagnosed(event.event_type))
    .map((event) => ({ ...event, cycle_id: event.run_id ?? event.cycle_id ?? context.cycleId ?? "", slot: event.slot_number ?? event.slot ?? null }))
    .filter((event) => !context.cycleId || event.cycle_id === context.cycleId);
  const identity = (event: TestnetMissedEvent) => event.id ?? event.event_id ?? `${event.cycle_id}:${event.slot}:${event.event_type}:${event.observed_at ?? event.timestamp}`;
  const originals = [...new Map(rows.filter((event) => original(event.event_type)).map((event) => [identity(event), event])).values()];
  const diagnoses = rows.filter((event) => diagnosed(event.event_type)).sort((a, b) => time(a.observed_at ?? a.timestamp) - time(b.observed_at ?? b.timestamp));
  const attached = new Set<TestnetMissedEvent>();
  const build = (event: TestnetMissedEvent, extra: TestnetMissedEvent[]) => {
    const initial = object(event.details);
    // NULL in a diagnosis is absence of evidence, not permission to erase a
    // previously observed value. Original event timestamps always remain intact.
    const evidence = Object.assign({}, initial, ...extra.map((item) => Object.fromEntries(Object.entries(object(item.details)).filter(([, value]) => value != null)))) as Record<string, unknown>;
    const observed = instant(event.observed_at ?? event.timestamp);
    const detectedAt = instant(evidence.detected_at) ?? (original(event.event_type) ? observed : null);
    const firstCross = instant(evidence.first_cross_at);
    const occurredAt = instant(evidence.occurred_at) ?? firstCross ?? (time(detectedAt) < time(STRATEGY_4_1_EFFECTIVE_AT) ? detectedAt : null);
    const basis = text(evidence.occurred_at_basis) ?? (firstCross ? "EXCHANGE_FIRST_CROSS" : occurredAt ? "MISSED_OBSERVED_NO_LATER_THAN" : null);
    const source = text(evidence.evidence_source) ?? (typeof evidence.evidence_source === "object" ? JSON.stringify(evidence.evidence_source) : null);
    return classifyMissedLevelTemporal({
      asset: event.asset ?? context.asset ?? text(evidence.asset) ?? "", cycle_id: event.run_id ?? event.cycle_id ?? context.cycleId ?? "",
      slot: event.slot_number ?? event.slot ?? null, source_event_id: original(event.event_type) ? event.id ?? event.event_id ?? null : text(evidence.original_event_id),
      operation_id: text(evidence.operation_id ?? evidence.operationId), operation_sequence: numeric(evidence.operation_sequence ?? evidence.operationSequence),
      target_price: numeric(evidence.target_price ?? evidence.targetPrice ?? evidence.target), event_type: event.event_type,
      first_cross_at: firstCross, occurred_at: occurredAt, occurred_at_basis: basis,
      occurred_by_at: instant(evidence.occurred_by_at) ?? (time(detectedAt) < time(STRATEGY_4_1_EFFECTIVE_AT) ? detectedAt : null),
      detected_at: detectedAt, created_at: instant(original(event.event_type) ? event.created_at ?? evidence.original_created_at : evidence.original_created_at),
      strategy_version: text(evidence.strategy_version_at_occurrence), detected_by_strategy_version: text(evidence.detected_by_strategy_version ?? initial.strategy_version),
      strategy_effective_at: STRATEGY_4_1_EFFECTIVE_AT, root_cause: text(evidence.root_cause),
      resolved_at: instant(evidence.resolved_at), resolved_by_version: text(evidence.resolved_by_version),
      evidence_source: source, external_evidence: text(evidence.external_evidence),
    });
  };
  const result = originals.map((event) => {
    const matches = diagnoses.filter((diagnosis) => {
      if (diagnosis.cycle_id !== event.cycle_id || diagnosis.slot !== event.slot) return false;
      const details = object(diagnosis.details), originalDetails = object(event.details);
      if (details.original_event_id) return details.original_event_id === (event.id ?? event.event_id);
      const sequence = numeric(details.operation_sequence ?? details.operationSequence);
      const originalSequence = numeric(originalDetails.operation_sequence ?? originalDetails.operationSequence);
      if (sequence !== null && originalSequence !== null && sequence !== originalSequence) return false;
      const candidates = originals.filter((candidate) => candidate.cycle_id === event.cycle_id && candidate.slot === event.slot
        && (sequence === null || numeric(object(candidate.details).operation_sequence ?? object(candidate.details).operationSequence) === sequence));
      if (candidates.length === 1) return true;
      const detected = time(details.detected_at), sourceTime = time(originalDetails.detected_at ?? event.observed_at ?? event.timestamp);
      return Number.isFinite(detected) && Math.abs(detected - sourceTime) <= 1000;
    });
    matches.forEach((event) => attached.add(event));
    return build(event, matches);
  });
  // A truncated source may contain only a diagnosis. Preserve it as incomplete
  // evidence instead of silently presenting zero occurrences / a green motor.
  const orphanGroups: TestnetMissedEvent[][] = [];
  for (const event of diagnoses.filter((event) => !attached.has(event))) {
    const details = object(event.details);
    const group = orphanGroups.find((items) => items.some((candidate) => {
      if (candidate.cycle_id !== event.cycle_id || candidate.slot !== event.slot) return false;
      const other = object(candidate.details);
      if (details.original_event_id && other.original_event_id) return details.original_event_id === other.original_event_id;
      const seq = numeric(details.operation_sequence ?? details.operationSequence), otherSeq = numeric(other.operation_sequence ?? other.operationSequence);
      const target = numeric(details.target_price ?? details.targetPrice), otherTarget = numeric(other.target_price ?? other.targetPrice);
      if (seq !== null && otherSeq !== null && seq !== otherSeq || target !== null && otherTarget !== null && target !== otherTarget) return false;
      return Math.abs(time(details.detected_at) - time(other.detected_at)) <= 1000;
    }));
    if (group) group.push(event); else orphanGroups.push([event]);
  }
  for (const [event, ...extra] of orphanGroups) if (event) result.push(build(event, extra));
  for (const slot of context.fallbackSlots ?? []) {
    if (!slot.missed_at || result.some((row) => row.slot === slot.slot_number && (!context.cycleId || row.cycle_id === context.cycleId))) continue;
    result.push(build({ cycle_id: context.cycleId, slot: slot.slot_number, event_type: "MISSED_LEVEL", observed_at: slot.missed_at,
      details: { operation_sequence: slot.operation_sequence, target_price: slot.target_buy_price, evidence_source: "robot_v1_testnet_slots.missed_at; source event unavailable" } }, []));
  }
  return result.sort((a, b) => (a.detected_at ?? "").localeCompare(b.detected_at ?? "") || a.cycle_id.localeCompare(b.cycle_id) || Number(a.slot) - Number(b.slot));
}

export function summarizeTemporalMissed(rows: TemporalMissedOccurrence[]) {
  return {
    historicalCount: rows.filter((row) => row.temporal_classification === "HISTORICAL_PRE_4_1").length,
    currentVersionCount: rows.filter((row) => row.temporal_classification === "POST_4_1_REGRESSION" || row.temporal_classification === "POST_4_1_EXTERNAL").length,
    activeIssueCount: rows.filter((row) => row.is_active_issue).length,
    unresolvedCount: rows.filter((row) => row.temporal_classification === "UNRESOLVED" || row.is_active_issue && row.temporal_classification === "HISTORICAL_PRE_4_1").length,
    regressionCount: rows.filter((row) => row.temporal_classification === "POST_4_1_REGRESSION" && row.is_active_issue).length,
    externalCount: rows.filter((row) => row.temporal_classification === "POST_4_1_EXTERNAL").length,
  };
}
