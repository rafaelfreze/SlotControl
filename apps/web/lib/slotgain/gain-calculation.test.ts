import assert from "node:assert/strict";
import test from "node:test";

import { getValueForGains } from "./gain-calculation.ts";

test("o valor segue a quantidade de gains e a taxa atual da estratégia", () => {
  assert.equal(getValueForGains(10, 0, 0.012, 8), 11.00130234);
  assert.equal(getValueForGains(25, 0, 0.055, 3), 29.35603437);
});

test("gains adicionados usam o mesmo total operacional dos gains futuros", () => {
  const realGains = 5;
  const addedGains = 3;

  assert.equal(getValueForGains(10, 0, 0.012, realGains + addedGains), 11.00130234);
});
