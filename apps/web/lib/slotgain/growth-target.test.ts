import assert from "node:assert/strict";
import test from "node:test";

import { getLeaderGrowthTarget } from "./growth-target.ts";

test("meta 7 no quinto ciclo sugere completar o líder de 11 para 35", () => {
  assert.deepEqual(getLeaderGrowthTarget(7, 5, 11), {
    targetGains: 35,
    missingGains: 24,
    suggestedManualGains: 24
  });
});

test("sugestão inteira alcança pelo menos a meta quando a escada tem fração", () => {
  assert.deepEqual(getLeaderGrowthTarget(7, 5, 11.25), {
    targetGains: 35,
    missingGains: 23.75,
    suggestedManualGains: 24
  });
});

test("meta já atingida mantém o formulário disponível com um gain", () => {
  assert.deepEqual(getLeaderGrowthTarget(7, 5, 35), {
    targetGains: 35,
    missingGains: 0,
    suggestedManualGains: 1
  });
});
