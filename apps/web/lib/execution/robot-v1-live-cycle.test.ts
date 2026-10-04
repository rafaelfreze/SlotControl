import assert from "node:assert/strict";
import test from "node:test";

import { liveClientOrderId, liveExposure, liveUncoveredQuantity } from "./robot-v1-live-cycle.ts";

const run = "11111111-2222-4333-8444-555555555555";
test("LIVE client IDs are stable per operation and distinct across revisions", () => {
  const first = liveClientOrderId(run, "BTC", 1, 1, "BUY", 1);
  assert.equal(first, liveClientOrderId(run, "BTC", 1, 1, "BUY", 1));
  assert.notEqual(first, liveClientOrderId(run, "BTC", 1, 2, "BUY", 2));
  assert.notEqual(first, liveClientOrderId(run, "BTC", 1, 1, "SELL", 1));
  assert.match(first, /^COR1-BTC-1-1-BUY-[a-f0-9]{14}$/);
  assert.ok(first.length <= 36);
});

test("LIVE TP covers only owned net fills, never a second resident quantity", () => {
  const orders = [
    { side: "BUY" as const, status: "FILLED", executed_quantity: "0.000041", fee_base: "0" },
    { side: "SELL" as const, status: "NEW", executed_quantity: "0", fee_base: "0",
      requested_quantity: "0.00004" },
  ];
  assert.equal(liveUncoveredQuantity(orders, 0.00001), 0);
  assert.equal(liveUncoveredQuantity([orders[0]], 0.00001), 0.00004);
});

test("STP expiry preserves actual BUY/TP partial fills and protects only the remaining own quantity", () => {
  const buy = { side: "BUY" as const, status: "EXPIRED_IN_MATCH", executed_quantity: .1,
    fee_base: .001, cumulative_quote: 10, reserved_notional_brl: 20 };
  assert.equal(liveUncoveredQuantity([buy], .001), .099);
  const expiredTp = { side: "SELL" as const, status: "EXPIRED_IN_MATCH", executed_quantity: .04,
    requested_quantity: .099, fee_base: 0 };
  assert.equal(liveUncoveredQuantity([buy, expiredTp], .001), .059);
  assert.equal(liveUncoveredQuantity([buy, expiredTp, { ...expiredTp, status: "NEW",
    executed_quantity: 0, requested_quantity: .059 }], .001), 0);
  assert.deepEqual(liveExposure([{ asset: "BTC", committedBrl: 10 }], [{ ...buy, asset: "BTC" }]),
    { BTC: 10, SOL: 0, global: 10 });
  assert.equal(liveUncoveredQuantity([{ ...buy, executed_quantity: 0, fee_base: 0 }], .001), 0);
});

test("LIVE exposure includes partial BUY reservations and rejects any hard-cap breach", () => {
  const positions = [{ asset: "BTC" as const, committedBrl: 430 }, { asset: "SOL" as const, committedBrl: 250 }];
  const orders = [{ asset: "BTC" as const, side: "BUY" as const, status: "PARTIALLY_FILLED",
    executed_quantity: 0.00001, fee_base: 0, reserved_notional_brl: 18, cumulative_quote: 8 }];
  assert.deepEqual(liveExposure(positions, orders), { BTC: 440, SOL: 250, global: 690 });
  assert.throws(() => liveExposure(positions, [...orders,
    { ...orders[0], asset: "SOL" as const, reserved_notional_brl: 30, cumulative_quote: 0 }]), /HARD_CAP_BREACHED/);
});
