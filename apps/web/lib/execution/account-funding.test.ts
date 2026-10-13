import assert from "node:assert/strict";
import test from "node:test";
import { buildAccountFunding, fundingClientMessage, type AccountFundingInput } from "./account-funding.ts";
import type { LiveExecutorState } from "./live-executor-transport.ts";

const now = Date.parse("2026-10-13T13:00:00Z"), at = new Date(now).toISOString();
function fixture(count = 1): AccountFundingInput {
  const owned = (id: string) => ({ operator_id: "operator", exchange_account_id: "account", trading_engine_id: id });
  const engines = Array.from({ length: count }, (_, i) => ({ id: `engine${i}`, operator_id: "operator", exchange_account_id: "account",
    environment: "REAL", quote_asset: "BRL", symbol: "SOLBRL", executor_shard_id: `executor-0${i + 1}`,
    status: "ACTIVE", hard_cap_quote: 275, orderPrefix: `C2-engine${i}-` }));
  const orders = engines.map((engine) => ({ ...owned(engine.id), run_id: `run-${engine.id}`, symbol: engine.symbol,
    side: "BUY", status: "NEW", client_order_id: `${engine.orderPrefix}2-B-test`, exchange_order_id: engine.id,
    requested_quantity: 1, executed_quantity: 0, reserved_notional_quote: 10, cumulative_quote: 0, price: 10, trades_reconciled: true }));
  const state = { ...owned(engines[0].id), symbol: "SOLBRL", quote_asset: "BRL", observed_at: at,
    filters: { symbol: "SOLBRL", baseAsset: "SOL", quoteAsset: "BRL", quantityStep: .001, priceTick: .1, minNotional: 10 },
    balances: [{ asset: "BRL", free: 254, locked: count * 10, total: 254 + count * 10 },
      { asset: "BNB", free: .001, locked: 0, total: .001 }, { asset: "SOL", free: 0, locked: count, total: count }],
    open_orders: orders.map((order) => ({ id: order.exchange_order_id, clientOrderId: order.client_order_id,
      symbol: order.symbol, side: order.side, status: order.status, originalQuantity: 1, executedQuantity: 0, price: 10 })),
  } as LiveExecutorState;
  return { operatorId: "operator", accountId: "account", accountName: "Sintética", now, engines,
    runs: engines.map((engine) => ({ ...owned(engine.id), id: `run-${engine.id}`, status: "ACTIVE", last_reconciled_at: at })),
    slotAccounts: engines.flatMap((engine) => Array.from({ length: 25 }, (_, i) => ({ ...owned(engine.id), slot_number: i + 1, balance_quote: 11 }))),
    slots: engines.flatMap((engine) => Array.from({ length: 25 }, (_, i) => ({ ...owned(engine.id), id: `${engine.id}:${i}`,
      run_id: `run-${engine.id}`, slot_number: i + 1, position_quantity: i === 0 ? 1 : 0, position_committed_quote: i === 0 ? 11 : 0 }))),
    orders, pending: [], states: [state] };
}

test("whole grid is funded by native account wallet once, including same-symbol cross-shard engines", () => {
  const [row] = buildAccountFunding(fixture(2));
  assert.deepEqual([row.engineCount, row.slotCount, row.ledgerTarget, row.positionCost, row.buyReserved, row.cashRequired, row.spotFree, row.deficit],
    [2, 50, 550, 22, 20, 508, 254, 254]);
  assert.equal(row.status, "SHORTFALL");
});
test("configured cap is separate from current slot capital, pending is future need not cash", () => {
  const input = fixture(); input.engines[0].hard_cap_quote = 400;
  input.slotAccounts[0].balance_quote = 12.25;
  input.pending = [{ trading_engine_id: "engine0", amount_quote: 20 }];
  const [row] = buildAccountFunding(input);
  assert.deepEqual([row.configuredCap, row.ledgerTarget, row.pending, row.cashRequired, row.deficit], [400, 276.25, 20, 275.25, 21.25]);
});
test("price improvement on partial fill never overcredits physical BUY lock", () => {
  const input = fixture(); const order = input.orders[0], resident = input.states[0].open_orders[0];
  Object.assign(order, { executed_quantity: .4, cumulative_quote: 3.5, status: "PARTIALLY_FILLED" });
  Object.assign(resident, { executedQuantity: .4, status: "PARTIALLY_FILLED" });
  input.states[0].balances[0].locked = 6;
  assert.equal(buildAccountFunding(input)[0].buyReserved, 6); // not 10 - 3.5 = 6.5
});
test("foreign locked cash, Earn, future TP profits and marked prices never cover grid", () => {
  const input = fixture(); input.states[0].balances[0].free = 0; input.states[0].balances[0].locked = 900;
  assert.equal(buildAccountFunding(input)[0].deficit, 254);
});
test("BNB technical reserve is reported separately, not a promise of all future fees", () => {
  const input = fixture(); input.states[0].balances[1].free = .00001;
  const [row] = buildAccountFunding(input);
  assert.equal(row.status, "COVERED"); assert.equal(row.bnbStatus, "LOW");
  assert.match(fundingClientMessage(row), /reserva abaixo do mínimo técnico/);
  input.states[0].balances.splice(1, 1);
  assert.equal(buildAccountFunding(input)[0].bnbStatus, "UNKNOWN");
});
test("missing/stale/ambiguous financial evidence never produces zero deficit or sufficient", () => {
  const cases: Array<(input: AccountFundingInput) => void> = [
    (input) => { input.slotAccounts.pop(); },
    (input) => { input.slotAccounts[24].slot_number = 1; },
    (input) => { input.runs[0].last_reconciled_at = new Date(now - 181_000).toISOString(); },
    (input) => { input.states[0].observed_at = new Date(now - 30_001).toISOString(); },
    (input) => { input.states[0].open_orders = []; },
    (input) => { input.orders[0].status = "PREPARED"; },
    (input) => { input.orders[0].status = "FILLED"; input.orders[0].executed_quantity = 1; input.orders[0].trades_reconciled = false; },
    (input) => { input.orders[0].client_order_id = "C2-other-engine"; },
    (input) => { input.states[0].open_orders[0].executedQuantity = .2; },
    (input) => { input.states[0].open_orders[0].originalQuantity = undefined; },
    (input) => { input.states[0].balances[2].locked = 0; },
    (input) => { input.slotAccounts[0].balance_quote = null; },
  ];
  for (const mutate of cases) {
    const input = fixture(); mutate(input); const [row] = buildAccountFunding(input);
    assert.equal(row.status, "INCOMPLETE", row.issues.join()); assert.equal(row.deficit, null);
  }
});
test("BRL and USDT never net and one wallet observation is not summed across symbols", () => {
  const input = fixture(2), engine = input.engines[1]; engine.quote_asset = "USDT"; engine.symbol = "SOLUSDT";
  input.orders[1].symbol = "SOLUSDT"; input.states[0].open_orders.pop();
  const state = structuredClone(input.states[0]);
  Object.assign(state, { symbol: "SOLUSDT", quote_asset: "USDT", trading_engine_id: engine.id });
  Object.assign(state.filters, { symbol: "SOLUSDT", quoteAsset: "USDT" });
  state.balances[0] = { asset: "USDT", free: 0, locked: 10, total: 10 };
  state.open_orders = [{ ...input.states[0].open_orders[0], id: engine.id, symbol: engine.symbol, clientOrderId: input.orders[1].client_order_id }];
  input.states.push(state);
  const rows = buildAccountFunding(input);
  assert.equal(rows[0].currency, "BRL"); assert.equal(rows[0].deficit, 0);
  assert.equal(rows[1].currency, "USDT"); assert.equal(rows[1].deficit, 254);
});
test("changed wallet during observation and duplicate order ownership remain incomplete", () => {
  const input = fixture(2); input.states.push(structuredClone(input.states[0])); input.states[1].balances[0].free++;
  assert.equal(buildAccountFunding(input)[0].status, "INCOMPLETE");
  const duplicate = fixture(2); duplicate.orders[1].client_order_id = duplicate.orders[0].client_order_id;
  assert.equal(buildAccountFunding(duplicate)[0].status, "INCOMPLETE");
});
test("different operator/account/engine is rejected, not merged into coverage", () => {
  for (const key of ["operator_id", "exchange_account_id", "trading_engine_id"] as const) {
    const input = fixture(); input.slotAccounts[0][key] = "foreign";
    assert.throws(() => buildAccountFunding(input), /SCOPE_MISMATCH/);
  }
});
test("reverse ownership detects new or older-run engine resident missing from ledger", () => {
  const input = fixture();
  input.states[0].open_orders.push({ ...input.states[0].open_orders[0], id: "new-order",
    clientOrderId: "C2-engine0-3-B-old-run" });
  assert.equal(buildAccountFunding(input)[0].status, "INCOMPLETE");
  input.states[0].open_orders[1].clientOrderId = "external-manual-order";
  assert.equal(buildAccountFunding(input)[0].status, "COVERED");
});
test("a same-account sibling run is not identity for another engine's slots or orders", () => {
  const input = fixture(2); input.orders[0].run_id = input.runs[1].id;
  assert.throws(() => buildAccountFunding(input), /RUN_SCOPE_MISMATCH/);
  const slots = fixture(2); slots.slots[0].run_id = slots.runs[1].id;
  assert.throws(() => buildAccountFunding(slots), /RUN_SCOPE_MISMATCH/);
});
test("owner-ready text distinguishes complete principal from indefinite fees and no writes", () => {
  const [row] = buildAccountFunding(fixture(2));
  assert.match(fundingClientMessage(row), /50 slots/); assert.match(fundingClientMessage(row), /254,00 BRL/);
  assert.match(fundingClientMessage(row), /taxas futuras não/); assert.match(fundingClientMessage(row), /não houve cancelamento/);
  row.status = "INCOMPLETE"; assert.doesNotMatch(fundingClientMessage(row), /Faltam/);
});
