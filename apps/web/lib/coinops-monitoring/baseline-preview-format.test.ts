import assert from "node:assert/strict";
import test from "node:test";

import { formatOptionalDecimal } from "./baseline-preview-format.ts";

test("preview preserva zero real e não converte valores ausentes em zero", () => {
  assert.equal(formatOptionalDecimal(null), "—");
  assert.equal(formatOptionalDecimal(undefined), "—");
  assert.equal(formatOptionalDecimal(""), "—");
  assert.equal(formatOptionalDecimal(Number.NaN), "—");
  assert.equal(formatOptionalDecimal(0), "0");
  assert.equal(formatOptionalDecimal("0"), "0");
  assert.equal(formatOptionalDecimal(12.345, 2), "12,35");
});
