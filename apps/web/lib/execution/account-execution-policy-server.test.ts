import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { completeLedgerRead } from "./complete-ledger-read.ts";
import { accountConnectionProof } from "./account-connection-proof.ts";
import { advanceAccountExecutionPolicy, ENGINE_ISOLATION_CONTRACT } from "./account-execution-policy.ts";

const request = "11111111-1111-4111-8111-111111111111", newer = "22222222-2222-4222-8222-222222222222";
const version = "a".repeat(40), ids = ["executor-02", "executor-03"];
type Row = Record<string, any>;
function fixture() {
  const calls: string[] = [], records = new Set<string>(); let policy: Row | null = null;
  let failMarker = false, badHealth: Row = {}, badCredential: Row = {}, foreignIdentity = false;
  const target = (id: string) => ({ shardId: id, ip: `203.0.113.${id.endsWith("02") ? 2 : 3}`,
    base: `https://${id}.example.test`, credentialRef: `ref-${id}`, validatedVersion: version });
  const service = { from(table: string) {
    let payload: Row | null = null;
    const query = { select: () => query, eq: () => query, order: () => query, range: () => query,
      update: (row: Row) => { payload = row; return query; },
      single: async () => {
        assert.equal(table, "account_executor_connections"); assert.equal(payload?.status, "VALIDATED");
        assert.ok(!JSON.stringify(payload).includes("uidHash")); return { data: { exchange_account_id: "account" }, error: null };
      }, maybeSingle: async () => ({ data: policy, error: null }),
      then: (resolve: (value: unknown) => unknown) => {
        assert.equal(table, "trading_engines"); return Promise.resolve({ data: [{ id: "A", executor_shard_id: "executor-02" }], error: null }).then(resolve);
      } }; return query;
  }, rpc: async (name: string, args: Row) => {
    calls.push(name);
    assert.equal(args.p_operator_id, "operator"); assert.equal(args.p_account_id, "account");
    if (name === "stage_account_execution_policy") {
      if (policy) assert.equal(args.p_request_id, policy.request_id);
      policy ??= { request_id: args.p_request_id, executor_version: args.p_executor_version, required_shards: ids, status: "PREPARING" };
    } else {
      assert.equal(name, "record_account_execution_policy"); assert.equal(args.p_request_id, policy!.request_id);
      assert.equal(args.p_ip, target(args.p_shard_id).ip); records.add(args.p_shard_id);
      policy!.status = records.size === 2 ? "ACTIVE" : "PREPARING";
    }
    return { data: structuredClone(policy), error: null };
  } };
  const dependencies: Record<string, unknown> = {
    "./complete-ledger-read.ts": { completeLedgerRead }, "./account-connection-proof.ts": { accountConnectionProof },
    "./account-execution-policy.ts": { advanceAccountExecutionPolicy, ENGINE_ISOLATION_CONTRACT },
    "./executor-shards-server.ts": { resolveExecutorForConnection: async (_op: string, _acct: string, id: string) => target(id),
      parseExecutorValidatedVersions: (value: string) => [value] },
    "./binance-identity-server": { claimAccountIdentity: async (_service: unknown, op: string, acct: string, env: string, hash: string) => {
      assert.equal(op, "operator"); assert.equal(acct, "account"); assert.equal(env, "REAL"); assert.equal(hash, "private-hash");
      if (foreignIdentity) throw new Error("BINANCE_IDENTITY_MISMATCH");
    } }, "./operator-executor-admin.ts": { operatorConnectionAdmin: async (_op: string, _acct: string, id: string, path: string, payload: Row) => {
      calls.push(`${id}:${path}`);
      if (path === "/v1/admin/credentials") {
        assert.deepEqual(payload, { operation: "REVALIDATE" });
        return { operator_id: "operator", exchange_account_id: "account", environment: "REAL", executor_shard_id: id,
          status: "PASS", executorIp: target(id).ip, credential_ref: target(id).credentialRef, uidHash: "private-hash",
          whitelistAccepted: true, validatedAt: new Date().toISOString(), permission: { read: true, spotTrading: true,
            withdrawals: false, internalTransfer: false, universalTransfer: false, margin: false, futures: false,
            options: false, fixTrading: false, portfolioMargin: false }, ...(id === ids[1] ? badCredential : {}) };
      }
      assert.equal(path, "/v1/admin/account-policy"); assert.equal(payload.contract, ENGINE_ISOLATION_CONTRACT);
      if (failMarker && id === ids[1]) { failMarker = false; throw new Error("UNCERTAIN_RESPONSE"); }
      return { operator_id: "operator", exchange_account_id: "account", environment: "REAL", executor_shard_id: id,
        executor_ip: target(id).ip, executor_version: version, contract: ENGINE_ISOLATION_CONTRACT, enabled: true };
    } } };
  const loaded: Row = {};
  const source = ts.transpileModule(readFileSync(new URL("./account-execution-policy-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "exports", "fetch", source)((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, loaded,
    async (url: string) => {
      const id = ids.find(id => url.includes(id))!; assert.ok(id); assert.ok(url.endsWith("/health")); calls.push(`${id}:health`);
      return { ok: true, json: async () => ({ healthy: true, executor_shard_id: id, clock: new Date().toISOString(),
        environment: "BINANCE_PRODUCTION_PREPARED", binance_connectivity: "OK", egress_ipv4: target(id).ip,
        egress_ipv4_verified: true, clock_drift_ms: 1, actual_executor_version: version, account_order_budget_protocol: 1,
        isolation_contract: ENGINE_ISOLATION_CONTRACT, ...(id === ids[1] ? badHealth : {}) }) };
    });
  return { calls, get policy() { return policy; }, enable: (id = request) => loaded.ensureAccountExecutionPolicy(service, "operator", "account", "executor-03", id),
    fail: () => { failMarker = true; }, changeHealth: (row: Row) => { badHealth = row; }, changeCredential: (row: Row) => { badCredential = row; },
    mismatch: () => { foreignIdentity = true; }, changeInventory: () => { policy!.required_shards = [...ids, "executor-04"]; } };
}

test("server enrolls both hosts only after health/IP/clock/runtime and independent credential proofs", async () => {
  const f = fixture(); assert.equal((await f.enable()).status, "ACTIVE");
  const stage = f.calls.indexOf("stage_account_execution_policy");
  for (const id of ids) assert.ok(f.calls.indexOf(`${id}:/v1/admin/credentials`) < stage);
  assert.ok(f.calls.indexOf("record_account_execution_policy") < f.calls.indexOf("executor-03:/v1/admin/account-policy"));
  assert.ok(f.calls.every(call => !/order|cancel|promote|capital|registry/.test(call)));
});
test("server resumes original partial request and rejects changed preparing inventory", async () => {
  const f = fixture(); f.fail(); await assert.rejects(f.enable(), /UNCERTAIN_RESPONSE/);
  assert.equal(f.policy!.status, "PREPARING"); assert.equal((await f.enable(newer)).request_id, request);
  const changed = fixture(); changed.fail(); await assert.rejects(changed.enable(), /UNCERTAIN_RESPONSE/);
  changed.changeInventory(); await assert.rejects(changed.enable(newer), /ISOLATION_PREPARING/);
});
test("wrong IP/version/clock/protocol/permission/identity cannot stage or enable policy", async () => {
  for (const mutation of [{ egress_ipv4: "203.0.113.99" }, { actual_executor_version: "b".repeat(40) },
    { clock: new Date(Date.now() - 60000).toISOString() }, { clock_drift_ms: 2001 }, { account_order_budget_protocol: 0 }]) {
    const f = fixture(); f.changeHealth(mutation); await assert.rejects(f.enable(), /PREFLIGHT_REQUIRED/);
    assert.ok(!f.calls.some(call => call === "stage_account_execution_policy" || call.includes("account-policy")));
  }
  const credential = fixture(); credential.changeCredential({ whitelistAccepted: false });
  await assert.rejects(credential.enable(), /VALIDATION_REQUIRED/); assert.ok(!credential.calls.includes("stage_account_execution_policy"));
  const identity = fixture(); identity.mismatch(); await assert.rejects(identity.enable(), /IDENTITY_MISMATCH/);
  assert.ok(!identity.calls.includes("stage_account_execution_policy"));
});
