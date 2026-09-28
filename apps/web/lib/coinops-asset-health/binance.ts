import type { BinanceHealthMetric, BinanceHealthSnapshot, BinanceHealthStatus } from "./types";

// Observability only. This module has no exchange credentials, trading client or order imports.
export const BINANCE_HEALTH_CANNOT_TRADE = true as const;
export const BINANCE_OPERATION_INTERVAL_MS = 30 * 60_000;
export const BINANCE_STRUCTURAL_INTERVAL_MS = 24 * 60 * 60_000;
export const BINANCE_ATTENTION_PERSISTENCE_MS = 60 * 60_000;
export const BINANCE_CRITICAL_PERSISTENCE_MS = 6 * 60 * 60_000;

type Shard = { id: string; enabled: boolean };
type Sample = { shard_id: string; heartbeat_at: string; weight_observed_at: string | null;
  binance_weight_current: number | null; errors_last_5m: number; reconciliation_age_ms: number;
  reconciliation_p95_ms: number; executor_version: string | null };
type FetchLike = typeof fetch;
const spot = { id: "binance-spot-rest", name: "Binance Spot REST", url: "https://developers.binance.com/en/docs/products/spot/rest-api", independenceGroup: "binance-public" };
const market = { id: "binance-market-data", name: "Binance Market Data REST", url: "https://developers.binance.com/en/docs/products/spot/rest-api", independenceGroup: "binance-public" };
const capacity = { id: "coinops-capacity", name: "CoinOps · telemetria dos executores", url: "/automacao", independenceGroup: "coinops-executors" };
const por = { id: "binance-proof-of-reserves", name: "Binance Proof of Reserves", url: "https://www.binance.com/en/proof-of-reserves", independenceGroup: "binance-disclosure" };
const official = { id: "binance-announcements", name: "Comunicados oficiais Binance", url: "https://www.binance.com/en/support/announcement", independenceGroup: "binance-disclosure" };

function fresh(metric: BinanceHealthMetric, now: Date): BinanceHealthMetric {
  if (metric.status === "SOURCE_UNAVAILABLE" || metric.status === "DATA_STALE") return metric;
  const at = Date.parse(metric.fetchedAt);
  return !Number.isFinite(at) || at > now.getTime() + 60_000 || now.getTime() - at > metric.ttlSeconds * 1000
    ? { ...metric, status: "DATA_STALE", reason: `${metric.label}: última leitura expirou; não infere risco.` } : metric;
}

/** Last good observation remains valid only until its original TTL. */
export function mergeBinanceMetrics(previous: BinanceHealthMetric[], collected: BinanceHealthMetric[], now: Date): BinanceHealthMetric[] {
  const map = new Map(previous.map((metric) => [metric.key, metric]));
  for (const metric of collected) {
    const old = map.get(metric.key);
    map.set(metric.key, metric.status === "SOURCE_UNAVAILABLE" && old && fresh(old, now).status !== "DATA_STALE"
      ? { ...old, errorCode: metric.errorCode ?? "SOURCE_UNAVAILABLE" }
      : metric);
  }
  return [...map.values()].map((metric) => fresh(metric, now));
}

async function publicProbe(fetcher: FetchLike, key: string, url: string, source: BinanceHealthMetric["source"], now: Date): Promise<BinanceHealthMetric> {
  const start = Date.now();
  try {
    const response = await fetcher(url, { cache: "no-store", headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || key === "spot_time" && !Number.isFinite(Number((body as { serverTime?: unknown }).serverTime)))
      throw new Error("INVALID_RESPONSE");
    return { key, label: key === "spot_ping" ? "Conectividade Spot REST" : "Market data / relógio Spot",
      category: "OPERATION", indicatorClass: "PRIMARY", status: "HEALTHY", value: { latencyMs: Date.now() - start },
      reason: "Endpoint público respondeu à coleta server-side; isso não prova custódia nem disponibilidade de todas as funções.",
      source, fetchedAt: now.toISOString(), metricAt: now.toISOString(), ttlSeconds: 90 * 60, confidence: "HIGH" };
  } catch (error) {
    const code = error instanceof Error && /^HTTP_[0-9]{3}$/.test(error.message) ? error.message : "PROBE_UNAVAILABLE";
    return { key, label: key === "spot_ping" ? "Conectividade Spot REST" : "Market data / relógio Spot",
      category: "OPERATION", indicatorClass: "PRIMARY", status: "SOURCE_UNAVAILABLE", value: null,
      reason: "Coleta pública falhou; uma falha isolada não representa incidente global confirmado.", source,
      fetchedAt: now.toISOString(), metricAt: null, ttlSeconds: 90 * 60, confidence: "LOW", errorCode: code };
  }
}

export async function collectBinanceMetrics(input: { now: Date; dueFast: boolean; dueStructural: boolean;
  shards: Shard[]; samples: Sample[]; fetcher?: FetchLike }): Promise<BinanceHealthMetric[]> {
  const { now, dueFast, dueStructural, shards, samples } = input, at = now.toISOString();
  const metrics: BinanceHealthMetric[] = [];
  if (dueFast) metrics.push(...await Promise.all([
    publicProbe(input.fetcher ?? fetch, "spot_ping", "https://api.binance.com/api/v3/ping", spot, now),
    publicProbe(input.fetcher ?? fetch, "spot_time", "https://data-api.binance.vision/api/v3/time", market, now),
  ]));
  for (const shard of shards.filter((row) => row.enabled)) {
    const sample = samples.find((row) => row.shard_id === shard.id);
    const age = sample ? now.getTime() - Date.parse(sample.heartbeat_at) : Infinity;
    const current = Number(sample?.binance_weight_current);
    const status: BinanceHealthMetric["status"] = !sample || !Number.isFinite(age) || age < -60_000 || age > 120_000
      ? "DATA_STALE" : sample.errors_last_5m > 0 || sample.reconciliation_age_ms > 120_000 || current >= 4_800 ? "WARNING" : "HEALTHY";
    metrics.push({ key: `executor:${shard.id}`, label: shard.id, category: "API_COINOPS", indicatorClass: "COMPLEMENTARY",
      status, value: sample ? { weightPerMin: Number.isFinite(current) ? current : null,
        errorsLast5m: sample.errors_last_5m, reconciliationAgeMs: sample.reconciliation_age_ms,
        reconciliationP95Ms: sample.reconciliation_p95_ms, version: sample.executor_version } : null,
      reason: status === "HEALTHY" ? "Telemetria local recente, sem erro agregado nos últimos 5 min."
        : status === "DATA_STALE" ? "Heartbeat local ausente ou atrasado; não implica falha global Binance."
          : "Telemetria local requer atenção; erro agregado não prova falha da Binance.",
      source: { ...capacity, id: `coinops-capacity:${shard.id}` }, fetchedAt: at,
      metricAt: sample?.heartbeat_at ?? null, ttlSeconds: 180, confidence: status === "DATA_STALE" ? "LOW" : "HIGH",
      shardId: shard.id, optional: true });
  }
  if (dueStructural) for (const [key, label, category, source] of [
    ["proof_of_reserves", "Proof of Reserves", "RESERVES", por],
    ["security_events", "Incidentes de segurança", "SECURITY", official],
    ["deposits_withdrawals", "Depósitos e saques", "WITHDRAWALS", official],
    ["material_regulation", "Fatos regulatórios materiais", "REGULATION", official],
    ["websocket", "WebSocket Spot", "OPERATION", spot],
  ] as const) metrics.push({ key, label, category, indicatorClass: "COMPLEMENTARY", status: "SOURCE_UNAVAILABLE",
    value: null, reason: "Sem feed oficial estruturado e verificável neste coletor. Não inferir normalidade ou risco.",
    source, fetchedAt: at, metricAt: null, ttlSeconds: 48 * 60 * 60, confidence: "LOW",
    errorCode: "NO_VERIFIABLE_STRUCTURED_FEED", optional: true });
  return metrics;
}

export function deriveBinanceHealth(input: { metrics: BinanceHealthMetric[]; previous?: BinanceHealthSnapshot | null; now: Date }): BinanceHealthSnapshot {
  const { now } = input, metrics = input.metrics.map((metric) => fresh(metric, now));
  const by = (key: string) => metrics.find((metric) => metric.key === key);
  const probes = [by("spot_ping"), by("spot_time")];
  const failures = probes.filter((metric) => metric?.status === "SOURCE_UNAVAILABLE" || metric?.status === "DATA_STALE");
  const healthy = probes.filter((metric) => metric?.status === "HEALTHY");
  const previousAt = Date.parse(input.previous?.evaluatedAt ?? "");
  const continuous = Number.isFinite(previousAt) && now.getTime() - previousAt <= 2 * BINANCE_OPERATION_INTERVAL_MS + 15 * 60_000;
  const failureSinceByMetric: Record<string, string> = {};
  for (const metric of failures) if (metric) {
    const old = continuous ? input.previous?.failureSinceByMetric?.[metric.key] : undefined;
    failureSinceByMetric[metric.key] = old && Number.isFinite(Date.parse(old)) ? old : now.toISOString();
  }
  // Public endpoints share Binance infrastructure. They can justify ATTENTION after persistence,
  // never CRITICAL_RISK by themselves. Executor/IP errors are intentionally excluded.
  const corroboratingShards = metrics.filter((metric) => metric.shardId && metric.status === "WARNING"
    && typeof metric.value === "object" && metric.value !== null
    && Number((metric.value as { errorsLast5m?: unknown }).errorsLast5m) > 0).length;
  const persistentPublicFailure = failures.length === 2 && corroboratingShards >= 2 && failures.every((metric) => metric &&
    now.getTime() - Date.parse(failureSinceByMetric[metric.key]) >= BINANCE_ATTENTION_PERSISTENCE_MS);
  const confirmedCritical = metrics.filter((metric) => metric.indicatorClass === "CRITICAL" && metric.status === "CRITICAL"
    && metric.confidence === "HIGH" && !metric.shardId);
  const groups = new Set(confirmedCritical.map((metric) => metric.source.independenceGroup));
  const criticalSince = confirmedCritical.length && continuous ? input.previous?.failureSinceByMetric?.critical : undefined;
  if (confirmedCritical.length) failureSinceByMetric.critical = criticalSince ?? now.toISOString();
  const critical = groups.size >= 2 && confirmedCritical.length >= 2 &&
    now.getTime() - Date.parse(failureSinceByMetric.critical) >= BINANCE_CRITICAL_PERSISTENCE_MS;
  const status: BinanceHealthStatus = critical ? "CRITICAL_RISK" : persistentPublicFailure ? "ATTENTION"
    : healthy.length === 2 ? "HEALTHY" : "INSUFFICIENT_DATA";
  const local = metrics.filter((metric) => metric.shardId && metric.status !== "HEALTHY");
  const reasons = status === "HEALTHY" ? ["As duas leituras públicas Spot estão recentes e responderam. Isto avalia disponibilidade observada, não solvência, segurança total ou todos os serviços da Binance."]
    : status === "ATTENTION" ? ["Ambos os endpoints públicos Spot falharam por pelo menos uma hora e mais de um executor registrou erros. Requer investigação; não comprova risco de custódia e não altera trading."]
      : status === "CRITICAL_RISK" ? confirmedCritical.map((metric) => metric.reason)
        : ["Leituras públicas Spot insuficientes ou vencidas. Falha de fonte não comprova falha global da exchange."];
  if (local.length) reasons.push(`${local.length} executor(es) com telemetria local a observar; isso não reclassifica a Binance globalmente.`);
  const sources = [...new Map(metrics.map((metric) => [metric.source.id, metric.source])).values()].map((source) => {
    const rows = metrics.filter((metric) => metric.source.id === source.id);
    return { id: source.id, name: source.name, url: source.url, fetchedAt: rows.at(-1)!.fetchedAt,
      status: rows.some((metric) => metric.status === "SOURCE_UNAVAILABLE" || metric.status === "DATA_STALE") ? "SOURCE_UNAVAILABLE" : "OK" };
  });
  return { asset: "BINANCE", status, previousStatus: input.previous?.status ?? null, evaluatedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + 90 * 60_000).toISOString(), summary: reasons[0], reasons,
    trigger: critical ? "CONFIRMED_PERSISTENT_MULTI_SOURCE" : persistentPublicFailure ? "PERSISTENT_PUBLIC_SPOT_FAILURE"
      : status === "HEALTHY" ? "PUBLIC_SPOT_OBSERVED" : "PUBLIC_SPOT_EVIDENCE_INSUFFICIENT",
    metrics, sources, failureSinceByMetric };
}
