import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { allocationSnapshotFingerprint, confirmedEngineCapitalExposure, type AllocationOrder } from "./engine-append-exposure.ts";
import type { OperatorExchangeSnapshot } from "./operator-executor-admin.ts";
const engines = [{ id: "a", symbol: "SOLBRL" }, { id: "b", symbol: "SOLBRL" }];
const prefix = (id: string) => `C2-${createHash("sha256").update(`account|${id}`).digest("hex").slice(0, 10)}-`;
function fixture() {
  const slots = engines.map((engine) => ({ id: `slot-${engine.id}`, run_id: `run-${engine.id}`,
    trading_engine_id: engine.id, operation_sequence: 1, position_quantity: 1, position_committed_brl: 100 }));
  const orders: AllocationOrder[] = engines.flatMap((engine) => ["BUY", "SELL"].map((side) => ({ id: `${engine.id}-${side}`,
    run_id: `run-${engine.id}`, slot_id: `slot-${engine.id}`, trading_engine_id: engine.id, operation_sequence: 1,
    client_order_id: `${prefix(engine.id)}${side}`, exchange_order_id: `${engine.id}-${side}`, side,
    purpose: side === "BUY" ? "INITIAL" : "TP", executed_quantity: side === "BUY" ? 1 : 0,
    cumulative_quote: side === "BUY" ? 100 : 0, fee_base: 0, fee_quote: 0, trades_reconciled: true })));
  const snapshot = { exchange_account_id: "account", quote_asset: "BRL", balances: [
    { asset: "BRL", free: 300, locked: 0 }, { asset: "SOL", free: 0, locked: 2 }], markets: [{ symbol: "SOLBRL",
    open_orders: orders.filter((order) => order.side === "SELL").map((order) => ({ orderId: order.exchange_order_id!,
      clientOrderId: order.client_order_id, side: "SELL", status: "NEW", origQty: 1, executedQty: 0, price: 105 })) }] } as OperatorExchangeSnapshot;
  return { slots, orders, snapshot };
}
test("same SOLBRL cross-shard credits each exact engine TP separately, never a stale sold position", () => {
  const { slots, orders, snapshot } = fixture();
  assert.deepEqual(confirmedEngineCapitalExposure(engines, slots, orders, snapshot).map((row) => row.position), [100, 100]);
  snapshot.markets[0].open_orders.pop(); snapshot.balances[1].locked = 1;
  assert.deepEqual(confirmedEngineCapitalExposure(engines, slots, orders, snapshot).map((row) => row.position), [100, 0]);
  snapshot.markets[0].open_orders[0].executedQty = .5; snapshot.balances[1].locked = .5;
  assert.deepEqual(confirmedEngineCapitalExposure(engines, slots, orders, snapshot).map((row) => row.position), [50, 0]);
});
test("foreign, duplicate, unbacked or corrupt order/position cannot release sibling allocation", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.orders[1].client_order_id = f.snapshot.markets[0].open_orders[0].clientOrderId = `${prefix("b")}SELL`; },
    (f: ReturnType<typeof fixture>) => { f.snapshot.balances[1].locked = 1; },
    (f: ReturnType<typeof fixture>) => { f.orders.push({ ...f.orders[1], id: "duplicate" }); },
    (f: ReturnType<typeof fixture>) => { f.slots[0].position_quantity = 0.5; },
    (f: ReturnType<typeof fixture>) => { f.orders[0].trades_reconciled = false; },
  ]) { const f = fixture(); mutate(f); assert.throws(() => confirmedEngineCapitalExposure(engines, f.slots, f.orders, f.snapshot), /ALLOCATION_UNKNOWN/); }
});
test("actual BUY holds use remaining quantity and wallet lock once; unmatched/manual orders never credit", () => {
  const { slots, orders, snapshot } = fixture();
  const buy = { ...orders[0], id: "next", client_order_id: `${prefix("a")}NEXT`, exchange_order_id: "next", slot_id: "slot-next", executed_quantity: 0 };
  orders.push(buy);
  snapshot.markets[0].open_orders.push({ orderId: "next", clientOrderId: buy.client_order_id, side: "BUY", status: "PARTIALLY_FILLED", origQty: 1, executedQty: .2, price: 100 });
  snapshot.balances[0].locked = 80;
  assert.equal(confirmedEngineCapitalExposure(engines, slots, orders, snapshot)[0].confirmedBuyHold, 80);
  snapshot.balances[0].locked = 79;
  assert.throws(() => confirmedEngineCapitalExposure(engines, slots, orders, snapshot), /ALLOCATION_UNKNOWN/);
});
test("stable snapshot hash ignores public prices/order iteration but catches holds, fills and balances", () => {
  const { snapshot } = fixture(); const hash = allocationSnapshotFingerprint(snapshot);
  snapshot.markets[0].price = 123; snapshot.observed_at = "later"; snapshot.markets[0].open_orders.reverse();
  assert.equal(allocationSnapshotFingerprint(snapshot), hash);
  snapshot.markets[0].open_orders[0].executedQty = .1;
  assert.notEqual(allocationSnapshotFingerprint(snapshot), hash);
  snapshot.balances[0].free = NaN;
  assert.throws(() => allocationSnapshotFingerprint(snapshot), /ALLOCATION_UNKNOWN/);
});
