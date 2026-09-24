import assert from "node:assert/strict";
import test from "node:test";
import { concretePremiumEngine, premiumNativeGroups, premiumNativeTotal, selectPremiumEngines, type PremiumEngine } from "./premium-operator.ts";

const make = (account: string, symbol: string, quote: string, amount: number): PremiumEngine => ({
  accountId: account, accountDisplayName: account, engineId: `${account}:${symbol}`, symbol, currency: quote,
  environment: "REAL", capital: amount, committed: amount / 10, exposure: amount / 5,
  realizedPnl: amount / 100, cap: amount, asset: symbol.startsWith("BTC") ? "BTC" : "SOL",
} as PremiumEngine);
const engines = [make("A", "BTCBRL", "BRL", 450), make("A", "SOLBRL", "BRL", 275),
  make("A", "BTCUSDT", "USDT", 100), make("A", "SOLUSDT", "USDT", 50),
  make("B", "BTCBRL", "BRL", 200), make("B", "SOLBRL", "BRL", 300)];

test("native presentation groups account/environment/quote and never sums BRL+USDT", () => {
  const groups = premiumNativeGroups(engines);
  assert.equal(groups.length, 3);
  assert.equal(premiumNativeTotal(engines, "capital"), null);
  assert.equal(premiumNativeTotal(groups[0].engines, "capital"), 725);
  assert.equal(premiumNativeTotal(groups[1].engines, "capital"), 150);
  assert.equal(premiumNativeTotal(groups[2].engines, "capital"), 500);
  assert.equal(premiumNativeTotal([], "capital"), null);
});
test("A/B same symbol and physical asset resolve only the selected engine", () => {
  const a = selectPremiumEngines(engines, "REAL", { accountId: "A", symbol: "BTCBRL" });
  assert.equal(a.length, 1); assert.equal(a[0].capital, 450);
  const b = selectPremiumEngines(engines, "REAL", { accountId: "B", symbol: "BTCBRL" });
  assert.equal(b.length, 1); assert.equal(b[0].capital, 200);
  assert.deepEqual(selectPremiumEngines(engines, "TESTNET", { accountId: "ALL", symbol: "ALL" }), []);
});
test("ALL and missing/ambiguous engines never authorize a mutation target", () => {
  assert.equal(concretePremiumEngine(engines, { accountId: "ALL", symbol: "BTCBRL" }, "REAL"), null);
  assert.equal(concretePremiumEngine(engines, { accountId: "A", symbol: "ALL" }, "REAL"), null);
  assert.equal(concretePremiumEngine(engines, { accountId: "B", symbol: "BTCUSDT" }, "REAL"), null);
  assert.equal(concretePremiumEngine(engines, { accountId: "A", symbol: "BTCUSDT" }, "REAL")?.engineId, "A:BTCUSDT");
});
