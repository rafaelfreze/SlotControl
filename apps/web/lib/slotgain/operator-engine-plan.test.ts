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
  assert.throws(() => validateEnginePlan({ ...plan, accountId: requestId, engines: [plan.engines[0], plan.engines[0]] }), /INPUT_INVALID/);
  assert.throws(() => validateEnginePlan({ ...plan, engines: [{ ...plan.engines[0], postAthPercent: "21" }] }), /RATE_INVALID/);
  assert.throws(() => validateEnginePlan({ ...plan, engines: [{ ...plan.engines[0], capital: "419.001" }] }), /AMOUNT_INVALID/);
});
