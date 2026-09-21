import assert from "node:assert/strict";
import test from "node:test";

import { BinanceSpotAdapter } from "../execution/binance-spot-adapter.ts";
import { assertSufficientShadowBalance, buildShadowIntent, calculateSlotNotional, classifyReconciledFill, recordShadowIntent, shouldCreateShadowEntryIntent } from "../execution/shadow-engine.ts";

const now = new Date("2026-09-21T14:00:00.000Z");
const input = {
  productId: "00000000-0000-0000-0000-000000000001",
  tenantId: "00000000-0000-0000-0000-000000000002",
  userId: "00000000-0000-0000-0000-000000000003",
  strategyId: "00000000-0000-0000-0000-000000000004",
  slotId: "00000000-0000-0000-0000-000000000005",
  cycleId: "00000000-0000-0000-0000-000000000006",
  asset: "BTC" as const,
  side: "BUY" as const,
  quantity: 0.0005,
  referencePrice: 60000,
  targetPrice: 60000,
  observedMarketPrice: 59000,
  observedAt: now.toISOString(),
  strategyReason: "ENTRY_TRIGGER_REACHED",
  strategyRegime: "NORMAL_GROWTH"
};
const limits = { maxOrderNotionalUsdt: 100, maxDailyNotionalUsdt: 200, maxMarketAgeSeconds: 60, dailyNotionalUsdt: 0 };

test("shadow intent is deterministic across a restart and never represents LIVE", () => {
  const first = buildShadowIntent(input, limits, now);
  const afterRestart = buildShadowIntent(input, limits, now);
  assert.equal(first.executionMode, "SHADOW");
  assert.equal(first.idempotencyKey, afterRestart.idempotencyKey);
  assert.equal(first.symbol, "BTCUSDT");
  assert.equal(calculateSlotNotional(625), 25);
});

test("same logical shadow intent is persisted once by an idempotent store", async () => {
  const stored = new Map<string, string>();
  const store = { upsert: async (intent: ReturnType<typeof buildShadowIntent>) => {
    if (stored.has(intent.idempotencyKey)) return { created: false, id: stored.get(intent.idempotencyKey) };
    stored.set(intent.idempotencyKey, "intent-1");
    return { created: true, id: "intent-1" };
  } };
  const first = await recordShadowIntent(input, limits, store, now);
  const replay = await recordShadowIntent(input, limits, store, now);
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(stored.size, 1);
});

test("shadow safety rejects stale market data, insufficient balance and daily/order limits", () => {
  assert.throws(() => buildShadowIntent({ ...input, executionMode: "LIVE" as never }, limits, now), /LIVE_EXECUTION_BLOCKED/);
  assert.throws(() => buildShadowIntent({ ...input, observedAt: "2026-09-21T13:58:00.000Z" }, limits, now), /MARKET_DATA_STALE/);
  assert.throws(() => assertSufficientShadowBalance(1, 10), /INSUFFICIENT_BALANCE/);
  assert.throws(() => buildShadowIntent(input, { ...limits, maxOrderNotionalUsdt: 20 }, now), /MAX_ORDER_NOTIONAL/);
  assert.throws(() => buildShadowIntent(input, { ...limits, maxDailyNotionalUsdt: 30, dailyNotionalUsdt: 10 }, now), /MAX_DAILY_NOTIONAL/);
});

test("only a free HOLD slot at or below its trigger becomes a shadow BUY candidate", () => {
  assert.equal(shouldCreateShadowEntryIntent("hold", 59000, 60000), true);
  assert.equal(shouldCreateShadowEntryIntent("aberto", 59000, 60000), false);
  assert.equal(shouldCreateShadowEntryIntent("hold", 61000, 60000), false);
  assert.equal(classifyReconciledFill(1, 0), "PENDING");
  assert.equal(classifyReconciledFill(1, 0.25), "PARTIALLY_FILLED");
  assert.equal(classifyReconciledFill(1, 1), "FILLED");
});

test("Binance adapter has no real order path in phase 1", async () => {
  let requests = 0;
  const adapter = new BinanceSpotAdapter(async () => {
    requests += 1;
    throw new Error("transport should not be reached for orders");
  });
  await assert.rejects(adapter.createOrder({ symbol: "BTCUSDT", side: "BUY", quantity: 1, clientOrderId: "qa" }), { name: "LiveExecutionBlockedError" });
  await assert.rejects(adapter.cancelOrder("BTCUSDT", "qa"), { name: "LiveExecutionBlockedError" });
  await assert.rejects(adapter.getBalances(), /READ_ONLY_CONNECTION_NOT_CONFIGURED/);
  assert.equal(requests, 0);
});
