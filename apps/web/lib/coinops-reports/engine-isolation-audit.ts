import type { DomainRegistry } from "../execution/operator-context.ts";
import type { AuditRow } from "./trigger-audit.ts";
const fields = ["operator_id", "exchange_account_id", "trading_engine_id", "environment", "symbol", "asset", "quote_asset",
  "executor_shard_id", "order_owner_prefix", "identity_contract", "credential_status", "credential_checked_at", "isolation_contract",
  "isolation_status", "executor_version", "enforcement_checked_at", "maker_preserving_stp", "account_budget_observed_at",
  "account_budget_source_shard", "account_budget_evidence_state", "unacknowledged_dispatches", "reserved_protection_orders", "evidence_basis"];

/** Exact field allowlist: never export a connection proof, HMAC, API key,
 * Binance UID or arbitrary persisted payload, even from a privileged source. */
export function validateEngineIsolationRows(data: unknown, registry: DomainRegistry, requested: readonly string[]): AuditRow[] {
  if (!Array.isArray(data) || data.length !== requested.length) throw new Error("COINOPS_REPORT_ISOLATION_INCOMPLETE");
  const seen = new Set<string>();
  return data.map((row) => {
    const engine = row && registry.engines.find((candidate) => candidate.id === row.trading_engine_id);
    if (!engine || !requested.includes(engine.id) || seen.has(engine.id) || row.operator_id !== registry.operator.id
      || row.exchange_account_id !== engine.exchange_account_id || row.environment !== engine.environment
      || row.symbol !== engine.symbol || row.quote_asset !== engine.quote_asset || row.executor_shard_id !== engine.executor_shard_id)
      throw new Error("COINOPS_REPORT_ENGINE_MISMATCH");
    seen.add(engine.id);
    return Object.fromEntries(fields.map((key) => [key, row[key] ?? null]));
  });
}
export function buildEngineIsolationAudit(rows: readonly AuditRow[]) {
  const checks = rows.flatMap((row) => [
    { code: "ENGINE_SHARD_IDENTITY_DECLARED", status: /^executor-[0-9]{2,4}$/.test(String(row.executor_shard_id)) ? "PASS" : "FAIL",
      explanation: "Identidade persistida do engine; não comprova health/fleet/runtime atual.", trading_engine_id: row.trading_engine_id,
      environment: row.environment, expected: "ACCOUNT_ENGINE_SHARD", observed: row.executor_shard_id },
    { code: "SHARED_ACCOUNT_ENFORCEMENT_DECLARED", status: row.isolation_status === "ACTIVE" && row.maker_preserving_stp === true ? "PASS" : "WARNING",
      explanation: "Metadado de enforcement. Sem prova atual de transporte, whitelist e telemetria não certifica onboarding.",
      trading_engine_id: row.trading_engine_id, environment: row.environment, expected: "ENGINE_ISOLATION_V2 + EXPIRE_TAKER",
      observed: row.isolation_status ?? "HISTORIC_ENGINE_POLICY_NOT_ENROLLED" },
  ]);
  return { rows: rows.map((row) => ({ ...row, row_type: "ENGINE_ISOLATION_SNAPSHOT" })), checks };
}
