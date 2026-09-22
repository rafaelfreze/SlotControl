import assert from "node:assert/strict";
import test from "node:test";

import { summarizeV1ShadowOperations } from "../execution/robot-v1-audit.ts";

test("Shadow accounting keeps archived gains after a physical slot is recycled", () => {
  const summary = summarizeV1ShadowOperations([
    { grossQuotePnl: 0.0493, estimatedQuoteFees: 0, netQuotePnl: 0.0493 },
    { grossQuotePnl: "0.0474419", estimatedQuoteFees: "0", netQuotePnl: "0.0474419" }
  ]);
  assert.deepEqual(summary, { operations: 2, grossProfit: 0.0967419, estimatedFees: 0, netProfit: 0.0967419 });
});
