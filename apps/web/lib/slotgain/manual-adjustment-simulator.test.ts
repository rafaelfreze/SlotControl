import assert from "node:assert/strict";
import test from "node:test";
import { simulateManualAdjustments } from "../execution/manual-adjustment-simulator.ts";

test("simulador isolado prova cenários contábeis A–J", () => {
  const scenarios = simulateManualAdjustments();
  assert.deepEqual(scenarios.map((scenario) => scenario.code), ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
  assert.deepEqual(scenarios.filter((scenario) => !scenario.passed), []);
});
