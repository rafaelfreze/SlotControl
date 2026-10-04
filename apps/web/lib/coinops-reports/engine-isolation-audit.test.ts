import assert from "node:assert/strict";
import test from "node:test";
import { validateEngineIsolationRows, buildEngineIsolationAudit } from "./engine-isolation-audit.ts";
import type { DomainRegistry } from "../execution/operator-context.ts";
const registry = { operator: { id: "operator" }, engines: [
  { id: "a", operator_id: "operator", exchange_account_id: "account", environment: "REAL", symbol: "SOLBRL", quote_asset: "BRL", executor_shard_id: "executor-02" },
  { id: "b", operator_id: "operator", exchange_account_id: "account", environment: "REAL", symbol: "SOLBRL", quote_asset: "BRL", executor_shard_id: "executor-03" },
] } as DomainRegistry;
const rows = registry.engines.map((engine) => ({ ...engine, trading_engine_id: engine.id, identity_contract: "ACCOUNT_ENGINE_SHARD",
  isolation_status: "ACTIVE", maker_preserving_stp: true, apiKey: "SHOULD_NOT_EXPORT", signature: "SHOULD_NOT_EXPORT", uidHash: "SHOULD_NOT_EXPORT" }));
test("same SOLBRL/account report preserves exact shard/engine and excludes every private proof", () => {
  const result = validateEngineIsolationRows(rows, registry, ["a", "b"]);
  assert.deepEqual(result.map((row) => [row.trading_engine_id, row.executor_shard_id]), [["a", "executor-02"], ["b", "executor-03"]]);
  assert.ok(!JSON.stringify(result).includes("SHOULD_NOT_EXPORT"));
  const audit = buildEngineIsolationAudit(result);
  assert.equal(audit.rows.length, 2); assert.equal(audit.checks.length, 4);
  assert.ok(audit.checks.every((row) => row.status === "PASS"));
  assert.ok(audit.checks.every((row) => /não comprova|não certifica/.test(row.explanation)));
});
test("missing pages, duplicate and foreign engine/account/shard fail; absent policy stays WARNING", () => {
  for (const input of [[rows[0]], [rows[0], rows[0]], [rows[0], { ...rows[1], executor_shard_id: "executor-02" }],
    [rows[0], { ...rows[1], exchange_account_id: "foreign" }]]) assert.throws(() => validateEngineIsolationRows(input, registry, ["a", "b"]), /REPORT_/);
  const clean = validateEngineIsolationRows(rows, registry, ["a", "b"]);
  const audit = buildEngineIsolationAudit(clean.map((row) => ({ ...row, isolation_status: null, maker_preserving_stp: false })));
  assert.equal(audit.checks.filter((row) => row.code === "SHARED_ACCOUNT_ENFORCEMENT_DECLARED" && row.status === "WARNING").length, 2);
});
