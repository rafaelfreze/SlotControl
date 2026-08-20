import assert from "node:assert/strict";
import test from "node:test";

import {
  indexCapitalContributionsBySlot,
  summarizeCapitalContributions,
  summarizeSlotCapitalFlow,
  type CapitalContributionView
} from "./capital-contributions.ts";

const contributions: CapitalContributionView[] = [
  {
    asset: "BTC",
    slot_id: "btc-12",
    amount_usdt: "4.04494392",
    accounting_amount_usdt: "3.77949295",
    gain_equivalent: 24,
    input_mode: "MANUAL_GAINS"
  },
  { asset: "BTC", slot_id: "btc-12", amount_usdt: 1, gain_equivalent: "5" },
  { asset: "SOL", slot_id: "sol-1", amount_usdt: 2.5, gain_equivalent: 1 }
];

test("soma gains e USDT aportados por ativo", () => {
  assert.deepEqual(summarizeCapitalContributions(contributions, { asset: "btc" }), {
    amountUsdt: 4.77949295,
    gains: 29
  });
});

test("mantem o detalhamento exato por slot", () => {
  assert.deepEqual(indexCapitalContributionsBySlot(contributions), {
    "btc-12": { amountUsdt: 4.77949295, gains: 29 },
    "sol-1": { amountUsdt: 2.5, gains: 1 }
  });
});

test("ignora valores invalidos em vez de contaminar os totais", () => {
  const invalid = [{ asset: "BTC", slot_id: "btc-1", amount_usdt: "x", gain_equivalent: -2 }];
  assert.deepEqual(summarizeCapitalContributions(invalid), { amountUsdt: 0, gains: 0 });
});

test("explica o saldo adicional liquido depois da redistribuicao", () => {
  const summary = summarizeSlotCapitalFlow({
    growth_contribution: "3.77949295",
    redistribution_received_usdt: "0",
    redistribution_sent_usdt: "2.35955062"
  });

  assert.equal(summary.externalContributionUsdt, 3.77949295);
  assert.equal(summary.redistributionNetUsdt, -2.35955062);
  assert.ok(Math.abs(summary.additionalCapitalNetUsdt - 1.41994233) < 1e-8);
});
