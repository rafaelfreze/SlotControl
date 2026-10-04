import assert from "node:assert/strict";
import test from "node:test";
import { accountOrderBudgetDecision, type AccountOrderBudget } from "./account-order-budget.ts";

const now = Date.parse("2026-10-04T13:00:01Z");
const sample: AccountOrderBudget = { accountId: "account", observedAt: now, serverTime: now,
  intervals: [{ intervalMs: 10_000, limit: 100, count: 95 }, { intervalMs: 86_400_000, limit: 200_000, count: 1000 }],
  restrictions: [],
  symbols: { SOLBRL: { maxOrders: 200, openOrders: 20, externalOrders: 2, selfTradePrevention: "EXPIRE_TAKER" } } };
const input = { accountId: "account", newOrders: 3, newEngineSymbol: "SOLBRL",
  existingEnginesForSymbol: 2, existingEnginesForAccount: 2, newEngines: 1 };
test("account limit is shared by same-symbol engines on different IPs, reservations are counted once", () => {
  const reservations = ["A", "B", "C"].map((engineId) => ({ accountId: "account", engineId,
    clientOrderId: engineId, reservedAt: now }));
  assert.equal(accountOrderBudgetDecision(sample, reservations.slice(0, 2), input, now).code, "PASS");
  assert.equal(accountOrderBudgetDecision(sample, reservations, input, now).code, "ACCOUNT_ORDER_CAPACITY_REQUIRED");
  assert.equal(accountOrderBudgetDecision(sample, [reservations[0], reservations[0]], input, now).intervals[0].projected, 99);
  assert.equal(accountOrderBudgetDecision(sample, [{ ...reservations[0], accountId: "other" }], input, now).intervals[0].projected, 98);
});
test("missing, stale, malformed or rolled-over evidence cannot authorize cross-shard admission", () => {
  for (const value of [null, { ...sample, accountId: "other" }, { ...sample, observedAt: now - 31_000 },
    { ...sample, intervals: [] }, { ...sample, intervals: [{ ...sample.intervals[0], count: NaN }] }])
    assert.equal(accountOrderBudgetDecision(value, [], input, now).code, "ACCOUNT_ORDER_BUDGET_UNKNOWN");
  assert.equal(accountOrderBudgetDecision(sample, [], input, now + 10_000).code, "ACCOUNT_ORDER_BUDGET_UNKNOWN");
});
test("N is limited by live Binance filters, never a fixed engine count", () => {
  assert.equal(accountOrderBudgetDecision(sample, [], { ...input, existingEnginesForSymbol: 6 }, now).code, "PASS");
  assert.equal(accountOrderBudgetDecision(sample, [], { ...input, existingEnginesForSymbol: 7 }, now).code, "ACCOUNT_ORDER_CAPACITY_REQUIRED");
  assert.equal(accountOrderBudgetDecision({ ...sample, symbols: { SOLBRL: { ...sample.symbols.SOLBRL, maxOrders: 1000 } } },
    [], { ...input, existingEnginesForSymbol: 30 }, now).code, "PASS");
});

test("a signed sample cannot erase an unacknowledged reservation or conflicting ownership", () => {
  const pending = { accountId: "account", engineId: "A", clientOrderId: "one", reservedAt: now - 1000 };
  assert.equal(accountOrderBudgetDecision(sample, [pending], input, now).intervals[0].projected, 99);
  assert.equal(accountOrderBudgetDecision(sample, [pending, { ...pending, engineId: "B" }], input, now).code, "ACCOUNT_ORDER_BUDGET_UNKNOWN");
  assert.equal(accountOrderBudgetDecision(sample, [{ ...pending, acknowledgedAt: now - 500 }], input, now).intervals[0].projected, 98);
  assert.equal(accountOrderBudgetDecision(sample, [{ ...pending, acknowledgedAt: now }], input, now).intervals[0].projected, 99);
});

test("global resident order filter remains shared across symbols and shards", () => {
  assert.equal(accountOrderBudgetDecision({ ...sample, exchangeOrders: { limit: 50, openOrders: 48, externalOrders: 1 } },
    [], input, now).code, "ACCOUNT_ORDER_CAPACITY_REQUIRED");
});

test("global resident projection includes every symbol/engine, not just the proposed market", () => {
  const global = { ...sample, exchangeOrders: { limit: 100, openOrders: 5, externalOrders: 1 } };
  assert.equal(accountOrderBudgetDecision(global, [], input, now).code, "PASS");
  assert.equal(accountOrderBudgetDecision(global, [], { ...input, existingEnginesForAccount: 3 }, now).code, "ACCOUNT_ORDER_CAPACITY_REQUIRED");
  assert.equal(accountOrderBudgetDecision(global, [], { ...input, existingEnginesForAccount: undefined }, now).code, "ACCOUNT_ORDER_BUDGET_UNKNOWN");
});

test("unsupported account-specific position/value filters or unsafe STP never pass admission", () => {
  assert.equal(accountOrderBudgetDecision({ ...sample, restrictions: ["SOL:MAX_ASSET"] }, [], input, now).code, "ACCOUNT_ORDER_BUDGET_UNKNOWN");
  assert.equal(accountOrderBudgetDecision({ ...sample, symbols: { SOLBRL: { ...sample.symbols.SOLBRL, selfTradePrevention: null } } },
    [], input, now).code, "ACCOUNT_ORDER_BUDGET_UNKNOWN");
});

test("signed server clock, not the browser clock, determines interval expiry", () => {
  const boundary = Math.floor(now / 10_000) * 10_000;
  const early = { ...sample, observedAt: boundary - 500, serverTime: boundary + 500 };
  assert.equal(accountOrderBudgetDecision(early, [], input, boundary + 100).code, "PASS");
  const late = { ...sample, observedAt: boundary + 500, serverTime: boundary - 500 };
  assert.equal(accountOrderBudgetDecision(late, [], input, boundary + 700).code, "PASS");
  assert.equal(accountOrderBudgetDecision(late, [], input, boundary + 1001).code, "ACCOUNT_ORDER_BUDGET_UNKNOWN");
});

test("a future TP reserve survives fresh counters and never expires on timeout or shard change", () => {
  const buy = { accountId: "account", engineId: "engine-on-02", clientOrderId: "buy-on-02",
    reservedAt: now - 100_000, acknowledgedAt: now - 90_000, protectionOrders: 3 };
  assert.equal(accountOrderBudgetDecision(sample, [buy], input, now).code, "ACCOUNT_ORDER_CAPACITY_REQUIRED");
  assert.equal(accountOrderBudgetDecision(sample, [buy, buy], input, now).intervals[0].projected, 101);
  const pending = { ...buy, acknowledgedAt: null, protectionOrders: 1 };
  assert.equal(accountOrderBudgetDecision(sample, [pending], input, now).intervals[0].projected, 100);
  for (const protectionOrders of [-1, NaN, .5])
    assert.equal(accountOrderBudgetDecision(sample, [{ ...buy, protectionOrders }], input, now).code, "ACCOUNT_ORDER_BUDGET_UNKNOWN");
  assert.equal(accountOrderBudgetDecision(sample, [buy, { ...buy, protectionOrders: 0 }], input, now).code,
    "ACCOUNT_ORDER_BUDGET_UNKNOWN");
});
