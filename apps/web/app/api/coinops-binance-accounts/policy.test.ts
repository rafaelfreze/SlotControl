import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertOwnedAccount, assertSameOrigin, validateCredentialIntent } from "./policy.ts";

const origin = "https://cripto-flax.vercel.app";
const valid = { operation: "CONNECT", requestId: randomUUID(), accountId: randomUUID(),
  displayName: "Thyely", environment: "REAL", apiKey: "A".repeat(64), apiSecret: "B".repeat(64) };

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
