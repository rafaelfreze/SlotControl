import assert from "node:assert/strict";
import test from "node:test";

import { getOpenMarketMetrics } from "./format.ts";

test("posição BTC aberta marca somente o PnL do notional congelado sobre o valor operacional atual", () => {
  const metrics = getOpenMarketMetrics({
    status: "aberto",
    base_value: 10,
    gain_rate: 0.01,
    gains: 20,
    operational_slot_value: 10,
    position_notional_usdt: 12,
    preco_entrada: 100,
    preco_atual: 110,
    preco_alvo: 101,
    strategy: null
  });

  assert.ok(Math.abs(metrics.resultadoAbertoUsdt - 1.2) < 1e-9);
  assert.ok(Math.abs(metrics.valorMarcado - 11.2) < 1e-9);
  assert.equal(metrics.valorSlot, 10);
});

test("registros anteriores sem snapshot usam o valor operacional como notional compatível", () => {
  const metrics = getOpenMarketMetrics({
    status: "aberto",
    base_value: 10,
    gain_rate: 0.01,
    gains: 0,
    operational_slot_value: 10,
    preco_entrada: 100,
    preco_atual: 105,
    preco_alvo: 101,
    strategy: null
  });

  assert.ok(Math.abs(metrics.resultadoAbertoUsdt - 0.5) < 1e-9);
  assert.ok(Math.abs(metrics.valorMarcado - 10.5) < 1e-9);
});

test("snapshot nulo de registro legado não é tratado como notional zero", () => {
  const metrics = getOpenMarketMetrics({
    status: "aberto",
    base_value: 10,
    gain_rate: 0.01,
    gains: 0,
    operational_slot_value: 10,
    position_notional_usdt: null,
    preco_entrada: 100,
    preco_atual: 105,
    preco_alvo: 101,
    strategy: null
  });

  assert.ok(Math.abs(metrics.resultadoAbertoUsdt - 0.5) < 1e-9);
  assert.ok(Math.abs(metrics.valorMarcado - 10.5) < 1e-9);
});

test("posição aberta preserva o alvo persistido quando a estratégia muda", () => {
  const metrics = getOpenMarketMetrics({
    status: "aberto",
    base_value: 10,
    gain_rate: 0.05,
    gains: 0,
    operational_slot_value: 10,
    position_notional_usdt: 10,
    preco_entrada: 100,
    preco_atual: 100,
    preco_alvo: 101,
    strategy: null
  });

  assert.equal(metrics.precoAlvo, 101);
  assert.ok(Math.abs(metrics.distanciaAteGainPercentual - 1) < 1e-9);
});
