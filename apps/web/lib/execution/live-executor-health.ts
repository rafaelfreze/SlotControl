export type LiveExecutorHealth = {
  healthy: boolean;
  version: string;
  region: string;
  environment: string;
  clock: string;
  clock_drift_ms: number | null;
  binance_connectivity: string;
  account_permission: string;
  egress_ipv4: string | null;
  egress_ipv4_verified: boolean;
  trading_enabled: boolean;
  kill_switch: boolean;
  latency_ms: number;
};

export type LiveExecutorStatus = {
  gate: "UNCONFIGURED" | "ATTENTION" | "LIVE_EXECUTOR_READY";
  ip: string | null;
  health: LiveExecutorHealth | null;
};

export async function loadLiveExecutorStatus(
  baseUrl = process.env.LIVE_EXECUTOR_BASE_URL,
  expectedIp = process.env.LIVE_EXECUTOR_EGRESS_IP,
  fetcher: typeof fetch = fetch,
  validatedVersion = process.env.LIVE_EXECUTOR_VALIDATED_VERSION,
): Promise<LiveExecutorStatus> {
  if (!baseUrl || !expectedIp || baseUrl !== `https://${expectedIp}`
    || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(expectedIp))
    return { gate: "UNCONFIGURED", ip: expectedIp || null, health: null };
  try {
    const response = await fetcher(`${baseUrl}/health`, {
      method: "GET", cache: "no-store", signal: AbortSignal.timeout(5_000),
    });
    const health = await response.json() as LiveExecutorHealth;
    const ready = response.ok && health.healthy === true
      && Boolean(validatedVersion) && health.version === validatedVersion
      && health.environment === "BINANCE_PRODUCTION_READ_ONLY"
      && health.binance_connectivity === "OK"
      && health.account_permission === "READ_ONLY"
      && health.egress_ipv4 === expectedIp && health.egress_ipv4_verified === true
      && health.trading_enabled === false && health.kill_switch === true
      && typeof health.clock_drift_ms === "number" && Math.abs(health.clock_drift_ms) <= 2_000;
    return { gate: ready ? "LIVE_EXECUTOR_READY" : "ATTENTION", ip: expectedIp, health };
  } catch {
    return { gate: "ATTENTION", ip: expectedIp, health: null };
  }
}
