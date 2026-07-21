import assert from "node:assert/strict";
import test from "node:test";

import { automationIdempotencyKey, entryWasCrossed, exitWasCrossed, findFirstCrossedWindow, type PriceWindow } from "./automation.ts";

const candle = (overrides: Partial<PriceWindow> = {}): PriceWindow => ({
  asset: "BTC",
  windowStart: "2026-07-21T10:00:00.000Z",
  windowEnd: "2026-07-21T10:01:00.000Z",
  open: 64_050,
  high: 64_080,
  low: 63_940,
  close: 63_970,
  source: "BINANCE",
  ...overrides
});

test("entrada reconhece toque, salto abaixo e candle que fecha acima", () => {
  assert.equal(entryWasCrossed(candle(), 64_000, 64_050), true);
  assert.equal(entryWasCrossed(candle({ low: 64_000, close: 64_020 }), 64_000, 64_050), true);
  assert.equal(entryWasCrossed(candle({ low: 63_900, close: 64_050 }), 64_000, 64_080), true);
  assert.equal(entryWasCrossed(candle({ low: 64_001, close: 64_020 }), 64_000, 64_050), false);
});

test("saida reconhece toque, salto acima e candle que fecha abaixo", () => {
  assert.equal(exitWasCrossed(candle({ open: 64_980, high: 65_080, low: 64_960, close: 65_030 }), 65_000, 64_980), true);
  assert.equal(exitWasCrossed(candle({ high: 65_000, close: 64_990 }), 65_000, 64_980), true);
  assert.equal(exitWasCrossed(candle({ high: 65_080, close: 64_970 }), 65_000, 64_980), true);
  assert.equal(exitWasCrossed(candle({ high: 64_999, close: 64_990 }), 65_000, 64_980), false);
});

test("encontra o primeiro cruzamento posterior ao gatilho salvo", () => {
  const windows = [
    candle({ windowStart: "2026-07-21T10:00:00.000Z", windowEnd: "2026-07-21T10:01:00.000Z", low: 64_100, close: 64_120 }),
    candle({ windowStart: "2026-07-21T10:01:00.000Z", windowEnd: "2026-07-21T10:02:00.000Z" })
  ];
  assert.equal(findFirstCrossedWindow("ENTRY", windows, 64_000, "2026-07-21T10:00:30.000Z")?.windowStart, "2026-07-21T10:01:00.000Z");
});

test("chave idempotente e estavel por slot, evento, preco e janela", () => {
  const input = { asset: "SOL" as const, slotId: "slot-1", eventType: "EXIT" as const, triggerPrice: 150.5, windowStart: "2026-07-21T10:00:00.000Z" };
  assert.equal(automationIdempotencyKey(input), automationIdempotencyKey({ ...input }));
  assert.notEqual(automationIdempotencyKey(input), automationIdempotencyKey({ ...input, windowStart: "2026-07-21T10:01:00.000Z" }));
});
