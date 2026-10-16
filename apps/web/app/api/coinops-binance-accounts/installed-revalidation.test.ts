import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { accountConnectionProof } from "../../../lib/execution/account-connection-proof.ts";
import { signedExecutorHeaders } from "../../../lib/execution/live-executor-client.ts";
import { assertOwnedAccount, assertSameOrigin, validateCredentialIntent } from "./policy.ts";

type Row = Record<string, unknown>;
function load(source: URL, dependencies: Record<string, unknown>, fetcher?: typeof fetch) {
  const compiled = ts.transpileModule(readFileSync(source, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Row = {};
  new Function("require", "exports", "fetch", compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected route dependency: ${name}`); return dependencies[name];
  }, exports, fetcher);
  return exports;
}

function fixture(options: { result?: Row; executorError?: string; identityResult?: string; foreignOwner?: boolean } = {}) {
  const operatorId = "00000000-0000-4000-8000-000000000001";
  const accountId = "00000000-0000-4000-8000-000000000002";
  const requestId = "00000000-0000-4000-8000-000000000003";
  const origin = "https://coinops.example.test";
  const target = { shardId: "executor-03", ip: "203.0.113.33", base: "https://203.0.113.33",
    secret: "fixture-hmac-not-a-real-secret".repeat(2), credentialRef: `account_${accountId.replaceAll("-", "")}` };
  const writes: Array<{ table: string; row: Row }> = [], claims: Row[] = [];
  const credentialCalls: Row[] = [], candidates: string[] = [];
  const operator = { id: operatorId, user_id: "admin-user", status: "ACTIVE" };
  const account = { id: accountId, operator_id: options.foreignOwner ? "another-operator" : operatorId,
    status: "ACTIVE", onboarding_environment: "REAL" };
  const service = { from(table: string) {
    const chain = { select: () => chain, eq: () => chain,
      single: async () => { assert.equal(table, "operators"); return { data: operator, error: null }; },
      maybeSingle: async () => { assert.equal(table, "exchange_accounts"); return { data: account, error: null }; },
      upsert: async (row: Row) => {
        assert.ok(["account_executor_connections", "account_onboarding_checks"].includes(table));
        writes.push({ table, row }); return { error: null };
      } }; return chain;
  }, async rpc(name: string, args: Row) {
    assert.equal(name, "claim_binance_account_identity"); claims.push(args);
    return { error: null, data: options.identityResult ?? "BOUND" };
  } };
  const identity = load(new URL("../../../lib/execution/binance-identity-server.ts", import.meta.url), { "server-only": {} });
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), `${target.base}/v1/admin/credentials`);
    assert.equal(init?.method, "POST");
    const input = JSON.parse(String(init?.body)) as Row;
    assert.deepEqual(input, { operator_id: operatorId, exchange_account_id: accountId,
      credential_ref: target.credentialRef, environment: "REAL", operation: "REVALIDATE",
      request_id: requestId, executor_shard_id: target.shardId });
    assert.ok(new Headers(init?.headers).has("x-coinops-signature")); credentialCalls.push(input);
    if (options.executorError) return Response.json({ error: options.executorError }, { status: 403 });
    return Response.json({ operator_id: operatorId, exchange_account_id: accountId,
      environment: "REAL", executor_shard_id: target.shardId, executorIp: target.ip,
      credential_ref: target.credentialRef, status: "PASS", whitelistAccepted: true,
      validatedAt: new Date().toISOString(), uidHash: "a".repeat(64), permission: {
        read: true, spotTrading: true, withdrawals: false, internalTransfer: false,
        universalTransfer: false, margin: false, futures: false, options: false,
        fixTrading: false, portfolioMargin: false }, ...options.result });
  }) as typeof fetch;
  const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (value: unknown, init: { status: number; headers: Record<string, string> }) =>
      Response.json(value, init) } },
    "@/lib/execution/testnet-policy": { assertOperationalEnvironment: (environment: string) => assert.equal(environment, "REAL") },
    "@/lib/execution/live-executor-client": { signedExecutorHeaders },
    "@/lib/execution/initial-identity-bootstrap": {},
    "@/lib/execution/executor-shards-server": {
      resolveExecutorForConnectionCandidate: async (op: string, acct: string, shard: string, operation: string) => {
        assert.deepEqual([op, acct, shard, operation], [operatorId, accountId, target.shardId, "REVALIDATE"]);
        candidates.push(shard); return target;
      }, withExecutorShard: (input: Row) => ({ ...input, executor_shard_id: target.shardId }) },
    "@/lib/execution/account-connection-proof": { accountConnectionProof },
    "@/lib/execution/staged-shard-reassignment": {},
    "@/lib/execution/binance-identity-server": identity,
    "@/lib/execution/binance-account-registry-server": {},
    "@/lib/supabase/server": { createClient: () => ({ ...service,
      auth: { getUser: async () => ({ data: { user: { id: operator.user_id } } }) } }) },
    "@/lib/supabase/service-role": { createServiceRoleClient: () => service },
    "@/lib/supabase/env": { getCoinOpsServiceTenantId: () => "fixture-tenant", getSupabaseDataSchema: () => "coinops" },
    "./policy": { assertOwnedAccount, assertSameOrigin, validateCredentialIntent },
  };
  const route = load(new URL("./route.ts", import.meta.url), dependencies, fetcher);
  const send = () => (route.POST as (request: unknown) => Promise<Response>)({
    headers: new Headers({ origin, "content-type": "application/json", "sec-fetch-site": "same-origin",
      "x-coinops-admin-intent": "binance-credentials" }), nextUrl: new URL(`${origin}/api/coinops-binance-accounts`),
    text: async () => JSON.stringify({ operation: "REVALIDATE_SHARD", requestId, accountId,
      shardId: target.shardId, environment: "REAL" }),
  });
  return { send, writes, claims, credentialCalls, candidates, operatorId, accountId, target };
}

test("installed credential validation persists only the signed destination proof after the global UID claim", async () => {
  const f = fixture(), response = await f.send();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.executor_shard_id, "executor-03");
  assert.equal(result.credential_ref, f.target.credentialRef);
  assert.deepEqual(f.claims, [{ p_operator_id: f.operatorId, p_account_id: f.accountId,
    p_environment: "REAL", p_identity_hash: "a".repeat(64) }]);
  assert.deepEqual(f.writes.map(write => write.table), ["account_executor_connections", "account_onboarding_checks"]);
  assert.equal(f.writes[0].row.status, "VALIDATED");
  assert.equal(f.writes[0].row.executor_shard_id, "executor-03");
  assert.doesNotMatch(JSON.stringify([result, f.writes]), /uidHash|p_identity_hash|apiKey|apiSecret/);
  assert.equal(f.credentialCalls.length, 1);
});

test("absent vault, wrong UID, stale or foreign executor evidence cannot register an installed credential", async () => {
  for (const options of [{ executorError: "EXECUTOR_CREDENTIAL_NOT_FOUND" },
    { identityResult: "COINOPS_BINANCE_IDENTITY_CHANGED" },
    { result: { uidHash: null } }, { result: { executorIp: "203.0.113.99" } },
    { result: { executor_shard_id: "executor-02" } }, { result: { exchange_account_id: "foreign-account" } },
    { result: { whitelistAccepted: false } }, { result: { status: "WARNING" } },
    { result: { validatedAt: new Date(Date.now() - 31_000).toISOString() } },
    { result: { apiKey: "forbidden-response" } }]) {
    const f = fixture(options), response = await f.send();
    assert.notEqual(response.status, 200, JSON.stringify(options));
    assert.equal(f.writes.length, 0, "no connection or audit PASS before all proof/UID gates pass");
  }
});

test("another account owner cannot reach candidate validation or an executor", async () => {
  const f = fixture({ foreignOwner: true }), response = await f.send();
  assert.notEqual(response.status, 200);
  assert.equal(f.candidates.length, 0); assert.equal(f.credentialCalls.length, 0);
  assert.equal(f.claims.length, 0); assert.equal(f.writes.length, 0);
});
