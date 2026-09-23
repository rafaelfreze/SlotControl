type Event = { event_type: string; observed_at: string; details: Record<string, unknown> };
export const TESTNET_MISSED_EVENT_TYPES = ["MISSED_LEVEL", "MISSED_LEVEL_DURING_REARM", "MISSED_LEVEL_DIAGNOSED"] as const;
const text = (value: unknown) => typeof value === "string" ? value : null;
const number = (value: unknown) => value != null && Number.isFinite(Number(value)) ? Number(value) : null;
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
export function missedLevelCauseLabel(cause: string | null) {
  if (cause === "DELAYED_TP_RECONCILIATION") return "O TP já havia sido preenchido, mas sua confirmação chegou atrasada ao motor";
  if (cause === "NO_RESIDENT_BUY_AT_OBSERVATION") return "O preço foi observado além do nível antes de existir uma compra residente";
  return cause === "STALE_CACHED_RUN_DISCOVERY" ? "A descoberta de ciclos usava um cache desatualizado, atrasando a reconciliação" : cause || "evidência histórica insuficiente; revisão necessária";
}

/** Presentation only; absence is not zero and diagnosis never creates a fill. */
export function missedLevelEvidence(events: Event[]) {
  const evidence = events.filter((event) => /MISSED_LEVEL/.test(event.event_type)).sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  const details = Object.assign({}, ...evidence.map((event) => event.details)) as Record<string, unknown>;
  const occurrence = evidence.find((event) => event.event_type === "MISSED_LEVEL" || event.event_type === "MISSED_LEVEL_DURING_REARM");
  const observedPrice = (keys: string[]) => {
    for (const event of [...evidence].reverse()) for (const key of keys) {
      const value = number(event.details[key]);
      if (value !== null) return value;
    }
    return null;
  };
  return {
    // A later diagnosis is not a new occurrence. With no original timestamp the
    // caller can use the slot's persisted missed_at; never substitute audit time.
    rootCause: text(details.root_cause), observedAt: timestamp(details.detected_at) ?? timestamp(occurrence?.observed_at),
    firstCrossAt: text(details.first_cross_at), fillAt: text(details.filled_at), collectedAt: text(details.collected_at),
    decisionCreatedAt: text(details.decision_created_at), dispatchedAt: text(details.decision_dispatched_at),
    ackAt: text(details.exchange_ack_at), residentAt: text(details.order_resident_at),
    targetPrice: observedPrice(["target_price", "targetPrice", "target"]),
    marketPrice: observedPrice(["market_price", "marketPrice"]),
    latencyMs: number(details.latency_ms ?? details.reconciliation_gap_ms), resolvedByVersion: text(details.resolved_by_version),
  };
}
