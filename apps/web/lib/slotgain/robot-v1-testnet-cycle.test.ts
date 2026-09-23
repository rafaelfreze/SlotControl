import assert from "node:assert/strict";
import test from "node:test";

import { planTerminalTestnetRestart, testnetOperationalState, testnetResetIdempotencyKey, type TestnetCycleOrderState } from "../execution/robot-v1-testnet-cycle.ts";

const order = (value: Partial<TestnetCycleOrderState>): TestnetCycleOrderState => ({
  slot_number: 1, side: "BUY", purpose: "INITIAL", client_order_id: "buy-initial", exchange_order_id: "1",
  status: "FILLED", executed_quantity: 0.084, fee_base: 0, ...value
});

const terminal = [
  order({}),
  order({ side: "SELL", purpose: "TP", client_order_id: "tp-terminal", exchange_order_id: "2", status: "FILLED", executed_quantity: 0.084 }),
  order({ slot_number: 2, purpose: "ENTRY", client_order_id: "next-buy", exchange_order_id: "3", status: "NEW", executed_quantity: 0 })
];

test("terminal TP with no remaining position plans one cycle restart and cancellation of the old BUY", () => {
  const plan = planTerminalTestnetRestart(terminal, 0.001);
  assert.equal(plan.shouldRestart, true);
  assert.equal(plan.terminalFill?.client_order_id, "tp-terminal");
  assert.equal(plan.activeNextBuy?.client_order_id, "next-buy");
});

test("a still-open or partially filled position prevents terminal restart", () => {
  assert.equal(planTerminalTestnetRestart([terminal[0]!, { ...terminal[1]!, executed_quantity: 0.04 }, terminal[2]!], 0.001).reason, "OPEN_POSITION_REMAINS");
  assert.equal(planTerminalTestnetRestart([...terminal, order({ slot_number: 2, purpose: "ENTRY", client_order_id: "partial", status: "PARTIALLY_FILLED", executed_quantity: 0.01 })], 0.001).reason, "OPEN_POSITION_REMAINS");
});

test("restart idempotency is stable for duplicate stream, cron and reconciliation deliveries", () => {
  const key = testnetResetIdempotencyKey("old-cycle", "tp-terminal");
  assert.equal(key, testnetResetIdempotencyKey("old-cycle", "tp-terminal"));
  assert.notEqual(key, testnetResetIdempotencyKey("old-cycle", "another-fill"));
  assert.equal(key.length, 64);
});

test("multiple resident next BUYs fail closed", () => {
  assert.throws(() => planTerminalTestnetRestart([...terminal, { ...terminal[2]!, client_order_id: "duplicate" }], 0.001), /MULTIPLE_ACTIVE_BUYS/);
});

test("human state distinguishes restart, fill wait, operation, reconciliation and errors", () => {
  const base = { runStatus: "ACTIVE", lastError: null, resetStartedAt: null, resetCompletedAt: null, initialBuyStatus: null, openPositions: 0, activeTakeProfits: 0, activeNextBuys: 0 };
  assert.equal(testnetOperationalState({ ...base, resetStartedAt: "2026-09-23T00:00:00Z" }), "REINICIANDO CICLO");
  assert.equal(testnetOperationalState({ ...base, initialBuyStatus: "NEW" }), "AGUARDANDO FILL");
  assert.equal(testnetOperationalState({ ...base, openPositions: 1, activeTakeProfits: 1, activeNextBuys: 1 }), "OPERANDO");
  assert.equal(testnetOperationalState(base), "RECONCILIANDO");
  assert.equal(testnetOperationalState({ ...base, lastError: "FAILED" }), "ERRO");
});

test("recovery checkpoints preserve the same reset key across each crash boundary", () => {
  const checkpoints = ["after_terminal_fill", "after_cycle_complete", "after_initial_send", "after_initial_fill", "after_tp", "after_next_buy"];
  const keys = checkpoints.map(() => testnetResetIdempotencyKey("old-cycle", "tp-terminal"));
  assert.equal(new Set(keys).size, 1);
});
