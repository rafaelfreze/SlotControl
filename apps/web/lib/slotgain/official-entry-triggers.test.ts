import assert from "node:assert/strict";
import test from "node:test";

import { buildOfficialFutureEntryPlan, type OfficialTriggerSlot } from "./official-entry-triggers.ts";

const slot = (overrides: Partial<OfficialTriggerSlot>): OfficialTriggerSlot => ({
  id: String(overrides.id ?? overrides.slotNumber ?? 1),
  asset: "BTC",
  status: "hold",
  slotNumber: 1,
  pool: "MAIN",
  enabled: true,
  funded: true,
  allowReserve: false,
  activeFromCycleNumber: 1,
  operationalGains: 0,
  operationalValue: 10,
  cycleProgress: 0,
  lastOperatedAt: null,
  ...overrides
});

test("fila oficial NORMAL usa BTC 2%, SOL 3% e separa os ativos", () => {
  const slots = [
    slot({ id: "btc-met", asset: "BTC", slotNumber: 1, cycleProgress: 7 }),
    slot({ id: "btc-next", asset: "BTC", slotNumber: 2, cycleProgress: 1 }),
    slot({ id: "sol-next", asset: "SOL", slotNumber: 3, cycleProgress: 0 }),
    slot({ id: "sol-second", asset: "SOL", slotNumber: 4, cycleProgress: 1 })
  ];

  const btc = buildOfficialFutureEntryPlan("BTC", "NORMAL_GROWTH", 1, slots);
  const sol = buildOfficialFutureEntryPlan("SOL", "NORMAL_GROWTH", 1, slots);

  assert.equal(btc.dropPercent, 2);
  assert.deepEqual(btc.candidateIds, ["btc-next"]);
  assert.equal(sol.dropPercent, 3);
  assert.deepEqual(sol.candidateIds, ["sol-next", "sol-second"]);
});

test("fila oficial usa principal elegível antes da reserva em ambos os modos", () => {
  const slots = [
    slot({ id: "btc-main", asset: "BTC", slotNumber: 2, operationalGains: 1 }),
    slot({ id: "btc-reserve", asset: "BTC", slotNumber: 26, pool: "RESERVE", allowReserve: true, operationalGains: 0 }),
    slot({ id: "sol-main", asset: "SOL", slotNumber: 4, operationalGains: 0 }),
    slot({ id: "sol-reserve", asset: "SOL", slotNumber: 27, pool: "RESERVE", allowReserve: true, operationalGains: 0 })
  ];

  const btcNormal = buildOfficialFutureEntryPlan("BTC", "NORMAL_GROWTH", 1, slots);
  const solNormal = buildOfficialFutureEntryPlan("SOL", "NORMAL_GROWTH", 1, slots);
  const btcDefensive = buildOfficialFutureEntryPlan("BTC", "DEFENSIVE_POST_ATH", 1, slots);
  const solDefensive = buildOfficialFutureEntryPlan("SOL", "DEFENSIVE_POST_ATH", 1, slots);

  assert.equal(btcNormal.dropPercent, 2);
  assert.deepEqual(btcNormal.candidateIds, ["btc-main"]);
  assert.equal(solNormal.dropPercent, 3);
  assert.deepEqual(solNormal.candidateIds, ["sol-main"]);
  assert.equal(btcDefensive.dropPercent, 5);
  assert.deepEqual(btcDefensive.candidateIds, ["btc-main"]);
  assert.equal(solDefensive.dropPercent, 8);
  assert.deepEqual(solDefensive.candidateIds, ["sol-main"]);
});

test("fila oficial usa reserva habilitada e financiada quando todos os principais estão OPEN", () => {
  const slots = [
    slot({ id: "main-open", status: "aberto", slotNumber: 1 }),
    slot({ id: "reserve", slotNumber: 26, pool: "RESERVE", allowReserve: true })
  ];

  assert.deepEqual(buildOfficialFutureEntryPlan("BTC", "NORMAL_GROWTH", 1, slots).candidateIds, ["reserve"]);
  assert.deepEqual(buildOfficialFutureEntryPlan("BTC", "DEFENSIVE_POST_ATH", 1, slots).candidateIds, ["reserve"]);
});

test("fila oficial não usa reserva desabilitada, não financiada ou sem permissão", () => {
  const mainOpen = slot({ id: "main-open", status: "aberto", slotNumber: 1 });
  const unavailableReserve = [
    slot({ id: "reserve-disabled", slotNumber: 26, pool: "RESERVE", allowReserve: true, enabled: false }),
    slot({ id: "reserve-unfunded", slotNumber: 27, pool: "RESERVE", allowReserve: true, funded: false }),
    slot({ id: "reserve-not-allowed", slotNumber: 28, pool: "RESERVE", allowReserve: false })
  ];

  for (const mode of ["NORMAL_GROWTH", "DEFENSIVE_POST_ATH"] as const) {
    const plan = buildOfficialFutureEntryPlan("BTC", mode, 1, [mainOpen, ...unavailableReserve]);
    assert.deepEqual(plan.candidateIds, []);
  }
});

test("fila NORMAL pausa quando todos os principais elegíveis já atingiram a meta", () => {
  const slots = [
    slot({ id: "main-met", slotNumber: 1, cycleProgress: 7 }),
    slot({ id: "reserve-below", slotNumber: 26, pool: "RESERVE", allowReserve: true, cycleProgress: 1 })
  ];

  assert.deepEqual(buildOfficialFutureEntryPlan("BTC", "NORMAL_GROWTH", 1, slots).candidateIds, []);
});

test("fila NORMAL usa reserva se ainda há principal abaixo da meta, mas nenhum está livre", () => {
  const slots = [
    slot({ id: "main-open-below", status: "aberto", slotNumber: 1, cycleProgress: 2 }),
    slot({ id: "main-free-met", slotNumber: 2, cycleProgress: 7 }),
    slot({ id: "reserve-below", slotNumber: 26, pool: "RESERVE", allowReserve: true, cycleProgress: 1 })
  ];

  assert.deepEqual(buildOfficialFutureEntryPlan("BTC", "NORMAL_GROWTH", 1, slots).candidateIds, ["reserve-below"]);
});
