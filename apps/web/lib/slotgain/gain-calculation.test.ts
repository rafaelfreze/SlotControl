import assert from "node:assert/strict";
import test from "node:test";

import { getValueForGains } from "./gain-calculation.ts";

test("o valor segue a quantidade de gains e a taxa atual da estratégia", () => {
  assert.equal(getValueForGains(10, 0, 0.012, 8), 10.96);
  assert.equal(getValueForGains(25, 0, 0.055, 3), 29.125);
});

test("aporte externo entra no capital usado nos gains futuros", () => {
  assert.equal(getValueForGains(10, 5, 0.012, 8), 16.44);
});
