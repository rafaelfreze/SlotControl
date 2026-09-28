import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { collectBinanceMetrics, deriveBinanceHealth, mergeBinanceMetrics, BINANCE_HEALTH_CANNOT_TRADE } from "./binance.ts";
import type { BinanceHealthMetric } from "./types.ts";

const now = new Date("2026-09-28T12:00:00Z");
const source = { id: "fixture", name: "Official", url: "https://binance.com", independenceGroup: "binance-public" };
const metric = (key: string, status: BinanceHealthMetric["status"] = "HEALTHY", extra: Partial<BinanceHealthMetric> = {}): BinanceHealthMetric => ({
  key, label: key, category: "OPERATION", indicatorClass: "PRIMARY", status, value: {}, reason: key, source,
  fetchedAt: now.toISOString(), metricAt: now.toISOString(), ttlSeconds: 5_400, confidence: "HIGH", ...extra,
});
const pair = (status: BinanceHealthMetric["status"]) => [metric("spot_ping", status), metric("spot_time", status)];

test("two recent Spot observations are healthy only in monitored scope; local executor fault stays local", () => {
  const metrics = [...pair("HEALTHY"), metric("executor:02", "WARNING", { category: "API_COINOPS", shardId: "executor-02", value: { errorsLast5m: 3 } })];
  const result = deriveBinanceHealth({ metrics, now });
  assert.equal(result.status, "HEALTHY");
  assert.match(result.reasons.join(" "), /executor/);
  assert.match(result.summary, /não solvência/);
});

test("single 5xx, 429, missing PoR and stale source never imply Binance-wide risk", () => {
  for (const extra of [metric("proof_of_reserves", "SOURCE_UNAVAILABLE", { category: "RESERVES", optional: true }),
    metric("executor:02", "WARNING", { category: "API_COINOPS", shardId: "executor-02", errorCode: "HTTP_429" })]) {
    assert.equal(deriveBinanceHealth({ metrics: [...pair("HEALTHY"), extra], now }).status, "HEALTHY");
  }
  assert.equal(deriveBinanceHealth({ metrics: [metric("spot_ping", "SOURCE_UNAVAILABLE"), metric("spot_time")], now }).status, "INSUFFICIENT_DATA");
  assert.equal(deriveBinanceHealth({ metrics: pair("SOURCE_UNAVAILABLE"), now }).status, "INSUFFICIENT_DATA");
  assert.equal(deriveBinanceHealth({ metrics: pair("HEALTHY").map((item) => ({ ...item, fetchedAt: "2026-09-28T08:00:00Z" })) , now }).status, "INSUFFICIENT_DATA");
});

test("persistent public outage requires independent CoinOps shard corroboration, not one endpoint or IP", () => {
  const local = ["executor-01", "executor-02"].map((shardId) => metric(`executor:${shardId}`, "WARNING", {
    category: "API_COINOPS", shardId, value: { errorsLast5m: 5 }, source: { ...source, independenceGroup: "coinops-executors" },
  }));
  const previous = { ...deriveBinanceHealth({ metrics: [...pair("SOURCE_UNAVAILABLE"), ...local], now: new Date(now.getTime() - 61 * 60_000) }),
    failureSinceByMetric: { spot_ping: new Date(now.getTime() - 61 * 60_000).toISOString(),
      spot_time: new Date(now.getTime() - 61 * 60_000).toISOString() } };
  assert.equal(deriveBinanceHealth({ metrics: [...pair("SOURCE_UNAVAILABLE"), local[0]], previous, now }).status, "INSUFFICIENT_DATA");
  assert.equal(deriveBinanceHealth({ metrics: [...pair("SOURCE_UNAVAILABLE"), ...local], previous, now }).status, "ATTENTION");
  assert.equal(deriveBinanceHealth({ metrics: pair("HEALTHY"), previous, now }).status, "HEALTHY");
});

test("critical risk needs persistent high-confidence severe facts from independent sources", () => {
  const severe = [metric("confirmed_security", "CRITICAL", { category: "SECURITY", indicatorClass: "CRITICAL" }),
    metric("confirmed_suspension", "CRITICAL", { category: "WITHDRAWALS", indicatorClass: "CRITICAL",
      source: { ...source, id: "independent", independenceGroup: "independent" } })];
  const earlier = new Date(now.getTime() - 7 * 60 * 60_000);
  const previous = { ...deriveBinanceHealth({ metrics: [...pair("HEALTHY"), ...severe], now: earlier }),
    evaluatedAt: new Date(now.getTime() - 30 * 60_000).toISOString(), failureSinceByMetric: { critical: earlier.toISOString() } };
  assert.equal(deriveBinanceHealth({ metrics: [...pair("HEALTHY"), severe[0]], previous, now }).status, "HEALTHY");
  assert.equal(deriveBinanceHealth({ metrics: [...pair("HEALTHY"), ...severe], previous, now }).status, "CRITICAL_RISK");
});

test("failed read uses last valid observation within TTL; expired evidence is insufficient", () => {
  const success = metric("spot_ping");
  const failure = metric("spot_ping", "SOURCE_UNAVAILABLE", { errorCode: "HTTP_503" });
  assert.equal(mergeBinanceMetrics([success], [failure], now)[0].status, "HEALTHY");
  assert.equal(mergeBinanceMetrics([{ ...success, fetchedAt: "2026-09-28T08:00:00Z" }], [failure], now)[0].status, "SOURCE_UNAVAILABLE");
});

test("collector uses official public endpoints and registry-derived shards only; trading imports are prohibited", async () => {
  const fetcher: typeof fetch = async (url) => new Response(JSON.stringify(String(url).includes("/time") ? { serverTime: now.getTime() } : {}), { status: 200 });
  const metrics = await collectBinanceMetrics({ now, dueFast: true, dueStructural: true,
    shards: [{ id: "executor-02", enabled: true }, { id: "executor-03", enabled: true }], samples: [], fetcher });
  assert.deepEqual(metrics.filter((item) => item.shardId).map((item) => item.shardId), ["executor-02", "executor-03"]);
  assert.equal(metrics.find((item) => item.key === "proof_of_reserves")?.status, "SOURCE_UNAVAILABLE");
  const code = readFileSync(new URL("./binance.ts", import.meta.url), "utf8");
  assert.equal(BINANCE_HEALTH_CANNOT_TRADE, true);
  assert.doesNotMatch(code, /from ["'][^"']*(?:execution|orders|strategy-engine|binance-client|credentials)/);
  assert.doesNotMatch(code, /\b(?:placeOrder|cancelOrder|transfer|withdraw)\s*\(/);
});
