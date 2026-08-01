import assert from "node:assert/strict";
import test from "node:test";

import { getValueAfterGains } from "./gain-calculation.ts";

test("o valor de gains futuros usa a taxa atual da estratégia", () => {
  assert.equal(getValueAfterGains(100, 0.012), 101.2);
  assert.equal(Number(getValueAfterGains(100, 0.012, 3).toFixed(6)), 103.643373);
});
