/** Control-plane policy: no order, reconciliation or account migration side effects. */
export type ShardState = "HEALTHY" | "OBSERVE" | "WARNING" | "CAPACITY_LIMIT" | "OFFLINE";
export type ScaleAction = "NONE" | "SCALE_UP" | "SCALE_OUT" | "INVESTIGATE";
export type ShardMetrics = {
  shardId: string; observedAt: string; heartbeatAt: string;
  accountIds: string[]; engineIds: string[];
  binanceWeightCurrent: number; binanceWeightAverage: number; binanceWeightPeak: number;
  cpuPercent: number; ramUsedMb: number; ramLimitMb: number;
  reconciliationP95Ms: number; schedulerBacklog: number;
  errorsLast5m: number; retriesLast5m: number;
};
export type CapacityPolicy = {
  binanceLimitPerMinute: number; observeRatio: number; warningRatio: number;
  capacityRatio: number; admissionRatio: number;
  maxMetricAgeMs: number; maxHeartbeatAgeMs: number;
  cpuWarningPercent: number; cpuCapacityPercent: number;
  ramWarningPercent: number; ramCapacityPercent: number;
  reconciliationWarningMs: number; backlogWarning: number;
};
export const DEFAULT_CAPACITY_POLICY: CapacityPolicy = {
  binanceLimitPerMinute: 6000, observeRatio: .50, warningRatio: .65,
  capacityRatio: .75, admissionRatio: .65, maxMetricAgeMs: 120_000,
  maxHeartbeatAgeMs: 120_000, cpuWarningPercent: 70, cpuCapacityPercent: 85,
  ramWarningPercent: 75, ramCapacityPercent: 85, reconciliationWarningMs: 45_000,
  backlogWarning: 1,
};
export type CapacityAssessment = {
  shardId: string; state: ShardState; action: ScaleAction; reasons: string[];
  alertCodes: string[]; binancePercent: number | null;
  accountCount: number; engineCount: number;
};
const valid = (value: number) => Number.isFinite(value) && value >= 0;
const age = (value: string, now: number) => now - Date.parse(value);
export function assessShardCapacity(metrics: ShardMetrics | null,
  policy: CapacityPolicy = DEFAULT_CAPACITY_POLICY, now = Date.now()): CapacityAssessment {
  const base = { shardId: metrics?.shardId ?? "UNASSIGNED",
    accountCount: metrics?.accountIds.length ?? 0, engineCount: metrics?.engineIds.length ?? 0 };
  if (!metrics || !metrics.shardId || !Number.isFinite(now)
    || !valid(policy.binanceLimitPerMinute) || !policy.binanceLimitPerMinute
    || ![metrics.binanceWeightCurrent, metrics.binanceWeightAverage, metrics.binanceWeightPeak,
      metrics.cpuPercent, metrics.ramUsedMb, metrics.ramLimitMb,
      metrics.reconciliationP95Ms, metrics.schedulerBacklog, metrics.errorsLast5m,
      metrics.retriesLast5m].every(valid)
    || !metrics.ramLimitMb || metrics.cpuPercent > 100
    || age(metrics.observedAt, now) < 0 || age(metrics.observedAt, now) > policy.maxMetricAgeMs
    || age(metrics.heartbeatAt, now) < 0 || age(metrics.heartbeatAt, now) > policy.maxHeartbeatAgeMs)
    return { ...base, state: "OFFLINE", action: "INVESTIGATE",
      reasons: ["CAPACITY_TELEMETRY_MISSING_OR_STALE"],
      alertCodes: ["EXECUTOR_RESOURCE_WARNING"], binancePercent: null };
  const ratio = Math.max(metrics.binanceWeightCurrent, metrics.binanceWeightAverage,
    metrics.binanceWeightPeak) / policy.binanceLimitPerMinute;
  const ramPercent = metrics.ramUsedMb / metrics.ramLimitMb * 100;
  const reasons: string[] = [], alertCodes: string[] = [];
  let state: ShardState = ratio >= policy.capacityRatio ? "CAPACITY_LIMIT"
    : ratio >= policy.warningRatio ? "WARNING" : ratio >= policy.observeRatio ? "OBSERVE" : "HEALTHY";
  let action: ScaleAction = state === "CAPACITY_LIMIT" || state === "WARNING" ? "SCALE_OUT" : "NONE";
  if (ratio >= policy.warningRatio) {
    reasons.push("BINANCE_WEIGHT_HEADROOM_LOW");
    alertCodes.push("BINANCE_WEIGHT_WARNING", "EXECUTOR_CAPACITY_WARNING");
  }
  if (metrics.cpuPercent >= policy.cpuWarningPercent || ramPercent >= policy.ramWarningPercent) {
    reasons.push("EXECUTOR_RESOURCE_HEADROOM_LOW");
    alertCodes.push("EXECUTOR_RESOURCE_WARNING");
    if (metrics.cpuPercent >= policy.cpuCapacityPercent || ramPercent >= policy.ramCapacityPercent)
      state = "CAPACITY_LIMIT";
    else if (state === "HEALTHY" || state === "OBSERVE") state = "WARNING";
    if (action === "NONE") action = "SCALE_UP";
  }
  if (metrics.schedulerBacklog >= policy.backlogWarning
    || metrics.reconciliationP95Ms >= policy.reconciliationWarningMs) {
    reasons.push("SCHEDULER_OR_RECONCILIATION_SLOW");
    alertCodes.push("SCHEDULER_BACKLOG_WARNING");
    if (state === "HEALTHY" || state === "OBSERVE") state = "WARNING";
    if (action === "NONE") action = "INVESTIGATE";
  }
  return { ...base, state, action, reasons, alertCodes: [...new Set(alertCodes)],
    binancePercent: Math.round(ratio * 10_000) / 100 };
}
export type AdmissionDecision = { allowed: boolean; code: "ASSIGN" | "CAPACITY_REQUIRED";
  reason: string; shardId: string | null };
/** Admission needs fresh metrics and a measured incremental p95. Existing
 * assignments and engines are never changed by this decision. */
export function decideShardAdmission(metrics: ShardMetrics | null, incrementalWeightP95: number | null,
  policy: CapacityPolicy = DEFAULT_CAPACITY_POLICY, now = Date.now()): AdmissionDecision {
  const assessment = assessShardCapacity(metrics, policy, now);
  const deny = (reason: string): AdmissionDecision => ({ allowed: false,
    code: "CAPACITY_REQUIRED", reason, shardId: metrics?.shardId ?? null });
  if (!metrics || assessment.state === "OFFLINE" || assessment.state === "CAPACITY_LIMIT")
    return deny(assessment.reasons[0] ?? "SHARD_NOT_AVAILABLE");
  if (incrementalWeightP95 === null || !valid(incrementalWeightP95) || !incrementalWeightP95)
    return deny("NEW_ACCOUNT_COST_UNMEASURED");
  if (assessment.state === "WARNING") return deny("SHARD_HEADROOM_LOW");
  const projected = Math.max(metrics.binanceWeightCurrent, metrics.binanceWeightAverage,
    metrics.binanceWeightPeak) + incrementalWeightP95;
  if (projected > policy.binanceLimitPerMinute * policy.admissionRatio)
    return deny("PROJECTED_BINANCE_WEIGHT_ABOVE_ADMISSION_LIMIT");
  return { allowed: true, code: "ASSIGN", reason: "MEASURED_HEADROOM_AVAILABLE",
    shardId: metrics.shardId };
}
/** Exactly one fixed-IP primary per account. Never migrate implicitly. */
export function assertUniquePrimaryShard(assignments: readonly { accountId: string; shardId: string }[]) {
  const byAccount = new Map<string, string>();
  for (const { accountId, shardId } of assignments) {
    if (!accountId || !shardId) throw new Error("COINOPS_SHARD_ASSIGNMENT_INVALID");
    const existing = byAccount.get(accountId);
    if (existing && existing !== shardId) throw new Error("COINOPS_ACCOUNT_MULTIPLE_PRIMARY_SHARDS");
    byAccount.set(accountId, shardId);
  }
  return byAccount;
}
