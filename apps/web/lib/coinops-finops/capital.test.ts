import assert from "node:assert/strict";
import test from "node:test";
import { buildFinopsCapital, finopsCapitalRows, type CapitalInput } from "./capital.ts";

const now = Date.parse("2026-09-27T00:00:00Z");
const at = new Date(now).toISOString();
function fixture(accountId = "account-1", engineId = "engine-1", shard = "executor-1", currency = "BRL"): CapitalInput {
  const ids = { operator_id: "operator", exchange_account_id: accountId, trading_engine_id: engineId };
  return { operatorId: "operator", now,
    accounts: [{ id: accountId, operator_id: "operator", display_name: accountId, status: "ACTIVE", executor_shard_id: shard, onboarding_environment: "REAL" }],
    engines: [{ id: engineId, ...ids, environment: "REAL", symbol: `SOL${currency}`, base_asset: "SOL", quote_asset: currency, status: "ACTIVE", kill_switch: false }],
    runs: [{ id: `run-${engineId}`, ...ids, status: "ACTIVE", last_reconciled_at: at }],
    slotAccounts: Array.from({ length: 25 }, (_, index) => ({ ...ids, slot_number: index + 1, balance_quote: "11.00000000", market_pnl_quote: index === 0 ? "0.35" : "0", fees_quote: index === 0 ? "0.05" : "0", gain_count: index === 0 ? 1 : 0 })),
    slots: Array.from({ length: 25 }, (_, index) => ({ ...ids, run_id: `run-${engineId}`, slot_number: index + 1, position_quantity: index === 0 ? "0.02" : "0", position_committed_quote: index === 0 ? "11" : "0" })),
    orders: [{ ...ids, run_id: `run-${engineId}`, side: "BUY", status: "PARTIALLY_FILLED", reserved_notional_quote: "11", requested_quote: null, requested_quantity: "0.02", price: "550", cumulative_quote: "1" }],
    wallets: [{ accountId, source: "fixture exchange snapshot", observedAt: at, balances: [{ asset: currency, free: "254", locked: "10" }, { asset: "SOL", free: "0", locked: "0.02" }] }],
    prices: [{ accountId, symbol: `SOL${currency}`, price: "600", observedAt: at }] };
}
function combined(...inputs: CapitalInput[]): CapitalInput {
  const first = inputs[0]!;
  return { ...first, accounts: inputs.flatMap((input) => input.accounts), engines: inputs.flatMap((input) => input.engines),
    runs: inputs.flatMap((input) => input.runs), slotAccounts: inputs.flatMap((input) => input.slotAccounts),
    slots: inputs.flatMap((input) => input.slots), orders: inputs.flatMap((input) => input.orders),
    wallets: inputs.flatMap((input) => input.wallets ?? []), prices: inputs.flatMap((input) => input.prices ?? []) };
}

test("capital is wallet quote cash plus owned positions, never ledger allocation or duplicate base balance", () => {
  const result = buildFinopsCapital(fixture());
  const row = result.accounts[0]!.currencies[0]!;
  assert.equal(row.monitored, "276.000000000000"); // 254 free + 10 locked + 0.02 SOL * 600
  assert.equal(row.ledgerCapital, "275.000000000000");
  assert.equal(row.ledgerFree, "254.000000000000"); // allocation minus position cost and remaining BUY
  assert.equal(row.positionCost, "11.000000000000");
  assert.equal(row.positionValue, "12.000000000000");
  assert.equal(row.reserved, "10.000000000000");
  assert.equal(row.realizedPnl, "0.300000000000");
  assert.equal(row.openPnl, "1.000000000000");
  assert.equal(row.complete, true);
  assert.equal(finopsCapitalRows(result).accounts[0]!.monitored, 276);
});
test("wallet refresh outage cannot reuse a fresh-looking prior balance as a current total", () => {
  const input=fixture();
  input.wallets![0]!.error="COINOPS_FINOPS_WALLET_SYNC_FAILED";
  const result=buildFinopsCapital(input);
  assert.equal(result.accounts[0]!.currencies[0]!.monitored,null);
  assert.equal(result.accounts[0]!.currencies[0]!.complete,false);
});

test("multiple engines never repeat the same account wallet", () => {
  const sol = fixture(), btc = fixture("account-1", "engine-btc");
  btc.engines[0]!.base_asset = "BTC"; btc.engines[0]!.symbol = "BTCBRL";
  btc.slots[0]!.position_quantity = "0.0001";
  btc.prices = [{ accountId: "account-1", symbol: "BTCBRL", price: "400000", observedAt: at }];
  const input = combined(sol, btc); input.accounts = sol.accounts; input.wallets = sol.wallets;
  input.wallets![0]!.balances.push({ asset: "BTC", free: 0, locked: "0.0001" });
  const result = buildFinopsCapital(input);
  assert.equal(result.accounts[0]!.currencies[0]!.monitored, "316.000000000000"); // 264 + 12 + 40
  assert.equal(result.counts.activeAccounts, 1);
  assert.equal(result.counts.activeEngines, 2);
});

test("native currencies and shards remain separate without implicit FX", () => {
  const result = buildFinopsCapital(combined(fixture(), fixture("account-usdt", "engine-usdt", "executor-2", "USDT")));
  assert.equal(result.currencies.length, 2);
  assert.deepEqual(result.currencies.map((row) => row.currency), ["BRL", "USDT"]);
  assert.equal(result.shards.length, 2);
  assert.equal(result.accounts[1]!.currencies[0]!.monitored, "276.000000000000");
  assert.equal(result.counts.shards, 2);
});

test("missing, stale or invalid observations are unavailable, never zero", () => {
  const input = fixture(); input.wallets = []; input.prices = [];
  const absent = buildFinopsCapital(input);
  assert.equal(absent.accounts[0]!.currencies[0]!.monitored, null);
  assert.equal(absent.markets[0]!.openPnl, null);
  assert.equal(absent.markets[0]!.positionCost, "11.000000000000");
  const stale = fixture(); stale.wallets![0]!.observedAt = "2026-09-26T20:00:00Z";
  assert.equal(buildFinopsCapital(stale).accounts[0]!.wallet.status, "STALE");
  assert.equal(buildFinopsCapital(stale).accounts[0]!.currencies[0]!.monitored, null);
  const invalid = fixture(); invalid.wallets![0]!.balances[0]!.free = "NaN";
  assert.equal(buildFinopsCapital(invalid).accounts[0]!.currencies[0]!.monitored, null);
});

test("positions use only the current cycle; old fills and closed reservations never inflate capital", () => {
  const input = fixture();
  input.runs.push({ ...input.runs[0]!, id: "old-run", status: "COMPLETED" });
  input.slots.push({ ...input.slots[0]!, run_id: "old-run", position_quantity: "100", position_committed_quote: "10000" });
  input.orders.push({ ...input.orders[0]!, run_id: "old-run", reserved_notional_quote: "1000" });
  input.orders.push({ ...input.orders[0]!, status: "CANCELED", reserved_notional_quote: "1000" });
  const result = buildFinopsCapital(input);
  assert.equal(result.markets[0]!.reserved, "10.000000000000");
  assert.equal(result.accounts[0]!.currencies[0]!.monitored, "276.000000000000");
});

test("incomplete or ambiguous ledger cannot produce a complete capital total", () => {
  const missing = fixture(); missing.slots.pop();
  assert.equal(buildFinopsCapital(missing).accounts[0]!.currencies[0]!.complete, false);
  const duplicate = fixture(); duplicate.runs.push({ ...duplicate.runs[0]!, id: "second-live-run" });
  assert.equal(buildFinopsCapital(duplicate).markets[0]!.positionValue, null);
  const unknownLedger = fixture(); unknownLedger.slotAccounts.pop();
  assert.equal(buildFinopsCapital(unknownLedger).markets[0]!.ledgerCapital, null);
  assert.equal(buildFinopsCapital(unknownLedger).markets[0]!.realizedPnl, null);
});

test("new account/shard is included dynamically and removed accounts stop current counts without changing source data", () => {
  const input = combined(fixture(), fixture("new-account", "new-engine", "executor-N"));
  assert.equal(buildFinopsCapital(input).counts.activeEngines, 2);
  input.accounts[1]!.status = "DISABLED";
  const before = JSON.stringify(input);
  const result = buildFinopsCapital(input);
  assert.equal(result.counts.accounts, 1);
  assert.equal(result.counts.activeEngines, 1);
  assert.equal(JSON.stringify(input), before);
});

test("pause keeps the observed capital while changing operating counts", () => {
  const input = fixture(); input.engines[0]!.status = "PAUSED"; input.runs[0]!.status = "PAUSED";
  const result = buildFinopsCapital(input);
  assert.equal(result.counts.activeEngines, 0);
  assert.equal(result.accounts[0]!.currencies[0]!.monitored, "276.000000000000");
});

test("operator and account-engine crossovers are rejected", () => {
  const otherOperator = fixture(); otherOperator.slots[0]!.operator_id = "other";
  assert.throws(() => buildFinopsCapital(otherOperator), /CAPITAL_SCOPE_MISMATCH/);
  const otherAccount = fixture(); otherAccount.slots[0]!.exchange_account_id = "other";
  assert.throws(() => buildFinopsCapital(otherAccount), /CAPITAL_ENGINE_MISMATCH/);
});

test("unmanaged wallet assets are disclosed and never converted or added as quote money", () => {
  const input = fixture(); input.wallets![0]!.balances.push({ asset: "BNB", free: "1", locked: "0" });
  const result = buildFinopsCapital(input);
  assert.ok(result.warnings.includes("UNMANAGED_WALLET_ASSETS:account-1"));
  assert.equal(result.accounts[0]!.currencies[0]!.monitored, "276.000000000000");
});

test("decimal native aggregation preserves ledger precision without float accumulation", () => {
  const input = fixture();
  input.slotAccounts.forEach((row) => { row.balance_quote = "0.1"; row.market_pnl_quote = "0.00000003"; row.fees_quote = 1e-8; });
  const result = buildFinopsCapital(input);
  assert.equal(result.markets[0]!.ledgerCapital, "2.500000000000");
  assert.equal(result.markets[0]!.realizedPnl, "0.000000500000");
});

test("base/quote overlap between markets is marked incomplete to prevent double counting", () => {
  const sol = fixture(); const other = fixture("account-1", "engine-cross");
  other.engines[0]!.quote_asset = "SOL"; other.engines[0]!.base_asset = "BTC"; other.engines[0]!.symbol = "BTCSOL";
  const input = combined(sol, other); input.accounts = sol.accounts;
  const result = buildFinopsCapital(input);
  assert.ok(result.warnings.includes("WALLET_BASE_QUOTE_OVERLAP:account-1"));
  assert.ok(result.accounts[0]!.currencies.every((row) => row.monitored === null));
});

test("fill race or stale reconciliation invalidates combined wallet/ledger capital", () => {
  const sellFilled = fixture(); sellFilled.wallets![0]!.balances[1]!.locked = "0";
  assert.equal(buildFinopsCapital(sellFilled).accounts[0]!.currencies[0]!.monitored, null);
  const orderChanged = fixture(); orderChanged.wallets![0]!.consistent = false;
  assert.equal(buildFinopsCapital(orderChanged).accounts[0]!.currencies[0]!.monitored, null);
  const staleLedger = fixture(); staleLedger.runs[0]!.last_reconciled_at = "2026-09-26T20:00:00Z";
  assert.equal(buildFinopsCapital(staleLedger).accounts[0]!.currencies[0]!.monitored, null);
});

test("an observed empty wallet is zero only when the owned position is also zero", () => {
  const input = fixture(); input.wallets![0]!.balances = [];
  assert.equal(buildFinopsCapital(input).accounts[0]!.currencies[0]!.monitored, null);
  input.slots[0]!.position_quantity = "0"; input.slots[0]!.position_committed_quote = "0";
  input.orders = [];
  assert.equal(buildFinopsCapital(input).accounts[0]!.currencies[0]!.monitored, "0.000000000000");
});
