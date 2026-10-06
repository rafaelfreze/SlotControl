type CronReport = {
  status: string; run_id?: string; trading_engine_id?: string; exchange_account_id?: string;
  executor_shard_id?: string | null; symbol?: string; code?: string; nextRunId?: string;
  recovery?: string; recovery_audit?: string;
};
const ROUTINE = new Set(["OK", "PASS", "BUSY_OR_INACTIVE", "LEASE_BUSY", "INACTIVE"]);

/** Logs are not the financial audit trail. Gains, orders and reconciliation
 * checkpoints remain persisted by the engine; never log their full payload. */
export function liveCronLog(mode: string, status: string, reports: readonly CronReport[],
  commitSha: string | null, now = Date.now()) {
  const material = reports.filter((item) => !ROUTINE.has(item.status));
  // UTC half-hour sampling works across serverless instances without a new DB write.
  const sampled = Math.floor(now / 60_000) % 30 === 0;
  if (mode === "EXECUTION" && status !== "PARTIAL_FAILURE" && !material.length && !sampled) return null;
  const counts: Record<string, number> = {};
  for (const report of reports) counts[report.status] = (counts[report.status] ?? 0) + 1;
  return { event: "COINOPS_LIVE_CRON", mode, status, engine_count: reports.length, counts,
    sampled: !material.length && mode === "EXECUTION", app_commit_sha: commitSha,
    reports: material.map(({ status: state, run_id, trading_engine_id, exchange_account_id,
      executor_shard_id, symbol, code, nextRunId, recovery, recovery_audit }) => ({
      status: state, run_id, trading_engine_id, exchange_account_id, executor_shard_id,
      symbol, code, nextRunId, recovery, recovery_audit })) };
}
