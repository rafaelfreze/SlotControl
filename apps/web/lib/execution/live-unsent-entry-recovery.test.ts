import assert from "node:assert/strict";
import test from "node:test";
import { mayAttestUnsentEntry } from "./live-unsent-entry-recovery.ts";
const now = Date.now();
const order = { status: "PREPARED", side: "BUY", purpose: "ENTRY", exchange_order_id: null, executed_quantity: "0", cumulative_quote: "0" };
const decision = { result: "DISPATCHED", dispatched_at: new Date(now - 90000).toISOString(), exchange_ack_at: null, completed_at: null };
test("only old unacknowledged empty ENTRY can request evidence; no MARKET, fill, terminal or fresh dispatch", () => {
  assert.equal(mayAttestUnsentEntry(order, decision, now), true);
  for (const patch of [{ purpose: "INITIAL" }, { purpose: "TP", side: "SELL" }, { exchange_order_id: "1" }, { executed_quantity: "0.1" }, { cumulative_quote: "1" }, { status: "NEW" }])
    assert.equal(mayAttestUnsentEntry({ ...order, ...patch }, decision, now), false);
  for (const patch of [{ result: "PENDING" }, { result: "COMPLETED" }, { exchange_ack_at: "ack" }, { completed_at: "done" }, { dispatched_at: new Date(now - 89999).toISOString() }])
    assert.equal(mayAttestUnsentEntry(order, { ...decision, ...patch }, now), false);
});
