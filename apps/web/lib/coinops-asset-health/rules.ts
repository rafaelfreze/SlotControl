import type { AssetCategoryAssessment, AssetHealthAsset, AssetHealthAssessment, AssetHealthCategory, AssetHealthStatus, AssetMetric, AssetMetricClass } from "./types";

export const ASSET_HEALTH_MIN_CATEGORIES: Record<AssetHealthAsset, number> = { BTC: 4, SOL: 5 };
export const ASSET_HEALTH_MIN_METRICS: Record<AssetHealthAsset, number> = { BTC: 6, SOL: 8 };
export const STRUCTURAL_PERSISTENCE_MS = 6 * 60 * 60_000;
export const ASSET_HEALTH_DECISION_POLICY = {
  attentionIndependentPrimarySignals: 2,
  attentionConfirmedCriticalSignals: 1,
  structuralIndependentSources: 2,
  structuralCategories: 2,
  structuralPersistenceMs: STRUCTURAL_PERSISTENCE_MS,
} as const;
const CATEGORIES: AssetHealthCategory[] = ["NETWORK", "SECURITY", "DEVELOPMENT", "LIQUIDITY", "ECOSYSTEM"];
const categoryLabels: Record<AssetHealthCategory, string> = {
  NETWORK: "Rede", SECURITY: "Segurança", DEVELOPMENT: "Desenvolvimento", LIQUIDITY: "Liquidez", ECOSYSTEM: "Ecossistema",
};
const available = (metric: AssetMetric) => !["SOURCE_UNAVAILABLE", "DATA_STALE"].includes(metric.status);
const evidenceKey = (metric: AssetMetric) => `${metric.source.id}:${metric.key}`;
const independence = (metric: AssetMetric) => metric.source.independenceGroup ?? metric.source.id;
/** Compatibility for snapshots created before evidence tiers existed. */
export const indicatorClass = (metric: AssetMetric): AssetMetricClass => metric.indicatorClass
  ?? (metric.key === "nakamoto_coefficient" || metric.key === "vote_account_superminority_proxy" ? "COMPLEMENTARY_PROXY" : "PRIMARY");

function effectiveMetric(metric: AssetMetric, now: Date): AssetMetric {
  if (!available(metric)) return metric;
  // A freshly checked release from last month is fresh evidence; event age is evaluated separately.
  const reference = Date.parse(metric.observedAt ?? metric.fetchedAt);
  if (!Number.isFinite(reference) || reference > now.getTime() + 60_000 || now.getTime() - reference > metric.ttlSeconds * 1_000)
    return { ...metric, status: "DATA_STALE", reason: `${metric.label}: última observação fora do TTL; valor preservado sem inferir risco.` };
  return metric;
}

/** Last-good evidence keeps its original TTL; a collection failure never refreshes its age. */
export function mergeAssetHealthMetrics(previous: AssetMetric[], collected: AssetMetric[], now = new Date()): AssetMetric[] {
  const merged = new Map(previous.map((item) => [`${item.asset}:${evidenceKey(item)}`, item]));
  // The old internal key could otherwise survive one TTL beside its explicit proxy replacement.
  if (collected.some((item) => item.asset === "SOL" && item.key === "vote_account_superminority_proxy")) {
    for (const [key, item] of merged) if (item.asset === "SOL" && item.key === "nakamoto_coefficient") merged.delete(key);
  }
  for (const item of collected) {
    const key = `${item.asset}:${evidenceKey(item)}`, prior = merged.get(key);
    if (item.status === "SOURCE_UNAVAILABLE" && prior && available(effectiveMetric(prior, now))) {
      merged.set(key, { ...prior, collectionStatus: "SOURCE_UNAVAILABLE", errorCode: item.errorCode, errorAt: item.fetchedAt });
    } else if (item.status === "SOURCE_UNAVAILABLE" && prior?.value != null) {
      merged.set(key, { ...prior, status: "DATA_STALE", collectionStatus: "SOURCE_UNAVAILABLE",
        errorCode: item.errorCode, errorAt: item.fetchedAt, reason: `${prior.label}: última evidência expirou e a fonte está indisponível.` });
    } else merged.set(key, { ...item, collectionStatus: item.status === "SOURCE_UNAVAILABLE" ? "SOURCE_UNAVAILABLE" : "OK" });
  }
  return [...merged.values()].map((item) => effectiveMetric(item, now));
}

function categoryAssessment(category: AssetHealthCategory, metrics: AssetMetric[]): AssetCategoryAssessment {
  const measured = metrics.filter((metric) => available(metric) && !metric.contextOnly && !metric.optional);
  const degraded = measured.filter((metric) => metric.status === "CRITICAL" || metric.status === "WARNING");
  const confirmedCritical = degraded.filter((metric) => indicatorClass(metric) === "CRITICAL" && metric.status === "CRITICAL" && metric.confidence === "HIGH");
  const primary = degraded.filter((metric) => indicatorClass(metric) === "PRIMARY");
  const proxy = degraded.filter((metric) => indicatorClass(metric) === "COMPLEMENTARY_PROXY");
  const state = !measured.length ? "INSUFFICIENT_DATA" : confirmedCritical.length ? "RISK" : primary.length ? "ATTENTION" : proxy.length ? "OBSERVE" : "HEALTHY";
  return { category, status: state, healthy: measured.filter((metric) => metric.status === "HEALTHY").length, total: measured.length,
    summary: !measured.length ? `${categoryLabels[category]} sem evidência recente suficiente.`
      : confirmedCritical[0]?.reason ?? primary[0]?.reason ?? proxy[0]?.reason ?? `${categoryLabels[category]} sem deterioração relevante nos indicadores medidos.` };
}

export type AssetHealthPreviousEvidence = {
  status: AssetHealthStatus; evaluatedAt: string; criticalCategories?: AssetHealthCategory[];
  criticalSinceByMetric?: Record<string, string>;
};

export function deriveAssetHealth(input: { asset: AssetHealthAsset; metrics: AssetMetric[]; now?: Date;
  previous?: AssetHealthPreviousEvidence | null }): AssetHealthAssessment {
  const now = input.now ?? new Date();
  const metrics = input.metrics.filter((metric) => metric.asset === input.asset).map((metric) => effectiveMetric(metric, now));
  assertTradingIsolation(metrics);
  const measured = metrics.filter((metric) => available(metric) && !metric.optional && !metric.contextOnly);
  const categories = CATEGORIES.map((category) => categoryAssessment(category, metrics.filter((metric) => metric.category === category)));
  const required = input.asset === "BTC" ? CATEGORIES.filter((category) => category !== "ECOSYSTEM") : CATEGORIES;
  const missingCategories = required.filter((category) => !measured.some((metric) => metric.category === category));
  const degraded = measured.filter((metric) => metric.status === "WARNING" || metric.status === "CRITICAL");
  const proxyObservations = degraded.filter((metric) => indicatorClass(metric) === "COMPLEMENTARY_PROXY");
  const primaryDegraded = degraded.filter((metric) => indicatorClass(metric) === "PRIMARY");
  const confirmedCritical = degraded.filter((metric) => indicatorClass(metric) === "CRITICAL"
    && metric.status === "CRITICAL" && metric.confidence === "HIGH");
  const primaryIndependentGroups = new Set(primaryDegraded.map(independence));
  const enough = !missingCategories.length && measured.length >= ASSET_HEALTH_MIN_METRICS[input.asset]
    && new Set(measured.map(independence)).size >= 3;
  // Persistence belongs to each unchanged metric, not the last snapshot date.
  // Failed cached observations and long collector gaps cannot accumulate persistence.
  const previousAt = Date.parse(input.previous?.evaluatedAt ?? "");
  const continuous = Number.isFinite(previousAt) && now.getTime() >= previousAt && now.getTime() - previousAt <= 2 * 60 * 60_000;
  const criticalSinceByMetric: Record<string, string> = {};
  const structuralCandidates = degraded.filter((metric) => indicatorClass(metric) !== "COMPLEMENTARY_PROXY"
    && metric.status === "CRITICAL" && metric.confidence !== "LOW");
  for (const metric of structuralCandidates) {
    const key = evidenceKey(metric), prior = continuous ? input.previous?.criticalSinceByMetric?.[key] : undefined;
    // Cached critical evidence can retain an already-proven risk within TTL, but cannot start or advance persistence.
    if (metric.collectionStatus === "SOURCE_UNAVAILABLE" && !prior) continue;
    criticalSinceByMetric[key] = prior && Number.isFinite(Date.parse(prior)) && Date.parse(prior) <= now.getTime() ? prior : now.toISOString();
  }
  const persistent = structuralCandidates.filter((metric) => {
    const since = criticalSinceByMetric[evidenceKey(metric)];
    const confirmedAt = Date.parse(metric.observedAt ?? metric.fetchedAt);
    const conflict = measured.some((other) => other.key === metric.key && other.status === "HEALTHY" && independence(other) !== independence(metric));
    return !conflict && since && confirmedAt - Date.parse(since) >= STRUCTURAL_PERSISTENCE_MS;
  });
  const persistentCategories = new Set(persistent.map((metric) => metric.category));
  const persistentSources = new Set(persistent.map(independence));
  const structural = persistentCategories.size >= ASSET_HEALTH_DECISION_POLICY.structuralCategories
    && persistentSources.size >= ASSET_HEALTH_DECISION_POLICY.structuralIndependentSources;
  const attention = confirmedCritical.length >= ASSET_HEALTH_DECISION_POLICY.attentionConfirmedCriticalSignals
    || primaryIndependentGroups.size >= ASSET_HEALTH_DECISION_POLICY.attentionIndependentPrimarySignals;
  const status: AssetHealthStatus = !enough ? "INSUFFICIENT_DATA" : structural ? "STRUCTURAL_RISK"
    : attention ? "ATTENTION" : "HEALTHY";
  const reasons = status === "INSUFFICIENT_DATA"
    ? [`Cobertura recente insuficiente: ${measured.length} indicadores${missingCategories.length ? `; faltam ${missingCategories.map((category) => categoryLabels[category]).join(", ")}` : " ou fontes independentes"}. Falha de coleta não é risco do ativo.`]
    : status === "STRUCTURAL_RISK" ? persistent.slice(0, 4).map((metric) => metric.reason)
      : status === "ATTENTION" ? [...confirmedCritical, ...primaryDegraded].slice(0, 4).map((metric) => metric.reason)
        : proxyObservations.length
          ? ["O conjunto de rede, segurança, descentralização, desenvolvimento, liquidez e ecossistema não atingiu o quórum de deterioração estrutural. Há indicador complementar/proxy em observação, sem força isolada para rebaixar o ativo.", ...proxyObservations.slice(0, 3).map((metric) => metric.reason)]
          : ["Nas métricas recentes acompanhadas, rede, segurança, desenvolvimento, liquidez e ecossistema não apresentam deterioração estrutural relevante. Esta avaliação tem cobertura limitada às fontes listadas."];
  const unavailable = metrics.filter((metric) => !available(metric)).length;
  const trigger = status === "STRUCTURAL_RISK" ? `PERSISTENT_INDEPENDENT_EVIDENCE:${[...persistentCategories].join(",")}`
    : status === "ATTENTION" ? `QUALIFIED_DEGRADATION:${[...confirmedCritical, ...primaryDegraded].map((metric) => metric.key).join(",")}`
      : status === "INSUFFICIENT_DATA" ? `INSUFFICIENT:${measured.length}/${metrics.length}`
        : proxyObservations.length ? `NO_GLOBAL_DEGRADATION;OBSERVE:${proxyObservations.map((metric) => metric.key).join(",")}` : "NO_STRUCTURAL_DETERIORATION";
  const sources = [...new Set(metrics.map((metric) => metric.source.id))].map((id) => {
    const rows = metrics.filter((metric) => metric.source.id === id), latest = [...rows].sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))[0];
    const failed = rows.some((metric) => !metric.optional && (metric.collectionStatus === "SOURCE_UNAVAILABLE" || metric.status === "SOURCE_UNAVAILABLE"));
    return { ...latest.source, fetchedAt: latest.errorAt ?? latest.fetchedAt,
      status: failed ? "SOURCE_UNAVAILABLE" : rows.some((metric) => metric.status === "DATA_STALE") ? "DATA_STALE" : "OK" };
  });
  const expiry = Math.min(now.getTime() + 90 * 60_000, ...measured.map((metric) => Date.parse(metric.observedAt ?? metric.fetchedAt) + metric.ttlSeconds * 1_000));
  return { asset: input.asset, status, healthyIndicators: measured.filter((metric) => metric.status === "HEALTHY").length,
    totalIndicators: measured.length, summary: reasons[0], reasons, categories, metrics, sources,
    trigger: `${trigger}${unavailable ? `;UNAVAILABLE:${unavailable}` : ""}`, evaluatedAt: now.toISOString(),
    validUntil: new Date(Math.max(now.getTime(), expiry)).toISOString(), criticalSinceByMetric,
    coverage: { available: measured.length, expected: metrics.filter((metric) => !metric.optional && !metric.contextOnly).length,
      missingCategories, unavailableOptional: metrics.filter((metric) => (metric.optional || metric.contextOnly) && !available(metric)).length } };
}

export function shouldNotifyAssetHealthTransition(before: AssetHealthStatus | null, after: AssetHealthStatus): boolean {
  return Boolean(before && before !== after && before !== "INSUFFICIENT_DATA" && after !== "INSUFFICIENT_DATA");
}

/** Price is deliberately absent from structural decisions. */
export function assertTradingIsolation(metrics: AssetMetric[]) {
  if (metrics.some((metric) => /price|return|candle/i.test(metric.key)))
    throw new Error("COINOPS_ASSET_HEALTH_PRICE_SIGNAL_FORBIDDEN");
}
