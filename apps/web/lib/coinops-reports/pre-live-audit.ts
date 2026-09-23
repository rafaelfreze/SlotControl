import type { AuditDatasets } from "./report-engine.ts";
import type { AuditRow } from "./trigger-audit.ts";

const ENGINE_CHECKS = ["SLOT_COUNT_25", "SINGLE_ACTIVE_ENTRY", "OPEN_POSITION_HAS_RESIDENT_TP",
  "STRATEGY_VERSION_PARITY", "STRATEGY_DECISION_IDEMPOTENCY", "STRATEGY_DECISION_DISPATCH",
  "MONTHLY_GAIN_COUNT_RECONCILES", "TARGET_REACHED_SLOT_HAS_NO_NEW_ENTRY", "TARGET_REACHED_SLOT_HAS_NO_REENTRY",
  "RANK_DESCENDING_BY_LIFETIME_GAINS", "ENVIRONMENT_CONFIG_ISOLATED", "CONFIG_SNAPSHOT_MATCHES_EXECUTION",
  "GAIN_PCT_MATCHES_CONFIG"] as const;
const GLOBAL_CHECKS = ["OPERATION_IDS_UNIQUE", "EVENT_IDEMPOTENCY_UNIQUE", "TERMINAL_EVENTS_UNIQUE",
  "COMPOUNDING_RECONCILES", "SOURCE_COMPLETENESS"] as const;

/** A read-only evidence gate, never a trading permission or feature flag. */
export function buildPreLiveAuditGate(data: AuditDatasets, incomplete: string[]): AuditRow {
  const checks = data.checks.filter((row) => !["PRE_LIVE_AUDIT_READY", "LIVE_STRATEGY_PARITY_READY"].includes(String(row.code)));
  const recovered = (row: AuditRow) => row.code === "STRATEGY_DECISION_DISPATCH"
    && row.active_failures === 0 && Number(row.recovered_historical_failures) > 0;
  const failures = checks.filter((row) => row.status === "FAIL" && !recovered(row));
  const historical = checks.filter((row) => row.status === "FAIL" && recovered(row));
  const activeRuntime = data.summary?.filter((row) => ["SHADOW", "TESTNET"].includes(String(row.environment)) && Number(row.active_errors) > 0) ?? [];
  const current = data.cycles.filter((row) => ["SHADOW", "TESTNET"].includes(String(row.environment))
    && !["CYCLE_COMPLETE", "COMPLETED", "FAILED"].includes(String(row.status)));
  const complete = ["SHADOW:BTC", "SHADOW:SOL", "TESTNET:BTC", "TESTNET:SOL"]
    .every((identity) => current.filter((row) => `${row.environment}:${row.asset}` === identity).length === 1);
  const safety = checks.find((row) => row.code === "PRODUCTION_LIVE_BLOCKED")?.status === "PASS"
    && checks.find((row) => row.code === "PRODUCTION_PERSISTED_WRITE_GUARD")?.status === "PASS";
  const missingChecks: string[] = [];
  const requireCheck = (code: string, environment?: string, asset?: string) => {
    if (!checks.some((row) => row.code === code && (!environment || row.environment === environment)
      && (!asset || row.asset === asset) && ["PASS", "WARNING", "FAIL"].includes(String(row.status)))) {
      missingChecks.push([environment, asset, code].filter(Boolean).join(":"));
    }
  };
  for (const code of GLOBAL_CHECKS) requireCheck(code);
  for (const environment of ["SHADOW", "TESTNET"]) {
    for (const code of ["TP_HAS_POSITION", "TP_NOT_DUPLICATED"]) requireCheck(code, environment);
    for (const asset of ["BTC", "SOL"]) for (const code of ENGINE_CHECKS) requireCheck(code, environment, asset);
  }
  requireCheck("TESTNET_OWNERSHIP", "TESTNET");
  for (const asset of ["BTC", "SOL"]) requireCheck("SHADOW_TESTNET_MONTHLY_TARGET_PARITY", "SHADOW/TESTNET", asset);
  const warnings = checks.filter((row) => row.status === "WARNING").length;
  return { code: "PRE_LIVE_AUDIT_READY", status: failures.length || activeRuntime.length ? "FAIL"
    : !complete || !safety || incomplete.length || historical.length || warnings || missingChecks.length ? "WARNING" : "PASS",
  explanation: `${failures.length} check(s) não resolvido(s); ${activeRuntime.length} motor(es) com erro ativo; ${historical.length} falha(s) histórica(s) com recuperação comprovada; ${warnings} limitações de evidência; ${missingChecks.length} check(s) obrigatório(s) ausente(s). Mesmo PASS só permite avaliar LIVE PREPARATION; nunca habilita trading.`,
  active_failures: failures.length, runtime_engines_with_errors: activeRuntime.length, recovered_historical_failures: historical.length,
  failed_checks: [...new Set(failures.map((row) => row.code))], all_four_engines_observed: complete,
  missing_required_checks: missingChecks,
  live_enabled: false, production_write_enabled: false, evidence_scope: "READ_ONLY_PRE_LIVE_AUDIT_GATE" };
}
