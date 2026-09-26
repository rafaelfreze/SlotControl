import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const compiled = ts.transpileModule(readFileSync(new URL("./binance-identity-server.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded: Record<string, unknown> = {};
new Function("require", "exports", compiled)((name: string) => {
  assert.equal(name, "server-only"); return {};
}, loaded);
const requireBinding = loaded.requireAccountIdentityBinding as
  (service: unknown, operator: string, account: string, environment: string) => Promise<void>;

function fixture(status: string, identity: boolean, operator = "operator", fail = false,
  credentialPatch: Record<string, unknown> = {}) {
  const filters: Record<string, Record<string, unknown>> = {};
  return { filters, service: { from(table: string) {
    filters[table] = {};
    const chain = { select: () => chain, order: () => chain, limit: () => chain,
      eq: (key: string, value: unknown) => { filters[table][key] = value; return chain; },
      single: async () => ({ error: null, data: table === "executor_shards"
        ? { id: "executor-01", egress_ipv4: "192.0.2.1" }
        : { operator_id: operator, status, executor_shard_id: "executor-01", onboarding_environment: null } }),
      maybeSingle: async () => ({ error: fail ? { message: "unavailable" } : null,
        data: table === "account_onboarding_checks" ? { status: "PASS", evidence: {
          status: "PASS", environment: "REAL", executor_shard_id: "executor-01", executor_ip: "192.0.2.1",
          ...credentialPatch } } : identity ? { exchange_account_id: "account" } : null }) };
    return chain;
  } } };
}

test("old executor01 accounts without onboarding metadata never exempt a new engine from identity", async () => {
  for (const status of ["INACTIVE", "ACTIVE"]) {
    const scenario = fixture(status, false);
    await assert.rejects(requireBinding(scenario.service, "operator", "account", "REAL"),
      /COINOPS_BINANCE_IDENTITY_REQUIRED/);
    assert.deepEqual(scenario.filters.binance_account_identity_bindings,
      { exchange_account_id: "account", operator_id: "operator", environment: "REAL" });
  }
});

test("physical identity admission requires the authoritative account owner and selected environment", async () => {
  const scenario = fixture("INACTIVE", true, "operator", false, { environment: "TESTNET" });
  await requireBinding(scenario.service, "operator", "account", "TESTNET");
  assert.deepEqual(scenario.filters.binance_account_identity_bindings,
    { exchange_account_id: "account", operator_id: "operator", environment: "TESTNET" });
  await assert.rejects(requireBinding(fixture("ACTIVE", true, "other-operator").service,
    "operator", "account", "REAL"), /COINOPS_ADMIN_ACCOUNT_DENIED/);
});

test("an unavailable identity store cannot authorize a new engine", async () => {
  await assert.rejects(requireBinding(fixture("ACTIVE", true, "operator", true).service,
    "operator", "account", "REAL"), /COINOPS_BINANCE_IDENTITY_REQUIRED/);
});

test("new activation requires a PASS credential from the current shard and IP after any staged reassignment", async () => {
  await requireBinding(fixture("INACTIVE", true).service, "operator", "account", "REAL");
  for (const patch of [{ status: "CREDENTIAL_REQUIRED" }, { executor_shard_id: "executor-02" },
    { executor_ip: "192.0.2.2" }, { environment: "TESTNET" }, { executor_shard_id: undefined }])
    await assert.rejects(requireBinding(fixture("INACTIVE", true, "operator", false, patch).service,
      "operator", "account", "REAL"), /COINOPS_BINANCE_CREDENTIAL_SHARD_VALIDATION_REQUIRED/);
});
