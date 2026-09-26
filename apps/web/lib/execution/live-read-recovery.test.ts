import assert from "node:assert/strict";
import test from "node:test";

import { mayRecoverReadOutage } from "./live-read-recovery.ts";

test("recovers only a successfully reconciled active read outage", () => {
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", "COINOPS_LIVE_RECONCILE_ORDERS_FAILED"), true);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", "COINOPS_LIVE_READ_STATE_FAILED"), true);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", "COINOPS_LIVE_EXECUTOR_READ_STALE"), true);
  for (const code of ["COINOPS_LIVE_TP_FAILED", "STRATEGY_PRICE_INVARIANT_FAILED", null])
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code), false);
  assert.equal(mayRecoverReadOutage("PAUSED", "OK", "COINOPS_LIVE_READ_STATE_FAILED"), false);
  assert.equal(mayRecoverReadOutage("ACTIVE", "RETRY", "COINOPS_LIVE_READ_STATE_FAILED"), false);
});
