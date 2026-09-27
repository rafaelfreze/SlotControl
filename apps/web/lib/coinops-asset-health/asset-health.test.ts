import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveAssetHealth, mergeAssetHealthMetrics, shouldNotifyAssetHealthTransition, STRUCTURAL_PERSISTENCE_MS } from "./rules.ts";
import { collectAssetHealthMetrics } from "./sources.ts";
import type { AssetHealthAsset, AssetHealthAssessment, AssetMetric } from "./types.ts";

const now = new Date("2026-09-27T12:00:00.000Z");
function fixtures(asset: AssetHealthAsset, at = now): AssetMetric[] {
  return (["NETWORK", "SECURITY", "DEVELOPMENT", "LIQUIDITY", "ECOSYSTEM"] as const).flatMap((category, index) => [0, 1].map((n) => ({
    asset, key: `${category.toLowerCase()}_${n}`, label: `${category} ${n}`, category,
    cadence: "FAST" as const, status: "HEALTHY" as const, value: 100, unit: null, reason: `${category} evidence`,
    confidence: "HIGH" as const, source: { id: `source-${index}`, name: category, url: `https://example.org/${category}` },
    fetchedAt: at.toISOString(), observedAt: at.toISOString(), metricAt: at.toISOString(), ttlSeconds: 7200,
  })));
}
const assess = (asset: AssetHealthAsset, metrics = fixtures(asset), at = now, previous?: AssetHealthAssessment) => deriveAssetHealth({ asset, metrics, now: at, previous });

for (const asset of ["BTC", "SOL"] as const) test(`${asset}: sufficient recent independent coverage is healthy`, () => {
  assert.equal(assess(asset).status, "HEALTHY");
});
test("one degraded metric and temporary outage yield attention, never structural risk", () => {
  const metrics = fixtures("SOL"); metrics[0].status = "CRITICAL";
  assert.equal(assess("SOL", metrics).status, "ATTENTION");
});
test("critical multi-source evidence must persist through fresh observations for six hours", () => {
  let previous: AssetHealthAssessment | undefined;
  for (let hour = 0; hour <= 6; hour++) {
    const at = new Date(now.getTime() + hour * 3600_000), metrics = fixtures("SOL", at);
    metrics[0].status = "CRITICAL"; metrics[2].status = "CRITICAL";
    previous = assess("SOL", metrics, at, previous);
    assert.equal(previous.status, hour === 6 ? "STRUCTURAL_RISK" : "ATTENTION");
  }
  const at = new Date(now.getTime() + 7 * 3600_000);
  const recovered = assess("SOL", fixtures("SOL", at), at, previous);
  assert.equal(recovered.status, "HEALTHY"); assert.deepEqual(recovered.criticalSinceByMetric, {});
});
test("critical categories from one underlying organization cannot claim independent confirmation", () => {
  const metrics = fixtures("BTC"); metrics[0].status = metrics[2].status = "CRITICAL";
  metrics[0].source.independenceGroup = metrics[2].source.independenceGroup = "shared-provider";
  const start = assess("BTC", metrics);
  const later = new Date(now.getTime() + STRUCTURAL_PERSISTENCE_MS);
  const recent = metrics.map((metric) => ({ ...metric, observedAt: later.toISOString(), fetchedAt: later.toISOString() }));
  assert.equal(assess("BTC", recent, later, { ...start, evaluatedAt: new Date(later.getTime() - 3600_000).toISOString() }).status, "ATTENTION");
});
test("contradictory independent observations of same network metric prevent structural escalation", () => {
  const metrics = fixtures("BTC"); metrics[0].status = metrics[2].status = "CRITICAL";
  metrics.push({ ...metrics[0], status: "HEALTHY", source: { id: "independent", name: "Independent", url: "https://example.org" } });
  const start = assess("BTC", metrics), later = new Date(now.getTime() + STRUCTURAL_PERSISTENCE_MS);
  const recent = metrics.map((metric) => ({ ...metric, observedAt: later.toISOString(), fetchedAt: later.toISOString() }));
  assert.equal(assess("BTC", recent, later, { ...start, evaluatedAt: new Date(later.getTime() - 3600_000).toISOString() }).status, "ATTENTION");
});
test("long collector gap resets persistence instead of turning missing time into structural evidence", () => {
  const metrics = fixtures("SOL"); metrics[0].status = metrics[2].status = "CRITICAL";
  const start = assess("SOL", metrics), later = new Date(now.getTime() + STRUCTURAL_PERSISTENCE_MS);
  const recent = metrics.map((metric) => ({ ...metric, observedAt: later.toISOString(), fetchedAt: later.toISOString() }));
  assert.equal(assess("SOL", recent, later, start).status, "ATTENTION");
});
test("read-only re-evaluation cannot promote attention without a later source observation", () => {
  const metrics = fixtures("SOL"); metrics[0].status = metrics[2].status = "CRITICAL";
  const start = assess("SOL", metrics);
  const atFiveHours = new Date(now.getTime() + 5 * 3600_000);
  const atSixHours = new Date(now.getTime() + 6 * 3600_000);
  const recent = metrics.map((metric) => ({ ...metric, fetchedAt: atFiveHours.toISOString(), observedAt: atFiveHours.toISOString() }));
  const five = assess("SOL", recent, atFiveHours, { ...start, evaluatedAt: new Date(atFiveHours.getTime() - 3600_000).toISOString() });
  assert.equal(five.status, "ATTENTION");
  assert.equal(assess("SOL", recent, atSixHours, five).status, "ATTENTION");
});
test("temporary collection failure cannot erase structural risk already proven within TTL", () => {
  const metrics = fixtures("SOL"); metrics[0].status = metrics[2].status = "CRITICAL";
  const start = assess("SOL", metrics), later = new Date(now.getTime() + 6 * 3600_000);
  const recent = metrics.map((metric) => ({ ...metric, fetchedAt: later.toISOString(), observedAt: later.toISOString() }));
  const risk = assess("SOL", recent, later, { ...start, evaluatedAt: new Date(later.getTime() - 3600_000).toISOString() });
  assert.equal(risk.status, "STRUCTURAL_RISK");
  const oneHourLater = new Date(later.getTime() + 3600_000);
  const failures = recent.filter((metric) => metric.status === "CRITICAL").map((metric) => ({ ...metric,
    status: "SOURCE_UNAVAILABLE" as const, fetchedAt: oneHourLater.toISOString() }));
  assert.equal(assess("SOL", mergeAssetHealthMetrics(recent, failures, oneHourLater), oneHourLater, risk).status, "STRUCTURAL_RISK");
});
test("source failure keeps last good data only inside original TTL with visible error", () => {
  const metrics = fixtures("SOL"), later = new Date(now.getTime() + 3600_000);
  const failure: AssetMetric = { ...metrics[0], status: "SOURCE_UNAVAILABLE", value: null, fetchedAt: later.toISOString(), errorCode: "HTTP_503" };
  const merged = mergeAssetHealthMetrics(metrics, [failure], later);
  assert.equal(merged[0].value, 100); assert.equal(merged[0].fetchedAt, now.toISOString());
  assert.equal(merged[0].collectionStatus, "SOURCE_UNAVAILABLE"); assert.equal(merged[0].errorCode, "HTTP_503");
  const expired = mergeAssetHealthMetrics(merged, [failure], new Date(now.getTime() + 3 * 3600_000));
  assert.equal(expired[0].status, "DATA_STALE");
  assert.equal(assess("SOL", expired, new Date(now.getTime() + 3 * 3600_000)).status, "INSUFFICIENT_DATA");
});
test("freshly queried old release/event is fresh evidence, not a stale collector", () => {
  const metrics = fixtures("BTC"); metrics[4].metricAt = "2026-08-01T00:00:00Z";
  assert.equal(assess("BTC", metrics).status, "HEALTHY");
});
test("missing required category cannot be hidden by many metrics elsewhere", () => {
  assert.equal(assess("SOL", fixtures("SOL").filter((metric) => metric.category !== "SECURITY")).status, "INSUFFICIENT_DATA");
});
test("optional unavailable measurements are explicit without claiming coverage", () => {
  const metrics = fixtures("SOL"); metrics.push({ ...metrics[0], key: "client_diversity", optional: true, status: "SOURCE_UNAVAILABLE", value: null });
  const result = assess("SOL", metrics);
  assert.equal(result.status, "HEALTHY"); assert.equal(result.totalIndicators, 10); assert.equal(result.coverage.unavailableOptional, 1);
});
test("extreme price context cannot change health or be accepted as structural signal", () => {
  const metrics = fixtures("SOL"); metrics[8].value = { totalUsd: 10, assetPriceChangePct: -99 }; metrics[8].contextOnly = true;
  assert.equal(assess("SOL", metrics).status, "HEALTHY");
  assert.throws(() => assess("SOL", [...metrics, { ...metrics[0], key: "price_drop_24h", value: -99, status: "CRITICAL" }]), /PRICE_SIGNAL_FORBIDDEN/);
});
test("transition notifications deduplicate stable status and do not label source outage as asset deterioration", () => {
  assert.equal(shouldNotifyAssetHealthTransition("HEALTHY", "HEALTHY"), false);
  assert.equal(shouldNotifyAssetHealthTransition(null, "HEALTHY"), false);
  assert.equal(shouldNotifyAssetHealthTransition("HEALTHY", "INSUFFICIENT_DATA"), false);
  for (const [before, after] of [["HEALTHY", "ATTENTION"], ["ATTENTION", "STRUCTURAL_RISK"], ["STRUCTURAL_RISK", "ATTENTION"], ["ATTENTION", "HEALTHY"]] as const)
    assert.equal(shouldNotifyAssetHealthTransition(before, after), true);
});

const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
function mockFetcher(tickerVolume: unknown = "1000000000") {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.includes("ticker/24hr")) return reply({ quoteVolume: tickerVolume, priceChangePercent: "-99" });
    if (path.includes("/depth")) return reply({ bids: [["100", "2"]], asks: [["100.01", "2"]] });
    if (path.endsWith("/blocks")) return reply(Array.from({ length: 15 }, (_, index) => ({ timestamp: now.getTime() / 1000 - index * 600 - 60 })));
    if (path.endsWith("/mempool")) return reply({ count: 100, vsize: 10000 });
    if (path.includes("summary.json")) return reply({ status: { indicator: "none" }, page: { updated_at: "2025-01-01T00:00:00Z" } });
    if (path.includes("mainnet-beta")) {
      const raw = JSON.parse(String(init?.body));
      if (!Array.isArray(raw)) { assert.equal(raw.method, "getBlockTime"); return reply({ id: 4, result: now.getTime() / 1000 - 15 }); }
      const requests = raw as Array<{ id: number; method: string }>;
      return reply(requests.map(({ id, method }) => {
        assert.notEqual(method, "getPerformanceSamples", "unsupported RPC method must never recur");
        return { id, result: method === "getHealth" ? "ok" : method === "getEpochInfo" ? { absoluteSlot: 1234 }
          : method === "getRecentPerformanceSamples" ? [{ numSlots: 150, samplePeriodSecs: 60, numTransactions: 90000, numNonVoteTransactions: 12000 }] : {} };
      }));
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
}
test("collector uses official Solana sample method and excludes vote traffic", async () => {
  const metrics = await collectAssetHealthMetrics(["FAST"], now, mockFetcher());
  assert.equal(metrics.find((metric) => metric.key === "network_activity")?.value, 200);
  assert.equal(metrics.find((metric) => metric.key === "finalized_block_age")?.value, .25);
  assert.equal(metrics.find((metric) => metric.key === "official_network_status")?.status, "HEALTHY");
  assert.equal(metrics.find((metric) => metric.key === "market_quote_volume_24h")?.status, "HEALTHY");
});
test("null market volume is unavailable rather than zero or a structural alarm", async () => {
  const metrics = await collectAssetHealthMetrics(["FAST"], now, mockFetcher(null));
  assert.equal(metrics.find((metric) => metric.key === "market_quote_volume_24h")?.status, "SOURCE_UNAVAILABLE");
});
test("all APIs unavailable yields insufficient data, never structural risk", async () => {
  const metrics = await collectAssetHealthMetrics(["FAST", "STRUCTURAL", "DEVELOPMENT"], now,
    (async () => { throw new Error("NETWORK_UNAVAILABLE"); }) as typeof fetch);
  for (const asset of ["BTC", "SOL"] as const) assert.equal(assess(asset, metrics).status, "INSUFFICIENT_DATA");
});
test("collector/rules cannot import or invoke trading execution", () => {
  for (const file of ["sources.ts", "rules.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*(execution|strategy|capacity|watchdog)/i);
    assert.doesNotMatch(source, /sendTransaction|sendOrder|advanceLiveRun|kill_switch|createOrder/);
  }
});
