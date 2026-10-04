import assert from "node:assert/strict";
import test from "node:test";
import { projectAccountBudgetObservation, type BudgetObservation } from "./account-order-budget-observation.ts";
const now = Date.parse("2026-10-04T15:00:01Z");
const engines = ["A", "B"].map((id) => ({ id, operator_id: "op", exchange_account_id: "account", symbol: "SOLBRL" }));
const ledger = engines.map((engine, index) => ({ ...engine, id: `ledger-${index}`, trading_engine_id: engine.id,
  client_order_id: `C2-${engine.id}-SELL`, exchange_order_id: String(index + 1), side: "SELL" }));
const own = ledger.map((row) => ({ id: row.exchange_order_id, symbol: row.symbol, clientOrderId: row.client_order_id,
  side: row.side, status: "NEW" }));
const sample: BudgetObservation = { operator_id: "op", exchange_account_id: "account", environment: "REAL",
  executor_shard_id: "executor-03", executor_ip: "203.0.113.33", credential_ref: "account_fixture", executor_version: "release",
  observedAt: now, serverTime: now, intervals: [{ intervalMs: 10000, count: 2, limit: 50 }], restrictions: [],
  symbols: [{ symbol: "SOLBRL", maxOrders: 200, selfTradePrevention: "EXPIRE_TAKER", openOrders: own }], exchangeOrders: null };
const input = { operatorId: "op", accountId: "account", shardId: "executor-03", ip: "203.0.113.33",
  credentialRef: "account_fixture", versions: ["release"], symbols: ["SOLBRL"], engines, ledger };
test("same-account/symbol cross-shard orders are owned only by complete exact engine ledger proof", () => {
  const result = projectAccountBudgetObservation(sample, input, now);
  assert.deepEqual(result.symbols.SOLBRL, { maxOrders: 200, selfTradePrevention: "EXPIRE_TAKER", openOrders: 2, externalOrders: 0 });
  const foreignId = { ...own[1], id: "999" };
  const mismatchedSide = { ...own[0], side: "BUY" };
  const mismatchedClient = { ...own[0], clientOrderId: "C2-A-looks-owned" };
  for (const row of [foreignId, mismatchedSide, mismatchedClient]) assert.equal(projectAccountBudgetObservation({ ...sample,
    symbols: [{ ...sample.symbols[0], openOrders: [row] }] }, input, now).symbols.SOLBRL.externalOrders, 1);
});
test("untrusted scopes, clocks, intervals, runtime and incomplete ownership fail closed", () => {
  for (const patch of [{ exchange_account_id: "foreign" }, { operator_id: "foreign" }, { environment: "TESTNET" },
    { executor_shard_id: "executor-02" }, { executor_ip: "203.0.113.22" }, { executor_version: "old" },
    { credential_ref: "foreign" }, { observedAt: now - 31000 }, { serverTime: now + 3000 },
    { intervals: [] }, { symbols: [] }, { restrictions: null }])
    assert.throws(() => projectAccountBudgetObservation({ ...sample, ...patch } as BudgetObservation, input, now), /OBSERVATION_INVALID/);
  assert.throws(() => projectAccountBudgetObservation(sample, { ...input, engines: engines.slice(0, 1) }, now), /OBSERVATION_INVALID/);
  assert.throws(() => projectAccountBudgetObservation(sample, { ...input, ledger: [...ledger, ledger[0]] }, now), /OBSERVATION_INVALID/);
  assert.throws(() => projectAccountBudgetObservation(sample, input, now + 9000), /OBSERVATION_INVALID/);
});
test("global resident-order filter includes non-CoinOps native symbols and rejects inconsistent subsets", () => {
  const external = { id: "3", symbol: "ETHUSDT", clientOrderId: "manual", side: "BUY", status: "NEW" };
  const value = { ...sample, exchangeOrders: { limit: 1000, openOrders: [...own, external] } };
  assert.deepEqual(projectAccountBudgetObservation(value, input, now).exchangeOrders, { limit: 1000, openOrders: 3, externalOrders: 1 });
  assert.throws(() => projectAccountBudgetObservation({ ...value, exchangeOrders: { limit: 1000, openOrders: [external] } }, input, now), /OBSERVATION_INVALID/);
});
