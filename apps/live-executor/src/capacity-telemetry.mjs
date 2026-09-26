import { cpus, totalmem } from "node:os";

const MB = 1024 * 1024;
const WINDOW_MS = 15 * 60_000;

/** IP-wide Binance header. Observing a response never changes its body or retry policy. */
export function createCapacityTelemetry({ fetcher = fetch, now = Date.now,
  cpuUsage = () => process.cpuUsage(), rss = () => process.memoryUsage().rss,
  memoryLimit = () => totalmem(), shardId = "executor-01" } = {}) {
  const samples = [];
  const failedRequests = [], probableRetries = [];
  const recentFailures = new Map();
  let previousCpu = cpuUsage(), previousAt = now(), cpuPercent = null;
  let lastIdleProbeAt = -Infinity, idleProbe = null;
  function observe(url, response) {
    let host;
    try { host = new URL(String(url)).hostname; } catch { return; }
    if (host !== "api.binance.com") return;
    const value = Number(response.headers?.get("x-mbx-used-weight-1m"));
    if (!Number.isFinite(value) || value < 0 || !response.headers?.has("x-mbx-used-weight-1m")) return;
    const at = now();
    samples.push({ at, value });
    while (samples.length && samples[0].at < at - WINDOW_MS) samples.shift();
  }
  async function trackedFetch(url, options) {
    let route = null;
    try {
      const parsed = new URL(String(url));
      if (parsed.hostname === "api.binance.com")
        route = `${String(options?.method ?? "GET").toUpperCase()}:${parsed.pathname}`;
    } catch { /* The underlying fetcher reports an invalid URL unchanged. */ }
    const startedAt = now();
    if (route && startedAt - (recentFailures.get(route) ?? -Infinity) <= 3_000)
      probableRetries.push(startedAt);
    try {
      const response = await fetcher(url, options);
      observe(url, response);
      if (route && (response.status === 429 || response.status >= 500)) {
        failedRequests.push(now());
        recentFailures.set(route, now());
      }
      return response;
    } catch (error) {
      if (route) {
        failedRequests.push(now());
        recentFailures.set(route, now());
      }
      throw error;
    }
  }
  /** An empty shard has no signed Binance traffic. A bounded public GET supplies
   * measured IP-weight evidence; absence of a header is never fabricated as 0. */
  async function sampleIfIdle() {
    const at = now();
    if (at - (samples.at(-1)?.at ?? -Infinity) < 60_000 || at - lastIdleProbeAt < 60_000)
      return idleProbe;
    lastIdleProbeAt = at;
    idleProbe = (async () => {
      const response = await trackedFetch("https://api.binance.com/api/v3/time", {
        method: "GET", cache: "no-store", signal: AbortSignal.timeout(4_000),
      });
      const clock = await response.json();
      if (!response.ok || !Number.isFinite(Number(clock.serverTime)))
        throw new Error("EXECUTOR_CAPACITY_PROBE_UNAVAILABLE");
    })();
    try { await idleProbe; } finally { idleProbe = null; }
  }
  function snapshot() {
    const at = now(), currentCpu = cpuUsage();
    const elapsedMs = at - previousAt;
    if (elapsedMs > 0) cpuPercent = Math.max(0, Math.min(100,
      ((currentCpu.user - previousCpu.user) + (currentCpu.system - previousCpu.system)) / (elapsedMs * 10)));
    previousCpu = currentCpu; previousAt = at;
    while (samples.length && samples[0].at < at - WINDOW_MS) samples.shift();
    while (failedRequests.length && failedRequests[0] < at - 300_000) failedRequests.shift();
    while (probableRetries.length && probableRetries[0] < at - 300_000) probableRetries.shift();
    for (const [route, failedAt] of recentFailures)
      if (at - failedAt > 3_000) recentFailures.delete(route);
    const latest = samples.at(-1);
    const minuteMax = new Map();
    for (const sample of samples) {
      const minute = Math.floor(sample.at / 60_000);
      minuteMax.set(minute, Math.max(minuteMax.get(minute) ?? 0, sample.value));
    }
    const weights = [...minuteMax.values()];
    return { shard_id: shardId, heartbeat_at: new Date(at).toISOString(),
      weight_observed_at: latest ? new Date(latest.at).toISOString() : null,
      binance_weight_current: latest?.value ?? null,
      binance_weight_average: weights.length ? weights.reduce((a, b) => a + b, 0) / weights.length : null,
      binance_weight_peak: weights.length ? Math.max(...weights) : null,
      binance_weight_samples: weights.length, cpu_percent: cpuPercent,
      ram_used_mb: rss() / MB, ram_limit_mb: memoryLimit() / MB,
      request_errors_last_5m: failedRequests.length,
      probable_retries_last_5m: probableRetries.length };
  }
  return { trackedFetch, snapshot, observe, sampleIfIdle };
}
