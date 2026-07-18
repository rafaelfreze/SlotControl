import assert from "node:assert/strict";
import test from "node:test";

import { getFinancialValueTone } from "./financial-tone.ts";

test("valores financeiros negativos usam tom vermelho", () => {
  assert.equal(getFinancialValueTone(-0.01), "negative");
});

test("valores financeiros positivos usam tom verde e zero permanece neutro", () => {
  assert.equal(getFinancialValueTone(1), "positive");
  assert.equal(getFinancialValueTone(0), "neutral");
  assert.equal(getFinancialValueTone("invalido"), "neutral");
});
