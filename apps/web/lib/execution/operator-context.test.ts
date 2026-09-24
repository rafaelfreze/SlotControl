import assert from "node:assert/strict";
import { test } from "node:test";
import { assertDomainRegistry, assertRowEngine, resolveEngineContext, sumNativeAmounts,
  type DomainRegistry } from "./operator-context.ts";

export const identity = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
export function fixtureRegistry(): DomainRegistry {
  const operator = { id: identity(1), product_id: identity(2), tenant_id: identity(3), user_id: identity(4), status: "ACTIVE", kill_switch: false };
  const accounts = [5, 6].map((id) => ({ id: identity(id), operator_id: operator.id,
    display_name: id === 5 ? "Fictícia A" : "Fictícia B", status: "ACTIVE", is_legacy_default: id === 5, kill_switch: false }));
  const engines = accounts.flatMap((account, index) => ["BTCBRL", "SOLBRL", "BTCUSDT", "SOLUSDT"].map((symbol, n) => ({
    id: identity(10 + index * 4 + n), operator_id: operator.id, exchange_account_id: account.id,
    environment: "REAL" as const, symbol, base_asset: symbol.slice(0, 3), quote_asset: symbol.slice(3), status: "ACTIVE",
    kill_switch: false, hard_cap_quote: 100, legacy_compatible: index === 0 && n < 2,
  })));
  return { operator, accounts, engines };
}

test("multi-account: explicit account/engine/operator/symbol mismatch never falls back", () => {
  const registry = fixtureRegistry();
  const selection = { environment: "REAL" as const, exchange_account_id: identity(5), trading_engine_id: identity(10), symbol: "BTCBRL" };
  assert.equal(resolveEngineContext(registry, selection).quote_asset, "BRL");
  for (const invalid of [{ exchange_account_id: identity(6) }, { trading_engine_id: identity(14) },
    { symbol: "BTCUSDT" }, { environment: "TESTNET" as const }, { operator_id: identity(99) },
    { trading_engine_id: identity(99) }, { exchange_account_id: "ALL" }]) {
    assert.throws(() => resolveEngineContext(registry, { ...selection, ...invalid }), /COINOPS_/);
  }
  assert.throws(() => resolveEngineContext(registry, { environment: "REAL", trading_engine_id: identity(10) }), /INCOMPLETE/);
  assert.equal(resolveEngineContext(registry, { environment: "REAL", asset: "BTC" }).symbol, "BTCBRL");
  assert.throws(() => resolveEngineContext(registry, { environment: "REAL", asset: "BTC", symbol: "BTCUSDT" }), /DENIED/);
});

test("multi-account: parent relationship and row ownership are validated after lookup", () => {
  const registry = fixtureRegistry(), engine = resolveEngineContext(registry, { environment: "REAL", asset: "BTC" });
  assertRowEngine(engine, engine);
  assert.throws(() => assertRowEngine({ ...engine, exchange_account_id: identity(6) }, engine), /MISMATCH/);
  assert.throws(() => assertRowEngine({ ...engine, trading_engine_id: identity(11) }, engine), /MISMATCH/);
  assert.throws(() => assertDomainRegistry(registry, { ...registry.operator, user_id: identity(9) }), /DENIED/);
  registry.engines[0]!.exchange_account_id = identity(99);
  assert.throws(() => assertDomainRegistry(registry, registry.operator), /DENIED/);
});

test("multi-market: exact native totals never combine accounts, environments or quotes", () => {
  const rows = [
    { exchange_account_id: identity(5), environment: "REAL" as const, quote_asset: "BRL", amount: "0.1" },
    { exchange_account_id: identity(5), environment: "REAL" as const, quote_asset: "BRL", amount: "0.2" },
    { exchange_account_id: identity(5), environment: "REAL" as const, quote_asset: "USDT", amount: "500" },
    { exchange_account_id: identity(6), environment: "REAL" as const, quote_asset: "BRL", amount: "100" },
    { exchange_account_id: identity(5), environment: "TESTNET" as const, quote_asset: "BRL", amount: "999" },
  ];
  assert.deepEqual(sumNativeAmounts(rows).map((row) => row.amount), ["0.30000000", "500.00000000", "100.00000000", "999.00000000"]);
  assert.equal(sumNativeAmounts([...rows, { ...rows[0]!, amount: null }])[0]!.amount, null);
  assert.throws(() => sumNativeAmounts([{ ...rows[0]!, amount: "1e30" }]), /INVALID/);
  assert.equal(sumNativeAmounts([{ ...rows[0]!, amount: "-0.12345678" }])[0]!.amount, "-0.12345678");
});

test("inactive account cannot admit new entries even when its engine is active", () => {
  const registry = fixtureRegistry(); registry.accounts[0]!.status = "INACTIVE";
  const context = resolveEngineContext(registry, { environment: "REAL", asset: "BTC" });
  assert.equal(context.status, "ACTIVE"); assert.equal(context.account_kill_switch, true);
  assert.equal(context.engine_kill_switch, false);
});
