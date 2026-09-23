type Event = { event_type: string; observed_at: string; details: Record<string, unknown> };
const text = (value: unknown) => typeof value === "string" ? value : null;
const number = (value: unknown) => value != null && Number.isFinite(Number(value)) ? Number(value) : null;
export function missedLevelCauseLabel(cause: string | null) {
  return cause === "STALE_CACHED_RUN_DISCOVERY" ? "A descoberta de ciclos usava um cache desatualizado, atrasando a reconciliação" : cause || "evidência histórica insuficiente; revisão necessária";
}

/** Presentation only; absence is not zero and diagnosis never creates a fill. */
export function missedLevelEvidence(events: Event[]) {
  const evidence = events.filter((event) => /MISSED_LEVEL/.test(event.event_type)).sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  const details = Object.assign({}, ...evidence.map((event) => event.details)) as Record<string, unknown>;
  return {
    rootCause: text(details.root_cause), observedAt: evidence[0]?.observed_at ?? null,
    firstCrossAt: text(details.first_cross_at), fillAt: text(details.filled_at), collectedAt: text(details.collected_at),
    decisionCreatedAt: text(details.decision_created_at), dispatchedAt: text(details.decision_dispatched_at),
    ackAt: text(details.exchange_ack_at), residentAt: text(details.order_resident_at),
    targetPrice: number(details.target_price ?? details.targetPrice ?? details.target),
    marketPrice: number(details.market_price ?? details.marketPrice),
    latencyMs: number(details.latency_ms ?? details.reconciliation_gap_ms), resolvedByVersion: text(details.resolved_by_version),
  };
}
