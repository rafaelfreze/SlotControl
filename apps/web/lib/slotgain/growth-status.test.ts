import assert from "node:assert/strict";
import test from "node:test";

import { getDashboardGrowthStatus, getMonthlyGrowthStatus } from "./growth-status.ts";

test("resumo mostra apenas OK quando a meta mensal foi atingida", () => {
  assert.deepEqual(getMonthlyGrowthStatus(7, 7), { missing: 0, label: "OK" });
  assert.deepEqual(getMonthlyGrowthStatus(1, 3), { missing: 0, label: "OK" });
});

test("resumo mostra somente a quantidade inteira que falta", () => {
  assert.deepEqual(getMonthlyGrowthStatus(7, 0), { missing: 7, label: "Faltam 7" });
  assert.deepEqual(getMonthlyGrowthStatus(7, 5.5), { missing: 2, label: "Faltam 2" });
  assert.deepEqual(getMonthlyGrowthStatus(1, 0), { missing: 1, label: "Faltam 1" });
});

test("resumo usa o progresso oficial por slot quando o baseline esta ativo", () => {
  assert.deepEqual(
    getDashboardGrowthStatus({
      monitoringActive: true,
      officialCycle: { target: 7, belowTarget: 25, nextProgress: 0 },
      legacyGoal: 7,
      legacyRealGains: 5
    }),
    { missing: 7, label: "Faltam 7" }
  );

  assert.deepEqual(
    getDashboardGrowthStatus({
      monitoringActive: true,
      officialCycle: { target: 2, belowTarget: 25, nextProgress: 0 },
      legacyGoal: 1,
      legacyRealGains: 0
    }),
    { missing: 2, label: "Faltam 2" }
  );
});

test("resumo oficial distingue meta cumprida e meta pausada", () => {
  assert.deepEqual(
    getDashboardGrowthStatus({
      monitoringActive: true,
      officialCycle: { target: 7, belowTarget: 0, nextProgress: null },
      legacyGoal: 7,
      legacyRealGains: 0
    }),
    { missing: 0, label: "OK" }
  );

  assert.deepEqual(
    getDashboardGrowthStatus({
      monitoringActive: true,
      officialCycle: { target: null, belowTarget: 25, nextProgress: null },
      legacyGoal: 7,
      legacyRealGains: 5
    }),
    { missing: 0, label: "Meta pausada" }
  );
});

test("resumo preserva o plano legado quando o baseline esta inativo", () => {
  assert.deepEqual(
    getDashboardGrowthStatus({
      monitoringActive: false,
      officialCycle: null,
      legacyGoal: 7,
      legacyRealGains: 5
    }),
    { missing: 2, label: "Faltam 2" }
  );
});
