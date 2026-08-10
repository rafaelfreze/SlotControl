import assert from "node:assert/strict";
import test from "node:test";

import {
  indexCapitalContributionsBySlot,
  summarizeCapitalContributions,
  type CapitalContributionView
} from "./capital-contributions.ts";

const contributions: CapitalContributionView[] = [
  { asset: "BTC", slot_id: "btc-12", amount_usdt: "4.04494392", gain_equivalent: 24 },
  { asset: "BTC", slot_id: "btc-12", amount_usdt: 1, gain_equivalent: "5" },
  { asset: "SOL", slot_id: "sol-1", amount_usdt: 2.5, gain_equivalent: 1 }
];

test("soma gains e USDT aportados por ativo", () => {
  assert.deepEqual(summarizeCapitalContributions(contributions, { asset: "btc" }), {
    amountUsdt: 5.04494392,
    gains: 29
  });
});

test("mantem o detalhamento exato por slot", () => {
  assert.deepEqual(indexCapitalContributionsBySlot(contributions), {
    "btc-12": { amountUsdt: 5.04494392, gains: 29 },
    "sol-1": { amountUsdt: 2.5, gains: 1 }
  });
});

test("ignora valores invalidos em vez de contaminar os totais", () => {
  const invalid = [{ asset: "BTC", slot_id: "btc-1", amount_usdt: "x", gain_equivalent: -2 }];
  assert.deepEqual(summarizeCapitalContributions(invalid), { amountUsdt: 0, gains: 0 });
});
