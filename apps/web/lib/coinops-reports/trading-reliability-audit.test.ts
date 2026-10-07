import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditReport } from "./report-engine.ts";
import { REPORT_VERSION } from "./filters.ts";

test("v22 publishes the observation and recurrence contract without claiming missing evidence is zero", () => {
  assert.equal(REPORT_VERSION, 22);
  const report = buildAuditReport({ sources: {}, incompleteSources: [], warnings: [],
    generatedAt: "2026-10-05T12:00:00Z", scope: { tenantId: "fixture", userId: "fixture" } },
  { start: "2026-10-05T00:00:00Z", end: "2026-10-06T00:00:00Z", assets: ["BTC", "SOL"], environments: ["REAL"] });
  const rule = report.datasets.rules.find(row => row.parameter === "normal_trading_observation_retry");
  assert.equal(rule?.value, "READ_ONLY_BOUNDED_RETRY_WITH_PERSISTENT_CHECKPOINT");
  assert.equal(rule?.evidence_scope, "CURRENT_CODE_CONTRACT");
  assert.match(String(rule?.notes), /UNKNOWN, não 0%/);
  assert.match(String(rule?.notes), /RECURRENCE_REGRESSION/);
  assert.equal(rule?.version, 4);
  assert.match(String(rule?.notes), /registry: somente timeout comprovado/);
  assert.match(String(rule?.notes), /sem reutilizar autorização parcial/);
  assert.match(String(rule?.notes), /LEDGER_READ_STALE local/);
  assert.match(String(rule?.notes), /25 slots físicos únicos/);
  assert.match(String(rule?.notes), /CAS do mesmo incidente/);
  assert.match(String(rule?.notes), /ledger\/monthly_gains/);
  assert.match(String(rule?.notes), /nunca zeram gains por falha/);
  assert.match(String(rule?.notes), /Target ausente, ganho divergente ou ambíguo permanece fechado/);
  const config = report.datasets.rules.find(row => row.parameter === "strategy_config_observation_retry");
  assert.equal(config?.value, "SHARED_LEDGER_GET_POLICY_NO_MUTATION_RETRY");
  assert.equal(config?.version, 1);
  assert.match(String(config?.notes), /zero PENDING\/APPLYING\/BLOCKED_SAFE/);
  assert.match(String(config?.notes), /strategy_config_pending=false por CAS/);
  assert.match(String(config?.notes), /Nenhum POST\/RPC\/mutação recebe retry/);
});

test("v22 exports persisted ledger read diagnostics without inventing provider error or recovery", () => {
  const details = { stage: "RECONCILE_ORDERS", source: "ENGINE", root_code: "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE",
    read_path: "ledger/orders", read_attempts: 2, http_status: 504, provider_code: "PGRST003" };
  const report = buildAuditReport({ sources: { robot_v1_live_alerts: [{ id: "alert", asset: "SOL",
    trading_engine_id: "engine-a", exchange_account_id: "account-a", code: "COINOPS_LIVE_TRANSIENT_LEDGER_READ",
    details, first_seen_at: "2026-10-07T15:25:09Z", last_seen_at: "2026-10-07T15:25:09Z", resolved_at: null }] },
    incompleteSources: [], warnings: [], generatedAt: "2026-10-07T15:26:00Z",
    scope: { tenantId: "fixture", userId: "fixture" } },
    { start: "2026-10-07T00:00:00Z", end: "2026-10-08T00:00:00Z", assets: ["BTC", "SOL"], environments: ["REAL"] });
  const row = report.datasets.live_execution.find(row => row.row_type === "ALERT");
  assert.deepEqual(row?.details, details);
  assert.equal(row?.resolved_at, null); assert.equal(row?.trading_engine_id, "engine-a");
});
