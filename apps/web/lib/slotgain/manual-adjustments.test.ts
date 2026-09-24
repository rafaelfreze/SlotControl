import assert from "node:assert/strict";
import test from "node:test";
import { FX_SOURCE, previewManualAdjustment, settleAfterOpenPosition } from "../execution/manual-adjustments.ts";
import { rankMonthlySlots } from "../execution/monthly-slot-policy.ts";

const slot = (overrides: Record<string, unknown> = {}) => ({ environment: "TESTNET" as const, asset: "SOL" as const,
  physicalSlotNumber: 1, balanceUsdc: 100, committedNotionalUsdc: null, entryState: "CLOSED",
  monthlyGainCount: 1, lifetimeGainCount: 10, gainRate: 0.005, ...overrides });

test("closed SOL manual gain reaches target, adds equity but is not market P&L", () => {
  const result = previewManualAdjustment(slot(), { kind: "MANUAL_TARGET_GAIN", gainUnits: 1 });
  assert.equal(result.convertedAmountUsdc, 0.5);
  assert.equal(result.balanceAfterUsdc, 100.5);
  assert.equal(result.monthlyAfter, 2);
  assert.equal(result.targetReachedAfter, true);
  assert.equal(result.appliesTo, "NEXT_OPERATION");
});

test("OPEN manual credit keeps committed position frozen and compounds only next operation", () => {
  const result = previewManualAdjustment(slot({ entryState: "OPEN", committedNotionalUsdc: 100 }),
    { kind: "MANUAL_TARGET_GAIN", gainUnits: 1, explicitGainAmountUsdc: 5 });
  assert.equal(result.committedNotionalUsdc, 100);
  assert.equal(result.balanceAfterUsdc, 105);
  assert.equal(settleAfterOpenPosition(result, 2), 107);
});

test("USD contributions credit CLOSED and OPEN equity without counting a gain", () => {
  for (const state of ["CLOSED", "OPEN"] as const) {
    const result = previewManualAdjustment(slot({ entryState: state, committedNotionalUsdc: state === "OPEN" ? 100 : null }),
      { kind: "MANUAL_CONTRIBUTION", currency: "USD", amount: 10 });
    assert.equal(result.balanceAfterUsdc, 110);
    assert.equal(result.monthlyAfter, 1);
    assert.equal(result.lifetimeAfter, 10);
    if (state === "OPEN") {
      assert.equal(result.committedNotionalUsdc, 100);
      assert.equal(settleAfterOpenPosition(result, 3), 113);
    }
  }
});

test("BRL uses a fresh deterministic USDCBRL ask and rejects stale quotes", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  const fx = { rateBrlPerUsdc: 5, source: FX_SOURCE, observedAt: "2026-09-23T11:59:30Z" };
  const result = previewManualAdjustment(slot(), { kind: "MANUAL_CONTRIBUTION", currency: "BRL", amount: 50 }, fx, now);
  assert.equal(result.convertedAmountUsdc, 10);
  assert.equal(result.balanceAfterUsdc, 110);
  assert.throws(() => previewManualAdjustment(slot(), { kind: "MANUAL_CONTRIBUTION", currency: "BRL", amount: 50 },
    { ...fx, observedAt: "2026-09-23T11:57:00Z" }, now), /FX_STALE/);
});

test("manual lifetime gain changes future rank, but does not touch physical slot identity", () => {
  const before = Array.from({ length: 25 }, (_, i) => ({ physicalSlotNumber: i + 1, physicalSlotId: `TESTNET:scope:SOL:${i + 1}`,
    lifetimeGainCount: i === 0 ? 2 : i === 1 ? 3 : 0, monthlyGainCount: 0, balanceUsdc: 10, entryState: "PLANNED" }));
  const at = "2026-09-23T12:00:00Z";
  assert.equal(rankMonthlySlots("SOL", at, before)[0]?.operationalRank, 2);
  const after = before.map((item, i) => i === 0 ? { ...item, lifetimeGainCount: item.lifetimeGainCount + 2 } : item);
  assert.equal(rankMonthlySlots("SOL", at, after)[0]?.operationalRank, 1);
  assert.equal(after[0]?.physicalSlotId, before[0]?.physicalSlotId);
});

test("USDT contribution requires its own fresh FX and never borrows USDC conversion", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const state = slot({ quoteAsset: "USDT", entryState: "OPEN", committedNotionalUsdc: 100 });
  const request = { kind: "MANUAL_CONTRIBUTION" as const, currency: "BRL" as const, amount: 50 };
  const fx = { quoteAsset: "USDT" as const, rateBrlPerUsdc: 5, rateBrlPerQuote: 5,
    source: "BINANCE_SPOT_USDTBRL_ASK" as const, observedAt: "2026-09-24T11:59:30Z" };
  const result = previewManualAdjustment(state, request, fx, now);
  assert.equal(result.quoteAsset, "USDT"); assert.equal(result.balanceAfterUsdc, 110);
  assert.equal(result.committedNotionalUsdc, 100); assert.equal(result.monthlyAfter, 1);
  assert.throws(() => previewManualAdjustment(state, request, { ...fx, source: FX_SOURCE }, now), /FX/);
  assert.throws(() => previewManualAdjustment(state, request, { ...fx, quoteAsset: "USDC" }, now), /FX/);
});
