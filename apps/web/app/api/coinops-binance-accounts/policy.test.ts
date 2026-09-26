import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertOwnedAccount, assertSameOrigin, validateCredentialIntent } from "./policy.ts";

const origin = "https://cripto-flax.vercel.app";
const valid = { operation: "CONNECT", requestId: randomUUID(), accountId: randomUUID(),
  displayName: "Thyely", environment: "REAL", apiKey: "A".repeat(64), apiSecret: "B".repeat(64) };

test("assignment is explicit, has no credential payload, and supports one or two planned engines", () => {
  const input = { operation: "ASSIGN", requestId: randomUUID(), accountId: randomUUID(),
    displayName: "Fixture", environment: "REAL", plannedEngines: 2 };
  assert.doesNotThrow(() => validateCredentialIntent(input));
  assert.doesNotThrow(() => validateCredentialIntent({ ...input, plannedEngines: 1, environment: "TESTNET" }));
  for (const patch of [{ plannedEngines: 0 }, { plannedEngines: 3 }, { plannedEngines: 1.5 },
    { apiKey: "A".repeat(64) }, { apiSecret: "B".repeat(64) }, { displayName: "   " }, { environment: "SHADOW" }])
    assert.throws(() => validateCredentialIntent({ ...input, ...patch }), /INTENT_INVALID/);
});

test("onboarding assigns before credential submission, pins IP and never creates an account in CONNECT", () => {
  const route = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../../automacao/binance-accounts-panel.tsx", import.meta.url), "utf8");
  assert.match(route, /rpc\("assign_executor_shard"/);
  assert.match(route, /COINOPS_ADMIN_ASSIGNMENT_REQUIRED/);
  assert.doesNotMatch(route, /from\("exchange_accounts"\)\.insert/);
  assert.match(route, /resolveExecutorForAccount\(String\(input\.operator_id\), String\(input\.exchange_account_id\)\)/);
  assert.match(route, /withExecutorShard\(input, executor\)/);
  assert.match(route, /result\.executor_shard_id !== executor\.shardId/);
  assert.match(route, /await claimAccountIdentity/);
  assert.ok(route.indexOf("await claimAccountIdentity") < route.indexOf("await syncInactiveBinanceAccount"));
  assert.doesNotMatch(route, /identity_hash:\s*result\./);
  assert.match(panel, /onSubmit=\{assign\}/);
  assert.match(panel, /Executor atribuído:/);
  assert.match(panel, /IP para whitelist Binance:/);
  assert.match(panel, /active\?\.status === "INACTIVE"/);
});

test("credential registration requires same-origin, explicit intent and JSON", () => {
  assert.doesNotThrow(() => assertSameOrigin(origin, origin, "same-origin", "binance-credentials", "application/json"));
  for (const values of [
    [null, origin, "same-origin", "binance-credentials", "application/json"],
    ["https://evil.example", origin, "cross-site", "binance-credentials", "application/json"],
    [origin, origin, "same-origin", null, "application/json"],
    [origin, origin, "same-origin", "binance-credentials", "text/plain"],
  ] as Array<[string | null, string, string | null, string | null, string | null]>)
    assert.throws(() => assertSameOrigin(...values), /CSRF_DENIED/);
});

test("invalid secrets, replay intent shape and manipulated account identifiers are rejected", () => {
  assert.doesNotThrow(() => validateCredentialIntent(valid));
  for (const patch of [{ apiKey: "bad" }, { apiSecret: "bad" }, { accountId: "not-a-uuid" },
    { requestId: "replayed" }, { environment: "SHADOW" }, { operation: "REMOVE" }])
    assert.throws(() => validateCredentialIntent({ ...valid, ...patch }), /INTENT_INVALID|FORMAT_INVALID/);
  assert.throws(() => assertOwnedAccount({ operator_id: randomUUID(), is_legacy_default: false }, valid.accountId), /ACCOUNT_DENIED/);
  assert.throws(() => assertOwnedAccount({ operator_id: valid.accountId, is_legacy_default: true }, valid.accountId), /ACCOUNT_DENIED/);
  assert.doesNotThrow(() => assertOwnedAccount({ operator_id: valid.accountId, is_legacy_default: false }, valid.accountId));
});

test("engine preparation is operator-scoped and never dispatches an exchange order", () => {
  const route = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../../automacao/binance-accounts-panel.tsx", import.meta.url), "utf8");
  const activation = readFileSync(new URL("../coinops-live-activation/route.ts", import.meta.url), "utf8");
  assert.match(route, /from\("trading_engines"\)[\s\S]*?\.eq\("operator_id", operator\.id\)/);
  assert.match(route, /quoteAsset: engine\.quote_asset/);
  assert.match(panel, /action: "PREPARE"/);
  assert.match(panel, /exchange_account_id: engine\.accountId, trading_engine_id: engine\.id/);
  assert.match(activation, /loadLiveEngineExecutorStatus\(engine\)/);
  assert.match(activation, /prepareLiveCycle\(user\.id, asset, selection\)/);
  assert.doesNotMatch(panel, /(?:createOrder|cancelOrder|dispatchOrder)\s*\(/);
});

test("credential replacement and removal fail closed for active or paused Testnet cycles", () => {
  const route = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(route, /from\("robot_v1_testnet_runs"\)[\s\S]*?\.eq\("exchange_account_id", accountId\)\.in\("status", \["ACTIVE", "PAUSED"\]\)/);
  assert.match(route, /liveRuns\.error \|\| testnetRuns\.error[\s\S]*?testnetRuns\.data/);
});

test("staged reassignment is explicit, validates both shard identifiers and never accepts credentials", () => {
  const input = { operation: "REASSIGN_STAGED", requestId: randomUUID(), accountId: randomUUID(),
    fromShardId: "executor-01", toShardId: "executor-02" };
  assert.doesNotThrow(() => validateCredentialIntent(input));
  for (const patch of [{ fromShardId: "" }, { toShardId: "https://evil.test" },
    { toShardId: "executor-01" }, { apiSecret: "B".repeat(64) }, { operation: "REVALIDATE" }])
    assert.throws(() => validateCredentialIntent({ ...input, ...patch }), /INTENT_INVALID/);
});
test("reassignment UI is separate from Activate and unresolved INACTIVE routing is never cached", () => {
  const panel = readFileSync(new URL("../../automacao/binance-accounts-panel.tsx", import.meta.url), "utf8");
  const resolver = readFileSync(new URL("../../../lib/execution/executor-shards-server.ts", import.meta.url), "utf8");
  assert.match(panel, /Reatribuir conta preparada · sem ativar/);
  assert.match(panel, /window\.confirm/);
  assert.match(panel, /shard\.state === "HEALTHY"/);
  assert.match(resolver, /cacheable: account\.data\.status === "ACTIVE"/);
  assert.match(resolver, /!bound\.cacheable[\s\S]*?bindings\.delete\(cacheKey\)/);
});
