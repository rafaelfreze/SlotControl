import assert from "node:assert/strict";
import test from "node:test";
import { concretePremiumEngine, premiumNativeGroups, premiumNativeTotal, premiumQuoteBalanceRows, rankPremiumAccountsByOperatedBalance, selectPremiumEngines, selectedLiveExecutorStatus, withLiveMarketPrice, type PremiumEngine } from "./premium-operator.ts";
import type { Props } from "./automation-mobile";

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
test("account cards rank by operated exposure without adding unlike currencies", () => {
  const ranked = rankPremiumAccountsByOperatedBalance([
    { id: "A", displayName: "A", status: "ACTIVE", killSwitch: false },
    { id: "B", displayName: "B", status: "ACTIVE", killSwitch: false },
  ], engines);
  assert.deepEqual(ranked.map((row) => row.account.id), ["A", "B"]);
  assert.equal(ranked[0].operatedBalance, 145);
  assert.equal(ranked[1].operatedBalance, 100);
});
test("Binance free balances stay separated by account and quote, including USDT", () => {
  const rows = premiumQuoteBalanceRows(premiumNativeGroups(engines), [
    { accountId: "A", currency: "BRL", free: 10, locked: 1, observedAt: "2026-09-25T00:00:00Z" },
    { accountId: "A", currency: "USDT", free: 772.10, locked: 33, observedAt: "2026-09-25T00:00:00Z" },
    { accountId: "B", currency: "BRL", free: 20, locked: 2, observedAt: "2026-09-25T00:00:00Z" },
  ]);
  assert.deepEqual(rows.map((row) => [row.accountId, row.currency, row.free]),
    [["A", "BRL", 10], ["A", "USDT", 772.10], ["B", "BRL", 20]]);
  assert.equal(premiumQuoteBalanceRows(premiumNativeGroups(engines), [
    { accountId: "B", currency: "USDT", free: 999, locked: 0, observedAt: "2026-09-25T00:00:00Z" },
  ])[1].free, null);
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

test("same-symbol engines require exact engine selection without account/shard fallback", () => {
  const a = { ...make("A", "SOLBRL", "BRL", 275), engineId: "engine-A" };
  const b = { ...a, engineId: "engine-B", capital: 400 };
  const selected = { accountId: "A", symbol: "SOLBRL" };
  assert.equal(concretePremiumEngine([a, b], selected, "REAL"), null);
  assert.equal(concretePremiumEngine([a, b], selected, "REAL", "engine-A"), a);
  assert.equal(concretePremiumEngine([a, b], selected, "REAL", "engine-B"), b);
  assert.equal(concretePremiumEngine([a, b], selected, "REAL", "missing"), null);
  assert.equal(concretePremiumEngine([a, b], { ...selected, accountId: "B" }, "REAL", "engine-B"), null);
  assert.equal(concretePremiumEngine([a, b], selected, "TESTNET", "engine-B"), null);
});

test("public market quote updates only the read-only native presentation", () => {
  const original = { ...engines[2], price: null, openPnl: null,
    slots: [{ state: "OPEN", quantity: .1, committed: 10, currentPrice: null, openPnl: null },
      { state: "PLANNED", quantity: 0, committed: 0, currentPrice: null, openPnl: 0 }] } as PremiumEngine;
  const quoted = withLiveMarketPrice(original, 110);
  assert.equal(quoted.price, 110);
  assert.equal(quoted.slots[0].currentPrice, 110);
  assert.equal(quoted.slots[0].openPnl, 1);
  assert.equal(quoted.openPnl, 1);
  assert.equal(original.price, null);
  assert.equal(original.slots[0].currentPrice, null);
  assert.equal(withLiveMarketPrice(original, NaN).price, null);
  assert.equal(withLiveMarketPrice({ ...engines[0], slots: original.slots }, 440_000).price, 440_000);
  assert.equal(withLiveMarketPrice({ ...engines[0], environment: "SHADOW" }, 110).price, engines[0].price);
});

test("selected LIVE health uses Thyely engine evidence, not Rafael's legacy snapshot", () => {
  const selected = [engines[2], engines[3]];
  const active = { nativeLiveControl: { executor: { gate: "LIVE_EXECUTOR_ACTIVE", ip: "46.101.104.48",
    health: null } } } as unknown as Props;
  const engineData = { [selected[0].engineId]: active, [selected[1].engineId]: active };
  const healthy = selectedLiveExecutorStatus(selected, engineData);
  assert.equal(healthy.online, true);
  assert.equal(healthy.binanceConnected, true);
  assert.equal(healthy.ip, "46.101.104.48");
  assert.equal(selectedLiveExecutorStatus(selected, { [selected[0].engineId]: active }).online, false);
  assert.equal(selectedLiveExecutorStatus([], engineData).online, false);
});
