import assert from "node:assert/strict";
import test from "node:test";

import { getMonthlyGrowthStatus } from "./growth-status.ts";

test("resumo mostra apenas OK quando a meta mensal foi atingida", () => {
  assert.deepEqual(getMonthlyGrowthStatus(7, 7), { missing: 0, label: "OK" });
  assert.deepEqual(getMonthlyGrowthStatus(1, 3), { missing: 0, label: "OK" });
});

test("resumo mostra somente a quantidade inteira que falta", () => {
  assert.deepEqual(getMonthlyGrowthStatus(7, 0), { missing: 7, label: "Faltam 7" });
  assert.deepEqual(getMonthlyGrowthStatus(7, 5.5), { missing: 2, label: "Faltam 2" });
  assert.deepEqual(getMonthlyGrowthStatus(1, 0), { missing: 1, label: "Faltam 1" });
});
