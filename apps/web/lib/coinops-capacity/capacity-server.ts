import { randomUUID } from "node:crypto";

import { signedExecutorHeaders } from "@/lib/execution/live-executor-client";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { assessShardCapacity, decideShardAdmission, DEFAULT_CAPACITY_POLICY, type ShardMetrics } from "./capacity-manager";

type Service = ReturnType<typeof createServiceRoleClient>;
type ExecutorSample = {
  shard_id: string; egress_ipv4: string; heartbeat_at: string; weight_observed_at: string | null;
  binance_weight_current: number | null; binance_weight_average: number | null;
  binance_weight_peak: number | null; binance_weight_samples: number;
  cpu_percent: number | null; ram_used_mb: number; ram_limit_mb: number;
  account_count: number; engine_count: number; executor_version: string;
  request_errors_last_5m: number; probable_retries_last_5m: number;
};

export function capacityScope() {
  if (getSupabaseDataSchema() !== "coinops" || !getCoinOpsServiceTenantId())
    throw new Error("COINOPS_CAPACITY_SCOPE_INVALID");
  return createServiceRoleClient();
}

async function executorCapacity(): Promise<ExecutorSample | null> {
  const ip = process.env.LIVE_EXECUTOR_EGRESS_IP;
  const base = process.env.LIVE_EXECUTOR_BASE_URL;
  const secret = process.env.COINOPS_EXECUTOR_HMAC_SECRET;
  if (!ip || base !== `https://${ip}` || !secret) return null;
  const path = "/v1/capacity", requestId = randomUUID(), body = JSON.stringify({ request_id: requestId });
  try {
    const response = await fetch(`${base}${path}`, { method: "POST", cache: "no-store",
      headers: signedExecutorHeaders(secret, path, body, `CAPACITY:${requestId}`), body,
      signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return null;
    const sample = await response.json() as ExecutorSample;
    if (sample.shard_id !== "executor-01" || sample.egress_ipv4 !== ip
      || !Number.isFinite(Date.parse(sample.heartbeat_at))
      || Math.abs(Date.now() - Date.parse(sample.heartbeat_at)) > 30_000)
      return null;
    return sample;
  } catch { return null; }
}

function percentile95(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * .95) - 1]);
}

async function updateCapacityAlerts(service: Service, shardId: string,
  codes: Array<{ code: "BINANCE_WEIGHT_WARNING" | "EXECUTOR_CAPACITY_WARNING" | "CAPACITY_LIMIT";
    severity: "WARNING" | "CRITICAL" }>, details: Record<string, string | number | boolean | null>) {
  const at = new Date().toISOString();
  for (const code of ["BINANCE_WEIGHT_WARNING", "EXECUTOR_CAPACITY_WARNING", "CAPACITY_LIMIT"] as const) {
    const active = codes.find((item) => item.code === code);
    if (active) {
      const result = await service.from("executor_capacity_alerts").upsert({ shard_id: shardId,
        code, severity: active.severity, details, last_seen_at: at, resolved_at: null },
      { onConflict: "shard_id,code" });
      if (result.error) throw new Error("COINOPS_CAPACITY_ALERT_WRITE_FAILED");
    } else {
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
  const shardId = "executor-01", sample = await executorCapacity();
  if (!sample) {
    await updateCapacityAlerts(service, shardId,
      [{ code: "EXECUTOR_CAPACITY_WARNING", severity: "WARNING" }],
      { reason: "CAPACITY_TELEMETRY_UNAVAILABLE" });
    return { status: "CAPACITY_UNKNOWN" };
  }
  const tenantId = getCoinOpsServiceTenantId()!;
  const operators = await service.from("operators").select("id")
    .eq("tenant_id", tenantId).eq("status", "ACTIVE");
  if (operators.error || !operators.data) throw new Error("COINOPS_CAPACITY_OPERATOR_READ_FAILED");
  const ids = operators.data.map((item) => item.id);
  const [accounts, engines, runs, alerts] = await Promise.all([
    service.from("exchange_accounts").select("id,executor_shard_id,status")
      .in("operator_id", ids).eq("status", "ACTIVE"),
    service.from("trading_engines").select("id,exchange_account_id")
      .in("operator_id", ids).eq("environment", "REAL").eq("status", "ACTIVE"),
    service.from("robot_v1_live_runs").select("trading_engine_id,last_reconciled_at,created_at,status")
      .eq("tenant_id", tenantId).in("status", ["ACTIVE", "PAUSED"]),
    service.from("robot_v1_live_alerts").select("id")
      .eq("tenant_id", tenantId).is("resolved_at", null)
      .gte("last_seen_at", new Date(Date.now() - 300_000).toISOString()),
  ]);
  if (accounts.error || engines.error || runs.error || alerts.error)
    throw new Error("COINOPS_CAPACITY_LEDGER_READ_FAILED");
  const accountIds = new Set((accounts.data ?? []).filter((row) => row.executor_shard_id === shardId)
    .map((row) => row.id));
  const liveIds = new Set((engines.data ?? []).filter((row) => accountIds.has(row.exchange_account_id))
    .map((row) => row.id));
  const now = Date.now();
  const shardRuns = (runs.data ?? []).filter((row) => liveIds.has(row.trading_engine_id));
  const ages = shardRuns.filter((row) => row.status === "ACTIVE")
    .map((row) => Math.max(0, now - Date.parse(row.last_reconciled_at ?? row.created_at)));
  const registryMatch = sample.account_count === accountIds.size && sample.engine_count === liveIds.size
    && shardRuns.length === liveIds.size;
  const values = { shard_id: shardId, observed_at: new Date(now).toISOString(),
    heartbeat_at: sample.heartbeat_at, weight_observed_at: sample.weight_observed_at,
    binance_weight_current: sample.binance_weight_current,
    binance_weight_average: sample.binance_weight_average,
    binance_weight_peak: sample.binance_weight_peak,
    binance_weight_samples: sample.binance_weight_samples,
    cpu_percent: sample.cpu_percent, ram_used_mb: sample.ram_used_mb,
    ram_limit_mb: sample.ram_limit_mb, account_count: accountIds.size,
    engine_count: liveIds.size, registry_match: registryMatch,
    scheduler_backlog: ages.filter((age) => age >= 120_000).length,
    reconciliation_p95_ms: percentile95(ages), reconciliation_age_ms: ages.length ? Math.max(...ages) : 0,
    errors_last_5m: Math.max(sample.request_errors_last_5m ?? 0, alerts.data?.length ?? 0),
    retries_last_5m: sample.probable_retries_last_5m ?? 0,
    executor_version: sample.executor_version, updated_at: new Date(now).toISOString() };
  const saved = await service.from("executor_capacity_samples").upsert(values, { onConflict: "shard_id" });
  if (saved.error) throw new Error("COINOPS_CAPACITY_SAMPLE_WRITE_FAILED");
  const assessment = assessShardCapacity(asShardMetrics(values));
  const codes = assessment.state === "CAPACITY_LIMIT"
    ? [{ code: "CAPACITY_LIMIT" as const, severity: "CRITICAL" as const }]
    : assessment.state === "WARNING" && assessment.reasons.includes("BINANCE_WEIGHT_HEADROOM_LOW")
      ? [{ code: "BINANCE_WEIGHT_WARNING" as const, severity: "WARNING" as const }]
      : assessment.state === "WARNING" || assessment.state === "OFFLINE"
        ? [{ code: "EXECUTOR_CAPACITY_WARNING" as const, severity: "WARNING" as const }] : [];
  await updateCapacityAlerts(service, shardId, codes,
    { state: assessment.state, binance_percent: assessment.binancePercent,
      account_count: accountIds.size, engine_count: liveIds.size, registry_match: registryMatch });
  return { status: assessment.state, binancePercent: assessment.binancePercent,
    accountCount: accountIds.size, engineCount: liveIds.size };
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
  const account = await service.from("exchange_accounts").select("executor_shard_id")
    .eq("id", accountId).single();
  if (account.error || !account.data?.executor_shard_id) throw new Error("COINOPS_CAPACITY_UNKNOWN");
  const decision = await service.rpc("reserve_executor_capacity", {
    p_shard_id: account.data.executor_shard_id, p_engine_id: engineId });
  if (decision.error || !["CAPACITY_OK", "CAPACITY_REQUIRED", "CAPACITY_UNKNOWN"].includes(decision.data))
    throw new Error("COINOPS_CAPACITY_UNKNOWN");
  if (decision.data !== "CAPACITY_OK") throw new Error(`COINOPS_${decision.data}`);
  return { status: "CAPACITY_OK" as const, shardId: account.data.executor_shard_id };
}

export async function previewAccountCapacity(service: Service, accountId: string, engineCount: number) {
  const account = await service.from("exchange_accounts").select("executor_shard_id")
    .eq("id", accountId).single();
  if (account.error || !account.data?.executor_shard_id) return { code: "CAPACITY_UNKNOWN", shardId: null };
  const [shard, sample] = await Promise.all([
    service.from("executor_shards")
      .select("id,enabled,binance_limit_per_min,admission_ratio,incremental_engine_weight")
      .eq("id", account.data.executor_shard_id).maybeSingle(),
    service.from("executor_capacity_samples").select("*")
      .eq("shard_id", account.data.executor_shard_id).maybeSingle(),
  ]);
  if (shard.error || sample.error || !shard.data?.enabled || !sample.data)
    return { code: "CAPACITY_UNKNOWN", shardId: account.data.executor_shard_id };
  const policy = { ...DEFAULT_CAPACITY_POLICY,
    binanceLimitPerMinute: Number(shard.data.binance_limit_per_min),
    admissionRatio: Number(shard.data.admission_ratio) };
  const assessment = assessShardCapacity(asShardMetrics(sample.data), policy);
  if (assessment.state === "OFFLINE")
    return { code: "CAPACITY_UNKNOWN", shardId: account.data.executor_shard_id };
  const decision = decideShardAdmission(asShardMetrics(sample.data),
    Number(shard.data.incremental_engine_weight) * engineCount, policy);
  return { code: decision.allowed ? "CAPACITY_OK" : "CAPACITY_REQUIRED",
    shardId: account.data.executor_shard_id };
}
