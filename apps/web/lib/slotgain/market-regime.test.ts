import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_ASSET_MARKET_SETTINGS, DEFAULT_MARKET_REGIME_SETTINGS, activeBuyDropPercent, applyMarketRegimeHysteresis, calculateMarketRegime, distanceFromAthPercent, effectiveMarketRegime, operatingPlan, selectOperablePendingSlots } from "./market-regime.ts";

test("classifica ATH, topo, normal e fundo forte nos limites", () => {
  assert.equal(distanceFromAthPercent(100, 100), 0);
  assert.equal(calculateMarketRegime(-3, DEFAULT_MARKET_REGIME_SETTINGS), "TOP");
  assert.equal(calculateMarketRegime(-5, DEFAULT_MARKET_REGIME_SETTINGS), "TOP");
  assert.equal(calculateMarketRegime(-5.1, DEFAULT_MARKET_REGIME_SETTINGS), "NORMAL");
  assert.equal(calculateMarketRegime(-30, DEFAULT_MARKET_REGIME_SETTINGS), "NORMAL");
  assert.equal(calculateMarketRegime(-30.1, DEFAULT_MARKET_REGIME_SETTINGS), "DEEP");
});

test("aplica histerese nas fronteiras", () => {
  assert.equal(applyMarketRegimeHysteresis("TOP", -5.4, DEFAULT_MARKET_REGIME_SETTINGS), "TOP");
  assert.equal(applyMarketRegimeHysteresis("TOP", -5.6, DEFAULT_MARKET_REGIME_SETTINGS), "NORMAL");
  assert.equal(applyMarketRegimeHysteresis("NORMAL", -4.6, DEFAULT_MARKET_REGIME_SETTINGS), "NORMAL");
  assert.equal(applyMarketRegimeHysteresis("NORMAL", -4.4, DEFAULT_MARKET_REGIME_SETTINGS), "TOP");
  assert.equal(applyMarketRegimeHysteresis("DEEP", -29.6, DEFAULT_MARKET_REGIME_SETTINGS), "DEEP");
  assert.equal(applyMarketRegimeHysteresis("DEEP", -29.4, DEFAULT_MARKET_REGIME_SETTINGS), "NORMAL");
});

test("percentuais BTC e SOL acompanham o mesmo regime", () => {
  assert.equal(activeBuyDropPercent("BTC", "TOP"), 4);
  assert.equal(activeBuyDropPercent("BTC", "NORMAL"), 2);
  assert.equal(activeBuyDropPercent("SOL", "TOP"), 12);
  assert.equal(activeBuyDropPercent("SOL", "DEEP"), 8);
  assert.equal(effectiveMarketRegime({ mode_source: "MANUAL", manual_mode: "DEEP" }, "TOP"), "DEEP");
});

test("planos de reserva respeitam BTC profundo com somente 15 principais", () => {
  assert.deepEqual(operatingPlan("BTC", "TOP"), { zeroReserveCount: 5, activeSlotLimit: null });
  assert.deepEqual(operatingPlan("BTC", "NORMAL"), { zeroReserveCount: 3, activeSlotLimit: null });
  assert.deepEqual(operatingPlan("BTC", "DEEP"), { zeroReserveCount: 0, activeSlotLimit: 15 });
  assert.deepEqual(operatingPlan("SOL", "TOP"), { zeroReserveCount: 3, activeSlotLimit: null });
  const slots = Array.from({ length: 20 }, (_, index) => ({ id: String(index), slot_number: index + 1, sort_order: index + 1, status: "hold" as const, gains_distribuidos: index }));
  assert.equal(selectOperablePendingSlots("BTC", "DEEP", slots, DEFAULT_ASSET_MARKET_SETTINGS.BTC).length, 15);
});
