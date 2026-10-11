import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_BNB_FEE_MINIMUM_EXCLUSIVE, liveBnbFeeBalanceCheck } from "./live-bnb-fee-balance.ts";
import { LiveReadUnavailable } from "./live-read-error.ts";

const now = Date.parse("2026-10-11T17:30:00Z");
const snapshot = (free = .001, quote = "BRL") => ({ observed_at: new Date(now).toISOString(),
  balances: [{ asset: quote, free: 100_000 }, { asset: "BNB", free }],
  bnb_quote_price: { symbol: `BNB${quote}`, price: 1000, observedAt: new Date(now).toISOString() } });

test("exact strict BNB threshold is unchanged; quote capital or locked funds never replace Spot BNB", () => {
  assert.equal(LIVE_BNB_FEE_MINIMUM_EXCLUSIVE, .00001);
  for (const quote of ["BRL", "USDT"]) {
    for (const free of [0, .000009, .00001]) assert.equal(liveBnbFeeBalanceCheck(snapshot(free, quote), quote, now).sufficient, false);
    for (const free of [.00001000001, .001]) assert.equal(liveBnbFeeBalanceCheck(snapshot(free, quote), quote, now).sufficient, true);
    const compatibility = snapshot(.001, quote);
    assert.equal(liveBnbFeeBalanceCheck({ ...compatibility, bnb_quote_price: null,
      bnb_brl_price: compatibility.bnb_quote_price }, quote, now).sufficient, true);
  }
});

test("unknown/stale/malformed BNB or price cannot be represented as available or silently zero", () => {
  const valid = snapshot();
  const malformed = [snapshot(-1), snapshot(NaN), snapshot(Infinity),
    { ...valid, balances: [{ asset: "BRL", free: 100 }] },
    { ...valid, balances: [...valid.balances, { asset: "BNB", free: .001 }] },
    { ...valid, observed_at: "invalid" },
    { ...valid, observed_at: new Date(now - 30_001).toISOString() },
    { ...valid, observed_at: new Date(now + 2_001).toISOString() },
    { ...valid, bnb_quote_price: null },
    { ...valid, bnb_quote_price: { ...valid.bnb_quote_price, symbol: "BNBUSDT" } },
    ...[0, -1, NaN, Infinity].map((price) => ({ ...valid, bnb_quote_price: { ...valid.bnb_quote_price, price } })),
    { ...valid, bnb_quote_price: { ...valid.bnb_quote_price, observedAt: new Date(now - 30_001).toISOString() } },
    { ...valid, bnb_quote_price: { ...valid.bnb_quote_price, observedAt: new Date(now + 2_001).toISOString() } }];
  for (const state of malformed) assert.throws(() => liveBnbFeeBalanceCheck(state, "BRL", now),
    (error: unknown) => error instanceof LiveReadUnavailable && error.code === "COINOPS_LIVE_BNB_FEE_BALANCE_UNAVAILABLE"
      && error.path === "snapshot/bnb_fee");
  assert.throws(() => liveBnbFeeBalanceCheck(valid, "BNB", now), /BNB_FEE_BALANCE_UNAVAILABLE/);
  assert.throws(() => liveBnbFeeBalanceCheck(valid, "BRL", NaN), /BNB_FEE_BALANCE_UNAVAILABLE/);
  assert.equal(liveBnbFeeBalanceCheck({ ...valid, observed_at: new Date(now - 30_000).toISOString(),
    bnb_quote_price: { ...valid.bnb_quote_price, observedAt: new Date(now - 30_000).toISOString() } }, "BRL", now).sufficient, true);
});
