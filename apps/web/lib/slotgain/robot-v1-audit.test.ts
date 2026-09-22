import assert from "node:assert/strict";
import test from "node:test";

import { reconcileV1PhysicalSlotAccounts, sumV1DecimalAmounts, summarizeV1ShadowOperations } from "../execution/robot-v1-audit.ts";

test("Shadow accounting keeps archived gains after a physical slot is recycled", () => {
  const summary = summarizeV1ShadowOperations([
    { grossQuotePnl: 0.0493, estimatedQuoteFees: 0, netQuotePnl: 0.0493 },
    { grossQuotePnl: "0.0474419", estimatedQuoteFees: "0", netQuotePnl: "0.0474419" }
  ]);
  assert.deepEqual(summary, { operations: 2, grossProfit: 0.0967419, estimatedFees: 0, netProfit: 0.0967419 });
});

test("slot capital sums exact persisted decimals across independent gains and cycle resets", () => {
  assert.equal(sumV1DecimalAmounts(["10.000000000000", "0.050000000000"]), "10.050000000000");
  assert.equal(sumV1DecimalAmounts(["10.050000000000", "0.050250000000"]), "10.100250000000");
  assert.equal(sumV1DecimalAmounts(["10.094685800000", ...Array.from({ length: 24 }, () => "10.000000000000")]), "250.094685800000");
  assert.throws(() => sumV1DecimalAmounts(["0.0000000000001"]), /DECIMAL_INVALID/);
});

test("physical gain counters and balances survive recycled operations and new cycles", () => {
  const accounts = Array.from({ length: 25 }, (_, index) => ({
    slot_number: index + 1, initial_balance_usdc: "10.000000000000",
    balance_usdc: index === 0 ? "10.100250000000" : index === 1 ? "10.049300000000" : "10.000000000000",
    gain_count: index === 0 ? 2 : index === 1 ? 1 : 0,
    gross_profit_usdc: index === 0 ? "0.100250000000" : index === 1 ? "0.049300000000" : "0.000000000000",
    fees_usdc: "0.000000000000",
    net_profit_usdc: index === 0 ? "0.100250000000" : index === 1 ? "0.049300000000" : "0.000000000000"
  }));
  const operations = [
    { id: "old-cycle-slot-1", physical_slot_number: 1, gross_quote_pnl: "0.050000000000", estimated_quote_fees: "0", net_quote_pnl: "0.050000000000" },
    { id: "new-cycle-slot-1", physical_slot_number: 1, gross_quote_pnl: "0.050250000000", estimated_quote_fees: "0", net_quote_pnl: "0.050250000000" },
    { id: "recycled-slot-2", physical_slot_number: 2, gross_quote_pnl: "0.049300000000", estimated_quote_fees: "0", net_quote_pnl: "0.049300000000" }
  ];
  assert.equal(reconcileV1PhysicalSlotAccounts(accounts, operations), true);
  assert.equal(reconcileV1PhysicalSlotAccounts(accounts, [...operations, operations[0]!]), false);
  assert.equal(reconcileV1PhysicalSlotAccounts(accounts, operations.map((item) => item.id === "recycled-slot-2" ? { ...item, physical_slot_number: 3 } : item)), false);
  assert.equal(reconcileV1PhysicalSlotAccounts(accounts.map((item) => item.slot_number === 1 ? { ...item, balance_usdc: "10.000000000000" } : item), operations), false);
});
