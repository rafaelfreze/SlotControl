import { readLiveExecutorHealth, type ExecutorEngineScope } from "./live-executor-transport.ts";
import { parseExecutorValidatedVersions, resolveExecutorForEngine, resolveExecutorValidatedVersion,
  type ExecutorEngineResolver } from "./executor-shards-server.ts";

export type LiveExecutorHealth = {
  healthy: boolean;
  version: string;
  actual_executor_version?: string;
  legacy_contract_version?: string | null;
  legacy_compatibility_enabled?: boolean;
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
  isolation_contract?: string;
  account_order_budget_protocol?: number;
  account_order_budget_enforced?: boolean;
  unsent_recovery_protocol?: number;
};

export type LiveExecutorStatus = {
  gate: "UNCONFIGURED" | "ATTENTION" | "LIVE_EXECUTOR_READY"
    | "LIVE_EXECUTOR_PROTECTED" | "LIVE_EXECUTOR_ACTIVE";
  ip: string | null;
  health: LiveExecutorHealth | null;
};

export async function loadLiveExecutorStatus(
  baseUrl = process.env.LIVE_EXECUTOR_BASE_URL,
  expectedIp = process.env.LIVE_EXECUTOR_EGRESS_IP,
  fetcher: typeof fetch = fetch,
  validatedVersion = process.env.LIVE_EXECUTOR_VALIDATED_VERSION,
  engine?: ExecutorEngineScope,
  resolver: ExecutorEngineResolver = resolveExecutorForEngine,
): Promise<LiveExecutorStatus> {
  try {
    const target = engine ? await resolver(engine.operator_id, engine.exchange_account_id, engine.trading_engine_id) : null;
    if (target) {
      baseUrl = target.base; expectedIp = target.ip; validatedVersion = target.validatedVersion;
    }
    if (!baseUrl || !expectedIp || baseUrl !== `https://${expectedIp}`
      || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(expectedIp))
      return { gate: "UNCONFIGURED", ip: expectedIp || null, health: null };
    const response = engine ? null : await fetcher(`${baseUrl}/health`, {
      method: "GET", cache: "no-store", signal: AbortSignal.timeout(5_000),
    });
    const health = engine ? await readLiveExecutorHealth(engine, fetcher, async () => target!)
      : await response!.json() as LiveExecutorHealth;
    // The unscoped legacy banner must use the same bounded version policy as
    // engine-scoped health. Never mistake its compatibility alias for a release.
    const acceptedVersions = parseExecutorValidatedVersions(engine ? validatedVersion
      : resolveExecutorValidatedVersion("executor-01", validatedVersion));
    const actualVersion = health.actual_executor_version === undefined ? health.version : health.actual_executor_version;
    const verified = (engine || response!.ok) && health.healthy === true
      && acceptedVersions !== null && acceptedVersions.includes(actualVersion)
      && (!engine || health.version === actualVersion)
      && health.environment === (engine ? "REAL" : "BINANCE_PRODUCTION_PREPARED")
      && health.binance_connectivity === "OK"
      && health.account_permission === "SPOT_RESTRICTED"
      && health.egress_ipv4 === expectedIp && health.egress_ipv4_verified === true
      && typeof health.clock_drift_ms === "number" && Math.abs(health.clock_drift_ms) <= 2_000;
    const gate = !verified ? "ATTENTION" as const
      : health.trading_enabled && !health.kill_switch ? "LIVE_EXECUTOR_ACTIVE" as const
        : health.trading_enabled && health.kill_switch ? "LIVE_EXECUTOR_PROTECTED" as const
          : !health.trading_enabled && health.kill_switch ? "LIVE_EXECUTOR_READY" as const
            : "ATTENTION" as const;
    return { gate, ip: expectedIp, health };
  } catch {
    return { gate: "ATTENTION", ip: expectedIp ?? null, health: null };
  }
}

export function loadLiveEngineExecutorStatus(engine: ExecutorEngineScope) {
  return loadLiveExecutorStatus(undefined, undefined, undefined, undefined, engine);
}
