import { randomUUID } from "node:crypto";

import { signedExecutorHeaders } from "@/lib/execution/live-executor-client";
import { resolveExecutorShard, withExecutorShard } from "@/lib/execution/executor-shards-server";
import { requireAccountIdentityBinding } from "@/lib/execution/binance-identity-server";
import { bootstrapInitialIdentityBindings, requireLiveIdentityCoverage } from "@/lib/execution/initial-identity-bootstrap";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { assessShardCapacity, decideShardAdmission, DEFAULT_CAPACITY_POLICY, type ShardMetrics } from "./capacity-manager";
import { collectIndependentShards, shardLedgerMetrics, type CapacityLedger } from "./capacity-aggregation";
import { shardReservedWeight } from "./admission-reservations";
import { testnetCredentialCoverage } from "./environment-telemetry";

type Service = ReturnType<typeof createServiceRoleClient>;
type ExecutorSample = {
  shard_id: string; egress_ipv4: string; heartbeat_at: string; weight_observed_at: string | null;
  binance_weight_current: number | null; binance_weight_average: number | null;
  binance_weight_peak: number | null; binance_weight_samples: number;
  cpu_percent: number | null; ram_used_mb: number; ram_limit_mb: number;
  account_count: number; engine_count: number; executor_version: string;
  request_errors_last_5m: number; probable_retries_last_5m: number;
  account_ids?: string[]; engine_ids?: string[];
  registry_scope?: string; credential_account_ids?: string[];
  environments?: { TESTNET?: ExecutorSample };
};

export function capacityScope() {
  if (getSupabaseDataSchema() !== "coinops" || !getCoinOpsServiceTenantId())
    throw new Error("COINOPS_CAPACITY_SCOPE_INVALID");
  return createServiceRoleClient();
}

async function executorCapacity(shardId: string, expectedIp: string): Promise<ExecutorSample | null> {
  try {
    const config = await resolveExecutorShard(shardId);
    const { base, secret, ip } = config;
    if (ip !== expectedIp) return null;
    const path = "/v1/capacity", requestId = randomUUID();
    const body = JSON.stringify(withExecutorShard({ request_id: requestId }, config));
    const response = await fetch(`${base}${path}`, { method: "POST", cache: "no-store",
      headers: signedExecutorHeaders(secret, path, body, `CAPACITY:${requestId}`), body,
      signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return null;
    const sample = await response.json() as ExecutorSample;
    if (sample.shard_id !== shardId || sample.egress_ipv4 !== ip
      || !Number.isFinite(Date.parse(sample.heartbeat_at))
      || Math.abs(Date.now() - Date.parse(sample.heartbeat_at)) > 30_000)
      return null;
    return sample;
  } catch { return null; }
}

const CAPACITY_ALERT_CODES = ["BINANCE_WEIGHT_WARNING", "EXECUTOR_CAPACITY_WARNING", "CAPACITY_LIMIT",
  "EXECUTOR_OFFLINE", "SCHEDULER_BACKLOG_WARNING", "ENGINE_STALE", "EXECUTOR_RESOURCE_WARNING"] as const;
type CapacityAlertCode = typeof CAPACITY_ALERT_CODES[number];

async function updateCapacityAlerts(service: Service, shardId: string,
  codes: Array<{ code: CapacityAlertCode;
    severity: "WARNING" | "CRITICAL" }>, details: Record<string, string | number | boolean | null>,
  resolveAbsent = true) {
  const at = new Date().toISOString();
  for (const code of CAPACITY_ALERT_CODES) {
    const active = codes.find((item) => item.code === code);
    if (active) {
      const result = await service.from("executor_capacity_alerts").upsert({ shard_id: shardId,
        code, severity: active.severity, details, last_seen_at: at, resolved_at: null },
      { onConflict: "shard_id,code" });
      if (result.error) throw new Error("COINOPS_CAPACITY_ALERT_WRITE_FAILED");
    } else if (resolveAbsent) {
      const result = await service.from("executor_capacity_alerts")
        .update({ resolved_at: at, last_seen_at: at })
        .eq("shard_id", shardId).eq("code", code).is("resolved_at", null);
      if (result.error) throw new Error("COINOPS_CAPACITY_ALERT_RESOLVE_FAILED");
    }
  }
}

/** Called by a server-side cron. No browser, order or trading-state dependency. */
export async function refreshExecutorCapacity() {
  const service = capacityScope();
  const tenantId = getCoinOpsServiceTenantId()!;
  // A missing bootstrap blocks only new admission, never telemetry or trading.
  await bootstrapInitialIdentityBindings(service, tenantId).catch(() => undefined);
  const operators = await service.from("operators").select("id")
    .eq("tenant_id", tenantId).eq("status", "ACTIVE");
  if (operators.error || !operators.data) throw new Error("COINOPS_CAPACITY_OPERATOR_READ_FAILED");
  const ids = operators.data.map((item) => item.id);
  const [shards, accounts, engines, runs, alerts, previousSamples] = await Promise.all([
    service.from("executor_shards").select("id,egress_ipv4,enabled,binance_limit_per_min,admission_ratio").order("id"),
    service.from("exchange_accounts").select("id,executor_shard_id,status")
      .in("operator_id", ids),
    service.from("trading_engines").select("id,exchange_account_id")
      .in("operator_id", ids).eq("environment", "REAL").eq("status", "ACTIVE"),
    service.from("robot_v1_live_runs").select("trading_engine_id,last_reconciled_at,created_at,status")
      .eq("tenant_id", tenantId).in("status", ["ACTIVE", "PAUSED"]),
    service.from("robot_v1_live_alerts").select("trading_engine_id")
      .eq("tenant_id", tenantId).is("resolved_at", null)
      .gte("last_seen_at", new Date(Date.now() - 300_000).toISOString()),
    service.from("executor_capacity_samples").select("shard_id,heartbeat_at"),
  ]);
  if (shards.error || accounts.error || engines.error || runs.error || alerts.error || previousSamples.error)
    throw new Error("COINOPS_CAPACITY_LEDGER_READ_FAILED");
  const ledger: CapacityLedger = { accounts: accounts.data ?? [], engines: engines.data ?? [],
    runs: runs.data ?? [], alerts: alerts.data ?? [] };
  const results = await collectIndependentShards((shards.data ?? []).map((row) => row.id), async (shardId) => {
    const shard = shards.data!.find((row) => row.id === shardId)!;
    const sample = await executorCapacity(shardId, String(shard.egress_ipv4));
    if (!sample) {
      const previous = previousSamples.data?.find((row) => row.shard_id === shardId);
      if (previous && Date.now() - Date.parse(previous.heartbeat_at) <= DEFAULT_CAPACITY_POLICY.maxHeartbeatAgeMs)
        return { status: "AWAITING_FRESH_SAMPLE" };
      // Preserve last evidence (which becomes stale); never fabricate zero usage.
      await updateCapacityAlerts(service, shardId, [{ code: "EXECUTOR_OFFLINE", severity: "CRITICAL" }],
        { reason: "CAPACITY_TELEMETRY_UNAVAILABLE", shard_id: shardId }, false);
      return { status: "CAPACITY_UNKNOWN" };
    }
    const production = await saveShardCapacity(service, shard, sample, ledger);
    // Testnet telemetry is optional on older executors. Its absence/failure must
    // never invalidate or delay publication of a successful REAL observation.
    let testnet: { status: string } = { status: "CAPACITY_UNKNOWN" };
    const separate = sample.environments?.TESTNET;
    if (separate && separate.shard_id === shardId && separate.egress_ipv4 === sample.egress_ipv4
      && Number.isFinite(Date.parse(separate.heartbeat_at))
      && Math.abs(Date.now() - Date.parse(separate.heartbeat_at)) <= 30_000) {
      try {
        const [testEngines, testRuns] = await Promise.all([
          service.from("trading_engines").select("id,exchange_account_id")
            .in("operator_id", ids).eq("environment", "TESTNET").eq("status", "ACTIVE"),
          service.from("robot_v1_testnet_runs").select("trading_engine_id,last_reconciled_at,created_at,status,last_error")
            .eq("tenant_id", tenantId).in("status", ["ACTIVE", "PAUSED"]),
        ]);
        if (testEngines.error || testRuns.error) throw new Error("COINOPS_TESTNET_CAPACITY_LEDGER_UNAVAILABLE");
        testnet = await saveShardCapacity(service, shard, separate, { accounts: ledger.accounts,
          engines: testEngines.data ?? [], runs: testRuns.data ?? [],
          alerts: (testRuns.data ?? []).filter((row) => row.last_error)
            .map((row) => ({ trading_engine_id: row.trading_engine_id })) }, "TESTNET");
      } catch { /* Previous Testnet evidence becomes stale; REAL remains valid. */ }
    }
    return { ...production, environments: { TESTNET: testnet } };
  });
  return { status: results.every((row) => row.ok) ? "COLLECTED" : "PARTIAL", shards: results };
}

async function saveShardCapacity(service: Service,
  shard: { id: string; binance_limit_per_min: number; admission_ratio: number },
  sample: ExecutorSample, ledger: CapacityLedger, environment: "REAL" | "TESTNET" = "REAL") {
  const shardId = shard.id;
  const now = Date.now();
  const scope = shardLedgerMetrics(shardId, ledger, now);
  const sameIds = (actual: string[] | undefined, expected: string[]) => Array.isArray(actual)
    && JSON.stringify([...actual].sort()) === JSON.stringify(expected);
  const identityMatch = shardId === "executor-01" && !sample.engine_ids && !sample.account_ids
    || sameIds(sample.engine_ids, scope.engineIds) && sameIds(sample.account_ids, scope.accountIds);
  const registryMatch = environment === "TESTNET"
    ? scope.validRuns && testnetCredentialCoverage(sample, scope.accountIds)
    : sample.account_count === scope.accountIds.length
      && sample.engine_count === scope.engineIds.length && scope.validRuns && identityMatch;
  const values = { shard_id: shardId, observed_at: new Date(now).toISOString(),
    heartbeat_at: sample.heartbeat_at, weight_observed_at: sample.weight_observed_at,
    binance_weight_current: sample.binance_weight_current,
    binance_weight_average: sample.binance_weight_average,
    binance_weight_peak: sample.binance_weight_peak,
    binance_weight_samples: sample.binance_weight_samples,
    cpu_percent: sample.cpu_percent, ram_used_mb: sample.ram_used_mb,
    ram_limit_mb: sample.ram_limit_mb, account_count: scope.accountIds.length,
    engine_count: scope.engineIds.length, registry_match: registryMatch,
    scheduler_backlog: scope.schedulerBacklog,
    reconciliation_p95_ms: scope.reconciliationP95Ms, reconciliation_age_ms: scope.reconciliationAgeMs,
    errors_last_5m: Math.max(sample.request_errors_last_5m ?? 0, scope.errorsLast5m),
    retries_last_5m: sample.probable_retries_last_5m ?? 0,
    executor_version: sample.executor_version, updated_at: new Date(now).toISOString() };
  const saved = environment === "REAL"
    ? await service.from("executor_capacity_samples").upsert(values, { onConflict: "shard_id" })
    : await service.from("executor_capacity_environment_samples").upsert({ ...values, environment,
      inventory_source: "LEDGER_CREDENTIAL_BOUND_TRANSPORT" }, { onConflict: "shard_id,environment" });
  if (saved.error) throw new Error("COINOPS_CAPACITY_SAMPLE_WRITE_FAILED");
  // A reservation protects the admission window only until a subsequent
  // registry-matched executor sample proves that the ACTIVE engine is already
  // represented in observed weight. Expiring it here prevents the same engine
  // being charged once in telemetry and again as pending admission.
  if (registryMatch && scope.engineIds.length) {
    const consumed = await service.from("executor_capacity_admissions")
      .update({ expires_at: values.observed_at })
      .eq("shard_id", shardId).eq("environment", environment)
      .in("engine_id", scope.engineIds).lte("reserved_at", values.observed_at)
      .gt("expires_at", values.observed_at);
    if (consumed.error) throw new Error("COINOPS_CAPACITY_RESERVATION_CONSUME_FAILED");
  }
  const assessment = assessShardCapacity(asShardMetrics(values), { ...DEFAULT_CAPACITY_POLICY,
    binanceLimitPerMinute: Number(shard.binance_limit_per_min), admissionRatio: Number(shard.admission_ratio) });
  const codes: Array<{ code: CapacityAlertCode; severity: "WARNING" | "CRITICAL" }> =
    assessment.alertCodes.filter((code): code is CapacityAlertCode => CAPACITY_ALERT_CODES.includes(code as CapacityAlertCode))
      .map((code) => ({ code, severity: "WARNING" }));
  if (assessment.state === "CAPACITY_LIMIT") codes.push({ code: "CAPACITY_LIMIT", severity: "CRITICAL" });
  if (scope.reconciliationAgeMs >= 120_000) codes.push({ code: "ENGINE_STALE", severity: "CRITICAL" });
  // Existing administrative capacity incidents refer to the Production budget.
  // Testnet observations never resolve or overwrite those incidents.
  if (environment === "REAL") await updateCapacityAlerts(service, shardId, codes,
    { state: assessment.state, binance_percent: assessment.binancePercent,
      account_count: scope.accountIds.length, engine_count: scope.engineIds.length, registry_match: registryMatch });
  return { status: assessment.state, binancePercent: assessment.binancePercent,
    accountCount: scope.accountIds.length, engineCount: scope.engineIds.length };
}

type StoredSample = Record<string, unknown>;
export function asShardMetrics(row: StoredSample): ShardMetrics {
  const count = (value: unknown) => value !== null && value !== undefined
    && Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  const metric = (value: unknown) => value === null || value === undefined ? Number.NaN : Number(value);
  return { shardId: String(row.shard_id ?? ""), observedAt: String(row.observed_at ?? ""),
    heartbeatAt: String(row.heartbeat_at ?? ""), weightObservedAt: String(row.weight_observed_at ?? ""),
    accountIds: Array.from({ length: Math.min(count(row.account_count), 10000) }, (_, index) => String(index)),
    engineIds: Array.from({ length: Math.min(count(row.engine_count), 10000) }, (_, index) => String(index)),
    weightSampleCount: count(row.binance_weight_samples), registryMatch: row.registry_match === true,
    binanceWeightCurrent: metric(row.binance_weight_current),
    binanceWeightAverage: metric(row.binance_weight_average),
    binanceWeightPeak: metric(row.binance_weight_peak), cpuPercent: metric(row.cpu_percent),
    ramUsedMb: metric(row.ram_used_mb), ramLimitMb: metric(row.ram_limit_mb),
    reconciliationP95Ms: metric(row.reconciliation_p95_ms),
    schedulerBacklog: metric(row.scheduler_backlog), errorsLast5m: metric(row.errors_last_5m),
    retriesLast5m: metric(row.retries_last_5m) };
}

export async function reserveEngineCapacity(service: Service, engineId: string, accountId: string) {
  const account = await service.from("exchange_accounts").select("executor_shard_id,operator_id")
    .eq("id", accountId).single();
  if (account.error || !account.data?.executor_shard_id) throw new Error("COINOPS_CAPACITY_UNKNOWN");
  const engine = await service.from("trading_engines").select("environment,exchange_account_id,operator_id")
    .eq("id", engineId).eq("exchange_account_id", accountId).eq("operator_id", account.data.operator_id).single();
  if (engine.error || !engine.data || !["REAL", "TESTNET"].includes(engine.data.environment))
    throw new Error("COINOPS_CAPACITY_UNKNOWN");
  if (engine.data.environment === "REAL")
    await requireLiveIdentityCoverage(service, getCoinOpsServiceTenantId()!);
  await requireAccountIdentityBinding(service, account.data.operator_id, accountId,
    engine.data.environment as "REAL" | "TESTNET");
  const decision = await service.rpc("reserve_executor_capacity", {
    p_shard_id: account.data.executor_shard_id, p_engine_id: engineId });
  if (decision.error || !["CAPACITY_OK", "CAPACITY_REQUIRED", "CAPACITY_UNKNOWN"].includes(decision.data))
    throw new Error("COINOPS_CAPACITY_UNKNOWN");
  if (decision.data !== "CAPACITY_OK") throw new Error(`COINOPS_${decision.data}`);
  return { status: "CAPACITY_OK" as const, shardId: account.data.executor_shard_id };
}

export async function previewAccountCapacity(service: Service, accountId: string, engineCount: number,
  environment: "REAL" | "TESTNET" = "REAL") {
  const account = await service.from("exchange_accounts").select("executor_shard_id")
    .eq("id", accountId).single();
  if (account.error || !account.data?.executor_shard_id) return { code: "CAPACITY_UNKNOWN", shardId: null };
  const sampleQuery = environment === "REAL"
    ? service.from("executor_capacity_samples").select("*")
    : service.from("executor_capacity_environment_samples").select("*").eq("environment", environment);
  const [shard, sample, reservations] = await Promise.all([
    service.from("executor_shards")
      .select("id,enabled,binance_limit_per_min,admission_ratio,incremental_engine_weight")
      .eq("id", account.data.executor_shard_id).maybeSingle(),
    sampleQuery.eq("shard_id", account.data.executor_shard_id).maybeSingle(),
    service.from("executor_capacity_admissions").select("shard_id,environment,reserved_weight")
      .eq("shard_id", account.data.executor_shard_id).eq("environment", environment)
      .gt("expires_at", new Date().toISOString()),
  ]);
  if (shard.error || sample.error || reservations.error || !shard.data?.enabled || !sample.data)
    return { code: "CAPACITY_UNKNOWN", shardId: account.data.executor_shard_id };
  const reservedWeight = shardReservedWeight(account.data.executor_shard_id, environment, reservations.data ?? []);
  const policy = { ...DEFAULT_CAPACITY_POLICY,
    binanceLimitPerMinute: Number(shard.data.binance_limit_per_min),
    admissionRatio: Number(shard.data.admission_ratio) };
  const assessment = assessShardCapacity(asShardMetrics(sample.data), policy);
  if (assessment.state === "OFFLINE")
    return { code: "CAPACITY_UNKNOWN", shardId: account.data.executor_shard_id };
  const decision = decideShardAdmission(asShardMetrics(sample.data),
    Number(shard.data.incremental_engine_weight) * engineCount + reservedWeight, policy);
  return { code: decision.allowed ? "CAPACITY_OK" : "CAPACITY_REQUIRED",
    shardId: account.data.executor_shard_id };
}
