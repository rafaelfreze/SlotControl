import assert from "node:assert/strict";
import test from "node:test";
import { automationSignalMatches, automationSignalScopes } from "./automation-live-scope.ts";
import type { PremiumEngine } from "./premium-operator.ts";

const rafael = "11111111-1111-4111-8111-111111111111";
const thyely = "22222222-2222-4222-8222-222222222222";
const btc = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sol = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const engines = [
  { engineId: btc, accountId: rafael, environment: "REAL", symbol: "BTCBRL" },
  { engineId: sol, accountId: thyely, environment: "REAL", symbol: "SOLUSDT" },
  { engineId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", accountId: thyely,
    environment: "TESTNET", symbol: "SOLUSDT" },
] as PremiumEngine[];

test("subscription scope is environment, account, engine and symbol exact", () => {
  const scope = automationSignalScopes(engines, "live", { accountId: thyely, symbol: "SOLUSDT" });
  assert.equal(scope.length, 1);
  assert.deepEqual(scope[0], { environment: "REAL", exchange_account_id: thyely,
    trading_engine_id: sol, symbol: "SOLUSDT" });
  assert.equal(automationSignalMatches(scope[0], { ...scope[0], revision: 5 }), true);
  assert.equal(automationSignalMatches(scope[0], { ...scope[0], exchange_account_id: rafael }), false);
  assert.equal(automationSignalMatches(scope[0], { ...scope[0], trading_engine_id: btc }), false);
  assert.equal(automationSignalMatches(scope[0], { ...scope[0], environment: "TESTNET" }), false);
  assert.equal(automationSignalMatches(scope[0], { ...scope[0], symbol: "BTCUSDT" }), false);
  assert.equal(automationSignalMatches(scope[0], null), false);
  assert.equal(automationSignalScopes(engines, "overview", { accountId: "ALL", symbol: "ALL" }).length, 3);
});
