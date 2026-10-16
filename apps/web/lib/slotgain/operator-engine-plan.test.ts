import assert from "node:assert/strict";
import test from "node:test";

import { distributeLiveCapital } from "../execution/live-preparation.ts";
import { equalEngineCapitals, validateEnginePlan } from "../execution/operator-engine-plan.ts";

const accountId = "10000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000002";

test("cent-exact split preserves the full native cap over engines and 25 slots", () => {
  assert.deepEqual(equalEngineCapitals("838.01", ["BTC", "SOL"]), [419.01, 419]);
  const slots = distributeLiveCapital(419.01);
  assert.equal(slots.length, 25);
  assert.equal(slots.reduce((sum, item) => sum + Math.round(item * 100), 0), 41901);
  assert.equal(slots[0], 16.77);
  assert.equal(slots[1], 16.76);
  assert.deepEqual(equalEngineCapitals("1100.00", ["SOL"]), [1100]);
});

test("plan requires explicit account, same quote, exact sum and general profiles", () => {
  const plan = { accountId, requestId, quote: "USDT" as const, capital: "838.00",
    engines: [
      { asset: "BTC" as const, capital: "419.00", gainPercent: "1.2", spacingPercent: "2", postAthPercent: "5" },
      { asset: "SOL" as const, capital: "419.00", gainPercent: "5.5", spacingPercent: "3", postAthPercent: "8" },
    ] };
  const result = validateEnginePlan(plan);
  assert.equal(result.capital, 838);
  assert.deepEqual(result.engines.map((item) => item.allocation.reduce((sum, amount) => sum + Math.round(amount * 100), 0)), [41900, 41900]);
  assert.deepEqual(result.engines.map((item) => item.monthlyTarget), [7, 2]);
  assert.throws(() => validateEnginePlan({ ...plan, capital: "838.01" }), /CAP_SUM_MISMATCH/);
  assert.equal(validateEnginePlan({ ...plan, accountId: requestId, engines: [plan.engines[0], plan.engines[0]] }).engines.length, 2);
  assert.throws(() => validateEnginePlan({ ...plan, engines: [{ ...plan.engines[0], postAthPercent: "21" }] }), /RATE_INVALID/);
  assert.throws(() => validateEnginePlan({ ...plan, engines: [{ ...plan.engines[0], capital: "419.001" }] }), /AMOUNT_INVALID/);
});

test("N same-symbol plans have independent allocation and explicit monthly targets", () => {
  const result = validateEnginePlan({ accountId, requestId, quote: "BRL", capital: "1000.00",
    engines: Array.from({ length: 10 }, (_, i) => ({ asset: "SOL", capital: "100.00",
      gainPercent: "5.5", spacingPercent: "3", postAthPercent: "8", monthlyTarget: i + 1 })) });
  assert.equal(result.engines.length, 10);
  assert.deepEqual(result.engines.map((engine) => engine.monthlyTarget), Array.from({ length: 10 }, (_, i) => i + 1));
  assert.notEqual(result.engines[0].allocation, result.engines[1].allocation);
});

test("100 x R$11 plan preserves exact individual strategy and requires a canonical count", () => {
  const engine = { asset: "SOL" as const, capital: "1100.00", perSlotQuote: "11.00", slotCount: 100,
    gainPercent: "3", spacingPercent: "1", postAthPercent: "2", monthlyTarget: 3 };
  const plan = { accountId, requestId, quote: "BRL" as const, capital: "1100.00", engines: [engine] };
  const result = validateEnginePlan(plan).engines[0];
  assert.equal(result.slotCount, 100);
  assert.equal(result.allocation.length, 100);
  assert.ok(result.allocation.every((amount) => amount === 11));
  assert.deepEqual([result.gain, result.spacing, result.postAth, result.monthlyTarget], [.03, .01, .02, 3]);
  for (const slotCount of [0, 1, 100.1, 101, NaN])
    assert.throws(() => validateEnginePlan({ ...plan, engines: [{ ...engine, slotCount }] }), /SLOT_COUNT_INVALID/);
  assert.throws(() => validateEnginePlan({ ...plan, engines: [{ ...engine, perSlotQuote: "11.01" }] }), /SLOT_CAP_SUM_MISMATCH/);
  assert.throws(() => validateEnginePlan({ ...plan, engines: [{ ...engine, slotCount: null as unknown as number }] }), /SLOT_COUNT_INVALID/);
});

test("25, 50, 75 and 100 same-symbol plans do not share physical allocation arrays", () => {
  const result = validateEnginePlan({ accountId, requestId, quote: "BRL", capital: "2750.00",
    engines: [25, 50, 75, 100].map((slotCount) => ({ asset: "SOL", capital: (slotCount * 11).toFixed(2),
      slotCount, perSlotQuote: "11.00", gainPercent: "3", spacingPercent: "1", postAthPercent: "2", monthlyTarget: 3 })) });
  assert.deepEqual(result.engines.map((engine) => engine.allocation.length), [25, 50, 75, 100]);
  assert.equal(new Set(result.engines.map((engine) => engine.allocation)).size, 4);
});
