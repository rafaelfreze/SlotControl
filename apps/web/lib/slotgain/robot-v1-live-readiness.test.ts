import assert from "node:assert/strict";
import test from "node:test";

import { assessSolBrlPilot, validateFutureSolBrlCaps } from "../execution/robot-v1-live-readiness.ts";

const filters = { symbol: "SOLBRL", baseAsset: "SOL", quoteAsset: "BRL", minQuantity: .001, maxQuantity: 9222449, minNotional: 10, quantityStep: .001, priceTick: .1 };

test("SOLBRL 10 BRL budget fails the public NOTIONAL filter at the observed price", () => {
  const result = assessSolBrlPilot(filters, 601.6);
  assert.equal(result.accepted, false);
  assert.equal(result.executableQuantity, .016);
  assert.equal(result.executableNotional, 9.6256);
  assert.equal(result.minimumQuantity, .017);
  assert.equal(result.minimumPerSlotBrl, 10.2272);
  assert.equal(result.minimumCapitalFor25SlotsBrl, 255.68);
});

test("future SOLBRL caps must stay inside allocated capital and BTC LIVE is refused", () => {
  assert.deepEqual(validateFutureSolBrlCaps("SOL", 300, 12, 300), { capitalBrl: 300, maxOrderBrl: 12, maxExposureBrl: 300 });
  assert.throws(() => validateFutureSolBrlCaps("BTC", 300, 12, 300), /LIVE_CAP_INVALID/);
  assert.throws(() => validateFutureSolBrlCaps("SOL", 300, 12, 301), /LIVE_CAP_INVALID/);
  assert.throws(() => assessSolBrlPilot({ ...filters, symbol: "BTCBRL" }, 601.6), /LIVE_SYMBOL_BLOCKED/);
});
